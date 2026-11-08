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
#define NS_ORI   17u  // initial orientation (3 streams)
#define NS_TEX   20u  // surface texture seed

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
// Triaxial ellipsoid semi-axes (units of the equivalent radius a). The axes are scaled so that the
// orientation-averaged projected area (= surface area / 4, Cauchy) equals pi a^2: an ensemble then has
// exactly the optical depth of spheres of radius a (the LOD / medium contract). Below high quality: spheres.
vec3 nearShape(uint idx, uint seed) {
  if (uNearQuality < 1.5) return vec3(1.0);
  float b = 1.0 - 0.30 * nearU(idx, seed, NS_SHB);
  float c = b * (1.0 - 0.25 * nearU(idx, seed, NS_SHC));
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
// Body -> world (inertial SEF) orientation at spin phase W = (Omega/8)(t - tRef) mod 2pi.
// Spin rates are integer multiples of Omega/8 so that the phase is exact for any sim time.
// Large particles spin slowly (~Omega/2, axes near the orbit normal, the local flow vorticity);
// small ones faster and with random axes.
vec4 nearOrientation(uint idx, uint seed, float a, float W) {
  float u1 = nearU(idx, seed, NS_ORI), u2 = nearU(idx, seed, NS_ORI + 1u), u3 = nearU(idx, seed, NS_ORI + 2u);
  vec4 q0 = vec4(sqrt(1.0 - u1) * sin(TWO_PI * u2), sqrt(1.0 - u1) * cos(TWO_PI * u2), sqrt(u1) * sin(TWO_PI * u3), sqrt(u1) * cos(TWO_PI * u3));
  float cz = 2.0 * nearU(idx, seed, NS_SAX) - 1.0, ph = TWO_PI * nearU(idx, seed, NS_SAX + 1u);
  vec3 rnd = vec3(sqrt(max(0.0, 1.0 - cz * cz)) * vec2(cos(ph), sin(ph)), cz);
  float align = 0.85 * smoothstep(0.05, 1.0, a);
  vec3 ax = normalize(mix(rnd, vec3(0.0, 0.0, 1.0), align) + 1e-6);
  float wTyp = min(30.0, 0.5 + 0.1 / a);                       // typical |spin| / Omega
  float n = max(1.0, floor(8.0 * wTyp * (0.4 + 1.2 * nearU(idx, seed, NS_SRATE)) + 0.5));
  float ang = n * W + TWO_PI * nearU(idx, seed, NS_SPH);
  return nearQuatMul(nearQuatAxisAngle(ax, ang), q0);
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
