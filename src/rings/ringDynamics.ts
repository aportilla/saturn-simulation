// Size-dependent ring-particle dynamics shared by the LOD contract (RingLod), the profile (RingProfile) and the tests:
// the N-body size rules of docs/ring-physics.md 10.9 as implemented (10.12) and the particle-orientation model.
//
// * Participation in the self-gravity wakes. A particle of radius a follows the wakes with p_rel(a) = min(1, (a/a_p)^0.5)
//   (N-body, sections 10.3 / 10.5): a_p = 1.2 m at the mid-A-ring site (tau 0.66), 0.3 m at the B-ring site (tau 2.5),
//   log-interpolated in tau between them (the zone's typical tau, so a class's participation does not change while the
//   camera crosses sub-km structure). Model: a MIXTURE -- a share p of a size class follows the wake field fully (the
//   wakeDisplacement map), the rest is not displaced -- so the class's surface density is exactly 1 + p (D - 1) at any
//   contrast and the medium's tau-weighted D_tau = 1 + pbar (D - 1) is the exact sum of its classes (a displacement scaled
//   by p would give 1 / (1 + p (1/D - 1)) instead: at p = 0.5 a gap of D = 0.05 would stay at 0.095, not the 0.53 the
//   medium carries -- the contract would not be exact). Per size class one p (its cross-section-weighted mean), so the
//   medium's share of the unresolved participating tau is exact too (lodCarry is a class mean).
// * Spin alignment. Large particles spin slowly about axes near the orbit normal, small ones fast with random axes
//   (N-body simulations with spinning particles, reviewed by Schmidt et al. 2009, section 14.4.2). A
//   body spinning about its short axis presents more area along its spin axis than across it, so the cross-section of
//   the aligned classes depends on the direction. Model: a mixture again -- a share f(a) = smoothstep(0.05, 1, a / 1 m)
//   of a class belongs to the aligned population (spin axes within ~10 deg of the orbit normal, nearSpinAxis), the
//   rest is isotropic; the class's mean projected area along a direction d is then exactly pi a^2 (1 + f_k G(mu_d)),
//   G measured below from the shape and axis distributions (CPU mirror of nearShape / nearSpinAxis).
// * Tidal (radial) alignment. Gravitationally bound aggregates rotate synchronously with their long axis nearly radial,
//   with Roche-ellipsoid-like shapes near the inner limit of their formation (Karjalainen & Salo 2004); they form where
//   the Hill parameter of a particle pair r_h exceeds ~1.1 (transient) to ~1.2 (semi-permanent; Salo et al. 2018). At
//   r_h = 1 two synchronously rotating, radially aligned particles in contact are just bound (Weidenschilling et al.
//   1984). Individual ring particles in simulations spin at a mean (0.2-0.5) Omega, i.e. not synchronously (Salo et
//   al. 2018; Schmidt et al. 2009). So the tidally locked share of the aligned population is smoothstep(1.1, 1.2, r_h)
//   with r_h (eq. 1.124 of Salo et al. 2018) from the zone's bulk density: 0.5-0.8 in every main-ring zone -- no locked
//   particles there. The orientation model and the direction-dependent contract support it (anisotropy T(mu) cos 2psi).
// * Packing ceiling. Where the mid-plane volume filling of the participating particles would exceed 0.65 (random close
//   packing; N-body wake cores reach 0.64 at lambda/16, section 10.5) they are thickened: sigma_z,k(x) = sigma_z,k m(x),
//   m = max(1, tauDyn(x) ffP D(x) / (0.65 - tauDyn(x) ffNP)), ffP / ffNP the mid-plane filling of the participating /
//   other particles per unit tau_dyn. The non-participating ones are uniformly spread (they do not add to a core's
//   excess; their filling is <= 0.03 in every zone), so only the participating ones are thickened (the near field then
//   needs the density only where it already evaluates the wake map). m is capped at its value at D_cap, the mean D of
//   the densest 0.4 % of the field (the top bin of WAKE_D_BINS): beyond, the filling may exceed 0.65 (the N-body's
//   99.9th percentile reaches 0.77 at lambda/16).
// * The spin-aligned share's size law f(a) is a modelling choice: the literature gives the trend (slow large spinners
//   with axes near the normal, fast small ones random; rotation rates ~ 1/a below the largest bodies' ~Omega: Schmidt
//   et al. 2009), not a per-size share.
import { G } from '../core/constants';

/** N-body sites of the participation law (docs/ring-physics.md 10.3, 10.5): (tau, a_p (m)) */
export const PART_SITE_A = { tau: 0.66, ap: 1.2 };
export const PART_SITE_B = { tau: 2.5, ap: 0.3 };
/** packing ceiling: largest mean mid-plane volume filling (random close packing) */
export const PACKING_MAX = 0.65;
/** Hill parameters at which bound (synchronous, radially aligned) aggregates start (transient) / persist */
export const TIDAL_RH = [1.1, 1.2];
/** spin-axis concentration of the aligned population (nearSpinAxis: mix(random, orbit normal, ALIGN_MIX)) */
export const ALIGN_MIX = 0.85;
/** mu nodes of the anisotropy tables (uniform in mu = |cos| of the angle to the ring normal) */
export const ANISO_N = 9;

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** a_p (m) of the participation law at a zone of typical optical depth tau. */
export function participationScale(tau: number): number {
  const t = Math.min(1, Math.max(0, (tau - PART_SITE_A.tau) / (PART_SITE_B.tau - PART_SITE_A.tau)));
  return Math.exp(Math.log(PART_SITE_A.ap) * (1 - t) + Math.log(PART_SITE_B.ap) * t);
}
/** Participation of a particle of radius a (m): min(1, (a / a_p)^0.5). */
export const participation = (a: number, ap: number) => Math.min(1, Math.sqrt(Math.max(a, 0) / ap));
/** Share of the particles of radius a (m) in the spin-aligned population (nearSpinAlign / ALIGN_MIX). */
export const spinAlignedShare = (a: number) => smoothstep(0.05, 1, a);

// 16-point Gauss-Legendre nodes / weights on [-1, 1]
const GL_X = [-0.9894009349916499, -0.9445750230732326, -0.8656312023878318, -0.755404408355003, -0.6178762444026438,
  -0.45801677765722737, -0.2816035507792589, -0.09501250983763744, 0.09501250983763744, 0.2816035507792589,
  0.45801677765722737, 0.6178762444026438, 0.755404408355003, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499];
const GL_W = [0.027152459411754, 0.062253523938648, 0.095158511682493, 0.124628971255534, 0.149595988816577,
  0.169156519395003, 0.182603415044924, 0.189450610455068, 0.189450610455068, 0.182603415044924, 0.169156519395003,
  0.149595988816577, 0.124628971255534, 0.095158511682493, 0.062253523938648, 0.027152459411754];
/** Cross-section-weighted (a^(2-q) da) mean of f(a) over [lo, hi] (Gauss-Legendre in ln a, split where f has a kink). */
export function crossSectionMean(lo: number, hi: number, q: number, f: (a: number) => number, kinks: number[] = []): number {
  if (!(hi > lo)) return f(lo);
  const cuts = [lo, ...kinks.filter((k) => k > lo && k < hi).sort((x, y) => x - y), hi];
  let num = 0, den = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const l0 = Math.log(cuts[i]), l1 = Math.log(cuts[i + 1]), h = 0.5 * (l1 - l0), m = 0.5 * (l1 + l0);
    for (let j = 0; j < 16; j++) {
      const a = Math.exp(m + h * GL_X[j]);
      const w = GL_W[j] * h * Math.pow(a, 3 - q); // a^(2-q) da = a^(3-q) d(ln a)
      num += w * f(a);
      den += w;
    }
  }
  return den > 0 ? num / den : 0;
}

/**
 * Hill parameter r_h of a pair of identical particles of internal density rho (kg/m^3) at radius r (m) from Saturn
 * (Salo et al. 2018, eq. 1.124 of the chapter: r_h = 0.82 (M_P / 5.69e26 kg)^(-1/3) (rho / 900)^(1/3) (r / 1e8 m)).
 */
export function hillParameter(rho: number, r: number, mPlanet = 5.6834e26): number {
  return 0.82 * Math.cbrt(5.69e26 / mPlanet) * Math.cbrt(Math.max(rho, 1) / 900) * (r / 1e8);
}
/** Tidally locked (synchronous, radially aligned) share of the aligned population at Hill parameter rh. */
export const tidalShare = (rh: number) => smoothstep(TIDAL_RH[0], TIDAL_RH[1], rh);

/**
 * Mid-plane volume filling of a class of particles per unit optical depth: column number density per unit tau
 * dN/da = a^-q / (pi I2) over [lo, hi], each particle's chord at z = 0 for a Gaussian centre distribution of std sig(a)
 * (a boulder bigger than its vertical scatter blocks its full chord; docs/ring-physics.md section 6). I2 = Int a^(2-q)
 * over the whole distribution.
 */
export function midplaneFilling(lo: number, hi: number, q: number, I2: number, sig: (a: number) => number, weight: (a: number) => number = () => 1): number {
  if (!(hi > lo) || !(I2 > 0)) return 0;
  const l0 = Math.log(lo), l1 = Math.log(hi), h = 0.5 * (l1 - l0), m = 0.5 * (l1 + l0);
  let ff = 0;
  for (let j = 0; j < 16; j++) {
    const a = Math.exp(m + h * GL_X[j]);
    const n = (GL_W[j] * h * Math.pow(a, 1 - q)) / (Math.PI * I2); // a^-q da = a^(1-q) d(ln a)
    const s = Math.max(sig(a), 0.02);
    // Int_-a^a pi (a^2 - z^2) phi(z / s) / s dz (closed form)
    const u = a / (Math.SQRT2 * s);
    const P = erf(u), E = Math.exp(-u * u);
    const chord = Math.PI * ((a * a - s * s) * P + (2 * a * s * E) / Math.sqrt(2 * Math.PI));
    ff += n * chord * weight(a);
  }
  return ff;
}
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

// ------------------------------------------------------------------------------------ anisotropy of the aligned population
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** nearShape (high quality): semi-axes (units of a) for uniform draws u1, u2: b = 1 - 0.3 u1, c = b (1 - 0.25 u2),
 *  scaled so that the surface area (Knud Thomsen) is that of the unit sphere */
export function shapeAxes(u1: number, u2: number): [number, number, number] {
  const b = 1 - 0.3 * u1, c = b * (1 - 0.25 * u2);
  const P = 1.6075, bp = Math.pow(b, P), cp = Math.pow(c, P);
  const k = 1 / Math.sqrt(Math.pow((bp * cp + bp + cp) / 3, 1 / P));
  return [k, k * b, k * c];
}
/** projected area / pi of an ellipsoid with semi-axes A, B, C along the unit direction (dx, dy, dz) in its body frame */
const projArea = (A: number, B: number, C: number, dx: number, dy: number, dz: number) =>
  Math.sqrt(B * B * C * C * dx * dx + A * A * C * C * dy * dy + A * A * B * B * dz * dz);

export interface AnisotropyTables {
  /** G(mu_i) = <A(d)>_aligned / <A>_isotropic - 1 at mu_i = i / (ANISO_N - 1): free rotators about near-normal axes */
  G: Float64Array;
  /** T(mu_i): the cos(2 psi) amplitude of the tidally locked rotators (psi = azimuth of d from the radial direction),
   *  relative to the free rotators: <A>_locked = <A>_iso (1 + G(mu) + T(mu) cos 2 psi) */
  T: Float64Array;
  /** monte-carlo bodies used */
  n: number;
}
/**
 * Mean projected area of the aligned population along directions d (elevation mu above the ring plane, azimuth psi from
 * the radial direction), relative to the isotropic mean of the same bodies: CPU mirror of nearShape (high quality),
 * nearSpinAxis (aligned population: normalize(mix(random unit vector, orbit normal, ALIGN_MIX))) and the spin phase
 * (uniform for free rotators; for locked ones the body's long axis is the radial direction projected on its spin plane).
 * Deterministic (seeded); n = 40000 bodies gives an MC error ~1e-3.
 */
export function measureAnisotropy({ n = 40000, seed = 7, nPhi = 24 } = {}): AnisotropyTables {
  const rnd = mulberry32(seed);
  const G = new Float64Array(ANISO_N), Tc = new Float64Array(ANISO_N);
  const nPsi = 8;
  let iso = 0;
  const free = new Float64Array(ANISO_N), lockC = new Float64Array(ANISO_N);
  for (let i = 0; i < n; i++) {
    const [A, B, C] = shapeAxes(rnd(), rnd());
    // isotropic mean area of this body: random direction
    {
      const z = 2 * rnd() - 1, ph = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
      iso += projArea(A, B, C, r * Math.cos(ph), r * Math.sin(ph), z);
    }
    // spin axis of the aligned population
    const cz = 2 * rnd() - 1, ph = 2 * Math.PI * rnd(), rr = Math.sqrt(Math.max(0, 1 - cz * cz));
    let ax = [(1 - ALIGN_MIX) * rr * Math.cos(ph), (1 - ALIGN_MIX) * rr * Math.sin(ph), (1 - ALIGN_MIX) * cz + ALIGN_MIX];
    const la = Math.hypot(ax[0], ax[1], ax[2]);
    ax = ax.map((x) => x / la);
    // body frame basis with z = spin axis; x0 = the radial direction (+x) projected on the spin plane
    let x0 = [1 - ax[0] * ax[0], -ax[0] * ax[1], -ax[0] * ax[2]];
    const lx = Math.hypot(x0[0], x0[1], x0[2]);
    x0 = x0.map((q) => q / lx);
    const y0 = [ax[1] * x0[2] - ax[2] * x0[1], ax[2] * x0[0] - ax[0] * x0[2], ax[0] * x0[1] - ax[1] * x0[0]];
    for (let m = 0; m < ANISO_N; m++) {
      const mu = m / (ANISO_N - 1), sh = Math.sqrt(1 - mu * mu);
      // free rotator: average over the spin phase (and over the view azimuth, equivalent)
      let fsum = 0;
      for (let k = 0; k < nPhi; k++) {
        const ps = (2 * Math.PI * (k + rnd())) / nPhi;
        const d = [sh * Math.cos(ps), sh * Math.sin(ps), mu];
        fsum += projArea(A, B, C, d[0] * x0[0] + d[1] * x0[1] + d[2] * x0[2], d[0] * y0[0] + d[1] * y0[1] + d[2] * y0[2], d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]);
      }
      free[m] += fsum / nPhi;
      // locked rotator (long axis x0 ~ radial): cos 2 psi projection over the view azimuth psi
      let csum = 0;
      for (let k = 0; k < nPsi; k++) {
        const ps = (2 * Math.PI * (k + 0.5)) / nPsi;
        const d = [sh * Math.cos(ps), sh * Math.sin(ps), mu];
        const Ar = projArea(A, B, C, d[0] * x0[0] + d[1] * x0[1] + d[2] * x0[2], d[0] * y0[0] + d[1] * y0[1] + d[2] * y0[2], d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]);
        csum += (2 / nPsi) * Ar * Math.cos(2 * ps);
      }
      lockC[m] += csum;
    }
  }
  iso /= n;
  for (let m = 0; m < ANISO_N; m++) {
    G[m] = free[m] / n / iso - 1;
    Tc[m] = lockC[m] / n / iso;
  }
  return { G, T: Tc, n };
}
let anisoCache: AnisotropyTables | null = null;
/** The anisotropy tables of the shipped shape / orientation model (computed once, ~0.3 s). */
export function anisotropyTables(): AnisotropyTables {
  if (!anisoCache) anisoCache = measureAnisotropy();
  return anisoCache;
}
/** G(mu) + share T(mu) cos(2 psi) from the tables (linear in mu). */
export function anisotropyAt(t: AnisotropyTables, mu: number, cos2psi = 0, tidal = 0): number {
  const x = Math.min(1, Math.max(0, Math.abs(mu))) * (ANISO_N - 1);
  const i = Math.min(ANISO_N - 2, Math.floor(x)), f = x - i;
  const g = t.G[i] + (t.G[i + 1] - t.G[i]) * f;
  const tt = t.T[i] + (t.T[i + 1] - t.T[i]) * f;
  return g + tidal * tt * cos2psi;
}

/** Toomre critical wavelength 4 pi^2 G Sigma / kappa^2 (m). */
export const toomreLambda = (sigma: number, kappa: number) => (4 * Math.PI * Math.PI * G * Math.max(sigma, 1e-3)) / (kappa * kappa);
