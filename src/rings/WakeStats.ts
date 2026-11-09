// Statistics of the procedural self-gravity-wake field and the medium's dynamical optical depth (docs/ring-physics.md
// 10.9 "Medium optical depth", as implemented 10.12).
//
// The profile tau is PHOTOMETRIC: occultations measure the mean transmission of the clumpy ring. The medium and the
// particles carry the DYNAMICAL optical depth tau_dyn (the particles' total cross-section per area) with the wake
// density factor D_tau = 1 + c (D - 1) of the column (c = strength x the tau-weighted participation pbar, the mixture
// model of ringDynamics.ts) and, for the spin-aligned classes, their cross-section at normal incidence g1 (1 + f G(1)):
//     <exp(-tau_dyn g1 D_tau(x))>_x = exp(-tau_profile)          (normal incidence, Robbins et al. 2010's continuum)
// solved per radius for x = tau_dyn g1 / tau_profile from the distribution of the app's own field D (the CPU mirror of
// wakeDensity, WakeField.densityAt): WAKE_D_BINS = the means of D in 256 equal-probability bins at strength 1 for the
// A- and B-ring wake sets, sampled over 6 generation cycles. The strength and the participation scale the contrast
// linearly (as the medium's statistics do: rlWakePathScaled). measureDensityBins() re-measures them;
// scripts/test/lod.mjs fails when they are stale and prints new ones.
import { orbitalFrequencies } from '../core/constants';
import { WakeField, WAKE_SETS } from './WakeField';
import type { RingLocal } from './RingProfile';

export const WAKE_D_NBINS = 256;

/**
 * Means of the wake density factor D in WAKE_D_NBINS equal-probability bins (ascending), strength 1, per wake set:
 * measureDensityBins(set) (seed 12345 texture, 6 cycles x 8 phases x 512 points over 3 x 3 tiles).
 */
export const WAKE_D_BINS: Record<'A' | 'B', number[]> = {
  A: [
    0.07423, 0.07788, 0.08107, 0.08444, 0.08755, 0.09023, 0.0928, 0.09566, 0.09844, 0.1016, 0.1044, 0.1068, 0.1093, 0.112, 0.1147, 0.1172,
    0.12, 0.1226, 0.1254, 0.1282, 0.1307, 0.1332, 0.1361, 0.139, 0.1416, 0.1443, 0.1478, 0.1512, 0.1545, 0.1575, 0.1611, 0.1645,
    0.1681, 0.1714, 0.1753, 0.1789, 0.1824, 0.1862, 0.1899, 0.1937, 0.1979, 0.2014, 0.2055, 0.2093, 0.214, 0.2181, 0.2223, 0.2257,
    0.2291, 0.2327, 0.2369, 0.2413, 0.2453, 0.2495, 0.254, 0.2586, 0.2631, 0.2676, 0.2722, 0.2768, 0.2813, 0.2862, 0.2909, 0.2953,
    0.2995, 0.304, 0.3085, 0.3127, 0.317, 0.3219, 0.3269, 0.332, 0.3375, 0.3425, 0.3474, 0.3522, 0.3586, 0.3638, 0.3697, 0.375,
    0.3811, 0.3864, 0.3914, 0.3977, 0.4036, 0.409, 0.415, 0.4207, 0.4264, 0.4313, 0.4361, 0.4413, 0.4481, 0.4546, 0.4607, 0.4664,
    0.4716, 0.4765, 0.4814, 0.4873, 0.4923, 0.4974, 0.5039, 0.5097, 0.5167, 0.5234, 0.5309, 0.5373, 0.5426, 0.5486, 0.5551, 0.5612,
    0.5685, 0.5742, 0.5803, 0.5874, 0.5932, 0.5992, 0.6056, 0.6127, 0.6187, 0.6243, 0.6312, 0.6372, 0.6434, 0.6502, 0.6568, 0.6641,
    0.6707, 0.6766, 0.6836, 0.6902, 0.6967, 0.7031, 0.7096, 0.7158, 0.7217, 0.728, 0.7354, 0.7422, 0.7508, 0.7577, 0.7643, 0.7715,
    0.7792, 0.7855, 0.7927, 0.7998, 0.8071, 0.8149, 0.8229, 0.8305, 0.8386, 0.847, 0.8566, 0.8653, 0.8741, 0.883, 0.8916, 0.8995,
    0.9082, 0.9156, 0.9227, 0.9304, 0.9382, 0.9457, 0.9542, 0.9628, 0.9717, 0.9798, 0.9882, 0.9962, 1.004, 1.012, 1.021, 1.029,
    1.037, 1.045, 1.052, 1.061, 1.069, 1.079, 1.088, 1.098, 1.108, 1.117, 1.126, 1.137, 1.149, 1.163, 1.177, 1.189,
    1.201, 1.217, 1.23, 1.243, 1.258, 1.271, 1.287, 1.302, 1.319, 1.336, 1.355, 1.373, 1.393, 1.415, 1.434, 1.457,
    1.478, 1.503, 1.527, 1.551, 1.58, 1.607, 1.633, 1.661, 1.693, 1.721, 1.754, 1.793, 1.829, 1.866, 1.906, 1.939,
    1.979, 2.025, 2.066, 2.11, 2.156, 2.202, 2.252, 2.312, 2.36, 2.419, 2.483, 2.538, 2.601, 2.667, 2.748, 2.829,
    2.925, 3.035, 3.156, 3.284, 3.422, 3.557, 3.711, 3.879, 4.063, 4.299, 4.562, 4.858, 5.235, 5.675, 6.317, 7.393,
  ],
  B: [
    0.06955, 0.07113, 0.07251, 0.07377, 0.07547, 0.07691, 0.0784, 0.07984, 0.08163, 0.08336, 0.08527, 0.08724, 0.08896, 0.09076, 0.09278, 0.09438,
    0.09627, 0.09831, 0.1, 0.1019, 0.104, 0.1057, 0.1077, 0.1099, 0.1121, 0.1137, 0.116, 0.1184, 0.1203, 0.1226, 0.1253, 0.1277,
    0.1302, 0.1324, 0.1345, 0.1369, 0.1393, 0.1419, 0.1443, 0.1469, 0.1497, 0.1523, 0.1548, 0.1576, 0.1607, 0.1636, 0.1666, 0.1696,
    0.1725, 0.1755, 0.1783, 0.1819, 0.1853, 0.1888, 0.192, 0.1949, 0.1983, 0.2015, 0.2047, 0.2081, 0.2112, 0.2142, 0.2179, 0.2214,
    0.225, 0.2287, 0.2326, 0.2363, 0.2397, 0.2431, 0.2469, 0.2508, 0.2549, 0.2585, 0.2622, 0.2663, 0.2706, 0.2744, 0.2786, 0.283,
    0.2875, 0.2921, 0.2967, 0.3006, 0.3047, 0.3089, 0.3131, 0.3181, 0.3226, 0.3279, 0.3327, 0.3374, 0.3424, 0.3473, 0.3519, 0.3571,
    0.3627, 0.3683, 0.3738, 0.3793, 0.3855, 0.391, 0.3967, 0.4022, 0.4087, 0.4141, 0.4205, 0.4261, 0.4313, 0.4374, 0.4428, 0.4482,
    0.4547, 0.4609, 0.4679, 0.4736, 0.4807, 0.4879, 0.4942, 0.5003, 0.507, 0.5143, 0.5205, 0.5272, 0.5345, 0.5411, 0.5477, 0.5543,
    0.5613, 0.5679, 0.5745, 0.5818, 0.5888, 0.5955, 0.602, 0.6093, 0.6164, 0.6227, 0.6304, 0.6381, 0.6457, 0.6536, 0.6606, 0.6693,
    0.6776, 0.6856, 0.6957, 0.7039, 0.7123, 0.7207, 0.7297, 0.7379, 0.7463, 0.756, 0.7651, 0.7735, 0.7829, 0.7936, 0.8018, 0.8107,
    0.8207, 0.8296, 0.8381, 0.8484, 0.8594, 0.8705, 0.8817, 0.8926, 0.903, 0.9117, 0.9196, 0.9297, 0.9388, 0.9473, 0.959, 0.9703,
    0.9802, 0.9906, 1.002, 1.013, 1.026, 1.037, 1.052, 1.067, 1.08, 1.093, 1.107, 1.12, 1.134, 1.148, 1.164, 1.182,
    1.197, 1.212, 1.229, 1.246, 1.263, 1.28, 1.299, 1.318, 1.336, 1.353, 1.372, 1.392, 1.415, 1.438, 1.464, 1.489,
    1.511, 1.541, 1.574, 1.609, 1.639, 1.67, 1.703, 1.735, 1.77, 1.801, 1.838, 1.882, 1.929, 1.971, 2.013, 2.058,
    2.112, 2.163, 2.212, 2.268, 2.332, 2.394, 2.465, 2.542, 2.604, 2.685, 2.781, 2.887, 2.994, 3.095, 3.202, 3.319,
    3.431, 3.577, 3.727, 3.869, 4.038, 4.222, 4.408, 4.61, 4.87, 5.175, 5.465, 5.791, 6.145, 6.552, 6.976, 8.028,
  ],
};

/** Re-measure the D bins of a wake set with the CPU mirror of wakeDensity (~0.1-0.3 s). */
export function measureDensityBins(set: 'A' | 'B', { cycles = 6, phases = 8, points = 512, nb = WAKE_D_NBINS, seed = 99 } = {}): number[] {
  const rKm = set === 'A' ? 128_000 : 105_000;
  const fr = orbitalFrequencies(rKm * 1000);
  const wf = new WakeField(12345);
  wf.shapeOverride = { ...WAKE_SETS[set] };
  // strength 1: wake 1, a_max small enough for the lambda / a_max test; lambda from a representative Sigma
  const local = { rKm, tau: 1, sigma: set === 'A' ? 284 : 600, wake: 1, aMax: 0.1, macroscopic: true } as unknown as RingLocal;
  wf.configure(local, { omega: fr.omega, kappa: fr.kappa, qShear: 1.5 } as never);
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const P = 0.5 * wf.shape.tLife;
  const all: number[] = [];
  const span = 3 * wf.tile;
  for (let c = 0; c < cycles; c++) {
    for (let ph = 0; ph < phases; ph++) {
      // sim time: cycle c, phase (ph + 0.5) / phases (the generation clock, WakeField.update)
      const tau = (37 + c + (ph + 0.5) / phases) * P;
      wf.update(tau / fr.omega);
      for (let i = 0; i < points; i++) all.push(wf.densityAt((rnd() - 0.5) * span, (rnd() - 0.5) * span));
    }
  }
  all.sort((a, b) => a - b);
  const out: number[] = [];
  const per = all.length / nb;
  for (let b = 0; b < nb; b++) {
    const i0 = Math.round(b * per), i1 = Math.round((b + 1) * per);
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += all[i];
    out.push(sum / Math.max(i1 - i0, 1));
  }
  return out;
}

/**
 * x solving <exp(-x tau (1 + c (D - 1)))> = exp(-tau) over the bins D (equal weights): the factor by which the medium's
 * (dynamical) optical depth exceeds the photometric one for a column density factor of contrast c.
 */
export function solveDynFactor(bins: ArrayLike<number>, tau: number, c: number): number {
  if (!(tau > 1e-6) || !(c > 1e-6) || bins.length === 0) return 1;
  const n = bins.length;
  let mn = Infinity;
  for (let i = 0; i < n; i++) mn = Math.min(mn, 1 + c * (bins[i] - 1));
  // f(x) = ln <exp(-x tau Dt)> + tau (computed relative to the floor mn), decreasing in x, f(1) >= 0 (Jensen): bisection
  const f = (x: number): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.exp(-x * tau * (c * (bins[i] - 1) + 1 - mn));
    return -x * tau * mn + Math.log(s / n) + tau;
  };
  let lo = 1, hi = 2;
  while (f(hi) > 0 && hi < 1e3) { lo = hi; hi *= 2; }
  for (let it = 0; it < 60; it++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) lo = mid; else hi = mid;
    if (hi - lo < 1e-7 * hi) break;
  }
  return 0.5 * (lo + hi);
}

/** Grid of the dynamical-factor tables: tau log-spaced over [TAU_LO, TAU_HI], contrast c in [0, 1] */
export const DYN_TAU_N = 40;
export const DYN_TAU_LO = 0.02;
export const DYN_TAU_HI = 20;
export const DYN_C_N = 11;
const tables: Partial<Record<'A' | 'B', Float32Array>> = {};
/** x(tau_j, c_i) for a wake set (cached; ~10 ms). */
export function dynFactorTable(set: 'A' | 'B'): Float32Array {
  let t = tables[set];
  if (t) return t;
  const bins = WAKE_D_BINS[set];
  t = new Float32Array(DYN_TAU_N * DYN_C_N);
  for (let i = 0; i < DYN_C_N; i++) {
    const c = i / (DYN_C_N - 1);
    for (let j = 0; j < DYN_TAU_N; j++) {
      const tau = DYN_TAU_LO * Math.pow(DYN_TAU_HI / DYN_TAU_LO, j / (DYN_TAU_N - 1));
      t[i * DYN_TAU_N + j] = solveDynFactor(bins, tau, c);
    }
  }
  tables[set] = t;
  return t;
}
/** x(tau, c) for a wake set (bilinear in ln tau and c; below DYN_TAU_LO linear in tau from x(0) = 1). */
export function dynFactor(set: 'A' | 'B', tau: number, c: number): number {
  if (!(tau > 0) || !(c > 0) || WAKE_D_BINS[set].length === 0) return 1;
  const t = dynFactorTable(set);
  const ci = Math.min(1, c) * (DYN_C_N - 1);
  const i0 = Math.min(DYN_C_N - 2, Math.floor(ci)), fc = ci - i0;
  const at = (j: number) => t[i0 * DYN_TAU_N + j] * (1 - fc) + t[(i0 + 1) * DYN_TAU_N + j] * fc;
  if (tau <= DYN_TAU_LO) return 1 + (at(0) - 1) * (tau / DYN_TAU_LO);
  const x = (Math.log(Math.min(tau, DYN_TAU_HI) / DYN_TAU_LO) / Math.log(DYN_TAU_HI / DYN_TAU_LO)) * (DYN_TAU_N - 1);
  const j0 = Math.min(DYN_TAU_N - 2, Math.floor(x)), fj = x - j0;
  return at(j0) * (1 - fj) + at(j0 + 1) * fj;
}
/** Mean D of the densest 1 / WAKE_D_NBINS (0.4 %) of the area at contrast s (linear scaling of the strength-1 bins):
 *  where the packing ceiling stops thickening (ringDynamics.ts) */
export function densityQuantileHigh(set: 'A' | 'B', s: number): number {
  const b = WAKE_D_BINS[set];
  if (b.length === 0) return 1;
  return 1 + s * (b[b.length - 1] - 1);
}
