// ===== ring layer: main-ring thin sheet (far field) ===========================================
// Requires rlOptics. The profile is sampled through sv_ringStructure (moonlet-perturbed gap edges etc.).

#define RL_SPOKES 12
uniform vec4 uRlSpoke[RL_SPOKES];   // (formation longitude [rad], age [s], centre radius [m], seed 0..1)
uniform vec2 uRlSpokeAct;           // (seasonal activity 0..1, peak tau)
uniform vec4 uRlWakeStat;           // measured wake statistics: (fB, Wb, Wg, profile wake value they refer to)
uniform vec2 uRlWakeNrm;            // unit normal to the wake crests, (radial, azimuthal) components
uniform vec2 uRlWakeLamRef;         // (Toomre wavelength at the anchor [m], surface density there [kg/m^2])
uniform float uRlWakeReach;         // radial reach of the explicit wake field (clipmap) around the anchor [m]; 0: none
uniform vec4 uRlWakeHeff;           // path decorrelation heights / H: (lit view, lit sun, unlit view, unlit sun)

const float RL_GM = 3.79312062e16;

float rlWrapPi(float a) { return a - TWO_PI * floor((a + PI) / TWO_PI); }

// (moonlet edge waves: the streamline model of sv_ringStructure, applied to every profile lookup)

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
// short and average over the pattern once it exceeds ~half a wake spacing (reflection):
//   W_path = mix(W_col, 1, smoothstep(0, 0.5, Heff |dir . n| / (|dir_z| lambda))),  Heff = uRlWakeHeff * H.
// The transmission through the whole layer uses the measured path statistics instead (rlTransWakes below).
// Looking along the wakes keeps the paths in the gaps (more transparent, darker in reflection); looking
// across them averages (classical) — the origin of the A ring's azimuthal asymmetry and of its
// viewing-direction-dependent transparency (Colwell et al. 2006; Hedman et al. 2007).
// The TRANSMISSION of a path through the whole layer needs more than the class means: per column class (of the
// point where the path crosses the mid-plane) the density averaged along the path has a spread that, through the
// convexity of exp, raises the mean transmission (most light gets through the emptiest gaps), and the class means
// decorrelate only slowly (a path running 1 wake spacing across the crests over the layer's thickness still keeps
// ~70 % of the class contrast: the column is concentrated within ~0.25 H). Both are measured from the live field
// as functions of chi = H |dir . n| / (|dir_z| lambda) (RingLayerPass path-statistics probe at chi = uRlKerX: uRlKerT
// = class mean and variance of the path density, uRlKerF = its class minimum), and the path density of each class
// is taken as a Gamma distribution above that floor F: <exp(-a X)> = exp(-a F) (1 + a v / (m - F))^(-(m - F)^2 / v)
// (bounded by the emptiest paths, exp(-a F), at large a). Against explicit paths through the field this is exact
// to a few % (the class means alone underestimated the transmission across the wakes by up to 2x).
uniform float uRlKerX[RL_KER_NX];
uniform vec4 uRlKerT[RL_KER_NX];
uniform vec2 uRlKerF[RL_KER_NX];
uniform float uRlKerSig;    // rms height of the layer's column (units of H): the path kernel's across-crest std is chi lambda uRlKerSig
// interpolation weight of chi between table entries i and i + 1
int rlKerIndex(float chi, out float f) {
  int i = 0;
  for (int j = 1; j < RL_KER_NX - 1; j++) if (chi >= uRlKerX[j]) i = j;
  f = clamp((chi - uRlKerX[i]) / (uRlKerX[i + 1] - uRlKerX[i]), 0.0, 1.0);
  return i;
}
// <exp(-a X)> for X = F + a Gamma variable of mean m - F and variance v
float rlGammaMGF(float a, float m, float v, float F) {
  float e = m - F;
  if (e < 1e-4 || v < 1e-8) return exp(-a * m);
  float th = v / e;
  float x = a * th;
  float l1p = x < 0.01 ? x * (1.0 - x * (0.5 - x / 3.0)) : log(1.0 + x);
  return exp(-a * F - (e / th) * l1p);
}
// mean transmission of the prefiltered layer along a path of direction cosine m whose column density factor has
// mean Wm, variance Wv and floor F; Wv = 0 gives rlTransW
float rlTransG(RlS s, float m, float Wm, float Wv, float F) {
  float mm = max(m, 1e-6) / max(Wm, 1e-3);
  return rlGammaMGF(rlTauM(s, mm) / max(m, 1e-6), Wm, Wv, F);
}
// path statistics at chi scaled to the local wake strength ws (density 1 + (W - 1) ws, variance x ws^2) and
// normalized by the columns' mean density mW: p = (dense m, v, gap m, v), floors fl = (dense, gap)
void rlWakePathScaled(float chi, float ws, float mW, out vec4 p, out vec2 fl) {
  float f;
  int i = rlKerIndex(chi, f);
  vec4 ps = mix(uRlKerT[i], uRlKerT[i + 1], f);
  vec2 pf = mix(uRlKerF[i], uRlKerF[i + 1], f);
  float k2 = ws * ws / (mW * mW);
  p = vec4(max((1.0 + (ps.x - 1.0) * ws) / mW, 0.02), ps.y * k2, max((1.0 + (ps.z - 1.0) * ws) / mW, 0.02), ps.w * k2);
  fl = min(max((1.0 + (pf - 1.0) * ws) / mW, vec2(0.0)), p.xz);
}
// mean transmission of the two wake columns along a path through the whole layer (direction cosine m)
float rlTransWakes(RlS s, float m, float chi, float fB, float ws, float mW) {
  vec4 p;
  vec2 fl;
  rlWakePathScaled(chi, ws, mW, p, fl);
  return fB * rlTransG(s, m, p.x, p.y, fl.x) + (1.0 - fB) * rlTransG(s, m, p.z, p.w, fl.y);
}
// the same for a path of known mean-layer optical depth a (the march's statistical column)
float rlTransWakesTau(float a, float chi, float fB, float ws, float mW) {
  vec4 p;
  vec2 fl;
  rlWakePathScaled(chi, ws, mW, p, fl);
  return fB * rlGammaMGF(a, p.x, p.y, fl.x) + (1.0 - fB) * rlGammaMGF(a, p.z, p.w, fl.y);
}

float rlToomre(float r, RlS S) {
  float sig = S.D * 450.0 * S.H;              // surface density (PARTICLE_DENSITY * D * H)
  float rr = r / max(uRingR0, 1.0);
  if (uRlWakeLamRef.y > 0.0) return max(uRlWakeLamRef.x * (sig / uRlWakeLamRef.y) * rr * rr * rr, 2.0);
  return max(39.478 * 6.674e-11 * sig * r * r * r / RL_GM, 2.0);
}
// Toomre wavelength for the unresolved-wake statistics (path ratio chi, decorrelation): the explicit wake field and the
// statistics measured from it (uRlWakeStat) have the anchor's wavelength throughout the field's reach, so within it the
// sheet and the march's statistical branch use the anchor's too (otherwise they disagree with the explicit field across
// the march -> sheet handover: test:seam --only handover); the local wavelength takes over beyond the reach.
float rlWakeLambda(float r, RlS S) {
  float lamLoc = rlToomre(r, S);
  if (uRlWakeReach <= 0.0 || uRlWakeLamRef.y <= 0.0) return lamLoc;
  return mix(uRlWakeLamRef.x, lamLoc, smoothstep(0.5 * uRlWakeReach, uRlWakeReach, abs(r - uRingR0)));
}

// diagnostics of the last sheet evaluation (ring-layer debug views 24 / 25): (mid-plane height z0 [m], relief sun
// visibility, solar incidence cosine on the lit face of the local layer, |slope|)
vec4 gRlRelief = vec4(0.0, 1.0, 0.0, 0.0);

// main-ring sheet radiance at the hit with the displaced mid-plane (sv_ringReliefShade ringReliefHit). p:
// camera-relative hit; dr: precise radius offset from r0; theta: SEF azimuth; fp: radial footprint (m); st: the
// structure state at the hit (streamline map + relief: .zeta, .slope). Returns radiance L and transmission T.
// Relief: the layer is shaded in its own tilted frame -- normal n from the slope, viewing cosine |V.n|, solar incidence
// on each face (extended solar disk: the terminator of a tilt is soft), the relief's shadows (horizon toward the Sun),
// transmission of the background through the tilted layer exp(-tau / |V.n|).
// un (LOD contract, rlMain): (the share of tau the medium carries, its participation in the wakes relative to the
// whole column's, the share of its tau in spin-aligned classes, 0) -- (1, 1, aligned share of the column, 0) beyond the
// near field's reach. The profile's tau is the particle population's (tau_dyn with wakes) and its wake channel the
// wake strength x the column's participation (TauPyramid), so the sheet's contrast is that of D_tau = 1 + pbar (D - 1).
void rlMainSheet(vec3 rd, vec3 p, float dr, float theta, float fp, vec4 un, RingStream st, out vec3 L, out float T, out float tauOut) {
  float unresFrac = un.x;
  L = vec3(0.0);
  T = 1.0;
  tauOut = 0.0;
  float r = uRingR0 + dr;
  // 2-D ring structure (sv_ringStructure): the profile at the Lagrangian (streamline) radius, tau x J x M; the
  // footprint in Lagrangian units (crowded streamlines put more material into the same footprint). M (sub-km texture x
  // propellers) is folded into the transmission-preserving prefilter with its sub-footprint variance (rlApplyTauMod).
  vec3 lh = ringLocalFromRel(p);
  float dthh = atan(lh.y, uRingR0 + lh.x);
  float drs = dr + st.da;
  float fpL = fp * st.J;
  float xF = uRlIdx0F + drs / uRingDr0;
  RlS S = rlSampleP(uRlIdx0I, xF, fpL);
  rlScaleTau(S, unresFrac * st.J);
  rlApplyTauMod(S, st.tauMod, st.tauVar);
  float tauRef = rlTauM(S, 0.918);
  float spoke = rlSpokeTau(r, theta);
  tauOut = tauRef;
  gRlRelief = vec4(st.zeta, 1.0, 0.0, length(st.slope));
  if (tauRef <= 1e-7 && spoke <= 0.0) return;

  vec3 V = -rd;                              // toward the viewer
  vec3 eR = vec3(cos(theta), sin(theta), 0.0);
  vec3 eP = vec3(-sin(theta), cos(theta), 0.0);
  // ---- the local layer (relief): normal, viewing cosine, the viewer's face, solar incidence on both faces
  bool rel = st.slope.x != 0.0 || st.slope.y != 0.0 || st.zeta != 0.0;
  vec3 nL = rel ? ringReliefNormal(st.slope, eR, eP) : vec3(0.0, 0.0, 1.0);
  float vn = dot(V, nL);
  float mu = max(abs(vn), 1e-4);
  float vSide = vn >= 0.0 ? 1.0 : -1.0;      // +1: viewer on the normal's side of the local layer
  vec2 muS = ringReliefSunMu(nL);            // (face the normal points to, the other face)
  float mu0F = vSide > 0.0 ? muS.x : muS.y;  // the face toward the viewer (reflection)
  float mu0B = vSide > 0.0 ? muS.y : muS.x;  // the far face (transmission)
  // the main beam: the face that receives more light (with the two-column wakes); the other (only near the
  // terminator of a tilt) as a homogeneous layer
  bool lit = mu0F >= mu0B;
  float mu0 = max(lit ? mu0F : mu0B, 1e-6);
  float mu0o = lit ? mu0B : mu0F;
  float cosA = dot(uSunDir, V);
  // (relief shadows fall on flat ring too: evaluated wherever relief exists)
  float relVis = uRrOn > 0.5 || uRsOn > 0.5 ? ringReliefSunVis(drs, dthh, st.zeta, tauRef, fp) : 1.0;
  float vis = rlSunVis(p) * relVis;
  gRlRelief = vec4(st.zeta, relVis, mu0, length(st.slope));

  // ---- direct sunlight, with unresolved wakes as a two-column mixture (none in a propeller's stirred material:
  // RingStream .wakeMod); the medium's contrast includes the participation of the classes it carries (un.y)
  float ws = uRlWakeStat.w > 0.0 ? clamp(S.wake / uRlWakeStat.w, 0.0, 2.0) * uRlWakeScale * st.wakeMod * un.y : 0.0;
  float fB = uRlWakeStat.x;
  // the spin-aligned classes' cross-section along the Sun and the view (relative to isotropic)
  vec2 gA = vec2(1.0 + un.z * lodAniso(uSunDir), 1.0 + un.z * lodAniso(rd));
  vec3 IFsun;
  bool cols = ws * fB > 1e-3;
  float Wb = 1.0, Wg = 1.0, Wvb = 1.0, Wvg = 1.0, Wsb = 1.0, Wsg = 1.0;
  if (cols) {
    Wb = max(1.0 + (uRlWakeStat.y - 1.0) * ws, 0.02);
    Wg = max(1.0 + (uRlWakeStat.z - 1.0) * ws, 0.02);
    float mW = fB * Wb + (1.0 - fB) * Wg;
    Wb /= mW;
    Wg /= mW;
    vec3 nW = uRlWakeNrm.x * eR + uRlWakeNrm.y * eP;
    float lam = rlWakeLambda(r, S);
    vec2 hk = lit ? uRlWakeHeff.xy : uRlWakeHeff.zw;       // decorrelation heights (view, sun) / H
    float cv = smoothstep(0.0, 0.5, hk.x * S.H * abs(dot(V, nW)) / (mu * lam));
    float cs = smoothstep(0.0, 0.5, hk.y * S.H * abs(dot(uSunDir, nW)) / (mu0 * lam));
    Wvb = mix(Wb, 1.0, cv); Wsb = mix(Wb, 1.0, cs);
    Wvg = mix(Wg, 1.0, cv); Wsg = mix(Wg, 1.0, cs);
    IFsun = fB * rlLayerIFWA(S, mu, mu0, cosA, lit, Wb, Wsb, Wvb, gA) + (1.0 - fB) * rlLayerIFWA(S, mu, mu0, cosA, lit, Wg, Wsg, Wvg, gA);
    T = mix(1.0, rlTransWakes(S, mu / gA.y, S.H * abs(dot(V, nW)) / (mu * lam), fB, ws, mW), S.cover);
  } else {
    IFsun = rlLayerIFWA(S, mu, mu0, cosA, lit, 1.0, 1.0, 1.0, gA);
    T = mix(1.0, rlTrans(S, mu / gA.y), S.cover);
  }
  // near the terminator of a tilted patch the solar disk straddles the local horizon: the part below lights the other
  // face (homogeneous layer)
  if (mu0o > 1e-7) IFsun += rlLayerIFWA(S, mu, mu0o, cosA, !lit, 1.0, 1.0, 1.0, gA);
  vec3 IF = IFsun * vis;

  // ---- Saturnshine: each face is lit by the half of Saturn's disk on its side (a beam from the
  // half-disk centroid, elevation 4/(3 pi) of Saturn's angular radius), relative to the local layer
  vec3 dS;
  float Es = saturnshine(p, dS);
  if (Es > 0.0) {
    float dist = length(uSaturnCenter - p);
    float thS = asin(clamp(uSaturnRadii.x / dist, 0.0, 1.0));
    float thC = 0.4244 * thS;
    vec3 hdir = normalize(dS - nL * dot(dS, nL) + vec3(1e-9, 0.0, 0.0));
    float muB = sin(thC);
    vec3 bSame = hdir * cos(thC) + nL * (vSide * muB);
    vec3 bOther = hdir * cos(thC) - nL * (vSide * muB);
    float k = 0.5 * Es / max(uSunE, 1e-9);
    float cS = dot(bSame, V), cO = dot(bOther, V);
    vec2 gS = vec2(1.0 + un.z * lodAniso(bSame), gA.y), gO = vec2(1.0 + un.z * lodAniso(bOther), gA.y);
    // (no shadow-hiding surge for the extended source: rlLayerIFWAH)
    if (cols) {
      // the same two wake columns as the direct sunlight (as the march, whose beams take the column's sun-path
      // density): on the unlit face, lit by Saturn, a homogeneous layer was 5-7 % brighter than the columns
      IF += k * (fB * (rlLayerIFWAH(S, mu, muB, cS, true, Wb, Wsb, Wvb, gS, 0.0) + rlLayerIFWA(S, mu, muB, cO, false, Wb, Wsb, Wvb, gO))
        + (1.0 - fB) * (rlLayerIFWAH(S, mu, muB, cS, true, Wg, Wsg, Wvg, gS, 0.0) + rlLayerIFWA(S, mu, muB, cO, false, Wg, Wsg, Wvg, gO)));
    } else {
      IF += k * (rlLayerIFWAH(S, mu, muB, cS, true, 1.0, 1.0, 1.0, gS, 0.0) + rlLayerIFWA(S, mu, muB, cO, false, 1.0, 1.0, 1.0, gO));
    }
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
