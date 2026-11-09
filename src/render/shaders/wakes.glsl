// ===== sv_wakes =============================================================================
// Procedural self-gravity wakes (see src/rings/WakeField.ts for the model; Python mirror
// scripts/data/nbody/procedural.py). Coordinates are local Hill-frame (x radial, y azimuthal) in meters relative to the
// ring-frame anchor (sv_ringProfile). Requires sv_common.
//
//   vec2  wakeDisplacement(vec2 q)  displacement (m) of a particle whose undisplaced (epicyclic) position is q
//   float wakeDensity(vec2 x)       Eulerian surface-density factor at x (mean 1): the density of the particles placed by
//                                   wakeDisplacement (each generation's map inverted along its wave normal; clamped to
//                                   uWakeBounds.xy = [0.8 gammaGap^s, 4 gammaCore^-s])
//   float wakeDensityFiltered(vec2 x, float footprint)   same, contrast faded out when the footprint (m)
//                                   approaches the wake spacing (anti-aliasing for distant views)
//   float wakeMinDensity()          lower bound of wakeDensity() for the current pattern (for culling)
//   vec2  wakeDisplacementJ(vec2 q, out float Df)  wakeDisplacement and the forward map's density at the particle,
//                                   1 / (J_old(q) J_young(q + d_old)) (the packing ceiling, nearUpdate.glsl)
//   size-dependent participation (docs/ring-physics.md 10.12, src/rings/ringDynamics.ts: a mixture -- a share p of a
//   class follows the map fully, the rest not at all, so its density is exactly 1 + p (D - 1)):
//   vec2  wakeDisplacementP(vec2 q, float p)  p x wakeDisplacement (the near field calls it with p = 0 or 1 per particle)
//   float wakeDensityTau(vec2 x)    1 + uWakePartTau (wakeDensity - 1): the density of the whole column, uWakePartTau =
//                                   its tau-weighted participation pbar (WakeField.participationTau; 1 with wakes off).
//                                   The medium itself takes the participation per height from its LUT channels.
// Cost: wakeDisplacement 2 texture fetches (+ 2 with asynchrony), wakeDisplacementJ 6 (+ 4), wakeDensity 10 (+ 6).
#ifndef SV_WAKES
#define SV_WAKES

uniform highp sampler2DArray uWakeTex;  // layers 0, 1 (envelope fields A, B): (Re W, Im W, G_u, G_v), periodic, <|W|^2> = 1;
                                        // layer 2: the asynchrony field (delta in [0, 1), d delta/du, d delta/dv, 0), its
                                        // 64^2 tile repeated 4 x 4 (WakeField.ts): sampled at the tile coordinate / 4
uniform float uWakeTile;      // tile size L (m)
uniform vec4 uWakeGen[2];     // [0] older, [1] younger generation: (shear S_g, offsetU, offsetV, texture layer)
uniform vec4 uWakeClock;      // (cycle phase phi, asyncD, 2 envW (0: sin^2 handover), strength)
uniform vec4 uWakeDelta;      // asynchrony frame: (offsetU, offsetV, shear S of the younger generation, delta scale / L)
uniform vec4 uWakeShape;      // (ln gamma, ln g, 1/Rc^2, K_MIN): core density 1/(gamma g), gap gamma/g at full strength
uniform vec2 uWakeM0;         // central mode (m0x, m0y)
uniform vec4 uWakeBounds;     // (lower clamp of wakeDensity, upper clamp, max displacement per generation (m), 0)
uniform float uWakeOn;        // 0 / 1
uniform float uWakePartTau;   // tau-weighted mean wake participation of the medium (hook; 1 = every size follows)
uniform vec4 uWakeOpt;        // per frame (WakeField.update): (1 = the asynchrony phase can change an envelope, generation
                              // 0 can be non-zero, generation 1 can be non-zero, -): skips that change no result

#define WAKE_FD_H 1.5         // central-difference step along the wave normal (m)
#define WAKE_K_SOFT 0.1       // softness of the local wave number's lower clamp
#define WAKE_J_FLOOR 0.05     // Newton: lower bound of the Jacobian in the step
#define WAKE_J_MIN 0.06       // final |J| floor: one generation's density <= 1/WAKE_J_MIN
#define WAKE_NEWTON 2

// Wave normal n and mean wave number (rad/m) of generation g (mean mode, sheared).
vec3 wakeGeo(int g) {
  vec2 k = vec2(uWakeM0.x + uWakeGen[g].x * uWakeM0.y, uWakeM0.y) * (TWO_PI / uWakeTile);
  float km = length(k);
  return vec3(k / km, km);
}
vec2 wakeUV(int g, vec2 p) {
  vec4 G = uWakeGen[g];
  return vec2(p.x, p.y + G.x * p.x) / uWakeTile + G.yz;
}
// Asynchrony phase delta at p and its gradient (per m); 0 without asynchrony, or while no envelope depends on it
// (uWakeOpt.x: the handover is complete for every delta -- wakeEnvYoung is then the same at delta = 0).
vec3 wakeDelta(vec2 p) {
  if (uWakeClock.y <= 0.0 || uWakeOpt.x < 0.5) return vec3(0.0);
  float sd = uWakeDelta.w;
  vec4 t = texture(uWakeTex, vec3((vec2(p.x, p.y + uWakeDelta.z * p.x) * sd + uWakeDelta.xy) * 0.25, 2.0));
  return vec3(t.x, sd * (t.y + uWakeDelta.z * t.z), sd * t.z);
}
// Envelope of the younger generation at asynchrony phase delta (the older one has 1 - e).
float wakeEnvYoung(float delta) {
  if (uWakeClock.z <= 0.0) {
    float x = uWakeClock.y > 0.0 ? clamp((uWakeClock.x - uWakeClock.y * delta) / (1.0 - uWakeClock.y), 0.0, 1.0) : uWakeClock.x;
    float s = sin(0.5 * PI * x);
    return s * s;
  }
  return smoothstep(0.0, uWakeClock.z, uWakeClock.x - uWakeClock.y * delta);
}
// Local strength a of generation g from |W|^2 and delta.
float wakeAmp(int g, float r2, float delta) {
  float ey = wakeEnvYoung(delta);
  return uWakeClock.w * (g == 1 ? ey : 1.0 - ey) * (1.0 - exp(-r2 * uWakeShape.z));
}
// Local phase Theta in [-pi, pi) and local wave number K along n from a texel of generation g at texture coordinate u.
vec2 wakePhaseK(int g, vec4 T, vec2 u, vec3 geo) {
  float th = fract(uWakeM0.x * u.x + uWakeM0.y * u.y) * TWO_PI + atan(T.y, T.x + 1e-20);
  th -= TWO_PI * floor(th / TWO_PI + 0.5);
  float S = uWakeGen[g].x;
  float r = 1.0 + (geo.x * (T.z + S * T.w) + geo.y * T.w) / (uWakeTile * geo.z);
  float m = uWakeShape.w;
  return vec2(th, geo.z * 0.5 * (r + m + sqrt((r - m) * (r - m) + WAKE_K_SOFT * WAKE_K_SOFT)));
}
// Composite circle map C = G_g o M_gamma at local strength a: (C in (-pi, pi], dC/dTheta, sin 2C).
vec3 wakeCMap(float th, float a) {
  float gm = exp(a * uWakeShape.x), g = exp(a * uWakeShape.y);
  float s = sin(th), c = cos(th), gm2 = gm * gm;
  float N = g * gm * s;
  float Dd = 0.5 * ((1.0 - gm2) + (1.0 + gm2) * c);
  float E = 0.5 * ((1.0 + gm2) + (1.0 - gm2) * c);
  float R2 = N * N + Dd * Dd;
  return vec3(atan(N, Dd), g * gm * E / R2, 2.0 * N * Dd / R2);
}
float wakeCInv(float X, float a) {
  float gm = exp(a * uWakeShape.x), g = exp(a * uWakeShape.y);
  float ph = atan(sin(X), g * cos(X));
  return 2.0 * atan(sin(0.5 * ph), gm * cos(0.5 * ph));
}
// (Theta, a, K) of generation g at p for asynchrony phase delta: one texture fetch.
vec3 wakeGenEvalAt(int g, vec2 p, vec3 geo, float delta) {
  vec2 u = wakeUV(g, p);
  vec4 T = texture(uWakeTex, vec3(u, uWakeGen[g].w));
  vec2 tk = wakePhaseK(g, T, u, geo);
  return vec3(tk.x, wakeAmp(g, dot(T.xy, T.xy), delta), tk.y);
}
// The same with delta sampled at p (the particles' map): one texture fetch (+ the delta fetch).
vec3 wakeGenEval(int g, vec2 p, vec3 geo) { return wakeGenEvalAt(g, p, geo, wakeDelta(p).x); }
// (Theta, a, K) at p (midpoint averages) and their derivatives along n (central differences over WAKE_FD_H: exact for
// the quadratic rise of the strength near a dislocation), given delta and its gradient at p (dl): two texture fetches.
void wakeGenEvalD(int g, vec2 p, vec3 geo, vec3 dl, out vec3 v, out vec3 d) {
  float S = uWakeGen[g].x;
  vec2 u = wakeUV(g, p);
  vec2 du = vec2(geo.x, geo.y + S * geo.x) * (0.5 * WAKE_FD_H / uWakeTile);
  vec4 T0 = texture(uWakeTex, vec3(u - du, uWakeGen[g].w));
  vec4 T1 = texture(uWakeTex, vec3(u + du, uWakeGen[g].w));
  vec2 k0 = wakePhaseK(g, T0, u - du, geo);
  vec2 k1 = wakePhaseK(g, T1, u + du, geo);
  float dd = 0.5 * WAKE_FD_H * dot(geo.xy, dl.yz);
  float a0 = wakeAmp(g, dot(T0.xy, T0.xy), dl.x - dd);
  float a1 = wakeAmp(g, dot(T1.xy, T1.xy), dl.x + dd);
  float dphi = atan(T1.y * T0.x - T1.x * T0.y, T1.x * T0.x + T1.y * T0.y + 1e-20);
  float thn = geo.z + dphi / WAKE_FD_H;
  float th = k0.x + 0.5 * WAKE_FD_H * thn;
  th -= TWO_PI * floor(th / TWO_PI + 0.5);
  v = vec3(th, 0.5 * (a0 + a1), 0.5 * (k0.y + k1.y));
  d = vec3(thn, (a1 - a0) / WAKE_FD_H, (k1.y - k0.y) / WAKE_FD_H);
}
// Jacobian determinant 1 + dD/dn of one generation's map, D = (C(Theta) - Theta) / K, from (Theta, a, K) and their
// derivatives along n.
float wakeJac(vec3 v, vec3 d) {
  vec3 c = wakeCMap(v.x, v.y);
  float Ca = c.y * uWakeShape.x * sin(v.x) + 0.5 * uWakeShape.y * c.z;
  return 1.0 + ((c.y - 1.0) * d.x + Ca * d.y) / v.z - (c.x - v.x) * d.z / (v.z * v.z);
}

// Displacement of one generation at Lagrangian position p (none while its envelope is zero everywhere: uWakeOpt).
vec2 wakeGenDisp(int g, vec2 p) {
  if ((g == 0 ? uWakeOpt.y : uWakeOpt.z) < 0.5) return vec2(0.0);
  vec3 geo = wakeGeo(g);
  vec3 v = wakeGenEval(g, p, geo);
  if (v.y < 1e-4) return vec2(0.0);
  return geo.xy * ((wakeCMap(v.x, v.y).x - v.x) / v.z);
}

// Displacement (m) of a particle whose undisplaced (epicyclic) position is q (local frame, m).
vec2 wakeDisplacement(vec2 q) {
  if (uWakeOn < 0.5) return vec2(0.0);
  vec2 d0 = wakeGenDisp(0, q);
  vec2 d1 = wakeGenDisp(1, q + d0);
  return d0 + d1;
}

// Inverse of one generation's map at Eulerian position x: returns the Lagrangian point and the map's Jacobian
// determinant J there (density factor of this generation = 1/J). Closed-form guess from the fields at x (exact for a
// locally linear phase and constant strength / wave number), then Newton steps on t - D(x - t n) = 0 along n. (The
// asynchrony phase is sampled at every Newton point: it is sheared with the flow, so extrapolating it from x with its
// gradient put 2-15 % of the particles > 20 % off.)
vec2 wakeGenInverse(int g, vec2 x, out float J) {
  J = 1.0;
  // (a generation whose envelope is zero everywhere: identical to the strength test below)
  if ((g == 0 ? uWakeOpt.y : uWakeOpt.z) < 0.5) return x;
  vec3 geo = wakeGeo(g);
  vec3 v = wakeGenEval(g, x, geo);
  if (v.y < 1e-4) return x;
  float tmax = uWakeBounds.z;
  float t = clamp((v.x - wakeCInv(v.x, v.y)) / v.z, -tmax, tmax);
  vec3 ve = v, d = vec3(0.0);
  for (int i = 0; i < WAKE_NEWTON; i++) {
    vec3 vp;
    vec2 p = x - t * geo.xy;
    wakeGenEvalD(g, p, geo, wakeDelta(p), vp, d);
    float D = (wakeCMap(vp.x, vp.y).x - vp.x) / vp.z;
    float tn = clamp(t - (t - D) / max(wakeJac(vp, d), WAKE_J_FLOOR), -tmax, tmax);
    float dt = tn - t;
    // fields at the refined point (phase, strength and wave number advance linearly along n)
    float th = vp.x - d.x * dt;
    th -= TWO_PI * floor(th / TWO_PI + 0.5);
    ve = vec3(th, max(vp.y - d.y * dt, 0.0), max(vp.z - d.z * dt, 1e-6));
    t = tn;
  }
  // |J| floor: a fold's middle branch (rare, near dislocations) has J < 0
  J = max(abs(wakeJac(ve, d)), WAKE_J_MIN);
  return x - t * geo.xy;
}

// Eulerian surface-density factor (mean 1) at local position x: 1 / (J_young J_old) of the inverse maps.
float wakeDensity(vec2 x) {
  if (uWakeOn < 0.5) return 1.0;
  float J1, J0;
  vec2 q1 = wakeGenInverse(1, x, J1);
  wakeGenInverse(0, q1, J0);
  return clamp(1.0 / (J1 * J0), uWakeBounds.x, uWakeBounds.y);
}

// Same, with the contrast faded out as the footprint (m) approaches the local wake spacing.
float wakeDensityFiltered(vec2 x, float footprint) {
  if (uWakeOn < 0.5) return 1.0;
  float lam = uWakeTile / 17.54;
  float f = 1.0 - smoothstep(0.08 * lam, 0.45 * lam, footprint);
  if (f <= 0.0) return 1.0;
  return mix(1.0, wakeDensity(x), f);
}

float wakeMinDensity() { return uWakeOn < 0.5 ? 1.0 : uWakeBounds.x; }

// Displacement of a particle following the wakes fully (wakeDisplacement) and the forward map's surface density at its
// drawn position: 1 / (J_old(q) J_young(q + d_old)) -- the density wakeDensity inverts (equal up to the inverse's accuracy,
// docs/ring-physics.md 10.8), clamped like it. Two extra fetches per generation (central differences along n).
vec2 wakeDisplacementJ(vec2 q, out float Df) {
  Df = 1.0;
  if (uWakeOn < 0.5) return vec2(0.0);
  vec2 d = vec2(0.0);
  float J = 1.0;
  for (int g = 0; g < 2; g++) {
    // (a generation whose envelope is zero everywhere this frame contributes nothing: uWakeOpt, bit-exact)
    if ((g == 0 ? uWakeOpt.y : uWakeOpt.z) < 0.5) continue;
    vec2 p = q + d;
    vec3 geo = wakeGeo(g);
    vec3 dl = wakeDelta(p);
    vec3 v0 = wakeGenEvalAt(g, p, geo, dl.x);
    if (v0.y >= 1e-4) {
      vec3 v, dv;
      wakeGenEvalD(g, p, geo, dl, v, dv);
      J *= max(abs(wakeJac(v, dv)), WAKE_J_MIN);
      d += geo.xy * ((wakeCMap(v0.x, v0.y).x - v0.x) / v0.z);
    }
  }
  Df = clamp(1.0 / J, uWakeBounds.x, uWakeBounds.y);
  return d;
}

// Size-dependent participation (docs/ring-physics.md 10.12; N-body: p_rel(a) = min(1, (a / a_p)^0.5), 10.3 / 10.5). The
// renderers use a mixture: a share p of a class follows the wakes fully, the rest is not displaced, so the class's density
// is exactly 1 + p (D - 1) at any contrast (a displacement scaled by p would give 1 / (1 + p (1/D - 1)), much emptier gaps
// than the medium's linear rule). The near field draws per particle (p = 0 or 1), the medium carries the participating
// share of every class it holds in its vertical-structure channels (sv_ringLod ringLodChannels).
vec2 wakeDisplacementP(vec2 q, float p) { return p * wakeDisplacement(q); }
// The density factor of the whole column: 1 + pbar (D - 1), pbar = its tau-weighted participation.
float wakeDensityTau(vec2 x) { return 1.0 + uWakePartTau * (wakeDensity(x) - 1.0); }

#endif
