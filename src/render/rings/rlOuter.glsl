// ===== ring layer: outer & dusty rings ==========================================================
// F ring (eccentric, inclined, precessing; core + strands + envelope; clumps; Prometheus channels),
// Janus/Epimetheus ring, G ring with its arc, E ring (vertically extended dust torus around Enceladus).
// All dusty material scatters strongly forward (ringPhase with dust = 1): faint in back-scatter,
// glowing when back-lit. Requires rlOptics.

uniform vec4 uRlF;      // (a [m], e, varpi [rad], sin i)
uniform vec4 uRlF2;     // (node Omega [rad], co-moving longitude offset lambda_F(t) [rad], core sigma [m], core tau)
uniform vec4 uRlF3;     // (envelope sigma [m], envelope tau, strand tau, Prometheus channel depth)
uniform vec4 uRlProm;   // (longitude of Prometheus [rad], channel spacing [rad], channel shear rate [rad/s per m], channel period [s])
uniform vec4 uRlG;      // (G peak radius [m], G tau, arc tau, arc longitude [rad])
uniform vec4 uRlE;      // (E peak radius [m], E tau, scale height at peak [m], outer radius [m])
uniform float uRlDust;  // settings.dustRings (0/1)

float rlPhi(float x) { return 0.5 * (1.0 + erfApprox(x * 0.70710678)); }
// mean of a unit-peak Gaussian (sigma) over a box window of width w centred at offset x
// (differences of the approximate CDF can come out slightly negative far from the line: clamped, or the
// strands produced tiny negative radiances there)
float rlGaussBox(float x, float sigma, float w) {
  if (w < 0.25 * sigma) return exp(-0.5 * x * x / (sigma * sigma));
  return 2.50662827 * sigma / w * max(rlPhi((x + 0.5 * w) / sigma) - rlPhi((x - 0.5 * w) / sigma), 0.0);
}
// mean opacity <1 - exp(-tau(x)/m)> of a Gaussian line (peak tauP, sigma) over a box window w at offset x.
// Equivalent width of a Gaussian line: EW = sigma sqrt(2 pi) g(tauP/m), g(y) ~ 0.798 sqrt(ln(1 + 1.571 y^2))
float rlGaussOpacity(float x, float sigma, float w, float tauP, float m) {
  float point = 1.0 - exp(-tauP * exp(-0.5 * x * x / (sigma * sigma)) / m);
  float y = tauP / m;
  float g = 0.798 * sqrt(log(1.0 + 1.571 * y * y));
  float ew = 2.50662827 * sigma * g;
  float frac = max(rlPhi((x + 0.5 * w) / sigma) - rlPhi((x - 0.5 * w) / sigma), 0.0);
  float boxed = min(1.0, ew * frac / max(w, 1e-3));
  return clamp(mix(point, boxed, smoothstep(0.5 * sigma, 2.0 * sigma, w)), 0.0, 1.0);
}

// periodic 1-D value noise on the circle: n cells around 2 pi
float rlCircNoise(float lon, float n, uint salt) {
  float x = fract(lon / TWO_PI) * n;
  float i = floor(x);
  float f = x - i;
  uint i0 = uint(i);
  uint i1 = uint(mod(i + 1.0, n));
  float a = hashU(pcgHash(i0 ^ salt)), b = hashU(pcgHash(i1 ^ salt));
  return mix(a, b, f * f * (3.0 - 2.0 * f));
}

// ---------------------------------------------------------------- F ring
// returns hit distance (or -1) and radiance/transmission of the F-ring sheet
float rlFRing(vec3 rd, float sceneDist, float fpScale, out vec3 L, out float T) {
  L = vec3(0.0);
  T = 1.0;
  if (uRlDust < 0.5) return -1.0;
  float si = uRlF.w, ci = sqrt(1.0 - si * si);
  vec3 n = vec3(si * sin(uRlF2.x), -si * cos(uRlF2.x), ci);
  float dn = dot(rd, n);
  if (abs(dn) < 1e-9) return -1.0;
  float t = dot(uSaturnCenter, n) / dn;
  if (t <= 0.0 || t >= sceneDist) return -1.0;
  vec3 p = rd * t;
  vec3 q = p - uSaturnCenter;
  float r = length(q.xy);
  if (abs(r - uRlF.x) > 1.2e6) return -1.0;
  float th = atan(q.y, q.x);
  float a = uRlF.x, e = uRlF.y;
  float rF = a * (1.0 - e * e) / (1.0 + e * cos(th - uRlF.z));
  float xi = th - uRlF2.y;                         // longitude co-moving with the ring material
  // kinks and clumps
  float kink = 2.5e3 * (rlCircNoise(xi, 720.0, 11u) - 0.5) + 6.0e3 * (rlCircNoise(xi, 90.0, 12u) - 0.5);
  float clump = 0.25 + 1.5 * pow(rlCircNoise(xi, 1440.0, 13u), 2.0) + 0.5 * rlCircNoise(xi, 180.0, 14u);
  float d = r - rF - kink;
  float mu = max(abs(rd.z), 1e-4);
  float w = max(fpScale * rlFootprint(rd, t, p), 1.0);
  // Prometheus streamer-channels: each Prometheus orbit cuts a channel; older ones lie further behind
  // (spacing ~3.2 deg) and are sheared by the Keplerian flow (tilt grows with age).
  float chan = 1.0;
  if (uRlF3.w > 0.0) {
    float dl = rlWrapPi(uRlProm.x - th);          // > 0 behind Prometheus
    if (dl > 0.0 && dl < 1.2) {
      float k = floor(dl / uRlProm.y + 0.5);
      float age = k * uRlProm.w;
      float c0 = k * uRlProm.y + uRlProm.z * age * (d);    // shear tilts the channel with radius
      float dd = (dl - c0) * r;
      float wch = 1.5e5 + 1.0e3 * k;
      chan = 1.0 - uRlF3.w * exp(-k / 8.0) * exp(-0.5 * dd * dd / (wch * wch)) * exp(-0.5 * d * d / (6.0e4 * 6.0e4));
    }
  }
  float mu0 = max(uRlMu0, 1e-3);
  vec3 V = -rd;
  float cosA = dot(uSunDir, V);
  bool lit = sign(V.z) == uRlSunSign;
  float kL = 1.0 / mu + 1.0 / mu0;
  float vis = rlSaturnVis(p);
  // core (optically thick at low elevation): opacity via the equivalent-width formula
  float tc = uRlF2.w * clump * chan;
  float sc = uRlF2.z;
  float opMu = rlGaussOpacity(d, sc, w, tc, mu);
  float opMu0 = rlGaussOpacity(d, sc, w, tc, mu0);
  float opK = rlGaussOpacity(d, sc, w, tc, 1.0 / kL);
  // thin components: strands + envelope (mean tau over the window)
  float tauThin = uRlF3.y * rlGaussBox(d, uRlF3.x, w);
  float strands = 0.0;
  for (int j = 0; j < 4; j++) {
    float fj = float(j);
    float off = (j < 2 ? -1.0 : 1.0) * (35.0e3 + 45.0e3 * mod(fj, 2.0)) + 18.0e3 * sin(xi * (2.0 + fj) + 1.7 * fj);
    float sj = 3.0e3 + 2.5e3 * fj;
    float tj = uRlF3.z * (0.4 + rlCircNoise(xi + fj, 60.0 + 30.0 * fj, 20u + uint(j))) * chan;
    strands += tj * rlGaussBox(d - off, sj, w);
  }
  tauThin += strands;
  T = (1.0 - opMu) * exp(-tauThin / mu);
  vec3 alb = vec3(0.62, 0.6, 0.58);
  float Pc = rlPhase(cosA, 0.6), Pd = rlPhase(cosA, 1.0);
  vec3 IF;
  if (lit) {
    IF = alb * 0.25 * (Pc * opK + Pd * tauThin * kL) / (kL * mu);
  } else {
    float dd0 = 1.0 - mu / mu0;
    float core = abs(dd0) < 0.02 ? (1.0 - opMu0) * tc / mu0 * 0.5 : ((1.0 - opMu0) - (1.0 - opMu)) / dd0;
    IF = alb * 0.25 * (Pc * max(core, 0.0) + Pd * tauThin / mu);
  }
  L = IF * vis * (uSunE * INV_PI);
  return t;
}

// ---------------------------------------------------------------- Janus/Epimetheus ring + G ring (in the plane)
void rlGRings(vec3 rd, vec3 p, float r, float theta, float fp, out vec3 L, out float T) {
  L = vec3(0.0);
  T = 1.0;
  if (uRlDust < 0.5 || r < 1.45e8 || r > 1.8e8) return;
  float w = max(fp, 1.0);
  float pk = uRlG.x;
  float tau = uRlG.y * (r < pk ? rlGaussBox(r - pk, 1.0e6, w) : rlGaussBox(r - pk, 3.2e6, w));
  float dl = rlWrapPi(theta - uRlG.w);
  tau += uRlG.z * rlGaussBox(r - 1.67493e8, 2.5e5, w) * exp(-0.5 * dl * dl / (0.3 * 0.3));
  tau += 1.0e-6 * rlGaussBox(r - 1.5145e8, 1.5e6, w);
  if (tau <= 0.0) return;
  float mu = max(abs(rd.z), 1e-4);
  float cosA = dot(uSunDir, -rd);
  float vis = rlSaturnVis(p);
  float P = rlPhase(cosA, 1.0);
  L = vec3(0.75, 0.8, 0.9) * 0.25 * P * tau / mu * vis * (uSunE * INV_PI);
  T = exp(-tau / mu);
}

// ---------------------------------------------------------------- E ring (volume)
float rlETau(float r) {
  float pk = uRlE.x;
  float f = r < pk ? exp(-0.5 * pow((r - pk) / 2.5e7, 2.0)) : pow(r / pk, -4.0);
  return uRlE.y * f * smoothstep(1.7e8, 1.9e8, r) * (1.0 - smoothstep(0.85 * uRlE.w, uRlE.w, r));
}
float rlEH(float r) {
  float x = r / uRlE.x;
  return uRlE.z * (x > 1.0 ? x * x : 1.0 + 1.5 * (1.0 - x));
}
// sunlight transmitted by the main rings to camera-relative point p (thin sheet, coarse footprint)
float rlMainRingShadow(vec3 p) {
  float zs = p.z + uCamPos.z;
  float sz = uSunDir.z;
  if (abs(sz) < 1e-6 || zs * sz >= 0.0) return 1.0;
  float t = -zs / sz;
  float r = length((p + uCamPos).xy + t * uSunDir.xy);
  if (r < 6.6e7 || r > 1.37e8) return 1.0;
  RlS S = rlSample((r - uRingRMin) / uRingDr0, 2.56e5);   // exactly one pyramid level
  return rlTrans(S, abs(sz));
}
// Single-scattered radiance of the E ring between ray distances sA..sB (optically thin, tau ~ 1e-5).
// Steep rays cross the vertical Gaussian quickly: the column at the plane crossing times the fraction of
// the Gaussian inside [sA, sB]. Shallow rays (looking along the ring plane): numerical integration.
vec3 rlERing(vec3 rd, float sA, float sB, float jitter) {
  if (uRlDust < 0.5 || sB <= sA) return vec3(0.0);
  vec3 o = -uSaturnCenter;                         // camera position relative to Saturn
  float az = abs(rd.z);
  float acc = 0.0;
  float wSteep = smoothstep(0.06, 0.12, az);
  if (wSteep > 0.0) {
    float sc = -o.z / rd.z;
    vec3 qc = o + rd * sc;
    float r = length(qc.xy);
    float te = rlETau(r);
    if (te > 0.0) {
      float h = rlEH(r);
      float za = o.z + rd.z * sA, zb = o.z + rd.z * sB;
      float frac = abs(rlPhi(zb / h) - rlPhi(za / h));
      if (frac > 1e-4) {
        vec3 pc = rd * clamp(sc, sA, sB);
        acc += wSteep * te / az * frac * rlSaturnVis(pc) * rlMainRingShadow(pc);
      }
    }
  }
  if (wSteep < 1.0) {
    const int N = 14;
    float ds = (sB - sA) / float(N);
    float sum = 0.0;
    for (int i = 0; i < N; i++) {
      float s = sA + (float(i) + jitter) * ds;
      vec3 q = o + rd * s;
      float r = length(q.xy);
      float te = rlETau(r);
      if (te <= 0.0) continue;
      float h = rlEH(r);
      float sig = te * exp(-0.5 * q.z * q.z / (h * h)) / (2.50662827 * h);
      if (sig * ds < 1e-10) continue;
      vec3 p = rd * s;
      sum += sig * ds * rlSaturnVis(p) * rlMainRingShadow(p);
    }
    acc += (1.0 - wSteep) * sum;
  }
  float P = rlPhase(dot(uSunDir, -rd), 1.0);
  return acc * vec3(0.8, 0.9, 1.0) * 0.25 * P * (uSunE * INV_PI);
}
