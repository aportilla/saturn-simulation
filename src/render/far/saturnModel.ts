// CPU-side model of Saturn's visible cloud deck for the far-field renderer:
//  * zonal wind profile u(latitude) relative to System III and the derived angular drift rate
//  * latitude palette (albedo per band) for the 2025-2027 season, packed in a lookup texture
//  * long-lived discrete storms, advected with the local wind (double precision on the CPU)
//  * two-phase advection clock for the procedural turbulence (bounded shear, crossfaded resets)
//
// Latitudes are PLANETOGRAPHIC (angle of the 1-bar surface normal to the equator plane), the convention of
// the wind literature. Longitudes are System III EAST longitudes (body frame rotating with uSaturnRot).
import { ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, RGBAFormat } from 'three';
import { DEG, SATURN } from '../../core/constants';

export const SAT_LUT_N = 1024;
/** brightness-contrast and colour-ratio exponents applied to the palette around its mean */
const CONTRAST_GAMMA = 1.2;
const SAT_GAMMA = 1.25;

// ------------------------------------------------------------------------------------------- winds
// Zonal wind (m/s, + = eastward/prograde) vs planetographic latitude, relative to System III.
// Shape after Sanchez-Lavega et al. (2000, Icarus 147) and Garcia-Melendo et al. (2011, Icarus 215, CB2
// filter ~ upper troposphere): a broad equatorial super-rotating jet peaking ~445 m/s, and alternating
// narrow mid/high-latitude jets (eastward peaks ~60-120 m/s, westward ~ -20 m/s), the 77.5 N hexagon jet
// (~110 m/s) and the cyclonic polar vortices (~140-150 m/s just off the poles).
const JETS: [number, number, number][] = [
  // [planetographic lat (deg), peak (m/s), gaussian sigma (deg)]
  [41.5, -18, 2.2], [47.0, 105, 2.0], [55.5, -25, 2.2], [61.5, 80, 2.0], [70.0, -20, 1.8],
  [77.5, 110, 1.3], [88.4, 140, 0.9],
  [-35.5, -22, 2.2], [-41.5, 80, 2.0], [-51.0, -20, 2.2], [-59.0, 60, 2.0], [-66.0, -20, 1.8],
  [-72.5, 85, 1.6], [-87.6, 150, 1.0],
];
export function zonalWind(latG: number): number {
  const d = latG / DEG;
  const a = Math.abs(d);
  let u = 445 * Math.exp(-Math.pow(a / 22, 2.2));
  for (const [c, A, s] of JETS) u += A * Math.exp(-0.5 * ((d - c) / s) ** 2);
  return u;
}
/** Distance (m) from the spin axis of the 1-bar surface point at planetographic latitude latG. */
export function axisDistance(latG: number): number {
  const a = SATURN.R_EQ, b = SATURN.R_POL;
  const c = Math.cos(latG), s = Math.sin(latG);
  return (a * a * c) / Math.sqrt(a * a * c * c + b * b * s * s);
}
/** Eastward angular drift (rad/s) of cloud features relative to System III. Solid-body within 1500 km of the poles. */
export function angularRate(latG: number): number {
  const rhoC = 1.5e6;
  let lat = latG;
  if (axisDistance(lat) < rhoC) {
    // find the latitude where rho = rhoC (same hemisphere) and use the solid-body rate there
    let lo = 0, hi = Math.PI / 2;
    for (let i = 0; i < 40; i++) {
      const m = 0.5 * (lo + hi);
      if (axisDistance(m) > rhoC) lo = m; else hi = m;
    }
    lat = Math.sign(latG) * lo;
  }
  return zonalWind(lat) / axisDistance(lat);
}

// ------------------------------------------------------------------------------------------- palette
// Visible-light appearance of the bands (Cassini ISS natural-colour mosaics 2004-2017, HST/OPAL 2018-2024),
// with the seasonal state just after the May-2025 equinox: the north still carries its summer haze (warm
// khaki/golden high latitudes, hexagon interior), the south emerges from winter with the reduced-haze
// grey-blue tint seen in the north at the 2009 equinox. sRGB triplets (relative), north positive.
const PALETTE: [number, [number, number, number]][] = [
  [90, [130, 123, 100]], [86, [146, 138, 110]], [82, [160, 150, 118]], [79.5, [154, 146, 116]],
  [77.5, [150, 144, 118]], [75.5, [182, 172, 140]], [72, [170, 160, 128]], [68, [184, 172, 138]],
  [64, [174, 158, 122]], [61, [192, 178, 142]], [57, [180, 162, 124]], [53, [198, 182, 144]],
  [49.5, [188, 168, 128]], [47, [176, 156, 118]], [44.5, [202, 186, 148]], [41, [208, 190, 150]],
  [37, [216, 200, 160]], [33, [204, 184, 140]], [29, [196, 172, 124]], [25, [208, 184, 134]],
  [21, [190, 158, 106]], [17.5, [198, 164, 110]], [14, [220, 194, 144]], [10, [234, 212, 162]],
  [5, [240, 220, 172]], [2, [232, 210, 160]], [0, [237, 215, 166]], [-2.5, [234, 212, 163]],
  [-6, [240, 218, 170]], [-10, [230, 206, 154]], [-14, [212, 182, 126]], [-18, [194, 160, 106]],
  [-21.5, [204, 174, 122]], [-25.5, [212, 188, 140]], [-29.5, [198, 174, 128]], [-34, [190, 170, 130]],
  [-38, [206, 188, 150]], [-42, [190, 176, 142]], [-46, [188, 178, 148]], [-50, [178, 172, 150]],
  [-55, [168, 166, 152]], [-60, [160, 160, 152]], [-65, [150, 152, 148]], [-70, [142, 145, 143]],
  [-75, [134, 137, 136]], [-80, [126, 128, 128]], [-85, [116, 117, 118]], [-90, [104, 104, 106]],
];
/** Geometric albedo of the disk (linear RGB, ~ R 610 / G 545 / B 465 nm; Karkoschka 1994/1998, B-V = 1.04). */
export const SATURN_P_RGB: [number, number, number] = [0.54, 0.49, 0.36];
/** Minnaert exponent k per channel (limb darkening); I/F = A mu0^k mu^(k-1); p = 2A/(2k+1). */
export const SATURN_MINNAERT_K: [number, number, number] = [0.9, 0.88, 0.84];

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Relative linear-RGB palette at planetographic latitude (deg), smooth interpolation of the control points. */
function paletteAt(d: number): [number, number, number] {
  for (let i = 0; i < PALETTE.length - 1; i++) {
    const [l0, c0] = PALETTE[i];
    const [l1, c1] = PALETTE[i + 1];
    if (d <= l0 && d >= l1) {
      const t = smooth(l0, l1, d);
      return [0, 1, 2].map((k) => srgbToLinear(c0[k] * (1 - t) + c1[k] * t)) as [number, number, number];
    }
  }
  return [0, 1, 2].map((k) => srgbToLinear(PALETTE[PALETTE.length - 1][1][k])) as [number, number, number];
}

/** Lookup texture SAT_LUT_N x 2 (RGBA32F), u = (latG + 90deg)/180deg:
 *  row 0: Minnaert albedo A (linear RGB, absolute), a = latitude-turbulence amplitude (rad)
 *  row 1: r = eastward drift rate (rad/s) * 1e6, g = fine-detail contrast, b = streak stretch, a = band-edge sharpness */
export function buildSaturnLut(): DataTexture {
  const N = SAT_LUT_N;
  const data = new Float32Array(N * 2 * 4);
  const rnd = lcg(0x5a7);
  // fine sub-bands: many thin parallel stripes of slightly different brightness/colour
  const sub: { c: number; w: number; a: number; tint: number }[] = [];
  for (let i = 0; i < 110; i++) {
    const c = -88 + 176 * rnd();
    const w = 0.12 + 0.9 * rnd() * rnd();
    const belt = Math.abs(c) > 12 && Math.abs(c) < 30 ? 1.4 : 1.0;
    sub.push({ c, w, a: (rnd() * 2 - 1) * 0.07 * belt, tint: (rnd() * 2 - 1) * 0.04 });
  }
  const rel: [number, number, number][] = [];
  for (let i = 0; i < N; i++) {
    const d = -90 + (180 * (i + 0.5)) / N;
    const c = paletteAt(d);
    let m = 1, t = 0;
    for (const s of sub) {
      const g = Math.exp(-0.5 * ((d - s.c) / s.w) ** 2);
      m += s.a * g;
      t += s.tint * g;
    }
    rel.push([c[0] * m * (1 + t), c[1] * m, c[2] * m * (1 - t)]);
  }
  // normalise: area-weighted (equator-on disk, cos-lat weighting of the projected area) mean per channel
  const mean = [0, 0, 0];
  let wsum = 0;
  for (let i = 0; i < N; i++) {
    const lat = (-90 + (180 * (i + 0.5)) / N) * DEG;
    const w = Math.cos(lat) * Math.cos(lat);
    for (let k = 0; k < 3; k++) mean[k] += rel[i][k] * w;
    wsum += w;
  }
  for (let k = 0; k < 3; k++) mean[k] /= wsum;
  // contrast: the control points are taken from (gamma-encoded, stretched) natural-colour mosaics; band
  // contrast in calibrated I/F is similar to slightly stronger -> mild power-law boost around the mean
  const meanY = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2];
  for (let i = 0; i < N; i++) {
    const c = rel[i];
    const y = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / meanY;
    const g = Math.pow(y, CONTRAST_GAMMA);
    for (let k = 0; k < 3; k++) c[k] = mean[k] * Math.pow(c[k] / mean[k] / y, SAT_GAMMA) * g;
  }
  // re-normalise after the boost
  mean[0] = mean[1] = mean[2] = 0;
  for (let i = 0; i < N; i++) {
    const lat = (-90 + (180 * (i + 0.5)) / N) * DEG;
    const w = Math.cos(lat) * Math.cos(lat);
    for (let k = 0; k < 3; k++) mean[k] += rel[i][k] * w;
  }
  for (let k = 0; k < 3; k++) mean[k] /= wsum;
  const amin = SATURN_MINNAERT_K.map((k, j) => (SATURN_P_RGB[j] * (2 * k + 1)) / 2);
  for (let i = 0; i < N; i++) {
    const d = -90 + (180 * (i + 0.5)) / N;
    const a = Math.abs(d);
    const lat = d * DEG;
    const o0 = i * 4;
    for (let k = 0; k < 3; k++) data[o0 + k] = (rel[i][k] / mean[k]) * amin[k];
    // turbulence (latitude displacement) amplitude, radians
    const turb = a < 10 ? 0.35 : a < 30 ? 0.75 : a < 62 ? 0.9 : a < 74 ? 0.65 : 0.45;
    data[o0 + 3] = turb * DEG;
    const o1 = (N + i) * 4;
    data[o1] = angularRate(lat) * 1e6;
    data[o1 + 1] = a < 10 ? 0.045 : a < 30 ? 0.07 : a < 62 ? 0.06 : 0.05; // fine-detail contrast
    data[o1 + 2] = a < 60 ? 4.0 - 2.0 * smooth(40, 60, a) : 2.0 - 1.0 * smooth(60, 75, a); // streak stretch
    data[o1 + 3] = 1;
  }
  const tex = new DataTexture(data, N, 2, RGBAFormat, FloatType);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------------------------------- storms
export interface Storm {
  latDeg: number; // planetographic
  lonDeg: number; // System III east longitude at T_REF
  radiusKm: number;
  /** 0 = bright convective cloud, 1 = dark (brownish) oval, 2 = pale oval */
  kind: 0 | 1 | 2;
  strength: number;
}
/** Reference epoch for storm longitudes: 2026-01-01T00:00 TDB (s since J2000). */
export const STORM_T_REF = 820_454_400;
export const STORMS: Storm[] = [
  { latDeg: -35.2, lonDeg: 40, radiusKm: 1100, kind: 0, strength: 0.45 },   // "storm alley" convective spots
  { latDeg: -34.8, lonDeg: 162, radiusKm: 800, kind: 0, strength: 0.35 },
  { latDeg: -35.6, lonDeg: 287, radiusKm: 600, kind: 0, strength: 0.3 },
  { latDeg: -42.3, lonDeg: 220, radiusKm: 2300, kind: 1, strength: 0.2 },  // brownish anticyclone
  { latDeg: 55.4, lonDeg: 95, radiusKm: 1900, kind: 1, strength: 0.16 },
  { latDeg: 61.2, lonDeg: 300, radiusKm: 750, kind: 0, strength: 0.3 },
  { latDeg: 42.0, lonDeg: 12, radiusKm: 2600, kind: 2, strength: 0.14 },
  { latDeg: -66.2, lonDeg: 132, radiusKm: 1200, kind: 0, strength: 0.22 },
  { latDeg: 33.2, lonDeg: 200, radiusKm: 950, kind: 1, strength: 0.14 },
  { latDeg: -24.6, lonDeg: 350, radiusKm: 1000, kind: 0, strength: 0.18 },
  { latDeg: 70.6, lonDeg: 230, radiusKm: 1400, kind: 2, strength: 0.15 },
];
export const MAX_STORMS = 12;

/** Advection-clock period (simulated seconds) of the procedural turbulence. */
export const ADVECT_PERIOD = 2 * 86400;

export interface AdvectionState {
  tau0: number; tau1: number; w0: number; w1: number;
  seed0: [number, number, number]; seed1: [number, number, number];
}
/** Deterministic pattern offset for an advection cycle (written into `out`, no allocation). */
function seedFor(cycle: number, out: [number, number, number]): void {
  let s = ((cycle * 2654435761) >>> 0) ^ 0x9e37;
  for (let k = -2; k < 3; k++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    if (k >= 0) out[k] = (s / 4294967296) * 200 - 100;
  }
}
/** Two crossfaded advection phases offset by half a period; each restarts (with a new pattern seed) when its weight is 0. */
export function advectionState(t: number, period = ADVECT_PERIOD, out?: AdvectionState): AdvectionState {
  const o = out ?? { tau0: 0, tau1: 0, w0: 1, w1: 0, seed0: [0, 0, 0], seed1: [0, 0, 0] };
  const c0 = Math.floor(t / period);
  const c1 = Math.floor(t / period + 0.5);
  o.tau0 = t - c0 * period;
  o.tau1 = t - (c1 - 0.5) * period;
  o.w0 = 1 - Math.abs(1 - (2 * o.tau0) / period);
  o.w1 = 1 - o.w0;
  seedFor(2 * c0, o.seed0);
  seedFor(2 * c1 + 1, o.seed1);
  return o;
}
