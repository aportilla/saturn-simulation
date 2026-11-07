// ===== ring layer: optics ====================================================================
// Radiative transfer of the ring material as a plane-parallel particulate layer. Requires SV_HEADER_ALL.
//
// Conventions: t = vertical (normal) optical depth measured from the face a beam illuminates; mu = |cos|
// of the viewing direction to the ring normal, mu0 the same for the beam. All brightnesses are I/F
// (radiance = I/F * E / pi, E = beam irradiance normal to the beam).
//
//   single scattering (exact, any phase function P = ringPhase):
//     reflection   I/F = w P/4 * (1 - exp(-k tau)) / (k mu),   k = 1/mu0 + 1/mu - b/max(mu,mu0)
//     transmission I/F = w P/4 * (exp(-tau/mu0) - exp(-tau/mu)) / (1 - mu/mu0)
//   b = interparticle shadow hiding (Irvine 1966; Hapke 1986): near opposition the incident and emergent
//     rays share their path, so the joint transmission is exp(-tau_i - tau_e + b min(tau_i, tau_e)),
//     b(alpha) = 1 / (1 + tan(alpha/2)/h), h = 3D/8 (D = volume filling factor). This is the broad
//     opposition effect of dense rings, a property of the ensemble.
//   multiple scattering: two-stream (hemispheric-mean) solution for the diffuse fluxes F+/F- of light
//     scattered >= 1 times, sourced by the direct beam (backscattered fraction beta0(mu0) from the exact
//     phase function); its re-scattering into the viewing direction (hemispheric weights beta / 1-beta)
//     is integrated analytically along the line of sight. Light scattered exactly once is NOT in the
//     two-stream part, so nothing is double counted.

uniform sampler2D uRlP0;        // tau_eff(m_k) for m_k = 0.3^k, k = 0..3
uniform sampler2D uRlP1;        // (tau_eff(m_4), H, wake, D)
uniform sampler2D uRlP2;        // (albedo rgb, dust)
uniform sampler2D uRlPhaseLut;  // (beta0 macro, beta0 dust) at mu = i/63
uniform float uRlBetaM;         // diffuse back-scatter fraction, macroscopic particles
uniform float uRlBetaD;         // diffuse back-scatter fraction, dust
uniform float uRlSunSign;       // sign(sunDir.z): +1 -> north face lit
uniform float uRlMu0;           // |sunDir.z|
uniform float uRlIdx0I;         // level-0 index of the ring-frame origin: integer part
uniform float uRlIdx0F;         //   and fractional part (double precision split on the CPU)
uniform float uRlPhi0;          // SEF azimuth of the ring-frame origin (rad)
uniform float uRlShScale;       // shadow-hiding width multiplier
uniform float uRlFineAmp;       // sub-km structure amplitude multiplier
uniform float uRlCoarse;        // spacing of the coarsest pyramid level (m)
uniform float uRlPhaseModel;    // 0: Lambert sphere (diagnostics); 1: power law (Dones et al. 1993) = shared ringPhase
uniform float uRlPhaseN;        // power-law index n
uniform float uRlPhaseC;        // power-law normalization (Int P dOmega = 4 pi)
uniform float uRlSSScale;       // diagnostics: scale of the single-scattering term (1)
uniform float uRlMSScale;       // diagnostics: scale of the multiple-scattering term (1)
uniform float uRlWakeScale;     // diagnostics: scale of the granola wake strength (1)

#define RL_MLOG -1.2039728043   // ln(0.3)

// Ensemble phase function of the ring material (normalized to 4 pi). cosA = cos(phase angle).
// Macroscopic particles: power law C (1 - alpha/pi)^n with the shared intrinsic opposition surge;
// dust: the shared forward-scattering double Henyey-Greenstein (identical to ringPhase's dust term).
float rlPhase(float cosA, float dust) {
  if (uRlPhaseModel < 0.5) return ringPhaseLambert(cosA, dust);
  float a = acos(clamp(cosA, -1.0, 1.0));
  float macro = uRlPhaseC * pow(max(1.0 - a * INV_PI, 0.0), uRlPhaseN) * (1.0 + 0.5 * exp(-a / 0.05));
  if (dust <= 0.0) return macro;
  float cosT = -cosA;
  float d = 0.75 * phaseHG(cosT, 0.85) + 0.25 * phaseHG(cosT, 0.3);
  return mix(macro, d, dust);
}

float rlDexp(float a, float b, float x) {
  // (exp(-a x) - exp(-b x)) / (b - a), stable for a ~ b
  float d = (b - a) * x;
  if (abs(d) < 1e-3) return x * exp(-a * x) * (1.0 - 0.5 * d);
  return (exp(-a * x) - exp(-b * x)) / (b - a);
}
vec3 rlDexp3(vec3 a, float b, float x) {
  vec3 d = (b - a) * x;
  vec3 r = (exp(-a * x) - exp(-b * x)) / (b - a);
  vec3 s = x * exp(-a * x) * (1.0 - 0.5 * d);
  return mix(r, s, step(abs(d), vec3(1e-3)));
}

// ---------------------------------------------------------------- pixel footprint
// Radial extent (m) of this pixel's footprint on the ring plane at hit distance t (camera-relative hit
// p), from the ray differentials of one pixel step in x and y; plus the second-order radial spread of
// the azimuthal extent (matters at the ansae at grazing elevation).
float rlFootprint(vec3 rd, float t, vec3 p) {
  vec3 cx = uCamToWorld * vec3(1.0, 0.0, 0.0);
  vec3 cy = uCamToWorld * vec3(0.0, 1.0, 0.0);
  float vlen = 1.0 / max(-(uWorldToCam * rd).z, 1e-6);
  vec3 drx = (cx - rd * dot(rd, cx)) * (uPixelAngle * vlen);
  vec3 dry = (cy - rd * dot(rd, cy)) * (uPixelAngle * vlen);
  float iz = 1.0 / (abs(rd.z) > 1e-9 ? rd.z : 1e-9);
  vec3 dPx = t * (drx - rd * (drx.z * iz));
  vec3 dPy = t * (dry - rd * (dry.z * iz));
  vec2 q = (p + uCamPos).xy;
  float rq = max(length(q), 1.0);
  vec2 er = q / rq;
  vec2 ea = vec2(-er.y, er.x);
  float rx = dot(dPx.xy, er), ry = dot(dPy.xy, er);
  float ax = dot(dPx.xy, ea), ay = dot(dPy.xy, ea);
  return sqrt(rx * rx + ry * ry) + (ax * ax + ay * ay) / (2.0 * rq) + 1e-3;
}

// ---------------------------------------------------------------- shadows (fast paths)
// Same results as sv_saturn saturnSunVisibility / sv_lighting moonsSunVisibility, with a cheap
// rejection test (point outside the body's shadow cylinder + penumbra) before the transcendental math.
float rlSaturnVis(vec3 p) {
  vec3 c = p - uSaturnCenter;
  float along = dot(c, uSunDir);
  if (along > 0.0) return 1.0;
  vec3 perp = c - along * uSunDir;
  float R = uSaturnRadii.x * 1.02 - along * uSunAngRadius * 1.5;
  if (dot(perp, perp) > R * R) return 1.0;
  return saturnSunVisibility(p);
}
float rlMoonsVis(vec3 p) {
  float vis = 1.0;
  for (int i = 0; i < MAX_MOONS; i++) {
    if (i >= uMoonCount) break;
    vec3 c = uMoonPosR[i].xyz - p;
    float R = uMoonPosR[i].w;
    float along = dot(c, uSunDir);
    if (along <= -R) continue;
    vec3 perp = c - along * uSunDir;
    float rr = R + max(along, 0.0) * uSunAngRadius * 1.5;
    if (dot(perp, perp) > rr * rr) continue;
    float d = length(c);
    if (d <= R) return 0.0;
    float angM = asin(R / d);
    float sep = acos(clamp(dot(c / d, uSunDir), -1.0, 1.0));
    if (sep >= angM + uSunAngRadius) continue;
    vis *= 1.0 - diskOverlapFraction(sep, uSunAngRadius, angM);
  }
  return vis;
}
float rlSunVis(vec3 p) { return rlSaturnVis(p) * rlMoonsVis(p); }

// ---------------------------------------------------------------- profile sampling
struct RlS {
  vec4 t0;      // tau_eff(m) at m = 1, .3, .09, .027
  float t4;     //   and m = .0081
  float H;      // full thickness (m)
  float wake;   // self-gravity wake strength
  float D;      // volume filling factor
  vec3 alb;     // single-scattering albedo
  float dust;   // dust fraction of tau
  float cover;  // coverage factor for footprints beyond the coarsest level (1 = none)
};

RlS rlEmpty() {
  RlS s;
  s.t0 = vec4(0.0); s.t4 = 0.0; s.H = 10.0; s.wake = 0.0; s.D = 0.0; s.alb = vec3(0.5); s.dust = 1.0; s.cover = 1.0;
  return s;
}

float rlTauM(RlS s, float m) {
  float k = clamp(log(max(m, 1e-6)) / RL_MLOG, 0.0, 4.0);
  if (k < 1.0) return mix(s.t0.x, s.t0.y, k);
  if (k < 2.0) return mix(s.t0.y, s.t0.z, k - 1.0);
  if (k < 3.0) return mix(s.t0.z, s.t0.w, k - 2.0);
  return mix(s.t0.w, s.t4, k - 3.0);
}
// mean transmission <exp(-tau/m)> over the footprint
float rlTrans(RlS s, float m) { return exp(-rlTauM(s, m) / max(m, 1e-6)); }

void rlFetchLevel(float fi0, int L, float sharpW, out vec4 a, out vec4 b, out vec4 c) {
  float sc = exp2(float(L));
  float fi = (fi0 - 0.5 * (sc - 1.0)) / sc;
  int n = uRingLevelN[L];
  float cc = clamp(fi, 0.0, float(n - 1));
  int i0 = int(floor(cc));
  int i1 = min(i0 + 1, n - 1);
  float f = cc - float(i0);
  int off = uRingLevelOff[L];
  ivec2 q0 = ringTexel(off + i0), q1 = ringTexel(off + i1);
  vec4 a0 = texelFetch(uRlP0, q0, 0), a1 = texelFetch(uRlP0, q1, 0);
  if (sharpW < 0.5) {
    // sub-sample footprint at level 0: real edges are sharp (tens of m) while the data are a 250 m grid
    // with edges deconvolved to steps -> put a steep transition at the cell midpoint where tau jumps
    float lo = min(a0.y, a1.y), hi = max(a0.y, a1.y);
    if (hi > 2.5 * lo + 0.02) f = smoothstep(0.5 - sharpW, 0.5 + sharpW, f);
  }
  a = mix(a0, a1, f);
  b = mix(texelFetch(uRlP1, q0, 0), texelFetch(uRlP1, q1, 0), f);
  c = mix(texelFetch(uRlP2, q0, 0), texelFetch(uRlP2, q1, 0), f);
}

// fi0: level-0 fractional index; fp: radial footprint (m)
RlS rlSample(float fi0, float fp) {
  float nTot = float(uRingLevelN[0]);
  if (fi0 < -0.5 || fi0 > nTot - 0.5) return rlEmpty();
  float lev = clamp(log2(max(fp, uRingDr0) / uRingDr0), 0.0, float(uRingLevels - 1));
  int L0 = int(floor(lev));
  int L1 = min(L0 + 1, uRingLevels - 1);
  float lf = lev - float(L0);
  float sharpW = L0 == 0 && lf < 0.001 ? clamp(0.5 * max(fp, 15.0) / uRingDr0, 0.02, 0.5) : 1.0;
  vec4 a, b, c;
  rlFetchLevel(fi0, L0, sharpW, a, b, c);
  if (lf > 0.001 && L1 != L0) {
    vec4 a1, b1, c1;
    rlFetchLevel(fi0, L1, 1.0, a1, b1, c1);
    a = mix(a, a1, lf); b = mix(b, b1, lf); c = mix(c, c1, lf);
  }
  RlS s;
  s.t0 = a; s.t4 = b.x; s.H = b.y; s.wake = b.z; s.D = b.w; s.alb = c.rgb; s.dust = c.a;
  s.cover = clamp(uRlCoarse / max(fp, 1.0), 0.0, 1.0);
  return s;
}

void rlScaleTau(inout RlS s, float f) { s.t0 *= f; s.t4 *= f; }

// ---------------------------------------------------------------- sub-km radial structure
// Occultation profiles resolve ~1 km; real rings have structure down to ~10 m (B-ring irregular
// structure, plateau sub-structure, wave troughs). Multi-octave value noise in radius, 500 m .. 16 m,
// faded below the footprint; multiplicative and mean-preserving. cellI/cellF: precise level-0 index.
float rlFineNoise(float cellI, float cellF, float fp) {
  uint ci = uint(max(cellI, 0.0));
  float s = 0.0, norm = 0.0;
  for (int j = -1; j <= 4; j++) {
    float lam = uRingDr0 * exp2(float(-j));
    float amp = sqrt(lam / uRingDr0);
    norm += amp;
    float wv = clamp((lam / max(fp, 1e-3) - 1.0) * 0.5, 0.0, 1.0);
    if (wv <= 0.0) continue;
    uint idx;
    float loc;
    if (j < 0) {
      idx = ci >> 1;
      loc = (float(ci & 1u) + cellF) * 0.5;
    } else {
      float sub = cellF * exp2(float(j));
      float fl = floor(sub);
      idx = (ci << uint(j)) + uint(fl);
      loc = sub - fl;
    }
    uint salt = uint(j + 2) * 0x9E3779B9u;
    float h0 = hashU(pcgHash(idx ^ salt)) * 2.0 - 1.0;
    float h1 = hashU(pcgHash((idx + 1u) ^ salt)) * 2.0 - 1.0;
    float u = loc * loc * (3.0 - 2.0 * loc);
    s += wv * amp * mix(h0, h1, u);
  }
  return s / norm;
}
// multiplicative tau factor; amplitude per region (irregular B ring strongest)
float rlFineFactor(float cellI, float cellF, float fp, float tau, float wake) {
  if (uRlFineAmp <= 0.0 || fp > 2.0 * uRingDr0 || tau <= 0.0) return 1.0;
  float A = uRlFineAmp * (0.22 + 0.35 * smoothstep(1.0, 3.0, tau) + 0.1 * wake);
  return max(0.08, 1.0 + A * rlFineNoise(cellI, cellF, fp));
}

// ---------------------------------------------------------------- phase helpers
float rlBeta0(float mu, float dust) {
  vec2 b = texture(uRlPhaseLut, vec2((clamp(mu, 0.0, 1.0) * 63.0 + 0.5) / 64.0, 0.5)).rg;
  return mix(b.r, b.g, dust);
}
float rlBeta(float dust) { return mix(uRlBetaM, uRlBetaD, dust); }
// shadow-hiding correlation coefficient b(alpha) for filling factor D
float rlShadowHiding(float cosA, float D) {
  float h = max(0.375 * D * uRlShScale, 1e-5);
  float a = acos(clamp(cosA, -1.0, 1.0));
  return 1.0 / (1.0 + tan(min(0.5 * a, 1.5)) / h);
}

// ---------------------------------------------------------------- two-stream (per colour channel)
struct RlTS {
  vec3 Ap, B, U, V, lam, G;
  float mu0, tau;
};
// tau: layer optical depth; w: albedo; beta: diffuse back-scatter fraction; beta0: beam back-scatter
// fraction; mu0: beam direction cosine. Unit beam irradiance. Boundary: no diffuse light incident.
RlTS rlTwoStream(float tau, vec3 w, float beta, float beta0, float mu0) {
  RlTS s;
  mu0 = max(mu0, 2e-3);
  tau = max(tau, 0.0);
  vec3 g1 = 2.0 * (1.0 - w * (1.0 - beta));
  vec3 g2 = 2.0 * w * beta;
  vec3 lam = sqrt(max(g1 * g1 - g2 * g2, vec3(1e-8)));
  vec3 G = g2 / (g1 + lam);
  float im = 1.0 / mu0;
  vec3 det = im * im - lam * lam;
  vec3 sg = mix(vec3(-1.0), vec3(1.0), step(vec3(0.0), det));
  det = sg * max(abs(det), 1e-3 * (im * im + lam * lam));
  vec3 U = w * (-beta0 * (g1 - im) - g2 * (1.0 - beta0)) / det;
  vec3 V = -w * ((g1 + im) * (1.0 - beta0) + g2 * beta0) / det;
  vec3 e = exp(-lam * tau);
  float em = exp(-tau * im);
  vec3 Ap = (-U * em + V * G * e) / (1.0 - G * G * e * e);
  vec3 Bc = -V - Ap * G * e;
  s.Ap = Ap; s.B = Bc; s.U = U; s.V = V; s.lam = lam; s.G = G; s.mu0 = mu0; s.tau = tau;
  return s;
}
// diffuse fluxes (per unit beam irradiance) toward the beam face (fu) and away from it (fd) at depth t
void rlTSFlux(RlTS s, float t, out vec3 fu, out vec3 fd) {
  t = clamp(t, 0.0, s.tau);
  vec3 a = exp(-s.lam * (s.tau - t));
  vec3 b = exp(-s.lam * t);
  float c = exp(-t / s.mu0);
  fu = s.Ap * a + s.B * s.G * b + s.U * c;
  fd = s.Ap * s.G * a + s.B * b + s.V * c;
}
// multiply-scattered source (I/F per unit optical depth along the ray) for light travelling toward the
// beam face (towardFace = 1) or away from it (0); intermediate values blend (near-horizontal rays)
vec3 rlTSSource(RlTS s, vec3 w, float beta, float t, float towardFace) {
  vec3 fu, fd;
  rlTSFlux(s, t, fu, fd);
  vec3 up = (1.0 - beta) * fu + beta * fd;
  vec3 dn = (1.0 - beta) * fd + beta * fu;
  return w * max(mix(dn, up, towardFace), vec3(0.0));
}
// emergent multiply-scattered I/F, viewer on the beam face
vec3 rlTSEmergeRefl(RlTS s, vec3 w, float beta, float mu) {
  mu = max(mu, 1e-4);
  float im = 1.0 / mu;
  vec3 I1 = rlDexp3(s.lam, im, s.tau) / mu;
  vec3 I2 = (1.0 - exp(-(s.lam + im) * s.tau)) / (s.lam * mu + 1.0);
  float I3 = (1.0 - exp(-(1.0 / s.mu0 + im) * s.tau)) / (mu / s.mu0 + 1.0);
  float cu = 1.0 - beta, cd = beta;
  return w * max((cu + cd * s.G) * s.Ap * I1 + (cu * s.G + cd) * s.B * I2 + (cu * s.U + cd * s.V) * I3, vec3(0.0));
}
// emergent multiply-scattered I/F, viewer on the opposite face
vec3 rlTSEmergeTrans(RlTS s, vec3 w, float beta, float mu) {
  mu = max(mu, 1e-4);
  float im = 1.0 / mu;
  vec3 J1 = (1.0 - exp(-(s.lam + im) * s.tau)) / (s.lam * mu + 1.0);
  vec3 J2 = rlDexp3(s.lam, im, s.tau) / mu;
  float J3 = rlDexp(1.0 / s.mu0, im, s.tau) / mu;
  float cdn = 1.0 - beta, cup = beta;
  return w * max((cdn * s.G + cup) * s.Ap * J1 + (cdn + cup * s.G) * s.B * J2 + (cdn * s.V + cup * s.U) * J3, vec3(0.0));
}

// ---------------------------------------------------------------- layer I/F (column-resolved)
// Mean transmission <exp(-Wf tau / m)> of the prefiltered layer with its column density scaled by Wf.
float rlTransW(RlS s, float m, float Wf) {
  float mm = max(m, 1e-6) / max(Wf, 1e-3);
  return exp(-rlTauM(s, mm) / mm);
}
// I/F of the (prefiltered) layer lit by a beam (direction cosine muB, phase cos(alpha) = cosA); viewer at
// mu on the beam face (refl) or the opposite face. Includes single scattering, shadow hiding and MS.
// Column-resolved form for unresolved self-gravity wakes: density factor We of the column the light is
// scattered in, Ws averaged along the sunward path and Wv along the viewing path (the paths decorrelate
// from the column as they cross wake crests). We = Ws = Wv = 1 is the classical homogeneous layer.
//   refl:  w P/4 We (1 - exp(-k tau)) / (k mu),   k = Ws/muB + Wv/mu - b min(Ws/muB, Wv/mu)
//   trans: w P/4 We (exp(-Ws tau/muB) - exp(-Wv tau/mu)) / (mu (Wv/mu - Ws/muB))
vec3 rlLayerIFW(RlS s, float mu, float muB, float cosA, bool refl, float We, float Ws, float Wv) {
  mu = max(mu, 1e-4);
  muB = max(muB, 1e-3);
  float P = rlPhase(cosA, s.dust);
  vec3 w = s.alb;
  float beta = rlBeta(s.dust);
  float b0 = rlBeta0(muB, s.dust);
  RlTS ts = rlTwoStream(rlTauM(s, 0.5) * We, w, beta, b0, muB);
  vec3 ss;
  vec3 ms;
  if (refl) {
    float bsh = rlShadowHiding(cosA, s.D);
    float as = Ws / muB, av = Wv / mu;
    float k = as + av - bsh * min(as, av);
    float Tk = exp(-k * rlTauM(s, 1.0 / k));
    ss = w * (0.25 * P * We) * (1.0 - Tk) / (k * mu);
    ms = rlTSEmergeRefl(ts, w, beta, mu);
  } else {
    float Tb = rlTransW(s, muB, Ws), Tm = rlTransW(s, mu, Wv);
    float d = Wv / mu - Ws / muB;
    float f = abs(d) * mu < 0.02 * Wv ? rlTauM(s, muB / max(Ws, 1e-3)) * Tb / mu : (Tb - Tm) / (d * mu);
    ss = w * (0.25 * P * We) * max(f, 0.0);
    ms = rlTSEmergeTrans(ts, w, beta, mu);
  }
  return (ss * uRlSSScale + ms * uRlMSScale) * s.cover;
}
vec3 rlLayerIF(RlS s, float mu, float muB, float cosA, bool refl) {
  return rlLayerIFW(s, mu, muB, cosA, refl, 1.0, 1.0, 1.0);
}
