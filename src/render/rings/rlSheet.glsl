// ===== ring layer: main-ring thin sheet (far field) ===========================================
// Requires rlOptics.

uniform vec4 uRlPan;        // Encke-gap edge waves: (a_Pan [m], longitude [rad], amplitude [m], on)
uniform vec4 uRlDaphnis;    // Keeler-gap edge waves: (a_Daphnis [m], longitude [rad], radial amp [m], vertical amp [m])
#define RL_SPOKES 12
uniform vec4 uRlSpoke[RL_SPOKES];   // (formation longitude [rad], age [s], centre radius [m], seed 0..1)
uniform vec2 uRlSpokeAct;           // (seasonal activity 0..1, peak tau)
uniform vec4 uRlWakeStat;           // measured wake statistics: (fB, Wb, Wg, profile wake value they refer to)
uniform vec2 uRlWakeNrm;            // unit normal to the wake crests, (radial, azimuthal) components
uniform vec2 uRlWakeLamRef;         // (Toomre wavelength at the anchor [m], surface density there [kg/m^2])
uniform vec4 uRlWakeHeff;           // path decorrelation heights / H: (lit view, lit sun, unlit view, unlit sun)

const float RL_GM = 3.79312062e16;

float rlWrapPi(float a) { return a - TWO_PI * floor((a + PI) / TWO_PI); }

// ---------------------------------------------------------------- moonlet edge waves
// A moonlet in a gap perturbs the streamlines it passes: downstream of it (ahead of the moon for the
// faster inner edge, behind for the outer edge) the edge oscillates with azimuthal wavelength 3 pi da
// (Cuzzi & Scargle 1985), amplitude ~ (mu a^4 / da^3), damping over a few wavelengths.
float rlEdgeWave(float r, float theta, vec4 moon, float da0) {
  float da = r - moon.x;
  float ada = abs(da);
  if (moon.w <= 0.0 || ada < 0.3 * da0 || ada > 3.0 * da0) return 0.0;
  float dth = rlWrapPi(theta - moon.y) * (da < 0.0 ? 1.0 : -1.0);
  if (dth <= 0.0) return 0.0;
  float x = dth * r;                       // downstream distance along the orbit
  float lam = 3.0 * PI * ada;
  float amp = moon.z * pow(da0 / ada, 3.0);
  float env = exp(-x / (4.0 * lam)) * smoothstep(0.0, 0.3 * lam, x) * (1.0 - smoothstep(2.0 * da0, 3.0 * da0, ada));
  return amp * env * sin(TWO_PI * x / lam);
}
float rlEdgeDisplacement(float r, float theta) {
  float d = 0.0;
  d += rlEdgeWave(r, theta, uRlPan, 160.0e3);
  d += rlEdgeWave(r, theta, vec4(uRlDaphnis.xyz, uRlDaphnis.z > 0.0 ? 1.0 : 0.0), 17.0e3);
  return d;
}
// vertical displacement of the Keeler-gap edges (Daphnis' inclination) -> shadows near equinox
float rlKeelerHeight(float r, float theta) {
  vec4 m = uRlDaphnis;
  if (m.w == 0.0) return 0.0;
  float da = r - m.x;
  float ada = abs(da);
  if (ada < 14.0e3 || ada > 26.0e3) return 0.0;
  float dth = rlWrapPi(theta - m.y) * (da < 0.0 ? 1.0 : -1.0);
  if (dth <= 0.0) return 0.0;
  float x = dth * r;
  float lam = 3.0 * PI * 17.5e3;
  float edge = exp(-(ada - 17.5e3) / 2.5e3);
  return m.w * edge * exp(-x / (3.0 * lam)) * smoothstep(0.0, 0.3 * lam, x) * sin(TWO_PI * x / lam);
}

// ---------------------------------------------------------------- spokes
// Fine (sub-micron) dust levitated above the B ring near equinox; forms near the morning ansa as a
// roughly radial wedge, then each radius moves at its Keplerian rate (the wedge tilts), fading in hours.
float rlSpokeTau(float r, float theta) {
  if (uRlSpokeAct.x <= 0.0 || r < 9.6e7 || r > 1.18e8) return 0.0;
  float om = sqrt(RL_GM / (r * r * r)) * (1.0 + 0.75 * 0.016290573 * pow(6.033e7 / r, 2.0));
  float tau = 0.0;
  for (int k = 0; k < RL_SPOKES; k++) {
    vec4 S = uRlSpoke[k];
    float age = S.y;
    if (age <= 0.0) continue;
    float seed = S.w;
    float halfLen = 3.0e6 + 5.0e6 * fract(seed * 7.13);
    float dr = (r - S.z) / halfLen;
    if (abs(dr) > 1.0) continue;
    float life = 5000.0 + 9000.0 * fract(seed * 3.71);
    float amp = smoothstep(0.0, 900.0, age) * exp(-age / life);
    float width = (6.0e5 + 1.8e6 * fract(seed * 5.37)) * (1.0 + 0.5 * dr * dr);
    float th = S.x + om * age;
    float x = rlWrapPi(theta - th) * r;
    float radial = 1.0 - dr * dr;
    tau += amp * radial * radial * exp(-0.5 * x * x / (width * width)) * (0.5 + fract(seed * 11.3));
  }
  return uRlSpokeAct.x * uRlSpokeAct.y * tau;
}

// ---------------------------------------------------------------- unresolved self-gravity wakes
// Statistical form of the SAME wake field the near-field march samples explicitly (so the march -> sheet
// handover is seamless): two column types measured from the live shared wakeDensity — dense wakes (area
// fraction fB, density factor Wb) and gaps (Wg), fB Wb + (1 - fB) Wg = 1. A ray scatters in one column;
// its sunward and viewing paths stay in that column while their horizontal run across the crests is
// short and average over the pattern once it exceeds ~half a wake spacing:
//   W_path = mix(W_col, 1, smoothstep(0, 0.5, Heff |dir . n| / (|dir_z| lambda))),  Heff = 0.45 H.
// Looking along the wakes keeps the paths in the gaps (more transparent, darker in reflection); looking
// across them averages (classical) — the origin of the A ring's azimuthal asymmetry and of its
// viewing-direction-dependent transparency (Colwell et al. 2006; Hedman et al. 2007).
float rlToomre(float r, RlS S) {
  float sig = S.D * 450.0 * S.H;              // surface density (PARTICLE_DENSITY * D * H)
  float rr = r / max(uRingR0, 1.0);
  if (uRlWakeLamRef.y > 0.0) return max(uRlWakeLamRef.x * (sig / uRlWakeLamRef.y) * rr * rr * rr, 2.0);
  return max(39.478 * 6.674e-11 * sig * r * r * r / RL_GM, 2.0);
}

// main-ring sheet radiance at the plane hit. p: camera-relative hit; dr: precise radius offset from r0;
// theta: SEF azimuth; fp: radial footprint (m). Returns radiance L and transmission T.
void rlMainSheet(vec3 rd, vec3 p, float dr, float theta, float fp, out vec3 L, out float T, out float tauOut) {
  L = vec3(0.0);
  T = 1.0;
  tauOut = 0.0;
  float r = uRingR0 + dr;
  // moonlet edge waves displace the streamlines -> sample the profile at the unperturbed radius
  float drs = dr - rlEdgeDisplacement(r, theta);
  float fi0 = uRingIdx0 + drs / uRingDr0;
  RlS S = rlSample(fi0, fp);
  float xF = uRlIdx0F + drs / uRingDr0;
  float kF = floor(xF);
  float tauRef = rlTauM(S, 0.918);
  rlScaleTau(S, rlFineFactor(uRlIdx0I + kF, xF - kF, fp, tauRef, S.wake));
  tauRef = rlTauM(S, 0.918);
  float spoke = rlSpokeTau(r, theta);
  tauOut = tauRef;
  if (tauRef <= 1e-7 && spoke <= 0.0) return;

  vec3 V = -rd;                              // toward the viewer
  float mu = max(abs(rd.z), 1e-4);
  float mu0 = max(uRlMu0, 1e-3);
  float vSide = sign(V.z);                   // +1: viewer north of the plane
  bool lit = vSide == uRlSunSign;
  float cosA = dot(uSunDir, V);
  float vis = rlSunVis(p);
  vec3 eR = vec3(cos(theta), sin(theta), 0.0);
  vec3 eP = vec3(-sin(theta), cos(theta), 0.0);
  // Keeler-gap vertical edge waves (Daphnis' inclined orbit) shadow the adjacent ring: the sun ray from
  // a point at distance `dist` from the edge, heading toward the gap, passes the edge at height
  // dist * mu0 / |sunDir . eR|
  float kh = rlKeelerHeight(r, theta);
  if (lit && kh * uRlSunSign > 0.0) {
    float toward = sign(uRlDaphnis.x - r);
    float sr = dot(uSunDir, eR) * toward;
    if (sr > 0.0) {
      float dist = abs(abs(r - uRlDaphnis.x) - 17.5e3);
      float hEdge = dist * mu0 / max(sr, 1e-3);
      vis *= smoothstep(0.6, 1.0, hEdge / abs(kh));
    }
  }

  // ---- direct sunlight, with unresolved wakes as a two-column mixture
  float ws = uRlWakeStat.w > 0.0 ? clamp(S.wake / uRlWakeStat.w, 0.0, 2.0) * uRlWakeScale : 0.0;
  float fB = uRlWakeStat.x;
  vec3 IFsun;
  if (ws * fB > 1e-3) {
    float Wb = max(1.0 + (uRlWakeStat.y - 1.0) * ws, 0.02);
    float Wg = max(1.0 + (uRlWakeStat.z - 1.0) * ws, 0.02);
    float mW = fB * Wb + (1.0 - fB) * Wg;
    Wb /= mW;
    Wg /= mW;
    vec3 nW = uRlWakeNrm.x * eR + uRlWakeNrm.y * eP;
    float lam = rlToomre(r, S);
    vec2 hk = lit ? uRlWakeHeff.xy : uRlWakeHeff.zw;       // decorrelation heights (view, sun) / H
    float cv = smoothstep(0.0, 0.5, hk.x * S.H * abs(dot(V, nW)) / (mu * lam));
    float cs = smoothstep(0.0, 0.5, hk.y * S.H * abs(dot(uSunDir, nW)) / (mu0 * lam));
    float Wvb = mix(Wb, 1.0, cv), Wsb = mix(Wb, 1.0, cs);
    float Wvg = mix(Wg, 1.0, cv), Wsg = mix(Wg, 1.0, cs);
    IFsun = fB * rlLayerIFW(S, mu, mu0, cosA, lit, Wb, Wsb, Wvb) + (1.0 - fB) * rlLayerIFW(S, mu, mu0, cosA, lit, Wg, Wsg, Wvg);
    T = mix(1.0, fB * rlTransW(S, mu, Wvb) + (1.0 - fB) * rlTransW(S, mu, Wvg), S.cover);
  } else {
    IFsun = rlLayerIF(S, mu, mu0, cosA, lit);
    T = mix(1.0, rlTrans(S, mu), S.cover);
  }
  vec3 IF = IFsun * vis;

  // ---- Saturnshine: each face is lit by the half of Saturn's disk on its side (a beam from the
  // half-disk centroid, elevation 4/(3 pi) of Saturn's angular radius)
  vec3 dS;
  float Es = saturnshine(p, dS);
  if (Es > 0.0) {
    float dist = length(uSaturnCenter - p);
    float thS = asin(clamp(uSaturnRadii.x / dist, 0.0, 1.0));
    float thC = 0.4244 * thS;
    vec3 hdir = normalize(vec3(dS.xy, 0.0) + vec3(1e-9, 0.0, 0.0));
    float muB = sin(thC);
    vec3 bSame = hdir * cos(thC) + vec3(0.0, 0.0, vSide * muB);
    vec3 bOther = hdir * cos(thC) - vec3(0.0, 0.0, vSide * muB);
    float k = 0.5 * Es / max(uSunE, 1e-9);
    IF += k * (rlLayerIF(S, mu, muB, dot(bSame, V), true) + rlLayerIF(S, mu, muB, dot(bOther, V), false));
  }

  // ---- spokes: a thin dust layer over the ring (dark in back-scatter, bright in forward scatter)
  if (spoke > 0.0) {
    float att = exp(-0.5 * spoke * (1.0 / mu + 1.0 / mu0));
    float Pd = rlPhase(cosA, 1.0);
    IF = IF * att + vis * vec3(0.8, 0.85, 0.9) * 0.25 * Pd * spoke / mu * (lit ? 1.0 : exp(-tauRef / mu0));
    T *= exp(-spoke / mu);
  }
  L = IF * (uSunE * INV_PI);
}
