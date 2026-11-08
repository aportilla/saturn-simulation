// Near-field sun shadow map: crisp, resolution-independent shadows of nearby ring particles on each other.
//
// Orthographic map looking down the sun direction s, centred on the camera. Map coordinates
// u = p.e_u (horizontal, perpendicular to the sun azimuth), v = p.e_v (e_v = (z - s s_z)/|..|), depth d = p.s.
// Every occluder of a point lies on the point's own sun ray, i.e. at the same (u, v): the map therefore
// covers a "tube" |u| < U, |v| < V along the sun direction - with the Sun ~8 deg above the plane, a
// 2U x ~330 m strip of ring around the camera - and resolves all occlusion inside it.
//
// Analytic caster map: the texels only index the casters, they do not shape the shadows. Each texel stores
// the most sunward caster (by centre depth) whose outline covers the texel centre (or whose centre lies in
// the texel, so that casters smaller than a texel are never lost): its exact outline in the sun plane - the
// projection of the triaxial ellipsoid along s, an ellipse (centre, semi-major axis vector, semi-minor
// radius) - and its centre depth. A lookup tests the receiver point analytically against the casters held by
// the four texels at the corners of its texel cell (and, for soft edges, the eight texels next to the cell's
// sides): inside the outline and downsun of the caster's centre -> shadowed (the centre depth decides exactly
// for spheres: a point outside a convex caster is either sunward or downsun of its chord).
// The edge is smoothed over the larger of the physical penumbra (solar angular radius x distance behind the
// caster) and the receiver's pixel footprint, with a disc-overlap profile that conserves the blocked flux.
// The receiving particle itself is excluded (convex bodies never shadow their own sunlit side), so no depth
// bias or normal offset is needed.
//
// Record (RGBA32UI): x, y = outline centre u, v as 24-bit fixed point over +-128 m (15 um), the top bytes
// hold the half-float semi-minor radius; z = centre depth (float bits); w = semi-major axis vector (2 x half;
// 0 = empty texel).
//
// Relief (high particle quality): particle surfaces are displaced ellipsoids (nearRelief, nearCommon.glsl), so
// a caster's true outline is the ellipse above times a radial profile rho(phi) (phi: direction in the sun
// plane), computed once per caster in the caster pass: rho = max over the meridian half-plane through the
// direction phi (5 samples within +-30 deg of the limb, coarse relief layers) of kappa (1 + h) sin(theta), in the
// axis-scaled body frame, for casters whose relief is resolvable at their distance from the camera (else the
// ellipse, flag bit clear). 24 samples x 5 bits over the global range nearShadowProfileRange() go to a second
// attachment (same texel as the record, so the two always belong together); texels are written where the
// profiled outline covers their centre, and the near-field lookups (NEAR_SHADOW_PROFILE) scale the outline
// radius by the interpolated profile wherever the receiver is within the band the profile can affect (outside
// it the ellipse bounds decide). Residual mismatch with the ray-marched silhouettes: relief features narrower
// than the 15 deg sampling, the two finest geometric layers (<= 0.05 radii) and the 5-bit quantization (~1% of
// the radius). The astronaut's lookup (no NEAR_SHADOW_PROFILE) keeps the plain ellipses.
//
// Casters: every PRESENT particle (independent of the LOD draw decision) of the size classes whose
// radius spans >= ~1.6 texels (k >= first caster class), inside the tube. Statistical consistency: the
// layer transmission used with the map only contains the optical depth the map cannot resolve - the
// smaller classes and the sub-class residual (whole column), and for each mapped class the part of the
// column beyond the point where the sun ray leaves that class's particle box (beyond it the particles
// are not instantiated). Near the edges of the tube the result blends to the purely statistical
// transmission (both are unbiased estimates of the same mean), so there is no seam in mean brightness.
import {
  GLSL3, NearestFilter, NoBlending, Points, RawShaderMaterial, RGBAIntegerFormat, UnsignedIntType, Vector3, Vector4,
  WebGLRenderTarget, BufferGeometry, LessEqualDepth, type IUniform, type WebGLRenderer,
} from 'three';
import { fsCamera } from '../fullscreen';
import { LOD_A0, LOD_CLASSES } from '../../rings/RingLod';
import type { RingLod } from '../../rings/RingLod';
import type { FrameState } from '../../core/FrameState';

export const SHADOW_W = 2048;
export const SHADOW_H = 1024;
/** horizontal half-width of the shadowed tube (m) */
export const SHADOW_U = 48;
/** casters must span at least this many texels in radius */
const MIN_CASTER_TEXELS = 1.6;
/** depth range (m) along the sun direction */
const DEPTH_RANGE = 4000;
/**
 * Edge blur radius limit (texels): the lookup reaches >= 1 texel beyond the receiver's cell on every side, so
 * casters whose soft edge extends up to ~this far are always found. (Penumbrae are physical up to ~85 m
 * behind the caster at the usual 4.7 cm texel, beyond that slightly sharper.)
 */
const MAX_BLUR_TEXELS = 0.9;

/** Uniform declarations + functions shared by the classifier, caster pass and lookups. */
export const NEAR_SHADOW_COMMON_GLSL = /* glsl */ `
uniform vec4 uShU;      // e_u (SEF), half-width U (m)
uniform vec4 uShV;      // e_v (SEF), half-height V (m)
uniform vec4 uShInfo;   // (texel size (m, larger axis), enabled 0/1, first caster class, depth range (m))
uniform vec4 uShPen;    // (solar angular radius (rad), max. edge blur radius (m), -, -)
bool nearShadowCaster(vec3 c, float rb, int k) {
  if (uShInfo.y < 0.5 || float(k) < uShInfo.z) return false;
  return abs(dot(c, uShU.xyz)) < uShU.w + rb && abs(dot(c, uShV.xyz)) < uShV.w + rb;
}
`;

/**
 * Relief profile of the caster outlines (near pass only: needs nearCommon.glsl). Defines NEAR_SHADOW_PROFILE,
 * which switches the lookup below to the profiled outlines; include it before NEAR_SHADOW_LOOKUP_GLSL.
 */
export const NEAR_SHADOW_PROFILE_GLSL = /* glsl */ `
#define NEAR_SHADOW_PROFILE
#define NSH_PROF_N 24
uniform highp usampler2D tShadowProf;   // per texel: the record's outline profile (24 x 5 bits)
// global range of the profile values (outline radius / ellipse radius): the relief shells at full amplitude
vec2 nearShadowProfileRange() {
  vec2 s0 = nearReliefShell(1.0, 0.0), s1 = nearReliefShell(1.0, 1.0);
  return vec2(min(s0.x, s1.x), max(s0.y, s1.y));
}
uint nearShadowProfQ(uvec4 p, int j) {
  uint wd = j < 6 ? p.x : (j < 12 ? p.y : (j < 18 ? p.z : p.w));
  return (wd >> (5u * uint(j % 6))) & 31u;
}
// outline radius / ellipse radius in the sun-plane direction d (from the outline centre; e_u, e_v components),
// linear in the angle; 1 without a profile (bit 31 of p.x clear: relief not resolvable where the caster is)
float nearShadowProfile(uvec4 p, vec2 d) {
  if ((p.x & 0x80000000u) == 0u) return 1.0;
  float phi = atan(d.y, abs(d.x) + abs(d.y) > 0.0 ? d.x : 1.0);
  float x = fract(phi * (1.0 / TWO_PI)) * float(NSH_PROF_N);
  int i0 = int(floor(x));
  int i1 = i0 + 1 >= NSH_PROF_N ? 0 : i0 + 1;
  float q = mix(float(nearShadowProfQ(p, i0)), float(nearShadowProfQ(p, i1)), x - float(i0));
  vec2 r = nearShadowProfileRange();
  return r.x + (r.y - r.x) * q * (1.0 / 31.0);
}
`;

/** Lookup side, used by the draw shaders. */
export const NEAR_SHADOW_LOOKUP_GLSL = /* glsl */ `
uniform highp usampler2D tShadow;   // analytic caster records (NearShadow.ts); w = 0: empty
// 1 deep inside the shadowed tube, fading to 0 over the outer 12% (and 0 outside / disabled)
float nearShadowCoverage(vec3 p) {
  if (uShInfo.y < 0.5) return 0.0;
  float u = abs(dot(p, uShU.xyz)) / uShU.w, v = abs(dot(p, uShV.xyz)) / uShV.w;
  return 1.0 - smoothstep(0.86, 0.98, max(u, v));
}
// Fraction of the solar disc hidden by one caster outline - an ellipse with semi-major axis vector a1 and
// semi-minor radius rMin (times the relief profile with NEAR_SHADOW_PROFILE, read from texel tc), centred at
// -dl from the receiver (sun plane, m) - for an edge blur radius R (penumbra and/or receiver footprint).
// Disc-overlap profile along the outline radius re toward the receiver: full inside |re - R|, nothing beyond
// re + R, and a peak of (outline area / pi R^2) when the caster is smaller than the blur (antumbra): the
// blocked flux is conserved for any R.
float nearShadowCov(vec2 dl, vec2 a1, float rMin, float R, ivec2 tc) {
  float rMaj2 = dot(a1, a1);
  float x1 = dot(dl, a1), x2 = dl.x * a1.y - dl.y * a1.x;
  float q = (x1 * x1 + x2 * x2 * rMaj2 / (rMin * rMin)) / (rMaj2 * rMaj2);   // (dl / outline)^2
  float L = length(dl);
  float re = q > 1e-24 ? L * inversesqrt(q) : rMin;
#ifdef NEAR_SHADOW_PROFILE
  if (uNearQuality > 1.5) {
    // relief: the profile only matters within [re rho_min - R, re rho_max + R]
    vec2 pr = nearShadowProfileRange();
    if (L >= re * pr.y + R) return 0.0;
    re *= L > re * pr.x - R ? nearShadowProfile(texelFetch(tShadowProf, tc, 0), dl) : pr.x;
  }
#endif
  float peak = min(1.0, sqrt(rMaj2) * rMin / (R * R));
  return peak * (1.0 - smoothstep(abs(re - R), re + R, L));
}
// One texel's caster record e (from texel tc) against the receiver (pu: sun-plane position, dp: sun-direction
// depth, so: the receiving particle's own centre (u, v, d), rp: receiver footprint radius (m), pen: 1 =
// physical penumbra)
float nearShadowRec(uvec4 e, ivec2 tc, vec2 pu, float dp, vec3 so, float rp, float pen) {
  if (e.w == 0u) return 0.0;
  float dc = uintBitsToFloat(e.z);
  if (dc <= dp) return 0.0;                                   // caster centre not sunward of the receiver
  vec2 cu = vec2(float(e.x & 0xFFFFFFu), float(e.y & 0xFFFFFFu)) * (1.0 / 65536.0) - 128.0;
  vec3 ds = abs(vec3(cu, dc) - so);
  if (max(max(ds.x, ds.y), ds.z) < 2e-3) return 0.0;          // the receiving particle itself
  vec2 a1 = unpackHalf2x16(e.w);
  float rMin = unpackHalf2x16(((e.x >> 24u) << 8u) | (e.y >> 24u)).x;
  float R = clamp(max(pen * uShPen.x * (dc - dp), rp), 1e-4, uShPen.y);
  return nearShadowCov(pu - cu, a1, rMin, R, tc);
}
// Sun visibility of point p (camera-relative SEF) from the caster map. The four texels at the corners of
// the texel cell holding p are tested first: together they hold every outline that contains p (a convex
// outline of >= 1.6 texels radius cannot cover p without covering one of them, except for slivers thinner
// than ~0.1 texel along the cell sides), so a full cover ends the search. Soft edges (penumbra, pixel
// footprint; blur radius <= uShPen.y < 1 texel) can reach p from outlines held only by the 8 texels next to
// the cell's sides (reach >= 1 texel; an outline holding only a diagonal neighbour stays >= 0.88 texel away,
// where the soft edge has faded to < 1e-3). The same caster appears in several texels: contributions combine
// by the maximum (overlapping soft edges of different casters are at most ~1 texel wide). Fetches are issued
// in independent batches of four (the lookup is latency-bound inside the large impostor shader).
// selfC: centre of the receiving particle (vec3(1e9): none); rp: receiver footprint radius (m); soft = false:
// sharp point sample from the cell corners only (sub-pixel particles, where only the mean matters).
#define NSH_TC(dx, dy) clamp(b + ivec2(dx, dy), ivec2(0), hi)
#define NSH_REC(e, t) nearShadowRec(e, t, pu, dp, so, rpe, pen)
#define NSH_BATCH(x0, y0, x1, y1, x2, y2, x3, y3) { \
  ivec2 t0 = NSH_TC(x0, y0), t1 = NSH_TC(x1, y1), t2 = NSH_TC(x2, y2), t3 = NSH_TC(x3, y3); \
  uvec4 e0 = texelFetch(tShadow, t0, 0), e1 = texelFetch(tShadow, t1, 0), e2 = texelFetch(tShadow, t2, 0), e3 = texelFetch(tShadow, t3, 0); \
  cov = max(cov, max(max(NSH_REC(e0, t0), NSH_REC(e1, t1)), max(NSH_REC(e2, t2), NSH_REC(e3, t3)))); }
float nearShadowVisibilityN(vec3 p, vec3 selfC, float rp, bool soft) {
  if (uShInfo.y < 0.5) return 1.0;
  vec2 pu = vec2(dot(p, uShU.xyz), dot(p, uShV.xyz));
  vec2 uv = pu / vec2(uShU.w, uShV.w) * 0.5 + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
  float dp = dot(p, uSunDir);
  vec3 so = vec3(dot(selfC, uShU.xyz), dot(selfC, uShV.xyz), dot(selfC, uSunDir));
  ivec2 sz = textureSize(tShadow, 0), hi = sz - 1;
  ivec2 b = ivec2(floor(uv * vec2(sz) - 0.5));
  float pen = soft ? 1.0 : 0.0, rpe = soft ? rp : 0.0;
  float cov = 0.0;
  NSH_BATCH(0, 0, 1, 0, 0, 1, 1, 1)
  if (!soft || cov >= 1.0) return 1.0 - cov;
  NSH_BATCH(-1, 0, -1, 1, 2, 0, 2, 1)
  NSH_BATCH(0, -1, 1, -1, 0, 2, 1, 2)
  return 1.0 - cov;
}
// resolved surfaces: edge smoothed over max(physical penumbra, receiver footprint rp)
float nearShadowVisibility(vec3 p, vec3 selfC, float rp) { return nearShadowVisibilityN(p, selfC, rp, true); }
// sub-pixel particles: sharp point sample (unbiased for the mean, which is all that matters there)
float nearShadowVisibilityPoint(vec3 p, vec3 selfC) { return nearShadowVisibilityN(p, selfC, 0.0, false); }
// The statistical part of the sun path (the classes not in the map, and each mapped class's column beyond
// the point where the sun ray leaves its particle box) is evaluated in nearDraw.vert.glsl.
`;

const ZERO4 = new Uint32Array(4);

/** Caster pass (point sprites in the orthographic sun view); vertex/fragment bodies (after NEAR_SHADOW_PROFILE_GLSL). */
export const NEAR_SHADOW_CASTER_VS = /* glsl */ `
flat out uvec4 vRec;     // the record written to every covered texel
flat out uvec4 vProf;    // its relief profile (second attachment)
flat out vec3 vQm;       // outline matrix (Q11, Q12, Q22): dl^T Q dl <= 1 inside (m^-2)
flat out vec4 vCt;       // outline centre (u, v) (m), centre texel (window coordinates)
// outline profile of a displaced caster (body orientation qr, semi-axes ax, relief parameters rp): for 24
// directions phi in the sun plane, the largest kappa (1 + h) sin(theta) over the meridian half-plane through
// phi (theta from the sun direction, axis-scaled body frame, 5 samples within +-30 deg of the limb, coarse
// layers, value-only textures); bit 31 of x flags a valid profile
uvec4 nearShadowProfileOf(vec4 qr, vec3 ax, vec4 rp) {
  float kap = nearKappa(1.0, rp.w);
  vec2 pr = nearShadowProfileRange();
  vec3 S = normalize(nearQRotInv(qr, uSunDir) / ax);
  uvec4 p = uvec4(0x80000000u, 0u, 0u, 0u);
  for (int j = 0; j < NSH_PROF_N; j++) {
    float ph = TWO_PI * float(j) / float(NSH_PROF_N);
    vec3 e = nearQRotInv(qr, cos(ph) * uShU.xyz + sin(ph) * uShV.xyz) / ax;
    vec3 E = normalize(e - dot(e, S) * S);
    float best = 0.0;
    for (int m = -2; m <= 2; m++) {
      float th = 1.5707963 + 0.2617994 * float(m);
      vec3 uu = cos(th) * S + sin(th) * E;
      best = max(best, kap * (1.0 + nearReliefH(uu, rp, 2)) * sin(th));
    }
    uint q = uint(clamp(floor((best - pr.x) / (pr.y - pr.x) * 31.0 + 0.5), 0.0, 31.0)) << (5u * uint(j % 6));
    if (j < 6) p.x |= q; else if (j < 12) p.y |= q; else if (j < 18) p.z |= q; else p.w |= q;
  }
  return p;
}
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 1.0;
  ivec2 tc;
  if (!nearListFetch(2, gl_VertexID, tc)) return;
  int k = nearClassOfRow(tc.y);
  vec4 r0 = texelFetch(tR0, tc, 0);
  vec3 c = r0.xyz;
  float a = abs(r0.w);
  uint idx = uint((tc.y - uClsRow0[k]) * uTexW + tc.x), seed = uint(uClsSeed[k]);
  vec3 ax = a * nearShape(idx, seed, a);
  vec4 qr = nearOrientation(idx, seed, a, uClsSpinW[k]);
  // outline = projection of the ellipsoid x^T M x <= 1 (M = R diag(ax^-2) R^T) along s:
  // Q = P^T (M - M s s^T M / s^T M s) P with P = [e_u e_v], evaluated in the body frame
  vec3 sb = nearQRotInv(qr, uSunDir), eu = nearQRotInv(qr, uShU.xyz), ev = nearQRotInv(qr, uShV.xyz);
  vec3 Dg = 1.0 / (ax * ax);
  vec3 ms = Dg * sb;
  float sm = dot(sb, ms), mu = dot(eu, ms), mv = dot(ev, ms);
  float Q11 = dot(eu, Dg * eu) - mu * mu / sm;
  float Q12 = dot(eu, Dg * ev) - mu * mv / sm;
  float Q22 = dot(ev, Dg * ev) - mv * mv / sm;
  float hd = 0.5 * (Q11 - Q22), tr = 0.5 * (Q11 + Q22);
  float dsc = sqrt(hd * hd + Q12 * Q12);
  float rMaj = inversesqrt(max(tr - dsc, 1e-12)), rMin = inversesqrt(tr + dsc);
  // major axis = eigenvector of the smaller eigenvalue (perpendicular to the angle 0.5 atan(2 Q12, Q11 - Q22))
  float th = dsc > 1e-7 * tr ? 0.5 * atan(2.0 * Q12, Q11 - Q22) : 0.0;
  vec2 a1 = rMaj * vec2(-sin(th), cos(th));
  vec2 cuv = vec2(dot(c, uShU.xyz), dot(c, uShV.xyz));
  float d = dot(c, uSunDir);
  uvec2 fx = uvec2(clamp(floor((cuv + 128.0) * 65536.0 + 0.5), vec2(0.0), vec2(16777215.0)));
  uint hm = packHalf2x16(vec2(rMin, 0.0));
  vRec = uvec4(fx.x | ((hm >> 8u) << 24u), fx.y | ((hm & 255u) << 24u), floatBitsToUint(d), packHalf2x16(a1));
  // relief profile of the outline (high quality), where the relief can be resolved: its typical amplitude
  // (0.1 a) spans >= 0.3 render px at the caster's distance from the camera (the shadows it casts fall within a
  // few tens of metres of it); elsewhere the ellipse
  bool prof = uNearQuality > 1.5 && 0.1 * a > 0.3 * length(c) * uPixelAngle;
  vProf = prof ? nearShadowProfileOf(qr, ax, nearReliefParams(idx, seed, a)) : uvec4(0u);
  vQm = vec3(Q11, Q12, Q22);
  vec2 ndc = cuv / vec2(uShU.w, uShV.w);
  vCt = vec4(cuv, (ndc * 0.5 + 0.5) * vec2(${SHADOW_W}.0, ${SHADOW_H}.0));
  // constant sprite depth = centre depth: the depth test keeps the most sunward caster per texel, and the
  // hidden ones are rejected before shading (early-z)
  gl_Position = vec4(ndc, clamp(-d / uShInfo.w, -1.0, 1.0), 1.0);
  // covers every texel centre within the outer outline radius (per axis) and the texel holding the centre
  float tmin = min(2.0 * uShU.w / ${SHADOW_W}.0, 2.0 * uShV.w / ${SHADOW_H}.0);
  gl_PointSize = min(2.0 * rMaj * (prof ? nearShadowProfileRange().y : 1.0) / tmin + 1.0, 511.0);
}`;

export const NEAR_SHADOW_CASTER_FS = /* glsl */ `
flat in uvec4 vRec;
flat in uvec4 vProf;
flat in vec3 vQm;
flat in vec4 vCt;
layout(location = 0) out uvec4 o;
layout(location = 1) out uvec4 oProf;
void main() {
  // texel centre relative to the outline centre (m)
  vec2 dl = (gl_FragCoord.xy / vec2(${SHADOW_W}.0, ${SHADOW_H}.0) * 2.0 - 1.0) * vec2(uShU.w, uShV.w) - vCt.xy;
  float q = vQm.x * dl.x * dl.x + 2.0 * vQm.y * dl.x * dl.y + vQm.z * dl.y * dl.y;   // (|dl| / ellipse radius)^2
  float rho = uNearQuality > 1.5 ? nearShadowProfile(vProf, dl) : 1.0;
  // texels whose centre lies inside the (profiled) outline, and the texel holding the centre (sub-texel casters)
  if (q > rho * rho && any(notEqual(floor(gl_FragCoord.xy), floor(vCt.zw)))) discard;
  o = vRec;
  oProf = vProf;
}`;

export class NearShadow {
  readonly rt: WebGLRenderTarget;
  readonly uniforms: Record<string, IUniform>;
  enabled = true;
  /** first size class rendered into the map */
  firstClass = 10;
  /** the local mid-plane's slope at the camera (dz0/dx, dz0/dy; set by NearFieldPass from the ring structure) */
  readonly reliefSlope: [number, number] = [0, 0];
  private readonly eu = new Vector3();
  private readonly ev = new Vector3();

  constructor() {
    // attachment 0: caster records, 1: their outline relief profiles (same texel)
    this.rt = new WebGLRenderTarget(SHADOW_W, SHADOW_H, {
      count: 2,
      type: UnsignedIntType, format: RGBAIntegerFormat, internalFormat: 'RGBA32UI',
      minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
    });
    this.uniforms = {
      uShU: { value: new Vector4(1, 0, 0, SHADOW_U) },
      uShV: { value: new Vector4(0, 0, 1, 20) },
      uShInfo: { value: new Vector4(0.05, 0, 10, DEPTH_RANGE) },
      uShPen: { value: new Vector4(4.9e-4, 0.04, 0, 0) },
      tShadow: { value: this.rt.textures[0] },
      tShadowProf: { value: this.rt.textures[1] },
    };
  }

  /** Per-frame geometry of the map. Returns whether the map is used this frame. */
  configure(f: FrameState, lod: RingLod): boolean {
    const s = f.sunDir;
    const sz = s.z;
    const cosE = Math.sqrt(Math.max(1 - sz * sz, 0));
    const slab = 1.6 * lod.H + 0.5;
    // relief: the layer follows the local mid-plane z0; over the tube's footprint around the camera (the slab crossing
    // within ~slab / |sz| along the Sun) it rises or falls by ~|grad z0| times that distance (camera's slope)
    const g = Math.min(Math.hypot(this.reliefSlope[0], this.reliefSlope[1]), 2);
    const V0 = SHADOW_U * Math.abs(sz) + slab * cosE + 1.0;
    const V = V0 + g * (SHADOW_U + slab / Math.max(Math.abs(sz), 0.05)) * cosE;
    // the tube must intersect the particle slab near the camera (camera within ~V of the layer, relative to the local
    // mid-plane)
    const camZ = f.ring.camLocal.z - f.ring.zMid;
    const on = this.enabled && cosE > 0.02 && Math.abs(sz) > 0.005 && lod.active && Math.abs(camZ) * cosE < V + slab;
    const eu = this.eu.set(s.y, -s.x, 0); // s x z
    if (eu.lengthSq() < 1e-12) eu.set(1, 0, 0);
    eu.normalize();
    const ev = this.ev.set(-s.x * sz, -s.y * sz, 1 - sz * sz).normalize(); // z - s s_z
    const texel = Math.max((2 * SHADOW_U) / SHADOW_W, (2 * V) / SHADOW_H);
    // first class whose smallest particles span MIN_CASTER_TEXELS texels in radius
    let k0 = LOD_CLASSES;
    for (let k = 0; k < LOD_CLASSES; k++) {
      if (lod.slots[k] > 0 && LOD_A0 * 2 ** k >= MIN_CASTER_TEXELS * texel) { k0 = k; break; }
    }
    this.firstClass = k0;
    (this.uniforms.uShU.value as Vector4).set(eu.x, eu.y, eu.z, SHADOW_U);
    (this.uniforms.uShV.value as Vector4).set(ev.x, ev.y, ev.z, V);
    (this.uniforms.uShInfo.value as Vector4).set(texel, on ? 1 : 0, k0, DEPTH_RANGE);
    (this.uniforms.uShPen.value as Vector4).set(f.sunAngularRadius, MAX_BLUR_TEXELS * texel, 0, 0);
    return on;
  }

  /**
   * Allocate (and zero) the integer target once even if the map is never used: three.js binds a float
   * placeholder texture for a render target that was never rendered to, and an unsigned sampler on that is a
   * GL_INVALID_OPERATION that silently drops the particle draws (e.g. 1 km above the rings, map off).
   */
  prepare(r: WebGLRenderer): void {
    if (this.prepared) return;
    this.prepared = true;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.rt);
    r.state.buffers.color.setMask(true);
    (r.getContext() as WebGL2RenderingContext).clearBufferuiv(WebGL2RenderingContext.COLOR, 0, ZERO4);
    r.setRenderTarget(prev);
  }
  private prepared = false;

  render(r: WebGLRenderer, casters: Points, count: number): void {
    this.prepared = true;
    r.setRenderTarget(this.rt);
    r.clear(false, true, false);
    // records = 0 (empty) with a hardware clear (the renderer's clear colour is not 0 for integer targets)
    r.state.buffers.color.setMask(true);
    (r.getContext() as WebGL2RenderingContext).clearBufferuiv(WebGL2RenderingContext.COLOR, 0, ZERO4);
    (casters.geometry as BufferGeometry).setDrawRange(0, count);
    r.render(casters, fsCamera);
  }

  static casterMaterial(vs: string, fs: string, uniforms: Record<string, IUniform>): RawShaderMaterial {
    return new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: vs, fragmentShader: fs, uniforms,
      depthTest: true, depthWrite: true, depthFunc: LessEqualDepth, blending: NoBlending,
    });
  }

  dispose(): void {
    this.rt.dispose();
  }
}
