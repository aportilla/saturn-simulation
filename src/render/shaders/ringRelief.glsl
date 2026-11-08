// ===== sv_ringRelief ========================================================================
// Vertical relief sources of the main rings (GLSL mirror of src/rings/relief.ts; uniforms owned by
// src/rings/RingStructure.ts): the mid-plane height of the material, added to the moonlets' streamline height zeta by
// sv_ringStructure (ringStructureRelief) -- ONE height field z0 for every renderer. Physics and references:
// docs/ring-physics.md section 10.
//   * bending waves (SCL83 linear theory, tabulated on the CPU): Mimas 5:3, Mimas 4:2, Titan -1:0 (nodal);
//     h = A(x) cos(Theta0 + m dth + phi(x)), x = a' - r_V
//   * the 1983-impact corrugation: m = 1 tilt wound up by nodal regression (C and D rings), m = 0 / m = 2 ripples of
//     the inner C ring wound up by the mean motion
//   * sites: Gaussian peaks of the B-ring edge's region A and the S/2009 S1 bump (positions updated per frame)
// Included BEFORE sv_ringStructure (needs sv_common, sv_ringProfile). All arguments are offsets from the ring-frame
// origin for float32 precision: aL = a' - uRingR0 (Lagrangian), dth = azimuth - frame-origin azimuth, fp = radial
// pixel footprint (m; components whose scale is below ~2 footprints fade out -- prefiltering).
// API:
//   vec3  rrWaves(aL, dth, fp)   bending waves + corrugation: (h, dh/da', dh/dS)
//   vec3  rrSites(aL, dth, fp)   localized peaks: (h, dh/da', dh/dS)
//   float rrBound(dr)            upper bound of |h| near the Eulerian offset dr (ray-surface search, march slab)
//   float rrSourcesSunVis(...)   relief shadows cast by these sources onto a point (horizon toward the Sun, extended
//                                solar disk, transmission through the occluding layer); see sv_ringReliefShade
#ifndef SV_RING_RELIEF
#define SV_RING_RELIEF

#define RR_WAVES 3
#define RR_PEAKS 8
#define RR_TAB_W 4096
// Saturn's gravity field (src/core/constants.ts SATURN: GM, R_GRAV_REF, J2, J4, J6 -- keep in sync)
#define RR_GM 3.79312062e16
#define RR_RREF 6.033e7
#define RR_J2 16290.573e-6
#define RR_J4 -935.314e-6
#define RR_J6 86.34e-6

uniform float uRrOn;                 // 0: no relief anywhere (all scales 0)
uniform sampler2D uRrTab;            // RGBA32F, RR_TAB_W x 2 RR_WAVES: row 2i (A, phi, dA/dx, dphi/dx) at x = x0 + j dx;
                                     // row 2i+1 crests: (x, A, |k|, 0) at phi = phiLo + j dPhi (propagating side)
uniform vec4 uRrWave[RR_WAVES];      // (r_V - r0 [m], Theta0 at the frame origin [rad], m, scale (0 = off))
uniform vec4 uRrWaveT[RR_WAVES];     // (x0 [m], 1/dx [1/m], N, peak |h| [m])
uniform vec4 uRrWaveI[RR_WAVES];     // (phiLo, 1/dPhi, NI, side: +1 propagates outward, -1 inward)
uniform vec4 uRrWaveX[RR_WAVES];     // relief extent (xLo, xHi) [m], (-, -)
uniform vec4 uRrCorr;                // (1 = on, Psi1 at the frame origin [rad], t - t_impact [s], ripple amplitude [m])
uniform vec4 uRrCorrT;               // (tilt C ring [rad], tilt D ring [rad], nodal rate at r0 [rad/s], 2 (phi0 - theta2) [rad])
uniform vec4 uRrCorrZ;               // m = 1 zone radii [m]: (D-ring inner, C/D boundary, C fade start, C fade end)
uniform vec4 uRrRipZ;                // ripple zone radii [m]: (r0, r1, r2, r3) (smoothstep ramps r0-r1 and r2-r3)
uniform vec4 uRrRip0;                // m = 0 ripple phase nu(r) dt around r0: (p0, c1, c2, c3) [rad, rad/m, ...]
uniform vec4 uRrRip2;                // m = 2 ripple phase (2 Omega - nu)(r) dt around r0: (p0, c1, c2, c3)
uniform vec4 uRrPeak[RR_PEAKS];      // (a' - r0 [m], dth of the centre [rad], height [m] (0 = unused), radial sigma [m])
uniform float uRrPeakS[RR_PEAKS];    // arc-length sigma [m]
uniform int uRrPeakN;
// region A (B-ring edge) cell field (relief.ts REGION_A / regionACell): (a_site - r0 [m], azimuth offset of the span start
// [rad], cell angle [rad], number of cells), (height scale: sun side x scale (0 = off), a_site [m], taper [rad],
// occupancy), (band lo, band hi [m] from a_site, max height [m], max radial sigma [m]), (hash seed, full span [rad], -, -)
uniform vec4 uRrSiteA;
uniform vec4 uRrSiteB;
uniform vec4 uRrSiteC;
uniform vec4 uRrSiteD;

float rrSmooth(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float rrWrapPi(float a) { return a - TWO_PI * floor((a + PI) / TWO_PI); }

// ---------------------------------------------------------------- orbital frequencies (J2..J6, float32)
// (Omega^2, nu^2 - Omega^2) at radius r: the difference is computed directly (no cancellation)
vec2 rrFreq2(float r) {
  float n2 = RR_GM / (r * r * r);
  float x2 = (RR_RREF / r) * (RR_RREF / r), x4 = x2 * x2, x6 = x4 * x2;
  float om2 = n2 * (1.0 + 1.5 * RR_J2 * x2 - 1.875 * RR_J4 * x4 + 2.1875 * RR_J6 * x6);
  float dnu = n2 * (3.0 * RR_J2 * x2 - 7.5 * RR_J4 * x4 + 13.125 * RR_J6 * x6);
  return vec2(om2, dnu);
}
// nodal precession rate Omega - nu (< 0)
float rrNodalRate(float r) {
  vec2 f = rrFreq2(r);
  return -f.y / (sqrt(f.x + f.y) + sqrt(f.x));
}
// d(Omega - nu)/dr, exact (relief.ts nodalRateDeriv): Omega - nu = -D / S with D = nu^2 - Omega^2, S = nu + Omega; every
// J term of D and Omega^2 scales as r^-(3 + 2k), S' = (Omega^2)' / (2 Omega) + (nu^2)' / (2 nu) (a sum: no cancellation)
float rrNodalRateDeriv(float r) {
  float n2r = RR_GM / (r * r * r * r);
  float x2 = (RR_RREF / r) * (RR_RREF / r), x4 = x2 * x2, x6 = x4 * x2;
  vec2 f = rrFreq2(r);
  float om = sqrt(f.x), nu = sqrt(f.x + f.y), S = nu + om;
  float dD = -n2r * (15.0 * RR_J2 * x2 - 52.5 * RR_J4 * x4 + 118.125 * RR_J6 * x6);
  float dOm2 = -n2r * (3.0 + 7.5 * RR_J2 * x2 - 13.125 * RR_J4 * x4 + 19.6875 * RR_J6 * x6);
  float dS = 0.5 * dOm2 / om + 0.5 * (dOm2 + dD) / nu;
  return -(dD - f.y * dS / S) / S;
}

// ---------------------------------------------------------------- bending waves
// table row 2i at x = a' - r_V: (A, phi, dA/dx, dphi/dx); zero outside
vec4 rrWaveSample(int i, float x) {
  vec4 T = uRrWaveT[i];
  float u = (x - T.x) * T.y;
  if (!(u >= 0.0 && u <= T.z - 1.0)) return vec4(0.0);
  float fl = min(floor(u), T.z - 2.0);
  int j = int(fl);
  float f = u - fl;
  return mix(texelFetch(uRrTab, ivec2(j, 2 * i), 0), texelFetch(uRrTab, ivec2(j + 1, 2 * i), 0), f);
}
// crest table row 2i+1 at phase phi: (x, A, |k|, 0)
vec4 rrWaveCrest(int i, float phi) {
  vec4 I = uRrWaveI[i];
  float u = clamp((phi - I.x) * I.y, 0.0, I.z - 1.0);
  float fl = min(floor(u), I.z - 2.0);
  int j = int(fl);
  return mix(texelFetch(uRrTab, ivec2(j, 2 * i + 1), 0), texelFetch(uRrTab, ivec2(j + 1, 2 * i + 1), 0), u - fl);
}
float rrFpFade(float lam, float fp) { return 1.0 - rrSmooth(0.25 * lam, 0.5 * lam, fp); }

// ---------------------------------------------------------------- corrugation (1983 impact)
// m = 1 tilt: (h, dh/dr, dh/dS) at absolute radius r (float32: zone envelopes only) and offsets aL, dth
vec3 rrCorrM1(float r, float dth, float fp) {
  vec4 Z = uRrCorrZ;
  if (!(r > Z.x && r < Z.w)) return vec3(0.0);
  float dt = uRrCorr.z;
  float tilt = r < Z.y ? mix(uRrCorrT.y, uRrCorrT.x, rrSmooth(Z.y - 5.0e5, Z.y + 5.0e5, r)) : uRrCorrT.x;
  float A = tilt * r * (1.0 - rrSmooth(Z.z, Z.w, r)) * rrSmooth(Z.x, Z.x + 5.0e5, r);
  float nr = rrNodalRate(r);
  // radial wavenumber dPsi/dr = -(d(Omega - nu)/dr) dt
  float k = -rrNodalRateDeriv(r) * dt;
  float fade = rrFpFade(TWO_PI / max(abs(k), 1e-12), fp);
  if (fade <= 0.0 || A <= 0.0) return vec3(0.0);
  float psi = uRrCorr.y + dth - (nr - uRrCorrT.z) * dt;
  float s = sin(psi), c = cos(psi);
  return fade * A * vec3(s, k * c, c / r);
}
// m = 0 / m = 2 ripples of the inner C ring (phase expansions around r0 near the camera, direct far away)
vec3 rrCorrRipples(float aL, float r, float dth, float fp) {
  vec4 Z = uRrRipZ;
  float amp = uRrCorr.w;
  if (!(r > Z.x && r < Z.w) || amp <= 0.0) return vec3(0.0);
  float A = amp * rrSmooth(Z.x, Z.y, r) * (1.0 - rrSmooth(Z.z, Z.w, r));
  float p0, p2, k0, k2;
  float dt = uRrCorr.z;
  if (abs(aL) < 3.0e5) {
    vec4 e = uRrRip0, g = uRrRip2;
    p0 = e.x + aL * (e.y + aL * (e.z + aL * e.w));
    p2 = uRrCorrT.w + 2.0 * dth - (g.x + aL * (g.y + aL * (g.z + aL * g.w)));
    k0 = e.y + aL * (2.0 * e.z + 3.0 * aL * e.w);
    k2 = -(g.y + aL * (2.0 * g.z + 3.0 * aL * g.w));
  } else {
    // far from the frame origin: direct float32 evaluation (phase error ~0.05 rad; these ~1 km ripples are then
    // far below the footprint and faded anyway)
    vec2 f = rrFreq2(r);
    float om = sqrt(f.x), nu = sqrt(f.x + f.y);
    p0 = mod(nu * dt, TWO_PI);
    p2 = uRrCorrT.w + 2.0 * dth - mod((2.0 * om - nu) * dt, TWO_PI);
    k0 = -1.5 * nu * dt / r;
    k2 = 1.5 * (2.0 * om - nu) * dt / r;
  }
  float fade = rrFpFade(TWO_PI / max(abs(k0), 1e-12), fp);
  if (fade <= 0.0) return vec3(0.0);
  float s0 = sin(p0), c0 = cos(p0), s2 = sin(p2), c2 = cos(p2);
  return fade * A * vec3(s0 + s2, k0 * c0 + k2 * c2, 2.0 * c2 / r);
}

// ---------------------------------------------------------------- sources
// Bending waves + corrugation at Lagrangian offset aL, azimuth offset dth: (h, dh/da', dh/dS)
vec3 rrWaves(float aL, float dth, float fp) {
  if (uRrOn < 0.5) return vec3(0.0);
  vec3 o = vec3(0.0);
  float r = uRingR0 + aL;
  for (int i = 0; i < RR_WAVES; i++) {
    vec4 W = uRrWave[i];
    if (W.w == 0.0) continue;
    vec4 s = rrWaveSample(i, aL - W.x);
    if (s.x == 0.0) continue;
    float fade = W.w * rrFpFade(TWO_PI / max(abs(s.w), 1e-9), fp);
    if (fade == 0.0) continue;
    float psi = W.y + W.z * dth + s.y;
    float c = cos(psi), sn = sin(psi);
    o += fade * vec3(s.x * c, s.z * c - s.x * s.w * sn, -s.x * W.z * sn / r);
  }
  if (uRrCorr.x > 0.5) {
    o += rrCorrM1(r, dth, fp);
    o += rrCorrRipples(aL, r, dth, fp);
  }
  return o;
}

// Region-A structure of cell j: (angle from the span start [rad], a' - r0 [m], height [m] (0: empty), radial sigma [m]),
// arc sigma [m] in ss (relief.ts regionACell)
vec4 rrRegionACell(int j, out float ss) {
  ss = 1.0;
  if (j < 0 || float(j) >= uRrSiteA.w) return vec4(0.0);
  uint h0 = pcgHash(uint(j) ^ uint(uRrSiteD.x));
  if (hashU(h0) >= uRrSiteB.w) return vec4(0.0);
  float u1 = hashU(pcgHash(h0 + 1u)), u2 = hashU(pcgHash(h0 + 2u)), u3 = hashU(pcgHash(h0 + 3u));
  float u4 = hashU(pcgHash(h0 + 4u)), u5 = hashU(pcgHash(h0 + 5u));
  float phi = (float(j) + 0.15 + 0.7 * u1) * uRrSiteA.z;
  float tap = min(rrSmooth(0.0, uRrSiteB.z, phi), rrSmooth(0.0, uRrSiteB.z, uRrSiteD.y - phi));
  float sr = 2000.0 + 3000.0 * u4;
  ss = sr * (1.5 + 2.0 * u5);
  float a = uRrSiteA.x + uRrSiteC.x + (uRrSiteC.y - uRrSiteC.x) * pow(u2, 0.7);
  float u35 = u3 * u3 * u3 * u3 * u3;
  return vec4(phi, a, uRrSiteC.z * (0.08 + 0.92 * u35) * tap, sr);
}

// Region A's structures around (aL, dth): the point's cell and its neighbours
vec3 rrRegionA(float aL, float dth, float fp) {
  if (uRrSiteB.x == 0.0) return vec3(0.0);
  float da0 = aL - uRrSiteA.x;
  if (da0 < uRrSiteC.x - 5.0 * uRrSiteC.w || da0 > uRrSiteC.y + 5.0 * uRrSiteC.w) return vec3(0.0);
  float rel = rrWrapPi(dth - uRrSiteA.y);
  float fj = rel / uRrSiteA.z;
  if (fj < -1.0 || fj > uRrSiteA.w + 1.0) return vec3(0.0);
  int j0 = int(floor(fj));
  vec3 o = vec3(0.0);
  for (int dj = -1; dj <= 1; dj++) {
    float ss;
    vec4 c = rrRegionACell(j0 + dj, ss);
    if (c.z <= 0.0) continue;
    float da = aL - c.y;
    float ds = (rel - c.x) * uRrSiteB.y;
    float g0 = sqrt(c.w * ss);
    float fade = 1.0 - rrSmooth(g0, 2.0 * g0, fp);
    float g = fade * uRrSiteB.x * c.z * exp(-0.5 * (da * da / (c.w * c.w) + ds * ds / (ss * ss)));
    o += vec3(g, -g * da / (c.w * c.w), -g * ds / (ss * ss));
  }
  return o;
}

// Localized peaks (region A, S/2009 S1): Gaussian bumps at their (moving) Lagrangian positions
vec3 rrSites(float aL, float dth, float fp) {
  if (uRrOn < 0.5) return vec3(0.0);
  vec3 o = rrRegionA(aL, dth, fp);
  if (uRrPeakN == 0) return o;
  float r = uRingR0 + aL;
  for (int i = 0; i < RR_PEAKS; i++) {
    if (i >= uRrPeakN) break;
    vec4 P = uRrPeak[i];
    float da = aL - P.x;
    if (abs(da) > 5.0 * P.w || P.z == 0.0) continue;
    float ss = uRrPeakS[i];
    float ds = rrWrapPi(dth - P.y) * r;
    if (abs(ds) > 5.0 * ss) continue;
    float fade = 1.0 - rrSmooth(P.w, 2.0 * P.w, fp);
    float g = fade * P.z * exp(-0.5 * (da * da / (P.w * P.w) + ds * ds / (ss * ss)));
    o += vec3(g, -g * da / (P.w * P.w), -g * ds / (ss * ss));
  }
  return o;
}

// Upper bound of |h| near the Eulerian offset dr (m): bending-wave zones, corrugation, sites (+ the B-ring edge modes'
// radial excursion, ~105 km, which carries the region-A peaks)
float rrBound(float dr) {
  if (uRrOn < 0.5) return 0.0;
  float b = 0.0;
  for (int i = 0; i < RR_WAVES; i++) {
    vec4 W = uRrWave[i];
    if (W.w == 0.0) continue;
    float x = dr - W.x;
    if (x > uRrWaveX[i].x && x < uRrWaveX[i].y) b += uRrWaveT[i].w * W.w;
  }
  float r = uRingR0 + dr;
  if (uRrCorr.x > 0.5 && r > uRrCorrZ.x && r < uRrCorrZ.w) {
    b += (r < uRrCorrZ.y + 5.0e5 ? uRrCorrT.y : uRrCorrT.x) * min(r, uRrCorrZ.w);
    if (r > uRrRipZ.x && r < uRrRipZ.w) b += 2.0 * uRrCorr.w;
  }
  float site = 0.0;
  for (int i = 0; i < RR_PEAKS; i++) {
    if (i >= uRrPeakN) break;
    vec4 P = uRrPeak[i];
    if (abs(dr - P.x) < 5.0 * P.w + 1.1e5) site = max(site, abs(P.z));
  }
  float dA = dr - uRrSiteA.x;
  if (uRrSiteB.x != 0.0 && dA > uRrSiteC.x - 5.0 * uRrSiteC.w - 1.1e5 && dA < uRrSiteC.y + 5.0 * uRrSiteC.w + 1.1e5) {
    site = max(site, uRrSiteC.z * abs(uRrSiteB.x));
  }
  return b + site;
}

// ---------------------------------------------------------------- relief shadows (sources of this chunk)
// Fraction of a unit disk below the line y = x (x in units of the disk radius).
float rrDiskBelow(float x) {
  x = clamp(x, -1.0, 1.0);
  return (x * sqrt(max(1.0 - x * x, 0.0)) + asin(x) + 0.5 * PI) * INV_PI;
}
// Distance u (m, horizontal) along a horizontal ray from radius rp with radial direction cosine cr at which the ray
// reaches radius rp + dlt on its first (monotonic) branch; < 0 if never (stable form, no cancellation).
float rrRayReach(float rp, float cr, float dlt) {
  float q = dlt * (2.0 * rp + dlt);
  float disc = rp * rp * cr * cr + q;
  if (disc < 0.0) return -1.0;
  float s = cr >= 0.0 ? 1.0 : -1.0;
  if (dlt * s < 0.0) return -1.0;           // behind the ray's radial motion
  float den = rp * cr + s * sqrt(disc);
  return abs(den) > 1e-6 ? q / den : -1.0;
}

// Horizon (tan of the elevation, toward the Sun) from the bending-wave crests, for a point at (aL, dth) with wave
// height hp: crests enumerated along the Sun's horizontal direction (radial cosine cr) in the order the ray meets
// them, up to distance uMax. Also returns the crossing's path factor 1/mu through the occluding crest (layer
// transmission exp(-tau/mu)).
float rrWaveHorizon(int i, float aL, float dth, float hp, float cr, float tanB, float uMin, float uMax, float fp, float shift, out float invMu) {
  invMu = 1.0;
  vec4 W = uRrWave[i];
  vec4 I = uRrWaveI[i];
  float best = -1e9;
  if (W.w == 0.0) return best;
  float rp = uRingR0 + aL;
  float x = aL - W.x;
  // the ray moves outward in x for cr >= 0 (the horizontal ray always ends moving outward)
  float dir = cr >= 0.0 ? 1.0 : -1.0;
  // phase at the point on the propagating branch (clamped to the table's phase range)
  vec4 s = rrWaveSample(i, x);
  float side = I.w;
  float xs = side * x;                     // > 0: on the propagating side
  float phiHi = I.x + (I.z - 1.0) / I.y;   // phase at the resonance end
  float phiP = xs > 0.0 ? s.y : phiHi;
  if (xs > 0.0 && s.x == 0.0) phiP = I.x;  // beyond the far end
  phiP = clamp(phiP, I.x, phiHi);
  // crests of the sun-side height: shift = pi when the Sun is south (the troughs of h)
  float psi0 = W.y + W.z * dth + shift;
  // moving away from the resonance (dir == side): the phase decreases; toward it: increases
  bool away = dir == side;
  if (!away && xs <= 0.0) return best;     // moving deeper into the evanescent side: no crests ahead
  float n0 = away ? floor((phiP + psi0) / TWO_PI) : ceil((phiP + psi0) / TWO_PI);
  for (int j = 0; j < 24; j++) {
    float phiN = (n0 + (away ? -float(j) : float(j))) * TWO_PI - psi0;
    if (phiN < I.x || phiN > phiHi) break;
    vec4 c = rrWaveCrest(i, phiN);        // (x, A, |k|)
    float u = rrRayReach(rp, cr, c.x - x);
    if (u <= uMin) continue;
    if (u > uMax) break;
    // the occluding crest at its true height: its shadow (~A / tan B) can be far longer than the footprint even when
    // the crest itself is not resolved (the caller skips points inside an unresolved wave)
    float A = c.y * W.w;
    float th = (A - hp) / u;
    if (th > best) {
      best = th;
      // the ray enters the crest's sunward flank: path factor through the tilted layer
      invMu = 1.0 / max(sin(atan(A * c.z * abs(cr)) + atan(tanB)), 0.02);
    }
  }
  return best;
}

// Horizon from a locally sinusoidal relief h = E sin(psi) (radial wavenumber k, for this source alone): the two nearest
// crests along the ray (radial cosine cr).
float rrSinHorizon(float E, float psi, float k, float cr, float uMax, out float invMu, float tanB) {
  invMu = 1.0;
  float kr = k * cr;
  if (E <= 0.0 || abs(kr) < 1e-12) return -1e9;
  float hp = E * sin(psi);
  // phase distance to the next crest (psi = pi/2 mod 2 pi) in the direction of motion
  float sgn = kr > 0.0 ? 1.0 : -1.0;
  float d = mod(sgn * (0.5 * PI - psi), TWO_PI);
  float best = -1e9;
  for (int j = 0; j < 2; j++) {
    float u = (d + TWO_PI * float(j)) / abs(kr);
    if (u > uMax) break;
    if (u <= 1e-3) continue;
    best = max(best, (E - hp) / u);
  }
  invMu = 1.0 / max(sin(atan(E * abs(k * cr)) + atan(tanB)), 0.02);
  return best;
}

// Visible fraction of the solar disk (centre elevation atan(tanB), angular radius rs) above a horizon of slope tanH.
float rrDiskVis(float tanH, float tanB, float rs) {
  return 1.0 - rrDiskBelow((atan(tanH) - atan(tanB)) / max(rs, 1e-6));
}

// Occulted fraction of the Sun by one opaque Gaussian peak (sun-side height h, radial / arc sigmas sr, ss) whose centre
// lies at (dA, dTh) = (radial offset a'_peak - a'_p [m], azimuth offset [rad]) from a point at radius rp and sun-side
// height hs; sun direction cosines (cr, ct) in the point's radial / azimuthal axes, elevation b0 = atan(tanB), solar
// radius rs, the lowest limb's slope tanLo, pixel footprint fp. The sun ray's closest approach to the peak (exact plane
// geometry incl. the orbit's curvature), the shadow's half-width there for three heights across the solar disk,
// averaged over the footprint (and the lateral penumbra).
float rrPeakOcc(float dA, float dTh, float h, float sr, float ss, float rp, float hs, float cr, float ct, float b0, float rs, float tanLo, float fp) {
  if (h <= 0.0) return 0.0;
  float sh = sin(0.5 * dTh);
  float dx = dA * cos(dTh) - 2.0 * rp * sh * sh;    // r_peak cos(dTh) - r_p, without cancellation
  float dy = (rp + dA) * sin(dTh);
  float u = dx * cr + dy * ct;
  if (u <= 0.0 || u > (h - hs) / tanLo) return 0.0;
  float dp = -ct * dx + cr * dy;
  // the sun's horizontal direction in the peak's own radial / azimuthal frame
  float cp = cos(dTh), spp = sin(dTh);
  float crp = cr * cp + ct * spp, ctp = -cr * spp + ct * cp;
  float qd = ctp * ctp / (sr * sr) + crp * crp / (ss * ss);   // Gaussian curvature across the ray
  float fw = max(fp, 2.0 * rs * u);
  float occ = 0.0;
  for (int j = 0; j < 3; j++) {
    float e = b0 + rs * (j == 0 ? -0.707 : (j == 1 ? 0.0 : 0.707));
    float need = hs + u * tan(e);
    float wgt = j == 1 ? 0.5 : 0.25;
    if (h <= need || e <= -0.5 * PI) continue;
    float hwid = need > 0.0 ? sqrt(2.0 * log(h / need) / qd) : 1e9;
    occ += wgt * clamp((min(dp + 0.5 * fw, hwid) - max(dp - 0.5 * fw, -hwid)) / fw, 0.0, 1.0);
  }
  return occ;
}

// Shadows of the sources of this chunk onto a point at Lagrangian offset aL, azimuth offset dth, with the sun's
// horizontal radial / azimuthal direction cosines (cr, ct) at the point, its elevation tangent tanB = |elevation| (the
// geometry is mirrored to the lit side: sg = sign of the Sun's elevation, heights hwhs given as sun-side heights
// sg * h), angular radius rs, the local optical depth tau (transmission of an occluding wave crest), pixel footprint
// fp. Returns the sun visibility.
float rrSourcesSunVisSided(float aL, float dth, float cr, float ct, float tanB, float rs, float tau, vec2 hwhs, float sg, float fp) {
  if (uRrOn < 0.5 || tanB <= -rs) return 1.0;
  float tanLo = max(tan(atan(tanB) - rs), 2e-5);   // lowest solar limb: longest shadows
  float vis = 1.0;
  float hw = hwhs.x, hs = hwhs.y;
  float shift = sg < 0.0 ? PI : 0.0;
  // bending waves: the crests at their true heights shadow points beyond the wave and inside it. Prefiltering: at a
  // point inside a wave the footprint does not resolve (wavelength < 2 footprints) the local phase is not resolved
  // either: the point is taken at the mean height (hw, faded to 0) and only crests more than one local wavelength
  // away can shadow it -- the large first crests shadowing the smaller wave train behind them (the "broad shadow band"
  // of the Mimas 5:3 wave near equinox, PIA11676), without aliasing the wave's own phase.
  for (int i = 0; i < RR_WAVES; i++) {
    if (uRrWave[i].w == 0.0) continue;
    float pk = uRrWaveT[i].w * uRrWave[i].w;
    float x = aL - uRrWave[i].x;
    // only if the ray can still reach the wave zone within the longest shadow
    float uMax = (pk + abs(hw)) / tanLo;
    if (x < uRrWaveX[i].x - uMax || x > uRrWaveX[i].y + uMax) continue;
    vec4 sp = rrWaveSample(i, x);
    float lamP = TWO_PI / max(abs(sp.w), 1e-9);
    // (blended with the footprint fade: no sharp switch where the wave becomes unresolved)
    float uMin = sp.x > 1e-3 * pk ? (1.0 - rrFpFade(lamP, fp)) * lamP / max(abs(cr), 0.05) : 0.0;
    float invMu;
    float th = rrWaveHorizon(i, aL, dth, hw, cr, tanB, uMin, uMax, fp, shift, invMu);
    if (th <= -1e8) continue;
    float v = rrDiskVis(th, tanB, rs);
    vis *= v + (1.0 - v) * exp(-tau * invMu);
  }
  // corrugation (local sinusoids: the m = 1 tilt and the m = 0 + m = 2 ripple pair as one beat-modulated wave)
  float r = uRingR0 + aL;
  if (uRrCorr.x > 0.5 && r > uRrCorrZ.x && r < uRrCorrZ.w) {
    vec4 Z = uRrCorrZ;
    float dt = uRrCorr.z;
    float tilt = r < Z.y ? mix(uRrCorrT.y, uRrCorrT.x, rrSmooth(Z.y - 5.0e5, Z.y + 5.0e5, r)) : uRrCorrT.x;
    float A = tilt * r * (1.0 - rrSmooth(Z.z, Z.w, r)) * rrSmooth(Z.x, Z.x + 5.0e5, r);
    float nr = rrNodalRate(r);
    float k = -rrNodalRateDeriv(r) * dt;
    // (unresolved at the point: its self-shadowing averages out -- faded with the footprint, as its height)
    A *= rrFpFade(TWO_PI / max(abs(k), 1e-12), fp);
    float psi = uRrCorr.y + dth - (nr - uRrCorrT.z) * dt + shift;
    float invMu;
    float th = rrSinHorizon(A, psi, k, cr, 2.0 * A / tanLo, invMu, tanB);
    if (th > -1e8) {
      float v = rrDiskVis(th, tanB, rs);
      vis *= v + (1.0 - v) * exp(-tau * invMu);
    }
    if (r > uRrRipZ.x && r < uRrRipZ.w && uRrCorr.w > 0.0) {
      // ripple pair: h = A (sin p0 + sin p2) = 2A cos((p0 - p2)/2) sin((p0 + p2)/2)
      float Ar = uRrCorr.w * rrSmooth(uRrRipZ.x, uRrRipZ.y, r) * (1.0 - rrSmooth(uRrRipZ.z, uRrRipZ.w, r));
      vec4 e = uRrRip0, g = uRrRip2;
      float p0, p2, k0, k2;
      if (abs(aL) < 3.0e5) {
        p0 = e.x + aL * (e.y + aL * (e.z + aL * e.w));
        p2 = uRrCorrT.w + 2.0 * dth - (g.x + aL * (g.y + aL * (g.z + aL * g.w)));
        k0 = e.y + aL * (2.0 * e.z + 3.0 * aL * e.w);
        k2 = -(g.y + aL * (2.0 * g.z + 3.0 * aL * g.w));
      } else {
        vec2 f = rrFreq2(r);
        float om = sqrt(f.x), nu = sqrt(f.x + f.y);
        p0 = mod(nu * dt, TWO_PI);
        p2 = uRrCorrT.w + 2.0 * dth - mod((2.0 * om - nu) * dt, TWO_PI);
        k0 = -1.5 * nu * dt / r; k2 = 1.5 * (2.0 * om - nu) * dt / r;
      }
      float env = 2.0 * Ar * cos(0.5 * (p0 - p2));
      float pm = 0.5 * (p0 + p2) + (env < 0.0 ? PI : 0.0) + shift;
      float kk = 0.5 * (k0 + k2);
      float E = rrFpFade(TWO_PI / max(abs(kk), 1e-12), fp) < 0.5 ? 0.0 : abs(env);
      th = rrSinHorizon(E, pm, kk, cr, 2.0 * E / tanLo, invMu, tanB);
      if (th > -1e8) {
        float v = rrDiskVis(th, tanB, rs);
        vis *= v + (1.0 - v) * exp(-tau * invMu);
      }
    }
  }
  // sites: opaque peaks (dense B-ring material, a solid moonlet) rising toward the lit face (sun-side heights |h|)
  float b0 = atan(tanB);
  for (int i = 0; i < RR_PEAKS; i++) {
    if (i >= uRrPeakN) break;
    vec4 P = uRrPeak[i];
    vis *= 1.0 - rrPeakOcc(P.x - aL, rrWrapPi(P.y - dth), abs(P.z), P.w, uRrPeakS[i], r, hs, cr, ct, b0, rs, tanLo, fp);
  }
  // region A: walk the cells the sun ray crosses inside the site's band (nearest first, <= 16)
  if (uRrSiteB.x != 0.0) {
    float hA = uRrSiteC.z * abs(uRrSiteB.x);
    float uLim = (hA - hs) / tanLo;
    float lo = uRrSiteA.x + uRrSiteC.x - 3.0 * uRrSiteC.w, hi = uRrSiteA.x + uRrSiteC.y + 3.0 * uRrSiteC.w;
    float u1 = -1.0, u2 = -1.0;
    if (aL >= lo && aL <= hi) { u1 = 0.0; u2 = rrRayReach(r, cr, (cr >= 0.0 ? hi : lo) - aL); if (u2 < 0.0) u2 = r * abs(cr); }
    else if (aL < lo) { u1 = rrRayReach(r, cr, lo - aL); u2 = rrRayReach(r, cr, hi - aL); }
    else { u1 = rrRayReach(r, cr, hi - aL); u2 = rrRayReach(r, cr, lo - aL); if (u1 >= 0.0 && u2 < 0.0) u2 = r * abs(cr); }
    if (u1 >= 0.0 && u2 > u1 && u1 < uLim) {
      u2 = min(u2, uLim);
      float th1 = rrWrapPi(dth + atan(u1 * ct, r + u1 * cr) - uRrSiteA.y) / uRrSiteA.z;
      float th2 = rrWrapPi(dth + atan(u2 * ct, r + u2 * cr) - uRrSiteA.y) / uRrSiteA.z;
      float dir = th2 >= th1 ? 1.0 : -1.0;
      int jA = int(floor(th1)) - int(dir), n = int(abs(floor(th2) - floor(th1))) + 3;
      for (int k = 0; k < 16; k++) {
        if (k >= n) break;
        int j = jA + int(dir) * k;
        float ss;
        vec4 c = rrRegionACell(j, ss);
        if (c.z <= 0.0) continue;
        float dTh = rrWrapPi(uRrSiteA.y + c.x - dth);
        vis *= 1.0 - rrPeakOcc(c.y - aL, dTh, c.z * abs(uRrSiteB.x), c.w, ss, r, hs, cr, ct, b0, rs, tanLo, fp);
      }
    }
  }
  return vis;
}

#endif
