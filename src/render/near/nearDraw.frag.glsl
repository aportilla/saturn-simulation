// ===== near-field draw: fragment stage ======================================================
// Sub-render-pixel particles: flat disc of half a render pixel with the disc-averaged radiance (per particle).
// Resolved particles: exact ray / triaxial-ellipsoid intersection in the spinning body frame (spheres below
// high quality), lumpy aggregate surface at high quality (gradient-noise normal perturbation + albedo
// patchiness, octaves by on-screen size),
// Lambert shading rescaled to the power-law particle phase function (ringParticleLambertFactor), shadows of
// the nearby particles from their analytic outlines (NearShadow.ts: edges smoothed over the physical
// penumbra or one pixel, whichever is larger), two-stream multiply-scattered ring light, exact depth.
flat in vec4 vC;
flat in vec4 vQ;
flat in vec4 vAx;
flat in vec4 vAlb;
flat in vec4 vE;
flat in vec4 vSS;
flat in vec4 vTiny;
flat in vec2 vT;
flat in vec3 vFl;
flat in vec3 vFd;

uniform int uDebug;
uniform vec2 uNearBeta;   // (diffuse back-scatter fraction, beam back-scatter fraction at mu0)
uniform highp sampler3D tNearNoise;   // periodic gradient noise (value, gradient), 16 lattice units per period
vec4 nearNoiseT(vec3 x) { return texture(tNearNoise, x * (1.0 / 16.0)); }

layout(location = 0) out vec4 outColor;

void main() {
  if (vC.w > 0.5) {
    // sub-render-pixel particle: flat disc of half a render pixel (rasterized with probability (rho/0.5)^2)
    vec2 pc = (gl_PointCoord - 0.5) * vAx.w;
    if (dot(pc, pc) > 0.25) discard;
    outColor = vec4(vTiny.rgb, length(vC.xyz));
    if (uDebug == 15) { float W = wakeDensity(ringLocalFromRel(vC.xyz).xy); outColor.rgb = W > 1.0 ? vec3(1.0, 0.1, 0.1) : vec3(0.1, 0.2, 1.0); }
    gl_FragDepth = logDepth01(vTiny.w);
    return;
  }
  vec3 rd = cameraRayDir(gl_FragCoord.xy / uResolution);
  vec3 c = vC.xyz;
  // ray relative to its point of closest approach to the center (no cancellation for small, distant particles)
  float b = dot(c, rd);
  vec3 o = b * rd - c;
  vec3 ob = nearQRotInv(vQ, o) / vAx.xyz;
  vec3 db = nearQRotInv(vQ, rd) / vAx.xyz;
  float A = dot(db, db), Bh = dot(ob, db), C = dot(ob, ob) - 1.0;
  float disc = Bh * Bh - A * C;
  if (disc < 0.0) discard;
  float tl = (-Bh - sqrt(disc)) / A;
  float t = b + tl;
  if (t <= 1e-3) discard;
  vec3 pb = ob + tl * db;                 // hit point, unit-sphere (body, axis-scaled) coordinates
  vec3 nb = normalize(pb / vAx.xyz);      // ellipsoid normal (body frame)

  // lumpy aggregate surface: a few octaves of gradient noise on the body-fixed unit sphere
  uint ts = uint(vAlb.w * 8388608.0);
  vec3 sp = normalize(pb);
  // height field h = 0.11 n(2 p) + 0.045 n(5 p) + 0.018 n(12 p) (units of the radius): knobbly aggregate
  // surface detail level by on-screen size (vAx.w = sprite size in px; large for quads): the octaves are
  // only evaluated where they can be seen
  vec4 n1 = vec4(0.0), n2 = vec4(0.0), n3 = vec4(0.0);
  float spx = vAx.w;
  if (uDebug != 31 && uNearQuality > 1.5) {
    vec3 so = vec3(float(ts & 1023u), float((ts >> 10u) & 1023u), float((ts >> 20u) & 1023u)) * (16.0 / 1024.0);
    if (spx > 7.0) n1 = nearNoiseT(sp * 2.0 + so);
    if (spx > 16.0) n2 = nearNoiseT(sp * 5.0 + so.yzx + 3.7);
    if (spx > 48.0) n3 = nearNoiseT(sp * 12.0 + so.zxy + 9.1);
  }
  vec3 g = 0.22 * n1.yzw + 0.225 * n2.yzw + 0.216 * n3.yzw;
  g -= dot(g, nb) * nb;
  vec3 nbb = normalize(nb - g);
  float albPatch = 1.0 + 0.08 * n2.x + 0.05 * n3.x;
  vec3 n = nearQRot(vQ, nbb);
  vec3 ng = nearQRot(vQ, nb);
  vec3 hit = rd * t;

  float ndl = dot(n, uSunDir);
  float sunLit = ndl > 0.0 && dot(ng, uSunDir) > -0.1 ? ndl : 0.0;
  float T = vT.x;
  float shDbg = 1.0;
  // footprint of one pixel on the surface (its projection onto the sun plane is never larger): shadow edges
  // are smoothed over max(physical penumbra, this) - no aliasing, no unphysical blur
  float rpx = 0.5 * t * uPixelAngle / max(abs(dot(ng, rd)), 0.3);
  // debug 19-22 (raw lookups): 19 at the hit point regardless of the Lambert term; 20-22 at points 1 km
  // downsun (shadowed wherever a caster outline covers it), 1 km sunward (never shadowed), 50 m sunward
  float dOff = uDebug == 20 ? -1000.0 : (uDebug == 21 ? 1000.0 : (uDebug == 22 ? 50.0 : 0.0));
  bool dbgSh = uDebug >= 19 && uDebug <= 22;
  // (vE.z = 0: the VS found even unshadowed direct sunlight negligible here; one call site keeps the
  // inlined lookup code small)
  if (((sunLit > 0.0 && vE.z > 0.5) || dbgSh) && vSS.w > 0.0) {
    // analytic shadow outlines of the nearby casters at the exact hit point (the particle itself excluded)
    float sh = nearShadowVisibility(hit + uSunDir * dOff, dOff != 0.0 ? vec3(1e9) : c, rpx);
    T = mix(vT.x, vT.y * sh, vSS.w);
    shDbg = sh;
  }
  float ndS = dot(n, vSS.xyz);
  float ssLit = clamp((ndS + 0.15) / 1.15, 0.0, 1.0);
  // multiply-scattered ring light from the two half-spaces (toward the lit face / toward the dark face); the
  // normal weighting 1.5 (2 beta - 1) makes the disk average back-scatter the fraction beta, like the medium
  float cl = 1.5 * (2.0 * uNearBeta.x - 1.0) * (uSunDir.z >= 0.0 ? 1.0 : -1.0) * n.z;
  vec3 Ed = vFl * (0.5 + 0.5 * cl) + vFd * (0.5 - 0.5 * cl);
  vec3 col = vAlb.rgb * albPatch * INV_PI * (vE.x * T * sunLit * vE.w + vE.y * ssLit + Ed);
  if (uDebug == 11) col = vec3(T, sunLit, vSS.w) * 0.5;
  // lighting-term debug views (radiance-scaled so a sunlit albedo-0.5 surface would be ~2.4)
  if (uDebug == 12) col = vec3(vE.x * T / uSunE) * 2.4;             // direct-sun factor (visibility x layer transmission)
  if (uDebug == 13) col = vec3(0.5 * INV_PI * vE.y * ssLit) * 4.0;  // Saturnshine term (x4)
  if (uDebug == 14) col = 0.5 * INV_PI * Ed * 4.0;                  // multiply-scattered ring light (x4)
  if (uDebug == 15) { float W = wakeDensity(ringLocalFromRel(c).xy); col = W > 1.0 ? vec3(1.0, 0.1, 0.1) : vec3(0.1, 0.2, 1.0); }
  // shadow-map consistency: on sunlit fragments inside the tube, R = T_part * map visibility, G = T_full
  if (uDebug == 17) col = (sunLit > 0.0 && vSS.w > 0.99) ? vec3(vT.y * shDbg, vT.x, 1.0) : vec3(0.0);
  if (dbgSh) {
    // raw map visibility: white lit, red shadowed, blue outside the tube (19: dimmed on faces turned away)
    col = vSS.w < 0.5 ? vec3(0.0, 0.0, 0.5) : mix(vec3(0.6, 0.0, 0.0), vec3(1.0), shDbg);
    if (uDebug == 19 && dot(ng, uSunDir) < 0.0) col *= 0.3;
  }
  outColor = vec4(col, t);
  gl_FragDepth = logDepth01(t * max(-(uWorldToCam * rd).z, 1e-4));
}
