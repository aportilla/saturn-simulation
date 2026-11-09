// Vertical relief of the main rings: the mid-plane height z0(a', theta, t) of the ring material from
//   * bending waves (linear theory, Shu, Cuzzi & Lissauer 1983 = SCL83): Mimas 5:3 and 4:2 inner vertical resonances,
//     the Titan -1:0 nodal bending wave in the C ring;
//   * the corrugation left by the 1983 impact (Hedman et al. 2011; French et al. 2025): the m = 1 tilt wound up by
//     differential nodal regression (C and D rings) and the m = 0 / m = 2 vertical ripples of the inner C ring;
//   * localized sites: the vertical structures of the B-ring edge's "region A" (Spitale & Porco 2010) and the moonlet
//     S/2009 S1 (Porco 2009; Spitale & Porco 2010).
// Mirror of src/render/shaders/ringRelief.glsl (chunk sv_ringRelief); RingStructure.ts owns the uniforms and adds this
// height to the moonlets' streamline height (one height field: z0 = zeta_streamline + relief). Physics, numbers and
// references: docs/ring-physics.md section 10.
// Self-contained (no imports, erasable TypeScript only), so Node scripts can import it directly (node >= 23 strips the
// types); the orbital frequencies (J2..J6) are injected.
//
// Conventions: radii and arcs in m, angles in rad, t = seconds past J2000 TDB (as the app: UTC + fixed offset, see
// tFromIso). Theta = SEF azimuth (= ring longitude from the ascending node of Saturn's equator on the ICRF equator).
// Every source is evaluated at the LAGRANGIAN radius a' (the material's unperturbed streamline: the relief rides on
// the streamline map, e.g. the B-ring-edge structures move with the edge modes). eval() returns
// (h, dh/da', dh/dS), S = arc length (prograde).

export type FreqFn = (r: number) => { omega: number; kappa: number; nu: number };

const G = 6.6743e-11;
/** Saturn's gravity field as src/core/constants.ts SATURN (GM, R_GRAV_REF, J2..J6) and ringRelief.glsl RR_* -- keep in sync */
const SATURN_GRAVITY = { GM: 3.79312062e16, R: 60_330e3, J2: 16_290.573e-6, J4: -935.314e-6, J6: 86.34e-6 };
const DAY = 86_400;
const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
/** Same mapping as src/core/time.ts (UTC -> s past J2000 with the post-2017 leap-second offset). */
const UNIX_J2000_OFFSET = 946_727_930.816;
export function tFromIso(iso: string): number {
  return Date.parse(iso) / 1000 - UNIX_J2000_OFFSET;
}
export function wrapPi(a: number): number {
  return a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
}
function wrap2Pi(a: number): number {
  return a - TWO_PI * Math.floor(a / TWO_PI);
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------------------------------------- bending waves
export interface BendingWaveDef {
  id: string;
  name: string;
  /** perturbing moon (NAIF id) */
  moonId: number;
  /**
   * Forcing term. 'ivr': inner vertical resonance of the satellite's inclination term, potential ~ sin i'
   * cos(m theta - (m+1) lambda' + Omega'), pattern speed ((m+1) n' - Omega'dot) / m, ratio (m+1):(m-1) (SCL83).
   * 'nodal': the Titan -1:0 nodal resonance, argument theta + lambda' - varpi' - Omega' (e' sin i' term), pattern
   * speed -n' + varpi'dot + Omega'dot < 0: the wave propagates OUTWARD as a leading spiral (Nicholson & Hedman 2016).
   */
  kind: 'ivr' | 'nodal';
  m: number;
  /** the moon's mean motion, apsidal and nodal precession rates (rad/s): pattern speed and resonance radius */
  n: number;
  pidot: number;
  Omdot: number;
  /** resonance radius (m); computed from the resonance condition with the J2..J6 frequencies when absent */
  rV?: number;
  /** starting guess for the root search (m) */
  rGuess: number;
  /** surface density of the dispersion relation (kg/m^2) */
  sigma: number;
  /** kinematic viscosity of the damping (m^2/s) */
  nuVisc: number;
  /** linear-theory forcing: the moon's GM (m^3/s^2), semi-major axis (m) and inclination (rad) ('ivr' only) */
  forcing?: { gm: number; a: number; inc: number };
  /** calibration to measurements: scale the profile to a peak |h| (m) and/or a maximum slope (rad) */
  calib?: { peak?: number; maxSlope?: number };
  source: string;
}

const MIMAS = { id: 601, gm: 2.50349e9, a: 185_534.65e3, n: (381.9944965 * DEG) / DAY, pidot: (1.00092 * DEG) / DAY, Omdot: (-0.99950 * DEG) / DAY, inc: 1.5733 * DEG };
const TITAN = { id: 606, n: (22.576976 * DEG) / DAY, pidot: (0.0014 * DEG) / DAY, Omdot: (-0.00137 * DEG) / DAY };

export const BENDING_WAVES: BendingWaveDef[] = [
  {
    // SCL83 linear theory with Sega et al. 2024 (Icarus 413, 115987; UVIS): sigma = 36.7 g/cm^2, nu = 576 cm^2/s, A_V =
    // 472 m / sqrt(sigma_100) = 779 m -> peak 0.9 km, slope 17.5 deg. VIMS (Koh et al., DPS 2022; Nicholson et al., DDA
    // 2024): amplitude peaks at ~400-450 m (250 m at B_eff < 25 deg, likely an artefact), slopes ~10 deg: calibrated to
    // 450 m.
    id: 'mimas53', name: 'Mimas 5:3 bending wave', moonId: MIMAS.id, kind: 'ivr', m: 4, n: MIMAS.n, pidot: MIMAS.pidot, Omdot: MIMAS.Omdot,
    rGuess: 131_900e3, sigma: 367, nuVisc: 0.0576, forcing: { gm: MIMAS.gm, a: MIMAS.a, inc: MIMAS.inc }, calib: { peak: 450 },
    source: 'SCL83; Sega et al. 2024 (sigma, nu); VIMS amplitude (Koh et al. 2022, Nicholson et al. 2024)',
  },
  {
    // Lissauer 1985 (via Hedman & Nicholson 2016): sigma 54 g/cm^2 (= the profile's B5 sigma). No measured amplitude:
    // pure linear theory (the Mimas 5:3 linear amplitude is 2x the VIMS one: uncertain by ~x2). Viscosity: the 5:3 value.
    id: 'mimas42', name: 'Mimas 4:2 bending wave', moonId: MIMAS.id, kind: 'ivr', m: 3, n: MIMAS.n, pidot: MIMAS.pidot, Omdot: MIMAS.Omdot,
    rGuess: 116_700e3, sigma: 540, nuVisc: 0.0576, forcing: { gm: MIMAS.gm, a: MIMAS.a, inc: MIMAS.inc },
    source: 'SCL83 linear theory; Lissauer 1985 (sigma)',
  },
  {
    // Nicholson & Hedman 2016 (Icarus 279, 78): IVR at 77,525.5 km (J2..J6 alone put it 33 km inward: the nodal rate
    // is sensitive to J8..J12), lambda = 5 km at 25 km -> sigma0 = 0.6 g/cm^2 (their eq. 14), 5-12 crests over
    // 77,535-77,575 km. Koh et al. (DPS 2022): local slopes up to ~45 deg, amplitudes 0.5-1.5 km at 15-45 km
    // (a strongly nonlinear wave; linear A_V = 334 m / sqrt(sigma0) = 431 m): calibrated to a 45 deg maximum slope.
    // Viscosity: 1.6 cm^2/s (French et al. 2025, inner C ring at 75,500 km).
    id: 'titan10', name: 'Titan -1:0 nodal bending wave', moonId: TITAN.id, kind: 'nodal', m: 1, n: TITAN.n, pidot: TITAN.pidot, Omdot: TITAN.Omdot,
    rV: 77_525.5e3, rGuess: 77_520e3, sigma: 6, nuVisc: 1.6e-4, calib: { maxSlope: 45 * DEG },
    source: 'Nicholson & Hedman 2016 (location, sigma); Koh et al. 2022 (slopes); French et al. 2025 (nu)',
  },
];

/** Normalized complex profile of a forced bending wave, H(eta) = e^{-i eta^2/2} int_eta^inf e^{i u^2/2} du / sqrt(2 pi):
 *  |H| -> 1 on the propagating side (eta -> -inf), H -> i / (eta sqrt(2 pi)) on the evanescent side. Evaluated on an
 *  increasing grid by integrating from a far evanescent point (asymptotic series) with Simpson sub-steps. */
function fresnelProfile(etas: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = etas.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  const e0 = Math.max(10, etas[n - 1] + 1);
  // int_e0^inf e^{i u^2/2} du ~ e^{i e0^2/2} (i/e0 + 1/e0^3 - 3i/e0^5)
  const c0 = Math.cos((e0 * e0) / 2), s0 = Math.sin((e0 * e0) / 2);
  const ar = 1 / e0 ** 3, ai = 1 / e0 - 3 / e0 ** 5;
  let Ir = c0 * ar - s0 * ai, Ii = s0 * ar + c0 * ai;
  let u = e0;
  const step = (u1: number) => {
    // Simpson sub-steps from u down to u1 (< u)
    const span = u - u1;
    if (span <= 0) return;
    const k = Math.max(2, 2 * Math.ceil(span / 0.004 / 2));
    const h = span / k;
    let sr = 0, si = 0;
    for (let j = 0; j <= k; j++) {
      const x = u1 + j * h;
      const w = j === 0 || j === k ? 1 : j % 2 ? 4 : 2;
      sr += w * Math.cos((x * x) / 2);
      si += w * Math.sin((x * x) / 2);
    }
    Ir += (sr * h) / 3;
    Ii += (si * h) / 3;
    u = u1;
  };
  const norm = 1 / Math.sqrt(TWO_PI);
  for (let i = n - 1; i >= 0; i--) {
    step(etas[i]);
    const c = Math.cos((u * u) / 2), s = Math.sin((u * u) / 2);
    // e^{-i u^2/2} (Ir + i Ii)
    re[i] = (c * Ir + s * Ii) * norm;
    im[i] = (c * Ii - s * Ir) * norm;
  }
  return { re, im };
}

/** Laplace coefficient b_s^(m)(alpha) = (1/pi) int_0^2pi cos(m psi) (1 - 2 alpha cos psi + alpha^2)^-s dpsi. */
export function laplaceCoefficient(s: number, m: number, alpha: number): number {
  const N = 4096;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const p = ((i + 0.5) / N) * TWO_PI;
    sum += Math.cos(m * p) / Math.pow(1 - 2 * alpha * Math.cos(p) + alpha * alpha, s);
  }
  return (sum * (TWO_PI / N)) / Math.PI;
}

/** Tabulated wave: h(x, Psi) = A(x) cos(Psi + phi(x)), x = a' - rV; Psi = the forcing argument at the point. */
export interface WaveTable {
  def: BendingWaveDef;
  /** resonance radius (m), pattern speed (rad/s), D' = d(nu^2 - m^2 (Omega - Omega_p)^2)/dr at rV (1/s^2/m) */
  rV: number;
  patternSpeed: number;
  dD: number;
  /** +1: propagates outward (nodal), -1: inward (IVR) */
  side: number;
  /** length scale W = sqrt(2 pi G sigma / |D'|) (m) and viscous damping length x_D (m) */
  W: number;
  xD: number;
  /** linear-theory asymptotic amplitude A_V = F / sqrt(G sigma |D'|) (m; NaN without a forcing model) and the forcing (m/s^2) */
  AVlinear: number;
  forcing: number;
  /** the amplitude scale used (m) after calibration: the profile is scale * |H| * damping */
  AV: number;
  /** table: x0 (m, first sample relative to rV), dx (m), N samples of (A, phi, dA/dx, dphi/dx) */
  x0: number;
  dx: number;
  N: number;
  data: Float32Array;
  /** inverse table over the propagating side: x(phi) at phi = phiLo + j dPhi (crest search), with A and |k| there */
  phiLo: number;
  dPhi: number;
  NI: number;
  inv: Float32Array;
  /** peak |h| (m), maximum slope (rad), where (m from rV), and the local wavelength at a few distances */
  peak: number;
  peakX: number;
  maxSlope: number;
  maxSlopeX: number;
  /** extent of the non-negligible relief: x range (m) where A > 1e-3 peak */
  xLo: number;
  xHi: number;
}

function rootBisect(f: (x: number) => number, lo: number, hi: number): number {
  let flo = f(lo);
  for (let i = 0; i < 200; i++) {
    const m = 0.5 * (lo + hi);
    const fm = f(m);
    if ((fm <= 0) === (flo <= 0)) { lo = m; flo = fm; } else hi = m;
  }
  return 0.5 * (lo + hi);
}

export const WAVE_TABLE_N = 4096;

export function buildWaveTable(def: BendingWaveDef, freq: FreqFn): WaveTable {
  const m = def.m;
  const Op = def.kind === 'ivr' ? ((m + 1) * def.n - def.Omdot) / m : -def.n + def.pidot + def.Omdot;
  const D = (r: number) => {
    const f = freq(r);
    const w = m * (f.omega - Op);
    return f.nu * f.nu - w * w;
  };
  const rV = def.rV ?? rootBisect(D, def.rGuess * 0.97, def.rGuess * 1.03);
  const hD = 20;
  const dD = (D(rV + hD) - D(rV - hD)) / (2 * hD);
  const side = dD > 0 ? -1 : 1;
  const sig = def.sigma;
  const a = Math.abs(dD) / (2 * Math.PI * G * sig);
  const W = 1 / Math.sqrt(a);
  const mu = freq(rV).nu;
  // viscous damping of the WKB wave: amplitude rate gamma = nu_v k^2 / 2 over the group velocity pi G sigma / mu
  // -> |h| ~ exp(-(x/x_D)^3), x_D^3 = 6 pi G sigma W^4 / (nu_v mu) (reproduces Sega et al. 2024: slope 17.5 deg)
  const xD = Math.cbrt((6 * Math.PI * G * sig * W ** 4) / (def.nuVisc * mu));
  let F = NaN, AVlin = NaN;
  if (def.forcing) {
    const fo = def.forcing;
    F = (fo.gm * Math.sin(fo.inc) * laplaceCoefficient(1.5, m, rV / fo.a)) / (2 * fo.a * fo.a);
    AVlin = F / Math.sqrt(G * sig * Math.abs(dD));
  }
  // grid: from 6 W on the evanescent side to 2 x_D (+ 3 W) on the propagating side
  const N = WAVE_TABLE_N;
  const xEv = -side * 6 * W, xPr = side * (2 * xD + 3 * W);
  const x0 = Math.min(xEv, xPr), x1 = Math.max(xEv, xPr);
  const dx = (x1 - x0) / (N - 1);
  // eta increases toward the evanescent side: eta = -side x / W
  const etas = new Float64Array(N);
  for (let i = 0; i < N; i++) etas[i] = (-side * (x0 + i * dx)) / W;
  const order = side > 0 ? 1 : -1; // etas are decreasing in i when side > 0
  let prof: { re: Float64Array; im: Float64Array };
  if (order > 0) {
    // etas decreasing: evaluate on the reversed (increasing) grid
    const rev = new Float64Array(N);
    for (let i = 0; i < N; i++) rev[i] = etas[N - 1 - i];
    const p = fresnelProfile(rev);
    prof = { re: new Float64Array(N), im: new Float64Array(N) };
    for (let i = 0; i < N; i++) { prof.re[i] = p.re[N - 1 - i]; prof.im[i] = p.im[N - 1 - i]; }
  } else {
    prof = fresnelProfile(etas);
  }
  // complex coefficient: IVR forcing F_z = -F sin(Theta) -> H = +A_V H(eta); nodal: N&H 2016 equilibrium (z ~ +sin Theta
  // inside the resonance) -> H = -A_V H(eta)
  const csign = def.kind === 'ivr' ? 1 : -1;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const x = x0 + i * dx;
    const xp = side * x;   // distance into the propagating side
    const damp = xp > 0 ? Math.exp(-((xp / xD) ** 3)) : 1;
    const taper = xp < 0 ? 1 - smoothstep(3 * W, 5 * W, -xp) : 1;
    re[i] = csign * prof.re[i] * damp * taper;
    im[i] = csign * prof.im[i] * damp * taper;
  }
  // amplitude, unwrapped phase, derivatives
  const A = new Float64Array(N), ph = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    A[i] = Math.hypot(re[i], im[i]);
    let p = Math.atan2(im[i], re[i]);
    if (i > 0) p += TWO_PI * Math.round((ph[i - 1] - p) / TWO_PI);
    ph[i] = p;
  }
  const dA = new Float64Array(N), dP = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(N - 1, i + 1);
    dA[i] = (A[i1] - A[i0]) / ((i1 - i0) * dx);
    dP[i] = (ph[i1] - ph[i0]) / ((i1 - i0) * dx);
  }
  // calibration
  let pk = 0, pkX = 0, sl = 0, slX = 0;
  for (let i = 0; i < N; i++) {
    if (A[i] > pk) { pk = A[i]; pkX = x0 + i * dx; }
    const s = Math.hypot(dA[i], A[i] * dP[i]);
    if (s > sl) { sl = s; slX = x0 + i * dx; }
  }
  let AV = Number.isFinite(AVlin) ? AVlin : 1;
  if (def.calib?.peak) AV = def.calib.peak / pk;
  else if (def.calib?.maxSlope) AV = Math.tan(def.calib.maxSlope) / sl;
  const data = new Float32Array(N * 4);
  let xLo = Infinity, xHi = -Infinity;
  for (let i = 0; i < N; i++) {
    data[i * 4] = AV * A[i];
    data[i * 4 + 1] = ph[i];
    data[i * 4 + 2] = AV * dA[i];
    data[i * 4 + 3] = dP[i];
    if (A[i] > 1e-3 * pk) { xLo = Math.min(xLo, x0 + i * dx); xHi = Math.max(xHi, x0 + i * dx); }
  }
  // inverse table over the propagating side, where the phase decreases monotonically with the distance from the
  // resonance (phi ~ const - (x/W)^2 / 2): x(phi) at ascending phi = phiLo + j dPhi, for the crest search of the
  // relief shadows (with the amplitude and |k| there)
  const iRes = Math.min(N - 1, Math.max(0, Math.round(-x0 / dx)));
  const iFar = side > 0 ? N - 1 : 0;
  const seq: number[] = [];
  for (let i = iFar; side > 0 ? i >= iRes : i <= iRes; i -= side) seq.push(i);   // far end -> resonance
  // enforce monotonic (ascending) phase along seq: drop points that would break it (near the resonance)
  const mono: number[] = [seq[0]];
  for (let j = 1; j < seq.length; j++) if (ph[seq[j]] > ph[mono[mono.length - 1]]) mono.push(seq[j]);
  const NI = WAVE_TABLE_N;
  const phiLo = ph[mono[0]], phiHi = ph[mono[mono.length - 1]];
  const dPhi = (phiHi - phiLo) / (NI - 1);
  const inv = new Float32Array(NI * 4);
  for (let j = 0, k = 0; j < NI; j++) {
    const target = phiLo + j * dPhi;
    while (k < mono.length - 2 && ph[mono[k + 1]] < target) k++;
    const ia = mono[k], ib = mono[Math.min(k + 1, mono.length - 1)];
    const f = ph[ib] !== ph[ia] ? Math.min(1, Math.max(0, (target - ph[ia]) / (ph[ib] - ph[ia]))) : 0;
    inv[j * 4] = x0 + (ia + f * (ib - ia)) * dx;
    inv[j * 4 + 1] = AV * (A[ia] + f * (A[ib] - A[ia]));
    inv[j * 4 + 2] = Math.abs(dP[ia] + f * (dP[ib] - dP[ia]));
    inv[j * 4 + 3] = 0;
  }
  return {
    def, rV, patternSpeed: Op, dD, side, W, xD, AVlinear: AVlin, forcing: F, AV, x0, dx, N, data,
    phiLo, dPhi, NI, inv, peak: AV * pk, peakX: pkX, maxSlope: Math.atan(AV * sl), maxSlopeX: slX, xLo, xHi,
  };
}

/** Linear interpolation of a wave table at x = a' - rV: [A, phi, dA/dx, dphi/dx] (all 0 outside). */
export function sampleWave(T: WaveTable, x: number, out: number[]): void {
  const u = (x - T.x0) / T.dx;
  if (!(u >= 0 && u <= T.N - 1)) { out[0] = out[1] = out[2] = out[3] = 0; return; }
  const i = Math.min(T.N - 2, Math.floor(u));
  const f = u - i;
  const d = T.data;
  for (let c = 0; c < 4; c++) out[c] = d[i * 4 + c] + f * (d[(i + 1) * 4 + c] - d[i * 4 + c]);
}

// ------------------------------------------------------------------------------- moon mean elements (live)
export interface MoonElements {
  /** mean longitude, longitude of pericentre, ascending node on Saturn's equator (rad, SEF), inclination (rad), e */
  lambda: number;
  varpi: number;
  node: number;
  inc: number;
  e: number;
}

/**
 * Mean elements from a state vector (SEF, m, m/s) in the epicyclic approximation with the J2..J6 frequencies (as
 * RingStructure does for the moonlets): guiding centre from the angular rate, (e cos M, e sin M) from the radial
 * offset and velocity, lambda = theta - 2 (Omega/kappa) e sin M. Errors O(e^2): 4e-4 rad (Mimas), 8e-4 (Titan).
 */
export function moonElements(p: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }, freq: FreqFn): MoonElements {
  const hx = p.y * v.z - p.z * v.y, hy = p.z * v.x - p.x * v.z, hz = p.x * v.y - p.y * v.x;
  const h = Math.hypot(hx, hy, hz);
  const node = Math.atan2(hx, -hy);
  const inc = Math.acos(Math.max(-1, Math.min(1, hz / h)));
  const r = Math.hypot(p.x, p.y, p.z);
  // argument of latitude: angle in the orbit plane from the node
  const nx = Math.cos(node), ny = Math.sin(node);
  const cu = (p.x * nx + p.y * ny) / r;
  // (h x N) / |h|: in-plane unit vector 90 deg ahead of the node
  const qx = (hy * 0 - hz * ny) / h, qy = (hz * nx - hx * 0) / h, qz = (hx * ny - hy * nx) / h;
  const su = (p.x * qx + p.y * qy + p.z * qz) / r;
  const theta = node + Math.atan2(su, cu);
  const thDot = h / (r * r);
  const rDot = (p.x * v.x + p.y * v.y + p.z * v.z) / r;
  const fr = freq(r);
  const q = -(Math.log(freq(r * 1.0001).omega) - Math.log(freq(r * 0.9999).omega)) / (Math.log(1.0001) - Math.log(0.9999));
  const ag = r - ((fr.omega - thDot) * r) / ((2 - q) * fr.omega);
  const fg = freq(ag);
  const ecM = -(r - ag) / ag, esM = rDot / (fg.kappa * ag);
  const M = Math.atan2(esM, ecM);
  const lambda = theta - 2 * (fg.omega / fg.kappa) * esM;
  return { lambda: wrap2Pi(lambda), varpi: wrap2Pi(lambda - M), node: wrap2Pi(node), inc, e: Math.hypot(ecM, esM) };
}

// ------------------------------------------------------------------------------------------- corrugation
/**
 * The 1983 impact (Hedman et al. 2011; French et al. 2025): every streamline got the same vertical kick at t_i; the
 * m = 1 part winds up by differential nodal regression, z1 = A1 sin(theta - theta1 - (Omega - nu)(r) (t - t_i)), the
 * m = 0 and (slow) m = 2 parts by the mean motion: z0 = A0 sin(nu (t - t_i)), z2 = A2 sin(2 (theta - theta2) -
 * (2 Omega - nu) (t - t_i)) (impulsive kick: z = 0 at t_i). theta1, theta2 are not published (Hedman et al. 2011 set
 * the node to 0 "without loss of generality"): 0 here.
 */
export const CORRUGATION = {
  /** impact epoch: UTC 1983 Sep 19.25 +- 5.5 d (French et al. 2025) */
  tImpact: tFromIso('1983-09-19T06:00:00Z'),
  /** m = 1: tilt angle (A1 = r x tilt). C ring: Hedman et al. 2011 photometry 2e-8..3e-7 rad (2-20 m); 1e-7 adopted.
   *  D ring: several hundred m (Hedman et al. 2007, via French et al. 2025): 300 m at 70,000 km. */
  tiltC: 1e-7,
  tiltD: 300 / 70_000e3,
  theta1: 0,
  /** radial zones (m): D ring 66,900-74,490 km, C ring 74,490 km -> faded over the C-ring ramp (91,000-92,000 km) */
  rD0: 66_900e3,
  rCD: 74_490e3,
  rC1: 91_000e3,
  rC2: 92_000e3,
  /** m = 0 / m = 2 ripples of the inner C ring (74,500-77,765 km; none beyond, French et al. 2025): ~4 m each in 2017
   *  (2.6-6.6 m measured 2010-2017 where tau ~ 0.04-0.05), decaying (initial amplitudes 4-7x the 2017 values:
   *  e-folding ~19.5 yr) */
  ripA2017: 4,
  ripT2017: tFromIso('2017-01-01T00:00:00Z'),
  ripTau: 19.5 * 365.25 * DAY,
  ripR0: 74_490e3,
  ripR1: 74_600e3,
  ripR2: 77_700e3,
  ripR3: 77_765e3,
  theta2: 0,
};

/** Precise phase of a frequency function over the elapsed time dt: Taylor coefficients around r0 (double). */
interface PhaseExp { p0: number; c1: number; c2: number; c3: number }
function phaseExpansion(f: (r: number) => number, r0: number, dt: number): PhaseExp {
  const h = Math.max(50, r0 * 2e-5);
  const f0 = f(r0), fp = f(r0 + h), fm = f(r0 - h), fpp = f(r0 + 2 * h), fmm = f(r0 - 2 * h);
  const d1 = (fp - fm) / (2 * h) * (4 / 3) - (fpp - fmm) / (4 * h) / 3;
  const d2 = (fp - 2 * f0 + fm) / (h * h);
  const d3 = (fpp - 2 * fp + 2 * fm - fmm) / (2 * h * h * h);
  return { p0: wrap2Pi(f0 * dt), c1: d1 * dt, c2: (d2 * dt) / 2, c3: (d3 * dt) / 6 };
}

// --------------------------------------------------------------------------------------------- sites
export interface ReliefPeak {
  /** Lagrangian radius (m) */
  a: number;
  /** longitude offset from the site's centre (rad) */
  dLon: number;
  /** height (m), radial and azimuthal (arc) Gaussian widths (m) */
  h: number;
  sr: number;
  ss: number;
}
export interface ReliefSite {
  id: string;
  name: string;
  /** longitude (rad, SEF) of the centre at epoch t0 (s past J2000) and its mean motion (rad/s) */
  lon0: number;
  t0: number;
  n: number;
  peaks: ReliefPeak[];
  source: string;
}

/** PCG hash as sv_common pcgHash / hashU (GLSL: float(uint) rounds to float32, mirrored with Math.fround). */
export function pcgHash(v: number): number {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}
export function hashU(v: number): number {
  return Math.fround(pcgHash(v)) / 4294967296;
}

/**
 * B-ring edge "region A" (Spitale & Porco 2010, AJ 140, 1747, section 6): a site orbiting at 758.986 deg/day (117,547.6 km,
 * ~20 km inside the mean edge), J2000 longitude 95 deg -- read as the longitude at epoch J2000.0 in the ascending-node
 * (SEF) system: it then puts the site at 168.2 deg on 2009-07-26 09:57 UTC, inside the 165.8-168.4 deg footprint of the
 * NAC frame N1627295980 (PIA11668) that shows the shadows (their central epoch JED 2454256.9 would give 355 deg) --
 * spanning ~10 deg (~20,000 km) of azimuth, with vertical structures up to 3.5 km (PIA11668: 2.5 km) that cast shadows
 * near equinox, coincident with the bright streaks lining the edge ("splashing" around embedded bodies hundreds of m to
 * km in size). PIA11668 shows dozens of them per ~1000 km of edge. Phenomenological model, a procedural cell field
 * (the same hash on CPU and GPU): the span is cut into 40 km arcs, 65 % of which hold one Gaussian structure --
 * heights 0.28-3.5 km (h = 3.5 km (0.08 + 0.92 u^5) x taper: 322 structures, median 0.32 km, 10 % above 2.1 km,
 * tallest 3.3 km (scripts/data/rings/relief_check.mjs) -- as the 30-90 px shadows of PIA11668 with a few longer
 * ones), radial sigma 2-5 km, 1.5-3.5x longer along the orbit (the frame's shadows are
 * ~10-20 km wide), Lagrangian radius from 5 km inside the site to 18 km outside it (biased toward the edge streamline
 * at 117,568 km; they move with the edge modes), heights tapered over the outer 1.5 deg of the span.
 */
export const REGION_A = {
  a: 117_547.6e3,
  n: (758.986 * DEG) / DAY,
  lon0: 95 * DEG,
  t0: 0,
  halfSpan: 5 * DEG,
  taper: 1.5 * DEG,
  cellArc: 40e3,
  occupancy: 0.65,
  bandLo: -5e3,
  bandHi: 18e3,
  hMax: 3500,
  srMax: 5000,
  seed: 0x5a17e2,
  source: 'Spitale & Porco 2010 section 6 (site); structure shapes and density phenomenological (PIA11668)',
};
export const REGION_A_CELLS = Math.round((2 * REGION_A.halfSpan * REGION_A.a) / REGION_A.cellArc);

/** Structure of region-A cell j (0..REGION_A_CELLS-1): angle from the span start (rad), a' (m), h (m), sigmas (m); null if empty. */
export function regionACell(j: number): { phi: number; a: number; h: number; sr: number; ss: number } | null {
  const R = REGION_A;
  if (j < 0 || j >= REGION_A_CELLS) return null;
  const h0 = pcgHash((j ^ R.seed) >>> 0);
  if (hashU(h0) >= R.occupancy) return null;
  const u = (k: number) => hashU(pcgHash((h0 + k) >>> 0));
  const dphi = R.cellArc / R.a;
  const phi = (j + 0.15 + 0.7 * u(1)) * dphi;
  const tap = Math.min(smoothstep(0, R.taper, phi), smoothstep(0, R.taper, 2 * R.halfSpan - phi));
  const u3 = u(3);
  const sr = 2000 + 3000 * u(4);
  return {
    phi,
    a: R.a + R.bandLo + (R.bandHi - R.bandLo) * Math.pow(u(2), 0.7),
    h: R.hMax * (0.08 + 0.92 * u3 * u3 * u3 * u3 * u3) * tap,
    sr,
    ss: sr * (1.5 + 2 * u(5)),
  };
}

/**
 * S/2009 S1 (Spitale & Porco 2010 section 7): moonlet ~300 m across at 116,914 +- 17 km, rising ~150 m above the ring
 * plane (36 km shadow at 0.24 deg solar elevation), in NAC frame N1627301569 (2009-07-26 11:30:49.7 UTC) whose ring
 * footprint spans 143.7-145.1 deg (ascending-node longitude; OPUS) -> 144.4 deg then; mean motion: Keplerian (J2..J6)
 * at its radius (the +-17 km radius error alone makes the longitude unknown by ~+-0.17 deg/day away from 2009).
 * Modelled as the relief of its propeller core: a 150 m Gaussian bump, radial width 150 m, 300 m along the orbit.
 */
function s2009s1(freq: FreqFn): ReliefSite {
  const a = 116_914e3;
  return {
    id: 's2009s1', name: 'S/2009 S1', lon0: 144.4 * DEG, t0: tFromIso('2009-07-26T11:30:49.665Z'), n: freq(a).omega,
    peaks: [{ a, dLon: 0, h: 150, sr: 150, ss: 300 }],
    source: 'Spitale & Porco 2010 section 7; OPUS geometry of N1627301569',
  };
}

// ------------------------------------------------------------------------------------------- the model
/** single peaks (uniform slots; region A is a procedural cell field) -- RR_PEAKS in ringRelief.glsl */
export const RELIEF_MAX_PEAKS = 8;
export const RELIEF_WAVES = 3;

export interface ReliefWaveState {
  T: WaveTable;
  /** forcing argument at the ring-frame origin azimuth now (rad, mod 2 pi); 0 amplitude scale = off */
  theta0: number;
  /** dTheta/dt at fixed theta (rad/s) */
  rate: number;
  scale: number;
}

/**
 * Per-frame state + CPU evaluation of the relief (mirror of sv_ringRelief). update() once per frame (RingStructure),
 * then eval(aL, dth, fp) at Lagrangian offsets from the frame origin.
 */
export class RingRelief {
  readonly freq: FreqFn;
  readonly waves: ReliefWaveState[];
  readonly sites: ReliefSite[];
  /** master switch / multiplier (1 = physical, 0 = flat; > 1 for inspection) */
  scale = 1;
  /** frame state of the last update */
  t = 0;
  r0 = 1.3e8;
  phi0 = 0;
  /** sign of the Sun's elevation at the last update (orientation of the sites' peaks) */
  sunSign = 1;
  /** corrugation: m = 1 phase at the frame origin, and the m = 0 / m = 2 phase expansions around r0 */
  corrOn = false;
  corrDt = 0;
  corrPsi1 = 0;
  rip = { amp: 0, e0: { p0: 0, c1: 0, c2: 0, c3: 0 } as PhaseExp, e2: { p0: 0, c1: 0, c2: 0, c3: 0 } as PhaseExp, psi2dth: 0 };
  /** peaks of all sites at the current time: (a' - r0, dth from the frame origin, h, sr, ss) */
  readonly peaks: { aL: number; dth: number; h: number; sr: number; ss: number }[] = [];
  /** region A now: its radius offset a - r0 (m), the span start's azimuth offset from the frame origin (rad), height
   *  scale (sun side x scale; 0 = off) */
  regionA = { aL: 1e12, dthStart: 0, hScale: 0 };

  constructor(freq: FreqFn) {
    this.freq = freq;
    this.waves = BENDING_WAVES.map((d) => ({ T: buildWaveTable(d, freq), theta0: 0, rate: 0, scale: 0 }));
    this.sites = [s2009s1(freq)];
    let n = 0;
    for (const s of this.sites) n += s.peaks.length;
    if (n > RELIEF_MAX_PEAKS) throw new Error(`relief: ${n} peaks > ${RELIEF_MAX_PEAKS}`);
  }

  /** Nodal precession rate Omega - nu (< 0) without cancellation. */
  nodalRate(r: number): number {
    const f = this.freq(r);
    return -(f.nu * f.nu - f.omega * f.omega) / (f.nu + f.omega);
  }
  /**
   * d(Omega - nu)/dr, exact, as the GLSL computes it (rrNodalRateDeriv): Omega - nu = -D / S with D = nu^2 - Omega^2
   * = n^2 (3 J2 x^2 - 7.5 J4 x^4 + 13.125 J6 x^6), x = R/r, and S = nu + Omega; every J term of D and Omega^2 scales as
   * r^-(3+2k), S' = (Omega^2)' / (2 Omega) + (nu^2)' / (2 nu).
   */
  nodalRateDeriv(r: number): number {
    const f = this.freq(r);
    const d2 = f.nu * f.nu - f.omega * f.omega;
    const g = SATURN_GRAVITY;
    const n2r = g.GM / (r * r * r * r);
    const x2 = (g.R / r) ** 2, x4 = x2 * x2, x6 = x4 * x2;
    const dD = -n2r * (15 * g.J2 * x2 - 52.5 * g.J4 * x4 + 118.125 * g.J6 * x6);
    const dOm2 = -n2r * (3 + 7.5 * g.J2 * x2 - 13.125 * g.J4 * x4 + 19.6875 * g.J6 * x6);
    const S = f.nu + f.omega;
    const dS = (0.5 * dOm2) / f.omega + (0.5 * (dOm2 + dD)) / f.nu;
    return -(dD - (d2 * dS) / S) / S;
  }

  /**
   * Per-frame state: time, ring-frame origin (r0, phi0), the moons' state vectors (bending-wave phases), the sign of
   * the Sun's elevation (the sites' vertical structures are symmetric thickenings of the layer -- "splashing", Spitale
   * & Porco 2010 -- of which a single mid-plane height field can only carry one side: their sunlit half, so the peaks
   * rise toward the lit face and cast shadows on it before and after an equinox, as observed).
   */
  update(t: number, r0: number, phi0: number, moons: { id: number; pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } }[], sunSign = 1): void {
    this.t = t;
    this.r0 = r0;
    this.phi0 = phi0;
    this.sunSign = sunSign >= 0 ? 1 : -1;
    for (const w of this.waves) {
      const d = w.T.def;
      const m = moons.find((x) => x.id === d.moonId);
      w.scale = m ? this.scale : 0;
      if (!m) continue;
      const el = moonElements(m.pos, m.vel, this.freq);
      if (d.kind === 'ivr') {
        w.theta0 = wrap2Pi(d.m * phi0 - (d.m + 1) * el.lambda + el.node);
        w.rate = -(d.m + 1) * d.n + d.Omdot;
      } else {
        w.theta0 = wrap2Pi(phi0 + el.lambda - el.varpi - el.node);
        w.rate = d.n - d.pidot - d.Omdot;
      }
    }
    // corrugation
    const C = CORRUGATION;
    const dt = t - C.tImpact;
    this.corrOn = dt > 0 && this.scale !== 0;
    this.corrDt = dt;
    if (this.corrOn) {
      this.corrPsi1 = wrap2Pi(phi0 - C.theta1 - this.nodalRate(r0) * dt);
      const amp = C.ripA2017 * Math.exp(-(t - C.ripT2017) / C.ripTau) * this.scale;
      this.rip.amp = amp;
      this.rip.e0 = phaseExpansion((r) => this.freq(r).nu, r0, dt);
      this.rip.e2 = phaseExpansion((r) => { const f = this.freq(r); return 2 * f.omega - f.nu; }, r0, dt);
      this.rip.psi2dth = wrap2Pi(2 * (phi0 - C.theta2));
    }
    // sites: region A's cell field, the single peaks
    const lonA = REGION_A.lon0 + REGION_A.n * (t - REGION_A.t0);
    this.regionA.aL = REGION_A.a - r0;
    this.regionA.dthStart = wrapPi(lonA - REGION_A.halfSpan - phi0);
    this.regionA.hScale = this.sunSign * this.scale;
    this.peaks.length = 0;
    for (const s of this.sites) {
      const lon = s.lon0 + s.n * (t - s.t0);
      for (const p of s.peaks) {
        this.peaks.push({ aL: p.a - r0, dth: wrapPi(lon + p.dLon - phi0), h: this.sunSign * p.h * this.scale, sr: p.sr, ss: p.ss });
      }
    }
  }

  private readonly _w = [0, 0, 0, 0];

  /**
   * Relief at Lagrangian offset aL = a' - r0 (m) and azimuth offset dth from the frame origin, radial footprint fp (m):
   * o = [h, dh/da', dh/dS] (m, -, -). Footprint prefilter: each component fades where its radial (or arc) scale drops
   * below ~2 footprints.
   */
  eval(aL: number, dth: number, fp: number, o: number[]): void {
    o[0] = o[1] = o[2] = 0;
    if (this.scale === 0) return;
    const r = this.r0 + aL;
    // bending waves
    for (const w of this.waves) {
      if (w.scale === 0) continue;
      const T = w.T;
      const x = aL - (T.rV - this.r0);
      sampleWave(T, x, this._w);
      const A = this._w[0];
      if (A === 0) continue;
      const k = Math.abs(this._w[3]);
      const lam = k > 0 ? TWO_PI / k : 1e30;
      const fade = w.scale * (1 - smoothstep(0.25 * lam, 0.5 * lam, fp));
      if (fade === 0) continue;
      const psi = w.theta0 + T.def.m * dth + this._w[1];
      const c = Math.cos(psi), s = Math.sin(psi);
      o[0] += fade * A * c;
      o[1] += fade * (this._w[2] * c - A * this._w[3] * s);
      o[2] += fade * (-A * T.def.m * s) / r;
    }
    // corrugation
    if (this.corrOn) this.evalCorrugation(aL, dth, fp, r, o);
    // sites
    for (const p of this.peaks) {
      const da = aL - p.aL;
      if (Math.abs(da) > 5 * p.sr) continue;
      const ds = wrapPi(dth - p.dth) * r;
      if (Math.abs(ds) > 5 * p.ss) continue;
      const fade = 1 - smoothstep(p.sr, 2 * p.sr, fp);
      if (fade === 0) continue;
      const g = fade * p.h * Math.exp(-0.5 * ((da * da) / (p.sr * p.sr) + (ds * ds) / (p.ss * p.ss)));
      o[0] += g;
      o[1] += (-g * da) / (p.sr * p.sr);
      o[2] += (-g * ds) / (p.ss * p.ss);
    }
    this.evalRegionA(aL, dth, fp, o);
  }

  /** Region A's structures around (aL, dth): the point's cell and its two neighbours (as rrRegionA in the GLSL). */
  private evalRegionA(aL: number, dth: number, fp: number, o: number[]): void {
    const A = this.regionA, R = REGION_A;
    if (A.hScale === 0) return;
    const da0 = aL - A.aL;
    if (da0 < R.bandLo - 5 * R.srMax || da0 > R.bandHi + 5 * R.srMax) return;
    const rel = wrapPi(dth - A.dthStart);
    const dphi = R.cellArc / R.a;
    const fj = rel / dphi;
    if (fj < -1 || fj > REGION_A_CELLS + 1) return;
    const j0 = Math.floor(fj);
    for (let j = j0 - 1; j <= j0 + 1; j++) {
      const c = regionACell(j);
      if (!c) continue;
      const da = aL - (c.a - this.r0);
      const ds = (rel - c.phi) * R.a;
      // prefilter on the structure's mean size (elongated along the orbit)
      const g0 = Math.sqrt(c.sr * c.ss);
      const fade = 1 - smoothstep(g0, 2 * g0, fp);
      if (fade === 0) continue;
      const g = fade * A.hScale * c.h * Math.exp(-0.5 * ((da * da) / (c.sr * c.sr) + (ds * ds) / (c.ss * c.ss)));
      o[0] += g;
      o[1] += (-g * da) / (c.sr * c.sr);
      o[2] += (-g * ds) / (c.ss * c.ss);
    }
  }

  private evalCorrugation(aL: number, dth: number, fp: number, r: number, o: number[]): void {
    const C = CORRUGATION;
    const dt = this.corrDt;
    // m = 1 (C and D rings)
    if (r > C.rD0 && r < C.rC2) {
      const tilt = r < C.rCD ? C.tiltD + (C.tiltC - C.tiltD) * smoothstep(C.rCD - 500e3, C.rCD + 500e3, r) : C.tiltC;
      const env = (1 - smoothstep(C.rC1, C.rC2, r)) * smoothstep(C.rD0, C.rD0 + 500e3, r);
      const A = this.scale * tilt * r * env;
      const nr = this.nodalRate(r);
      const k = -this.nodalRateDeriv(r) * dt; // dPsi1/dr
      const lam = TWO_PI / Math.max(Math.abs(k), 1e-12);
      const fade = 1 - smoothstep(0.25 * lam, 0.5 * lam, fp);
      if (fade > 0 && A > 0) {
        // Psi1 = theta - theta1 - (Omega - nu)(r) dt = corrPsi1 + dth - [(Omega-nu)(r) - (Omega-nu)(r0)] dt
        const psi = this.corrPsi1 + dth - (nr - this.nodalRate(this.r0)) * dt;
        const s = Math.sin(psi), c = Math.cos(psi);
        o[0] += fade * A * s;
        o[1] += fade * A * k * c;
        o[2] += (fade * A * c) / r;
      }
    }
    // m = 0 / m = 2 ripples (inner C ring)
    if (r > C.ripR0 && r < C.ripR3 && this.rip.amp > 0) {
      const env = smoothstep(C.ripR0, C.ripR1, r) * (1 - smoothstep(C.ripR2, C.ripR3, r));
      const A = this.rip.amp * env;
      const e0 = this.rip.e0, e2 = this.rip.e2;
      let p0: number, p2: number, k0: number, k2: number;
      if (Math.abs(aL) < 3e5) {
        p0 = e0.p0 + aL * (e0.c1 + aL * (e0.c2 + aL * e0.c3));
        p2 = this.rip.psi2dth + 2 * dth - (e2.p0 + aL * (e2.c1 + aL * (e2.c2 + aL * e2.c3)));
        k0 = e0.c1 + aL * (2 * e0.c2 + 3 * aL * e0.c3);
        k2 = -(e2.c1 + aL * (2 * e2.c2 + 3 * aL * e2.c3));
      } else {
        // as the GLSL far from the frame origin (power-law derivatives)
        const f = this.freq(r);
        p0 = f.nu * dt;
        p2 = this.rip.psi2dth + 2 * dth - (2 * f.omega - f.nu) * dt;
        k0 = (-1.5 * f.nu * dt) / r;
        k2 = (1.5 * (2 * f.omega - f.nu) * dt) / r;
      }
      const lam = TWO_PI / Math.max(Math.abs(k0), 1e-12);
      const fade = 1 - smoothstep(0.25 * lam, 0.5 * lam, fp);
      if (fade > 0 && A > 0) {
        const s0 = Math.sin(p0), c0 = Math.cos(p0), s2 = Math.sin(p2), c2 = Math.cos(p2);
        o[0] += fade * A * (s0 + s2);
        o[1] += fade * A * (k0 * c0 + k2 * c2);
        o[2] += (fade * A * 2 * c2) / r;
      }
    }
  }

  /** Upper bound of |h| (m) within `margin` of the Eulerian radius offset dr from r0 (sheet search / march slab). */
  bound(dr: number, margin = 0): number {
    if (this.scale === 0) return 0;
    const r = this.r0 + dr;
    let b = 0;
    for (const w of this.waves) {
      if (w.scale === 0) continue;
      const lo = w.T.rV + w.T.xLo - margin, hi = w.T.rV + w.T.xHi + margin;
      if (r > lo && r < hi) b += w.T.peak * w.scale;
    }
    const C = CORRUGATION;
    if (this.corrOn && r > C.rD0 - margin && r < C.rC2 + margin) {
      b += this.scale * (r < C.rCD + 500e3 + margin ? C.tiltD : C.tiltC) * Math.min(r + margin, C.rC2);
      if (r > C.ripR0 - margin && r < C.ripR3 + margin) b += 2 * this.rip.amp;
    }
    // sites (Lagrangian radii; the B-ring edge modes move them by up to ~105 km): the tallest peak nearby
    let site = 0;
    for (const p of this.peaks) {
      if (Math.abs(dr - p.aL) < 5 * p.sr + 110e3 + margin) site = Math.max(site, Math.abs(p.h));
    }
    const A = this.regionA;
    if (A.hScale !== 0 && dr - A.aL > REGION_A.bandLo - 5 * REGION_A.srMax - 110e3 - margin && dr - A.aL < REGION_A.bandHi + 5 * REGION_A.srMax + 110e3 + margin) {
      site = Math.max(site, REGION_A.hMax * Math.abs(A.hScale));
    }
    return b + site;
  }

  /** Relief height (m) at an SEF radius / azimuth at the current frame state (no streamline map; HUD, presets). */
  heightAtSEF(r: number, theta: number, fp = 0): number {
    const o = [0, 0, 0];
    this.eval(r - this.r0, wrapPi(theta - this.phi0), fp, o);
    return o[0];
  }
}
