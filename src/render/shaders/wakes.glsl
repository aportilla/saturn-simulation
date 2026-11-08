// ===== sv_wakes =============================================================================
// Procedural self-gravity wakes (see src/rings/WakeField.ts for the model). Coordinates are local
// Hill-frame (x radial, y azimuthal) in meters relative to the ring-frame anchor (sv_ringProfile).
// Requires sv_common.
//
//   vec2  wakeDisplacement(vec2 q)  displacement (m) of a particle whose undisplaced (epicyclic) position is q
//   float wakeDensity(vec2 x)       Eulerian surface-density factor at x (mean 1; gamma^s .. gamma^-s), with the
//                                   mass correction uWakeMassK of the single-branch inverse (wakeDensityRaw)
//   float wakeDensityFiltered(vec2 x, float footprint)   same, contrast faded out when the footprint (m)
//                                   approaches the wake spacing (anti-aliasing for distant views)
//   float wakeMinDensity()          lower bound of wakeDensity() for the current pattern (for culling)
#ifndef SV_WAKES
#define SV_WAKES

#define WAKE_M0X 3.0
#define WAKE_M0Y 6.0

uniform sampler2D uWakeTex;   // RGBA: smooth complex envelopes (ReA, ImA, ReB, ImB), periodic, mean |W|^2 = 1
uniform float uWakeTile;      // tile size L (m)
uniform vec4 uWakeGen[3];     // [0] older, [1] younger generation: (amplitude s_g, shear S_g, offsetU, offsetV)
uniform vec3 uWakeSel;        // per generation: 0 -> field A (xy), 1 -> field B (zw)
uniform float uWakeOn;        // 0 / 1
uniform vec4 uWakeShape;      // (ln gamma, 1/Rc^2, min density factor, max density factor)
uniform float uWakeMassK;     // mass correction of the dense part (wakeDensity), measured by the ring-layer pass

// Wave normal n and wavenumber |k| (rad/m) of generation g (mean mode, sheared).
void wakeGenGeom(int g, out vec2 n, out float km) {
  vec2 k = vec2(WAKE_M0X + uWakeGen[g].y * WAKE_M0Y, WAKE_M0Y) * (TWO_PI / uWakeTile);
  km = length(k);
  n = k / km;
}
// Local phase Theta in [-pi, pi) and local map strength a in [0, 1] of generation g at local position q.
vec2 wakeGenPhase(int g, vec2 q) {
  vec4 G = uWakeGen[g];
  vec2 u = vec2(q.x, q.y + G.y * q.x) / uWakeTile + G.zw;
  vec4 t = texture(uWakeTex, u);
  vec2 w = uWakeSel[g] > 0.5 ? t.zw : t.xy;
  float r2 = dot(w, w);
  float a = G.x * (1.0 - exp(-r2 * uWakeShape.y));
  float ph = fract(WAKE_M0X * u.x + WAKE_M0Y * u.y) * TWO_PI + atan(w.y, w.x + 1e-20);
  ph -= TWO_PI * floor(ph / TWO_PI + 0.5);
  return vec2(ph, a);
}
// Circle map M_gamma(Theta) = 2 atan(gamma tan(Theta/2)) on [-pi, pi), its inverse and derivative.
float wakeCircleMap(float th, float gam) { float h = 0.5 * th; return 2.0 * atan(gam * sin(h), cos(h)); }
float wakeCircleInv(float X, float gam) { float h = 0.5 * X; return 2.0 * atan(sin(h), gam * cos(h)); }
float wakeCircleDeriv(float th, float gam) {
  float c = cos(0.5 * th), s = sin(0.5 * th);
  return gam / (c * c + gam * gam * s * s);
}
// Phase data with directional derivatives along n (per meter, one forward difference of step WAKE_FD_H):
// returns (Theta, a, dTheta/dn, da/dn).
#define WAKE_FD_H 1.5
vec4 wakeGenPhaseD(int g, vec2 q, vec2 n, float km) {
  vec4 G = uWakeGen[g];
  vec2 u = vec2(q.x, q.y + G.y * q.x) / uWakeTile + G.zw;
  vec2 du = vec2(n.x, n.y + G.y * n.x) * (WAKE_FD_H / uWakeTile);
  vec4 t0 = texture(uWakeTex, u);
  vec4 t1 = texture(uWakeTex, u + du);
  bool sel = uWakeSel[g] > 0.5;
  vec2 w0 = sel ? t0.zw : t0.xy;
  vec2 w1 = sel ? t1.zw : t1.xy;
  float a0 = G.x * (1.0 - exp(-dot(w0, w0) * uWakeShape.y));
  float a1 = G.x * (1.0 - exp(-dot(w1, w1) * uWakeShape.y));
  float ph = fract(WAKE_M0X * u.x + WAKE_M0Y * u.y) * TWO_PI + atan(w0.y, w0.x + 1e-20);
  ph -= TWO_PI * floor(ph / TWO_PI + 0.5);
  float dphi = atan(w1.y * w0.x - w1.x * w0.y, w1.x * w0.x + w1.y * w0.y + 1e-20);
  return vec4(ph, a0, km + dphi / WAKE_FD_H, (a1 - a0) / WAKE_FD_H);
}
// Jacobian determinant of one generation's map (x = q + n*(M(Theta) - Theta)/km) from wakeGenPhaseD data.
float wakeGenJac(vec4 P, float km) {
  float gam = exp(P.y * uWakeShape.x);
  float c = cos(0.5 * P.x), s = sin(0.5 * P.x);
  float den = c * c + gam * gam * s * s;
  float Md = gam / den;                            // dM/dTheta
  float Ma = gam * sin(P.x) * uWakeShape.x / den;  // dM/da
  return 1.0 + ((Md - 1.0) * P.z + Ma * P.w) / km;
}

// Displacement of one generation at Lagrangian position q.
vec2 wakeGenDisp(int g, vec2 q) {
  vec2 pa = wakeGenPhase(g, q);
  if (pa.y < 1e-4) return vec2(0.0);
  vec2 n; float km;
  wakeGenGeom(g, n, km);
  float gam = exp(pa.y * uWakeShape.x);
  return n * ((wakeCircleMap(pa.x, gam) - pa.x) / km);
}

// Displacement (m) of a particle whose undisplaced (epicyclic) position is q (local frame, m).
vec2 wakeDisplacement(vec2 q) {
  if (uWakeOn < 0.5) return vec2(0.0);
  vec2 d0 = wakeGenDisp(0, q);
  vec2 d1 = wakeGenDisp(1, q + d0);
  return d0 + d1;
}

// Inverse of one generation's map at Eulerian position x; returns the Lagrangian point and the map's
// Jacobian determinant J there (density factor of this generation = 1/J).
vec2 wakeGenInverse(int g, vec2 x, out float J) {
  vec2 n; float km;
  wakeGenGeom(g, n, km);
  // phase field evaluated at x approximates the Eulerian phase M(Theta(q)) (the slowly varying envelope
  // phase is evaluated at x instead of q); refine once with a Newton step along n.
  vec2 pa = wakeGenPhase(g, x);
  J = 1.0;
  if (pa.y < 1e-4) return x;
  float gam = exp(pa.y * uWakeShape.x);
  float th = wakeCircleInv(pa.x, gam);
  vec2 q = x - n * ((pa.x - th) / km);
  // Newton refinement along n with the exact forward map and Jacobian at q
  vec4 P = wakeGenPhaseD(g, q, n, km);
  float gb = exp(P.y * uWakeShape.x);
  float Jq = wakeGenJac(P, km);
  vec2 xq = q + n * ((wakeCircleMap(P.x, gb) - P.x) / km);
  float r = dot(x - xq, n) / max(Jq, 0.05);
  q += n * r;
  // Jacobian at the refined point (phase and strength advance linearly along n)
  J = max(wakeGenJac(vec4(P.x + P.z * r, P.y + P.w * r, P.z, P.w), km), 1e-3);
  return q;
}

// Density factor 1 / (J_young J_old) of the single-branch inverse (mean ~0.88-0.9, see wakeDensity).
float wakeDensityRaw(vec2 x) {
  if (uWakeOn < 0.5) return 1.0;
  float J1, J0;
  vec2 q1 = wakeGenInverse(1, x, J1);
  wakeGenInverse(0, q1, J0);
  return clamp(1.0 / (J1 * J0), uWakeShape.z * 0.9, uWakeShape.w * 1.1);
}
// Eulerian surface-density factor (mean 1) at local position x. Where the envelope's local wavenumber exceeds the
// mean by more than ~gamma^a / (1 - gamma^a) the forward map folds in the wake cores (the particles pile up
// there); the single-branch inverse misses the folded branches, so wakeDensityRaw lacks ~10 % of the mass, all of
// it in the dense wakes (gaps within ~2 % of the binned density of forward-mapped particles). The excess over the
// mean is scaled to restore it: W = Wraw + (k - 1) max(Wraw - 1, 0), k = uWakeMassK measured from the live field
// (RingLayerPass wake-statistics probe), so <W> = 1 like the particle density.
float wakeDensity(vec2 x) {
  float w = wakeDensityRaw(x);
  return w + (uWakeMassK - 1.0) * max(w - 1.0, 0.0);
}

// Same, with the contrast faded out as the footprint (m) approaches the local wake spacing.
float wakeDensityFiltered(vec2 x, float footprint) {
  if (uWakeOn < 0.5) return 1.0;
  float lam = uWakeTile / 17.54;
  float f = 1.0 - smoothstep(0.08 * lam, 0.45 * lam, footprint);
  if (f <= 0.0) return 1.0;
  return mix(1.0, wakeDensity(x), f);
}

float wakeMinDensity() { return uWakeOn < 0.5 ? 1.0 : uWakeShape.z; }

#endif
