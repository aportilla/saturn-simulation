// ===== sv_ringProfile =======================================================================
// Access to the main-ring radial profile (D ring .. Roche Division) and the local Hill frame.
// Requires sv_common. See src/rings/RingProfile.ts for the texture layout.
#ifndef SV_RING_PROFILE
#define SV_RING_PROFILE

uniform sampler2D uRingTexA;  // (tauEff, H [m], Sigma [kg/m^2], wake 0..1)
uniform sampler2D uRingTexB;  // (albedo r, g, b, dust fraction)
uniform int uRingTexW;
uniform float uRingRMin;      // radius of level-0 sample 0 (m)
uniform float uRingDr0;       // level-0 sample spacing (m)
uniform int uRingLevels;
uniform int uRingLevelOff[16];
uniform int uRingLevelN[16];

// ---- local co-orbiting (Hill) frame — precise geometry near the camera
uniform float uRingR0;        // frame origin radius (m)
uniform float uRingIdx0;      // (uRingR0 - uRingRMin) / uRingDr0, computed in double precision on the CPU
uniform vec3 uRingER;         // unit radial axis (SEF)
uniform vec3 uRingEPhi;       // unit prograde azimuthal axis (SEF)
uniform vec3 uRingCamLocal;   // camera position in the local frame (m): x radial, y azimuthal, z north
uniform float uRingOmega;     // mean motion at r0 (rad/s)
uniform float uRingKappa;     // epicyclic frequency (rad/s)
uniform float uRingNu;        // vertical frequency (rad/s)
uniform float uRingQ;         // shear parameter (~1.5): v_y = -q Omega x

struct RingSample {
  float tau;     // normal optical depth
  float H;       // full layer thickness (m)
  float sigma;   // surface density (kg/m^2)
  float wake;    // self-gravity wake strength 0..1
  vec3 albedo;   // particle single-scattering albedo (linear RGB)
  float dust;    // fraction of tau in fine forward-scattering dust
};

ivec2 ringTexel(int i) { return ivec2(i % uRingTexW, i / uRingTexW); }

void ringFetchLevel(float fi0, int L, out vec4 a, out vec4 b) {
  float scale = exp2(float(L));
  float fi = (fi0 - 0.5 * (scale - 1.0)) / scale;
  int n = uRingLevelN[L];
  float c = clamp(fi, 0.0, float(n - 1));
  int i0 = int(floor(c));
  int i1 = min(i0 + 1, n - 1);
  float f = c - float(i0);
  int off = uRingLevelOff[L];
  a = mix(texelFetch(uRingTexA, ringTexel(off + i0), 0), texelFetch(uRingTexA, ringTexel(off + i1), 0), f);
  b = mix(texelFetch(uRingTexB, ringTexel(off + i0), 0), texelFetch(uRingTexB, ringTexel(off + i1), 0), f);
}

RingSample ringEmpty() {
  RingSample s;
  s.tau = 0.0; s.H = 10.0; s.sigma = 0.0; s.wake = 0.0; s.albedo = vec3(0.5); s.dust = 1.0;
  return s;
}

// Sample at a level-0 fractional index (sample centers at integers) with a radial footprint (m) used to
// pick the prefiltered level (0 = finest).
RingSample ringSampleIdx(float fi0, float footprint) {
  float nTot = float(uRingLevelN[0]);
  if (fi0 < -0.5 || fi0 > nTot - 0.5) return ringEmpty();
  float lev = clamp(log2(max(footprint, uRingDr0) / uRingDr0), 0.0, float(uRingLevels - 1));
  int L0 = int(floor(lev));
  int L1 = min(L0 + 1, uRingLevels - 1);
  float lf = lev - float(L0);
  vec4 a0, b0;
  ringFetchLevel(fi0, L0, a0, b0);
  if (lf > 0.001 && L1 != L0) {
    vec4 a1, b1;
    ringFetchLevel(fi0, L1, a1, b1);
    a0 = mix(a0, a1, lf);
    b0 = mix(b0, b1, lf);
  }
  RingSample s;
  s.tau = a0.x; s.H = a0.y; s.sigma = a0.z; s.wake = a0.w; s.albedo = b0.rgb; s.dust = b0.a;
  return s;
}
// Sample at an absolute radius r (m).
RingSample ringSample(float r, float footprint) { return ringSampleIdx((r - uRingRMin) / uRingDr0, footprint); }
float ringTau(float r) { return ringSample(r, 0.0).tau; }

// Camera-relative point -> local Hill-frame coordinates (m). Precise near the camera.
vec3 ringLocalFromRel(vec3 p) { return vec3(dot(p, uRingER), dot(p, uRingEPhi), p.z) + uRingCamLocal; }
// Radius offset (m) from r0 for a local-frame point, without catastrophic cancellation.
float ringDrFromLocal(vec3 l) {
  float X = l.x, Y = l.y;
  return (2.0 * uRingR0 * X + X * X + Y * Y) / (sqrt((uRingR0 + X) * (uRingR0 + X) + Y * Y) + uRingR0);
}
// Level-0 fractional profile index for a local-frame point (precise).
float ringIdxFromLocal(vec3 l) { return uRingIdx0 + ringDrFromLocal(l) / uRingDr0; }
// Radius (m) of a camera-relative point (coarse; any distance).
float ringRadiusRel(vec3 p) { return length((p + uCamPos).xy); }
// SEF height above the ring plane (m) of a camera-relative point (precise when the camera is near the plane).
float ringHeightRel(vec3 p) { return p.z + uCamPos.z; }

// Direct-sunlight transmission through the MAIN rings (thin-sheet approximation) for a camera-relative
// point p. footprint (m) prefilters the radial structure (pass 0 for full resolution).
float ringSunTransmission(vec3 p, float footprint) {
  float zs = p.z + uCamPos.z;
  float sz = uSunDir.z;
  if (abs(sz) < 1e-6 || zs * sz >= 0.0) return 1.0;
  float t = -zs / sz;
  vec3 h = p + t * uSunDir;
  float r = length((h + uCamPos).xy);
  float tau = ringSample(r, footprint).tau;
  return exp(-tau / abs(sz));
}

#endif
