// ===== near-field particle attributes =========================================================
// Every static per-particle attribute is a deterministic hash of (class seed, particle index), so the
// update pass and the draw passes derive identical values without storing them. Requires sv_common.

#define NS_XG    0u   // guiding-center radial offset in the box
#define NS_RAD   1u   // radius within the size class (power law)
#define NS_EA    2u   // epicycle amplitude (Rayleigh)
#define NS_EP    3u   // epicycle phase
#define NS_VA    4u   // vertical amplitude (Rayleigh)
#define NS_VP    5u   // vertical phase
#define NS_PRES  6u   // presence threshold (tau thinning)
#define NS_LOD   7u   // LOD draw threshold
#define NS_Y0    8u   // initial azimuthal guiding center
#define NS_SAX   9u   // spin axis (2 streams)
#define NS_SRATE 11u  // spin rate
#define NS_SPH   12u  // spin phase
#define NS_SHB   13u  // shape axis ratio b
#define NS_SHC   14u  // shape axis ratio c
#define NS_ALB   15u  // albedo factor (2 streams)
#define NS_ORI   17u  // (unused since the principal-axis rotation: 3 streams kept free)
#define NS_TEX   20u  // surface texture seed (relief texture offsets)
#define NS_REL   21u  // relief: clast-weight variation

uint nearHash(uint idx, uint seed, uint stream) {
  return pcgHash(pcgHash(idx ^ (seed * 0x9E3779B9u)) + stream * 0x85EBCA6Bu);
}
// uniform in (0, 1), never exactly 0 or 1
float nearU(uint idx, uint seed, uint stream) {
  return (float(nearHash(idx, seed, stream) >> 8u) + 0.5) * (1.0 / 16777216.0);
}
uniform float uNearQuality;   // render fidelity: 0 low, 1 medium (spheres), 2 high (lumpy ellipsoids)

// Radius a and own box half-size D (m) of a slot of a size class (src/rings/RingLod.ts buildPieces). Each
// particle lives in a shearing-periodic box of half-size D(a) (its horizontal reach to the handover band), so
// the slots sample n(a) D(a)^2: piecewise power laws, piece i covering [x0, x1] with slot density ~ a^(p-q) and
// box D1 (a/x1)^(p/2). u (uniform in (0,1)) picks the piece by its cumulative share, then the inverse CDF.
#define NEAR_PIECES 6
uniform vec4 uRadP[NEAR_PIECES];  // (x1, 1/E (0: log-uniform), (x0/x1)^E (log-uniform: ln(x0/x1)), cum. share), E = p-q+1
uniform vec4 uRadB[NEAR_PIECES];  // (D1 = box half-size at x1 (m), p/2, x0, -)
void nearRadiusBox(float u, out float a, out float D) {
  int i = 0;
  float u0 = 0.0;
  for (int j = 0; j < NEAR_PIECES - 1; j++) {
    if (u < uRadP[j].w) break;
    u0 = uRadP[j].w;
    i = j + 1;
  }
  vec4 P = uRadP[i];
  float t = clamp((u - u0) / max(P.w - u0, 1e-30), 0.0, 1.0);
  float s = P.y != 0.0 ? pow(mix(P.z, 1.0, t), P.y) : exp((1.0 - t) * P.z);   // a / x1
  a = P.x * s;
  D = max(uRadB[i].x * pow(s, uRadB[i].y), 0.05);
}
// Alignment of the spin axis with the orbit normal (0 = random .. 0.85): large particles (nearSpinAxis)
float nearSpinAlign(float a) { return 0.85 * smoothstep(0.05, 1.0, a); }
// Triaxial ellipsoid semi-axes (units of the equivalent radius a; z = the short axis = the spin axis). The axes
// are scaled so that the orientation-averaged projected area (= surface area / 4, Cauchy) equals pi a^2: an
// ensemble then has exactly the optical depth of spheres of radius a (the LOD / medium contract).
// Isotropy: a body spinning about its short axis presents more area along the spin axis than across it, so
// with the near-vertical spin axes of large particles the cross-section would depend on the view elevation
// (x 1.14 from above, x 0.92 edge-on for a >= 1 m with the full axis spread), which the isotropic medium cannot
// follow. The asphericity of the aligned particles is therefore reduced by NR_ISO x their alignment (their
// irregularity comes from the relief, isotropic in the mean); the planned direction-dependent LOD contract
// (with the tidal-alignment hook in nearOrientation) can restore it (NR_ISO 0). Below high quality: spheres.
#define NR_ISO 0.8
vec3 nearShape(uint idx, uint seed, float a) {
  if (uNearQuality < 1.5) return vec3(1.0);
  float sp = 1.0 - NR_ISO * nearSpinAlign(a) * (1.0 / 0.85);
  float b = 1.0 - 0.30 * sp * nearU(idx, seed, NS_SHB);
  float c = b * (1.0 - 0.25 * sp * nearU(idx, seed, NS_SHC));
  const float P = 1.6075; // Knud Thomsen surface-area approximation
  float bp = pow(b, P), cp = pow(c, P);
  float m = pow((bp * cp + bp + cp) / 3.0, 1.0 / P);
  return inversesqrt(m) * vec3(1.0, b, c);
}
// Albedo multiplier, log-normal with mean 1 (sigma 0.12): particle-to-particle variation.
float nearAlbedoFactor(uint idx, uint seed) {
  float u1 = nearU(idx, seed, NS_ALB), u2 = nearU(idx, seed, NS_ALB + 1u);
  float g = sqrt(-2.0 * log(u1)) * cos(TWO_PI * u2);
  return exp(0.12 * g - 0.0072);
}
// Quaternion helpers (x, y, z, w)
vec4 nearQuatAxisAngle(vec3 ax, float ang) { return vec4(ax * sin(0.5 * ang), cos(0.5 * ang)); }
vec4 nearQuatMul(vec4 a, vec4 b) {
  return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}
vec3 nearQRot(vec4 q, vec3 v) { vec3 t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
vec3 nearQRotInv(vec4 q, vec3 v) { return nearQRot(vec4(-q.xyz, q.w), v); }
// rotation taking +z to the unit vector d (shortest arc; a half turn about x for d = -z)
vec4 nearQuatFromZ(vec3 d) {
  float w = 1.0 + d.z;
  return w < 1e-6 ? vec4(1.0, 0.0, 0.0, 0.0) : normalize(vec4(-d.y, d.x, 0.0, w));
}
// Spin axis (world, SEF): large particles near the orbit normal (the local flow vorticity, prograde), small
// ones random (collisions randomize them).
vec3 nearSpinAxis(uint idx, uint seed, float a) {
  float cz = 2.0 * nearU(idx, seed, NS_SAX) - 1.0, ph = TWO_PI * nearU(idx, seed, NS_SAX + 1u);
  vec3 rnd = vec3(sqrt(max(0.0, 1.0 - cz * cz)) * vec2(cos(ph), sin(ph)), cz);
  return normalize(mix(rnd, vec3(0.0, 0.0, 1.0), nearSpinAlign(a)) + 1e-6);
}
// Spin angle at spin phase W = (Omega/8)(t - tRef) mod 2pi: rates are integer multiples of Omega/8 so that the
// angle is exact for any sim time; large particles spin slowly (~Omega/2), small ones faster.
float nearSpinAngle(uint idx, uint seed, float a, float W) {
  float wTyp = min(30.0, 0.5 + 0.1 / a);                       // typical |spin| / Omega
  float n = max(1.0, floor(8.0 * wTyp * (0.4 + 1.2 * nearU(idx, seed, NS_SRATE)) + 0.5));
  return n * W + TWO_PI * nearU(idx, seed, NS_SPH);
}
// Body -> world (inertial SEF) orientation. Principal-axis (stable) rotation: every particle spins about its
// shortest body axis (z: nearShape gives c <= b <= 1), the axis of maximum moment of inertia - collisions and
// internal friction damp any other (tumbling) state. The body x axis starts at a random azimuth about the spin
// axis (random spin phase).
// HOOK - tidal alignment (planned with the direction-dependent LOD contract; NOT active): large aggregates
// elongated toward Saturn would replace the free spin angle by the synchronous one, the body x axis kept near
// the local radial direction uRingER about the spin axis plus a libration (spin rate = Omega): a term
//   ang = mix(ang, atan(dot(cross(xAxis0, uRingER), ax), dot(xAxis0, uRingER)) + libration(t), tidal(a))
// with xAxis0 = nearQRot(qa, vec3(1,0,0)), applied right below.
vec4 nearOrientation(uint idx, uint seed, float a, float W) {
  vec3 ax = nearSpinAxis(idx, seed, a);
  vec4 qa = nearQuatFromZ(ax);                 // body z -> spin axis
  float ang = nearSpinAngle(idx, seed, a, W);  // (tidal-alignment hook: modify ang here)
  return nearQuatMul(nearQuatAxisAngle(ax, ang), qa);
}

// ---- surface relief (high particle quality) ---------------------------------------------------------------
// A particle's surface is r(u) = kappa (1 + amp h(u)) in its axis-scaled body frame (the base ellipsoid of
// nearShape is the unit sphere there), u = unit direction. h (units of the radius) = two cellular "clast" layers
// (sub-aggregates of a rubble pile / clumped snowball: union-of-spheres domes with creases), weighted by the
// particle size (wc: none below ~10 cm, full above ~0.7 m), plus two gradient-noise layers (overall
// irregularity, regolith lumps); a third noise layer and absolute-scale regolith texture only tilt the shading
// normal. The same field gives the ray-marched outline (nearDraw.frag.glsl), the shading normal and the
// caster outlines of the shadow map (NearShadow.ts). amp fades the geometric relief in with the on-screen size
// (NR_PX0 .. NR_PX1 render px radius; below: analytic ellipsoid with the relief as a normal perturbation), and
// kappa(amp, wc) renormalizes the size so that the orientation-averaged projected area stays pi a^2 (the LOD /
// medium contract; coefficients measured with the CPU mirror, src/render/near/NearRelief.ts, which reads the
// constants below from this file).
uniform highp sampler3D tNearNoise;   // periodic gradient noise (value, gradient), period 16 (NearNoise.ts)
uniform highp sampler3D tNearClast;   // periodic cellular clast field (value, gradient), period 8 (NearNoise.ts)
uniform highp sampler3D tNearNoiseV;  // the same fields, value only (R16F: ray march, outline profiles)
uniform highp sampler3D tNearClastV;
uniform vec4 uNearRelief;             // value range of the two textures: (clast min, clast max, noise min, noise max)
#define NR_FN1 1.3     // overall irregularity: frequency (lattice units per radius), amplitude (radii)
#define NR_AN1 0.075
#define NR_FC1 2.2     // clasts (sub-aggregates ~0.4 radii across)
#define NR_AC1 0.045
#define NR_FN2 3.6     // regolith lumps
#define NR_AN2 0.028
#define NR_FC2 5.6     // small clasts
#define NR_AC2 0.018
#define NR_FN3 10.0    // shading-only detail
#define NR_AN3 0.012
#define NR_WC0 0.08    // clast weight: smoothstep(NR_WC0, NR_WC1, a) x (0.55 .. 1)
#define NR_WC1 0.7
#define NR_PX0 12.0    // geometric relief fades in between these radii (render px)
#define NR_PX1 22.0
// kappa^-2 = 1 + amp (NR_K0 + NR_K1 wc) + amp^2 (NR_K2 + NR_K3 wc)  (measured: scripts/test/particles.mjs)
#define NR_K0 -0.0035
#define NR_K1 0.0279
#define NR_K2 0.0067
#define NR_K3 0.0338
vec4 nearNoiseT(vec3 x) { return textureLod(tNearNoise, x * 0.0625, 0.0); }
vec4 nearClastT(vec3 x) { return textureLod(tNearClast, x * 0.125, 0.0); }
float nearNoiseV(vec3 x) { return textureLod(tNearNoiseV, x * 0.0625, 0.0).x; }
float nearClastV(vec3 x) { return textureLod(tNearClastV, x * 0.125, 0.0).x; }
// per-particle relief parameters: texture offset (xyz, lattice units) and clast weight (w)
vec4 nearReliefParams(uint idx, uint seed, float a) {
  uint h = nearHash(idx, seed, NS_TEX);
  vec3 so = vec3(float(h & 1023u), float((h >> 10u) & 1023u), float((h >> 21u) & 1023u)) * (16.0 / 1024.0);
  return vec4(so, smoothstep(NR_WC0, NR_WC1, a) * (0.55 + 0.45 * nearU(idx, seed, NS_REL)));
}
// h and its (ambient) gradient dh/du at the unit direction u. layers: 2 = coarse (irregularity + clasts),
// 3 = + regolith lumps, 4 = every geometric layer (+ small clasts), 5 = + the shading-only detail layer.
vec4 nearRelief(vec3 u, vec4 rp, int layers) {
  vec4 n1 = nearNoiseT(u * NR_FN1 + rp.xyz);
  vec4 h = NR_AN1 * vec4(n1.x, n1.yzw * NR_FN1);
  if (rp.w > 0.0) {
    vec4 c1 = nearClastT(u * NR_FC1 + rp.yzx * 0.5);
    h += (rp.w * NR_AC1) * vec4(c1.x, c1.yzw * NR_FC1);
  }
  if (layers >= 3) {
    vec4 n2 = nearNoiseT(u * NR_FN2 + rp.zxy + 5.3);
    h += NR_AN2 * vec4(n2.x, n2.yzw * NR_FN2);
  }
  if (layers >= 4 && rp.w > 0.0) {
    vec4 c2 = nearClastT(u * NR_FC2 + rp.xyz * 0.5 + 2.7);
    h += (rp.w * NR_AC2) * vec4(c2.x, c2.yzw * NR_FC2);
  }
  if (layers >= 5) {
    vec4 n3 = nearNoiseT(u * NR_FN3 + rp.yzx + 9.1);
    h += NR_AN3 * vec4(n3.x, n3.yzw * NR_FN3);
  }
  return h;
}
// h alone (value-only textures), geometric layers 2..4 as nearRelief: the ray march and the outline profiles
float nearReliefH(vec3 u, vec4 rp, int layers) {
  float h = NR_AN1 * nearNoiseV(u * NR_FN1 + rp.xyz);
  if (rp.w > 0.0) h += (rp.w * NR_AC1) * nearClastV(u * NR_FC1 + rp.yzx * 0.5);
  if (layers >= 3) h += NR_AN2 * nearNoiseV(u * NR_FN2 + rp.zxy + 5.3);
  if (layers >= 4 && rp.w > 0.0) h += (rp.w * NR_AC2) * nearClastV(u * NR_FC2 + rp.xyz * 0.5 + 2.7);
  return h;
}
// Absolute-scale regolith texture (shading normal only): embedded pebbles / small aggregates (NR_LP cells) and
// grain clumps (NR_LG cells), both granular (cellular field), rms slopes NR_SP / NR_SG (amplitude = slope / (rms
// gradient of the texture, 6.0 per lattice unit, x frequency)), each faded in where its features span >= 2-4 px
// (fp: pixel footprint on the surface, m) and where the particle (radius aM, m) is >= 3-6 features across.
// Returns (value, gradient) like nearRelief.
#define NR_LP 0.04
#define NR_SP 0.25
#define NR_LG 0.01
#define NR_SG 0.15
vec4 nearRegolithTexture(vec3 u, vec4 rp, float aM, float fp) {
  vec4 g = vec4(0.0);
  float fP = aM * (1.0 / NR_LP);
  float wP = smoothstep(2.0, 4.0, NR_LP / fp) * smoothstep(3.0, 6.0, fP);
  if (wP > 0.0) {
    vec4 c = nearClastT(u * fP + rp.zxy * 0.5 + 4.1);
    g += (wP * NR_SP / (6.0 * fP)) * vec4(c.x, c.yzw * fP);
  }
  float fG = aM * (1.0 / NR_LG);
  float wG = smoothstep(2.0, 4.0, NR_LG / fp) * smoothstep(3.0, 6.0, fG);
  if (wG > 0.0) {
    vec4 c = nearClastT(u.yzx * fG + rp.yzx * 0.5 + 6.3);
    g += (wG * NR_SG / (6.0 * fG)) * vec4(c.x, c.wyz * fG);
  }
  return g;
}
// bound of |grad h| over the geometric layers (Lipschitz constant of the march), from the texture gradient ranges
uniform vec2 uNearReliefGrad;   // (max |gradient| of the noise texture, of the clast texture) per lattice unit
float nearReliefSlope(float wc, int layers) {
  float s = NR_AN1 * NR_FN1 * uNearReliefGrad.x + wc * NR_AC1 * NR_FC1 * uNearReliefGrad.y;
  if (layers >= 3) s += NR_AN2 * NR_FN2 * uNearReliefGrad.x;
  if (layers >= 4) s += wc * NR_AC2 * NR_FC2 * uNearReliefGrad.y;
  return s;
}
// exact bounds of h over the geometric layers (textures: trilinear samples lie within the texel range)
vec2 nearReliefBounds(float wc) {
  return vec2((NR_AN1 + NR_AN2) * uNearRelief.z + wc * (NR_AC1 + NR_AC2) * uNearRelief.x,
              (NR_AN1 + NR_AN2) * uNearRelief.w + wc * (NR_AC1 + NR_AC2) * uNearRelief.y);
}
float nearKappa(float amp, float wc) {
  return inversesqrt(max(1.0 + amp * (NR_K0 + NR_K1 * wc) + amp * amp * (NR_K2 + NR_K3 * wc), 0.25));
}
// geometric relief amplitude for a particle whose base bounding radius spans rho render px (0 below high quality)
float nearReliefAmp(float rho) { return uNearQuality > 1.5 ? smoothstep(NR_PX0, NR_PX1, rho) : 0.0; }
// Photometric correction of the resolved relief (NearRelief.ts RELIEF_PHOT): relief normals and resolved
// self-shadowing change a body's disk-integrated brightness (e.g. x 0.75 at 120 deg for a marched clumpy
// boulder), but that roughness is already part of the power-law phase function the factor imposes; this
// factor undoes it. Table [path: analytic + relief normals, ray-marched][clast weight 0, 0.5, 1][phase angle 0,
// 20 .. 180 deg], mixed between the paths by the relief amplitude (continuous at the fade-in).
uniform float uNearReliefPhot[60];
float nearReliefPhotFix(float alpha, float wc, float amp) {
  float x = clamp(alpha * (9.0 / PI), 0.0, 8.999);
  int i = int(x);
  float fx = x - float(i);
  float y = clamp(wc * 2.0, 0.0, 1.999);
  int j = int(y);
  float fy = y - float(j);
  float r[2];
  for (int p = 0; p < 2; p++) {
    int b0 = (p * 3 + j) * 10 + i, b1 = b0 + 10;
    r[p] = mix(mix(uNearReliefPhot[b0], uNearReliefPhot[b0 + 1], fx), mix(uNearReliefPhot[b1], uNearReliefPhot[b1 + 1], fx), fy);
  }
  return mix(r[0], r[1], amp);
}
// radial bounds of the (displaced) body relative to the base ellipsoid: (inner, outer) = kappa (1 + amp h)
vec2 nearReliefShell(float amp, float wc) {
  vec2 hb = nearReliefBounds(wc);
  float k = nearKappa(amp, wc);
  return k * (1.0 + amp * hb);
}
// largest radial extent of any particle shape relative to its equivalent radius a (ellipsoid major semi-axis
// <= 1.36 a, times the outer relief bound at full amplitude and clast weight): tube / culling margins
float nearMaxExtent() { return uNearQuality > 1.5 ? 1.37 * nearReliefShell(1.0, 1.0).y : 1.0; }

// ---- regolith photometry of resolved particles (ringRegolithIF in sv_lighting; NearRegolith.ts) -------------
uniform sampler2D tRegolithF;   // (P_power / (4 Phi_w), w, A_s, -) by (phase angle / pi, particle albedo)
uniform vec4 uRegolithLut;      // (columns NA, rows NALB, albedo of the first row, of the last row)
// Per-particle factor f (incl. the opposition surge) that makes a regolith sphere's disk-integrated phase
// function exactly ringParticlePhase, and the grain albedo w for ringRegolithIF, at phase angle cos(alpha)
// for a particle of albedo A. Rows at A0 + (A1 - A0) y^2 (denser at low albedo, where w(A) is steep).
vec2 nearRegolithFactor(float cosAlpha, float A) {
  float al = acos(clamp(cosAlpha, -1.0, 1.0));
  float y = sqrt(clamp((A - uRegolithLut.z) / (uRegolithLut.w - uRegolithLut.z), 0.0, 1.0));
  vec2 uv = vec2((al * INV_PI * (uRegolithLut.x - 1.0) + 0.5) / uRegolithLut.x, (y * (uRegolithLut.y - 1.0) + 0.5) / uRegolithLut.y);
  vec2 t = texture(tRegolithF, uv).xy;
  return vec2(t.x * ringParticleSurge(al), t.y);
}

// Multiple scattering inside the layer: two-stream (hemispheric-mean) diffuse fluxes of a homogeneous
// layer of normal optical depth tau and single-scattering albedo w, lit by a unit beam (irradiance normal to
// the beam) at mu0 on one face; t = normal optical depth below the lit face. beta = diffuse back-scatter
// fraction, beta0 = beam back-scatter fraction (from the Lambert-sphere phase function). Boundary: no diffuse
// light enters either face. Returns the diffuse irradiance arriving from the lit-face side (Flit) and from
// the dark-face side (Fdark), per colour channel. Light scattered once by OTHER particles is included, so a
// particle lit by these fluxes contributes the 2nd+ scattering orders (as in the ring-layer medium).
void nearTwoStream(float t, float tau, vec3 w, float beta, float beta0, float mu0, out vec3 Flit, out vec3 Fdark) {
  vec3 a = 2.0 * (1.0 - w * (1.0 - beta));
  vec3 b = max(2.0 * w * beta, vec3(1e-5));
  vec3 lam = sqrt(max(a * a - b * b, vec3(1e-8)));
  float k = 1.0 / max(mu0, 0.02);
  vec3 D = lam * lam - k * k;
  D = mix(D, vec3(-1e-3), lessThan(abs(D), vec3(1e-3)));     // stay off the lam = k resonance
  vec3 sd = w * (1.0 - beta0), su = w * beta0;
  vec3 U = (sd * (a + k) + b * su) / D;
  vec3 V = ((a - k) * su + b * sd) / D;
  vec3 r = (a - lam) / b;
  vec3 e = exp(-lam * tau);
  float ek = exp(-k * tau);
  vec3 C2 = (U * r * e - V * ek) / (1.0 - r * r * e * e);
  vec3 C1 = -U - C2 * r * e;
  vec3 e1 = exp(-lam * t), e2 = exp(-lam * max(tau - t, 0.0));
  float et = exp(-k * t);
  Flit = max(C1 * e1 + C2 * r * e2 + U * et, vec3(0.0));
  Fdark = max(C1 * r * e1 + C2 * e2 + V * et, vec3(0.0));
}
// (surface noise: precomputed periodic gradient-noise texture, see NearNoise.ts / nearDraw.frag.glsl)
