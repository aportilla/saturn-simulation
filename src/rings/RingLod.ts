// Shared level-of-detail contract between the near-field particle renderer and the ring-layer
// (unresolved medium) renderer. Both MUST use these numbers so that the optical depth carried by
// discretely-drawn particles plus the optical depth carried by the continuous medium always sums to the
// true local optical depth (no double counting, no holes, no brightness seams).
//
// Size classes: class k holds particles with radius in [A0*2^k, A0*2^(k+1)), k = 0..LOD_CLASSES-1,
// clipped to the local [aMin, aMax]. With dN/da = C a^-q:
//   tauFrac[k]  = Int_bin a^(2-q) da / Int_all a^(2-q) da          (share of normal optical depth)
//   nPerTau[k]  = Int_bin a^(-q) da / (pi Int_all a^(2-q) da)       (column number density per unit tau, m^-2)
//   aEff[k]     = sqrt( Int_bin a^(4-q) / Int_bin a^(2-q) )          (cross-section-weighted rms radius)
//
// Particles smaller than the smallest class (aMin < A0, e.g. 3-5 mm in the C ring / Cassini Division)
// carry tauSub = 1 - Sum_k tauFrac[k] of the optical depth: a never-drawn layer with vertical std-dev
// sigZSub*H (the medium always carries it). The top class absorbs any aMax above A0*2^LOD_CLASSES.
//
// A particle of radius a at 3-D distance s from the camera is drawn with probability
//   P(a,s) = clamp((rho/rhoMin)^2, 0, 1) * window_k(s),   rho = a / (s * pixelAngle)  [px]
//   window_k(s) = 1 - smoothstep(0.75*box[k], box[k], s)
// and when rho < rhoMin it is drawn at apparent radius rhoMin (expected coverage is conserved).
// The medium carries the rest: sigmaUnres = sigmaTotal - Sum_k sigma_k * P(aEff[k], s).
// See src/render/shaders/ringLod.glsl for the GLSL side.
//
// Near-field particle population (src/render/near): class k is a periodic square box of half-size box[k]
// (in the ring plane) that follows the camera, holding count[k] = nPerTau[k]*tauBoxMax*(2 box[k])^2
// particles; each is present with probability tau_macro(r)/tauBoxMax (so gaps are empty and the local
// column density matches the profile). Since window_k(s) = 0 for s >= box[k], wrapping at the box edge is
// invisible.
//
// Kinematics (exact linear Hill-frame solution, see NearFieldPass): guiding centers shear at
// v_y = -q Omega x; epicycles with Rayleigh amplitude of scale sigX[k] = EPI_RATIO * sigZ[k] (radial
// velocity dispersion c_r = kappa*sigX, c_r/c_z = EPI_RATIO), vertical oscillation of Rayleigh amplitude
// scale sigZ[k] = sigZFrac[k]*H (so z is Gaussian with std sigZ, matching ringExtinction()).
import type { RingLocal } from './RingProfile';

export const LOD_CLASSES = 10;
export const LOD_A0 = 0.01; // m
/** ratio of the radial to the vertical displacement dispersion (c_r/c_z for kappa ~ nu) */
export const EPI_RATIO = 1.5;

export interface LodOptions {
  /** radians per pixel */
  pixelAngle: number;
  /** maximum number of particles allocated over all class boxes (at the box's max tau) */
  budget: number;
  /** hard cap on any class's box half-size (m) */
  rMax: number;
  /** min drawn apparent radius in px */
  rhoMinPx: number;
  /** box half-size = boxFactor * aHi / (pixelAngle * rhoMin) */
  boxFactor: number;
  /**
   * Keep the previous allocation (boxes, counts, tauBoxMax) when a reconfiguration would change every
   * box by less than this relative amount and the old allocation still covers the new tauBoxMax.
   * Avoids regenerating all particles on small pixel-footprint / radial-position changes.
   */
  stickyTolerance: number;
}

export const DEFAULT_LOD_OPTIONS: LodOptions = {
  pixelAngle: 1e-3,
  budget: 4_000_000,
  rMax: 2500,
  rhoMinPx: 0.8,
  boxFactor: 2.0,
  stickyTolerance: 0.2,
};

function powInt(lo: number, hi: number, p: number): number {
  if (hi <= lo) return 0;
  if (Math.abs(p + 1) < 1e-9) return Math.log(hi / lo);
  return (Math.pow(hi, p + 1) - Math.pow(lo, p + 1)) / (p + 1);
}

export class RingLod {
  readonly aLo = new Float32Array(LOD_CLASSES);
  readonly aHi = new Float32Array(LOD_CLASSES);
  readonly tauFrac = new Float32Array(LOD_CLASSES);
  readonly nPerTau = new Float32Array(LOD_CLASSES);
  readonly aEff = new Float32Array(LOD_CLASSES);
  readonly sigZFrac = new Float32Array(LOD_CLASSES);
  readonly box = new Float32Array(LOD_CLASSES);
  /** particles allocated per class (at tauBoxMax) */
  readonly count = new Float64Array(LOD_CLASSES);
  /** integer particle slots per class (what the near-field pass allocates) */
  readonly slots = new Int32Array(LOD_CLASSES);
  /** share of tau in particles below the smallest class (never drawn) and its vertical std-dev / H */
  tauSub = 0;
  sigZFracSub = 0.4;
  tau = 0;
  tauBoxMax = 0;
  H = 10;
  q = 3;
  aMin = 0.01;
  aMax = 10;
  active = false;
  totalParticles = 0;
  options: LodOptions = { ...DEFAULT_LOD_OPTIONS };
  /** optical depth beyond which particles are statistically invisible (used for culling) */
  cullTau = 7;
  /** increments on every configure() */
  version = 0;
  /** increments only when the particle allocation (boxes / slots / tauBoxMax / size bins) changes */
  allocVersion = 0;

  readonly uniforms = {
    uLodActive: { value: 0 },
    uLodTauFrac: { value: this.tauFrac },
    uLodAEff: { value: this.aEff },
    uLodSigZ: { value: this.sigZFrac },
    uLodBox: { value: this.box },
    uLodRhoMin: { value: DEFAULT_LOD_OPTIONS.rhoMinPx },
    uLodCullTau: { value: 7 },
    uLodH: { value: 10 },
    uLodTau: { value: 0 },
    uLodTauSub: { value: 0 },
    uLodSigZSub: { value: 0.4 },
  };

  /** Vertical std-dev of class k as a fraction of the full layer thickness H (small particles ride higher). */
  static sigZFracForRadius(a: number): number {
    const t = Math.min(1, Math.max(0, Math.log2(a / LOD_A0) / 9));
    return 0.4 * (1 - t) + 0.15 * t;
  }

  /** Vertical / radial displacement dispersion (m) of class k at the configured layer thickness. */
  sigZ(k: number): number {
    return Math.max(this.sigZFrac[k] * this.H, 0.02);
  }
  sigX(k: number): number {
    return EPI_RATIO * this.sigZ(k);
  }

  /**
   * Configure for a local ring patch. `tauBoxMax` = max tau over the radial span the particle boxes cover
   * (particles are generated at that density and thinned by tau(r)/tauBoxMax).
   */
  configure(local: RingLocal, tauBoxMax: number, opts: Partial<LodOptions> = {}): void {
    const o = (this.options = { ...this.options, ...opts });
    const prevBox = Float64Array.from(this.box);
    const prevLo = Float64Array.from(this.aLo);
    const prevHi = Float64Array.from(this.aHi);
    const prevTauMax = this.tauBoxMax;
    const prevTotal = this.totalParticles;
    this.tau = local.tau;
    const newTauMax = Math.max(tauBoxMax, local.tau);
    this.H = local.H;
    this.q = local.q;
    this.aMin = local.aMin;
    this.aMax = local.aMax;
    const q = local.q;
    const I2all = powInt(local.aMin, local.aMax, 2 - q);
    for (let k = 0; k < LOD_CLASSES; k++) {
      const lo = Math.max(LOD_A0 * 2 ** k, local.aMin);
      const hi = k === LOD_CLASSES - 1 ? local.aMax : Math.min(LOD_A0 * 2 ** (k + 1), local.aMax);
      this.aLo[k] = lo;
      this.aHi[k] = Math.max(hi, lo);
      if (!local.macroscopic || hi <= lo || I2all <= 0) {
        this.tauFrac[k] = 0;
        this.nPerTau[k] = 0;
        this.aEff[k] = LOD_A0 * 2 ** (k + 0.5);
        this.sigZFrac[k] = RingLod.sigZFracForRadius(this.aEff[k]);
        continue;
      }
      const I0 = powInt(lo, hi, -q);
      const I2 = powInt(lo, hi, 2 - q);
      const I4 = powInt(lo, hi, 4 - q);
      this.tauFrac[k] = I2 / I2all;
      this.nPerTau[k] = I0 / (Math.PI * I2all);
      this.aEff[k] = Math.sqrt(I4 / I2);
      this.sigZFrac[k] = RingLod.sigZFracForRadius(this.aEff[k]);
    }
    // sub-class residual (particles with a < A0): never drawn, carried by the medium
    let fsum = 0;
    for (let k = 0; k < LOD_CLASSES; k++) fsum += this.tauFrac[k];
    if (local.macroscopic && I2all > 0 && local.aMin < LOD_A0) {
      this.tauSub = Math.max(0, 1 - fsum);
      const hiS = Math.min(LOD_A0, local.aMax);
      const I2s = powInt(local.aMin, hiS, 2 - q), I4s = powInt(local.aMin, hiS, 4 - q);
      this.sigZFracSub = RingLod.sigZFracForRadius(I2s > 0 ? Math.sqrt(I4s / I2s) : LOD_A0);
    } else {
      this.tauSub = 0;
      this.sigZFracSub = RingLod.sigZFracForRadius(LOD_A0);
    }
    // box sizes from the pixel footprint, then fit the budget
    const box = new Float64Array(LOD_CLASSES);
    const cnt = new Float64Array(LOD_CLASSES);
    for (let k = 0; k < LOD_CLASSES; k++) {
      box[k] = Math.min(o.rMax, (o.boxFactor * this.aHi[k]) / (o.pixelAngle * o.rhoMinPx));
    }
    let total = 0;
    for (let iter = 0; iter < 6; iter++) {
      total = 0;
      for (let k = 0; k < LOD_CLASSES; k++) {
        cnt[k] = this.nPerTau[k] * newTauMax * (2 * box[k]) ** 2;
        total += cnt[k];
      }
      if (total <= o.budget * 1.001) break;
      const f = Math.sqrt(o.budget / total);
      for (let k = 0; k < LOD_CLASSES; k++) box[k] *= f;
    }
    // sticky allocation: keep the previous boxes if the change is small and they still fit
    let keep = this.allocVersion > 0 && newTauMax <= prevTauMax * 1.0001 && newTauMax >= prevTauMax * 0.7;
    if (keep) {
      let keptTotal = 0;
      for (let k = 0; k < LOD_CLASSES; k++) {
        if (Math.abs(this.aLo[k] - prevLo[k]) > 1e-6 * prevLo[k] || Math.abs(this.aHi[k] - prevHi[k]) > 1e-6 * prevHi[k]) { keep = false; break; }
        const nb = box[k], ob = prevBox[k];
        if (cnt[k] > 0 && Math.abs(nb - ob) > o.stickyTolerance * Math.max(nb, ob)) { keep = false; break; }
        keptTotal += this.nPerTau[k] * prevTauMax * (2 * ob) ** 2;
      }
      if (keptTotal > o.budget * (1 + o.stickyTolerance)) keep = false;
      void prevTotal;
    }
    if (keep) {
      this.tauBoxMax = prevTauMax;
      for (let k = 0; k < LOD_CLASSES; k++) this.box[k] = prevBox[k];
    } else {
      this.tauBoxMax = newTauMax;
      for (let k = 0; k < LOD_CLASSES; k++) this.box[k] = box[k];
      this.allocVersion++;
    }
    total = 0;
    for (let k = 0; k < LOD_CLASSES; k++) {
      this.count[k] = this.nPerTau[k] * this.tauBoxMax * (2 * this.box[k]) ** 2;
      this.slots[k] = this.count[k] > 0.5 ? Math.ceil(this.count[k]) : 0;
      total += this.count[k];
    }
    this.totalParticles = total;
    this.version++;
    this.uniforms.uLodRhoMin.value = o.rhoMinPx;
    this.uniforms.uLodCullTau.value = this.cullTau;
    this.uniforms.uLodH.value = this.H;
    this.uniforms.uLodTau.value = this.tau;
    this.uniforms.uLodTauSub.value = this.tauSub;
    this.uniforms.uLodSigZSub.value = this.sigZFracSub;
  }

  setActive(on: boolean): void {
    this.active = on;
    this.uniforms.uLodActive.value = on ? 1 : 0;
  }

  /** CPU mirror of the GLSL draw probability (for stats / tests). */
  drawProb(a: number, k: number, s: number): number {
    if (!this.active) return 0;
    const rho = a / (Math.max(s, 1e-4) * this.options.pixelAngle);
    const x = rho / this.options.rhoMinPx;
    const D = this.box[k];
    const t = Math.min(1, Math.max(0, (s - 0.75 * D) / (0.25 * D)));
    const win = 1 - t * t * (3 - 2 * t);
    return Math.min(1, x * x) * win;
  }
}
