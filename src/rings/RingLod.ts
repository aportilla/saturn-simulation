// Shared level-of-detail contract between the near-field particle renderer and the ring-layer
// (unresolved medium) renderer. Both MUST use these numbers so that the optical depth carried by
// discretely-drawn particles plus the optical depth carried by the continuous medium always sums to the
// true local optical depth (no double counting, no holes, no brightness seams).
//
// Size classes: class k holds particles with radius in [A0*2^k, A0*2^(k+1)), k = 0..LOD_CLASSES-1 (A0 = 1 mm,
// 14 octaves), clipped to the local [aMin, aMax]. With dN/da = C a^-q:
//   tauFrac[k]  = Int_bin a^(2-q) da / Int_all a^(2-q) da          (share of normal optical depth)
//   nPerTau[k]  = Int_bin a^(-q) da / (pi Int_all a^(2-q) da)       (column number density per unit tau, m^-2)
//   aEff[k]     = sqrt( Int_bin a^(4-q) / Int_bin a^(2-q) )          (cross-section-weighted rms radius)
// Particles below 1 mm (true dust: D ring, gaps, F/G/E rings, Roche Division - um grains in the zone table)
// carry tauSub = 1 - Sum_k tauFrac[k]: a never-drawn layer with vertical std-dev sigZSub*H. The size
// distribution itself justifies it: they would be >= 1 px only within millimetres of the camera. The top
// class absorbs any aMax above A0*2^LOD_CLASSES.
//
// COUNT CONTRACT. Every particle whose apparent diameter is >= 1 DISPLAY pixel is drawn individually, at its
// true position and size - no stochastic thinning, no count-reducing window, no user setting. Apparent
// sizes are measured in display (canvas) pixels, rho = a / (s * displayPixelAngle), so the internal render
// scale changes the rendering fidelity only, never which particles are drawn. Below 1 px the near field
// hands over to the medium in a narrow band: it carries the fraction
//   carry(a, k, s) = smoothstep(LOD_RHO_LO, LOD_RHO_FULL, rho) * window_k(R)
// of a particle's optical depth (1 for rho >= 0.5 px = everything >= 1 px across; 0 below 0.4 px). Particles
// in the band are drawn at their true size with that probability (stable per-particle threshold; below half a
// render pixel as discs of half a render pixel with probability (rho_render / 0.5)^2 x carry: expected
// coverage = true coverage), so near field + medium is exact. The medium carries the rest:
//   sigmaUnres = sigmaTotal - Sum_k sigma_k * carry(aEff[k], k, s).
// window_k(R) = 1 - smoothstep(0.9 box[k], box[k], R) (R: horizontal distance) only matters if the slot cap
// clipped a class's box below its natural size: the medium then carries the particles that are not
// instantiated, and the shortfall is reported as a count deficit (never silently).
// See src/render/shaders/ringLod.glsl for the GLSL side.
//
// ALLOCATION (near-field particle population, src/render/near). Each particle of radius a lives in its own
// shearing-periodic square box (in the ring plane) that follows the camera, of half-size
//   D(a) = min( sqrt((c a)^2 - dz^2), box[k] ),   c = margin / (allocPixelAngle * LOD_RHO_LO):
// the horizontal distance beyond which it stays below the handover band even after zooming in by `margin`
// (c a = its 3-D reach; dz = the lowest camera height the allocation serves minus the slab half-thickness, 0 when
// the allocation does not depend on the camera height). Since carry = 0 there, wrapping at the box edge is
// invisible, and no particle is simulated where it could not be drawn (radii with c a <= dz are not
// instantiated at all). Class k holds slots[k] = tauMax[k] Int_bin nPerTau(a) (2 D(a))^2 da particles, radii
// sampled from n(a) D(a)^2 with up to LOD_PIECES power-law pieces (on each the box is a power of a, a tight
// upper bound of D(a): ~1% more slots); each is present with probability tau_macro(r)/tauMax[k] (so gaps are
// empty and the local column density matches the profile), tauMax[k] being the largest tau over the radial span
// of the class's box. box[k] = horizontal reach of aHi[k] (<= rMax). The allocation depends only on the zone
// (size bins, tauMax) and the display pixel angle (re-fitted when zooming in beyond the margin or out by more
// than zoomOutTolerance) - never on a user setting, and normally not on the camera position, so the particles
// persist while flying. Only if the total exceeds maxSlots (dense B ring: ~46M) is it fitted to the camera
// height h: valid for heights in [h / hyst, h * HEIGHT_HYST] (dz from h / hyst), re-fitted outside. Above the
// layer the headroom (zoom-in margin, hyst) is given up first, down to HEADROOM_MIN of its full exponent: it
// holds no particle that is drawn now. Only then (and inside the layer, where the layer itself hides everything
// farther) are the largest boxes clipped at a common radius (water-filling: far particles go first). What that
// leaves out is reported (count deficit, visibility-weighted from the camera).
// Vertical visibility is deliberately NOT used to thin the population: every particle crosses the mid-plane
// twice per orbit and rises to +-B (Rayleigh, typically ~1.2 sigma_z), and wake gaps (density ~0.24 x mean)
// leave even the B ring (tau ~4) at tau_gap ~1, so a conservative cut (consistent with the occlusion cull) keeps
// everything within ~5x the camera height; a persistent population cannot exploit the instantaneous depth.
//
// Kinematics (exact linear Hill-frame solution, see NearFieldPass): guiding centers shear at
// v_y = -q Omega x; epicycles with Rayleigh amplitude of scale sigX[k] = EPI_RATIO * sigZ[k] (radial
// velocity dispersion c_r = kappa*sigX, c_r/c_z = EPI_RATIO), vertical oscillation of Rayleigh amplitude
// scale sigZ[k] = sigZFrac[k]*H (so z is Gaussian with std sigZ, matching the medium's vertical structure).
// sigZFrac follows the zone's vertical law (ringRegions.ts sigZLaw, N-body calibrated: docs/ring-physics.md 10.12).
//
// SIZE RULES (src/rings/ringDynamics.ts, docs/ring-physics.md 10.12), per class k, shared with the GLSL:
//   partP[k]   participation in the self-gravity wakes: a particle of class k follows the wake map with probability
//              partP[k] (mixture), so the class's density is 1 + partP[k] (D - 1) and the medium's unresolved density
//              1 + pbar_unres (D - 1) is exact (channels of the ring layer's vertical-structure LUT)
//   alignF[k]  share in the spin-aligned population: the class's mean projected area along a direction d is
//              pi a^2 (1 + alignF[k] G(mu_d) [+ tidal share T(mu_d) cos 2psi]), G / T from the CPU mirror of the shapes
//   packing    the participating particles are thickened by m = max(1, tauDyn ffP min(D, Dcap) / (0.65 - tauDyn ffNP))
//              (mid-plane filling <= 0.65), the same in the near field (vertical amplitude) and the medium (profile)
//   tauDyn     the particle population's optical depth (tau_dyn / tau_profile from the wake statistics, WakeStats.ts):
//              presence and the medium follow it; tauDynFactor(tau) is the anchor zone's table (uLodTauDyn)
import type { RingLocal } from './RingProfile';
import {
  anisotropyTables, ANISO_N, crossSectionMean, hillParameter, midplaneFilling, PACKING_MAX, participation, spinAlignedShare,
  tidalShare,
} from './ringDynamics';
import { densityQuantileHigh } from './WakeStats';
import { sigZFracLegacy } from './ringRegions';

/** tau nodes of the anchor's tau_dyn / tau_profile table (uLodTauDyn): log-spaced over [LOD_DYN_LO, LOD_DYN_HI] */
export const LOD_DYN_N = 32;
export const LOD_DYN_LO = 0.005;
export const LOD_DYN_HI = 20;

export const LOD_CLASSES = 14;
export const LOD_A0 = 0.001; // m
/** display-pixel radius at and above which every particle is drawn individually (1 px apparent diameter) */
export const LOD_RHO_FULL = 0.5;
/**
 * below this display-pixel radius particles are carried by the medium only (handover band LOD_RHO_LO..FULL;
 * narrow: the drawn sub-pixel dots fade by coverage, so it needs no width to avoid popping, and every 0.1 px
 * of band below 0.5 px costs as many particles as the whole >= 1 px population per 0.6 px)
 */
export const LOD_RHO_LO = 0.4;
/** ratio of the radial to the vertical displacement dispersion (c_r/c_z for kappa ~ nu) */
export const EPI_RATIO = 1.5;
/** power-law pieces of a class's radius / box sampler (NEAR_PIECES in src/render/near/nearCommon.glsl) */
export const LOD_PIECES = 6;

export interface LodOptions {
  /** self-gravity wakes on (settings.wakes): the particle population's optical depth is tauDyn, else tauIso */
  wakes: boolean;
  /** display (canvas) radians per pixel */
  pixelAngle: number;
  /** cap on the particle slots over all classes (memory / per-frame update cost); a binding cap is reported */
  maxSlots: number;
  /** hard cap on any class's box half-size (m) */
  rMax: number;
  /** zoom headroom: boxes cover the handover band down to pixelAngle / margin */
  margin: number;
  /** re-fit (shrink) the allocation after zooming out by more than this factor */
  zoomOutTolerance: number;
}

export const DEFAULT_LOD_OPTIONS: LodOptions = {
  wakes: true,
  pixelAngle: 1e-3,
  maxSlots: 12_000_000,
  rMax: 60_000,
  margin: 1.25,
  zoomOutTolerance: 1.6,
};

function powInt(lo: number, hi: number, p: number): number {
  if (hi <= lo) return 0;
  if (Math.abs(p + 1) < 1e-9) return Math.log(hi / lo);
  return (Math.pow(hi, p + 1) - Math.pow(lo, p + 1)) / (p + 1);
}
/** height band of a camera-height-fitted (slot-capped) allocation: re-fitted above h * HEIGHT_HYST, and
 *  below h / HEIGHT_HYST^lambda (lambda: the headroom exponent the cap left, HEADROOM_MIN..1) */
const HEIGHT_HYST = 1.5;
/** smallest headroom exponent: zoom-in margin 1.25^0.3 = 1.07x, height band 1.5^0.3 = 1.13x */
const HEADROOM_MIN = 0.3;
/** headroom is only traded for slots this many slab half-thicknesses above the mid-plane (else: clip) */
const HEADROOM_MIN_HEIGHT = 2;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
function erfApprox(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
/** P(Z > z) for a centred Gaussian of std sig */
const gaussQ = (z: number, sig: number) => 0.5 * (1 - erfApprox(z / (Math.SQRT2 * sig)));
/** entries - 1 of the column-centroid table (sv_ringLod LOD_COLQ_N) */
export const LOD_COLQ_N = 64;
/**
 * Column-centroid table of a vertical profile given as a Gaussian mixture comps = [w0, s0, w1, s1, ...] (s: std-dev
 * in units of H): out[j] = C(j / LOD_COLQ_N), C(Q) = Int_0^Q h(Q') dQ', h(Q) = height (units of H, toward a beam)
 * beyond which the fraction Q of the column lies. For a Gaussian mixture C(Q) is the first moment of the column
 * beyond h(Q): Sum_k w_k s_k phi(h / s_k) / Sum_k w_k. Mirror of the GLSL ringColumnCentroid's data.
 */
export function columnCentroidTable(comps: ArrayLike<number>, out: Float32Array): void {
  let wt = 0, smax = 0;
  for (let i = 0; i < comps.length; i += 2) { wt += comps[i]; smax = Math.max(smax, comps[i + 1]); }
  const beyond = (h: number) => { let f = 0; for (let i = 0; i < comps.length; i += 2) f += comps[i] * gaussQ(h, comps[i + 1]); return f / wt; };
  out[0] = 0;
  out[LOD_COLQ_N] = 0;
  for (let j = 1; j < LOD_COLQ_N; j++) {
    const Q = j / LOD_COLQ_N;
    let lo = -8 * smax, hi = 8 * smax;
    for (let it = 0; it < 60; it++) { const m = 0.5 * (lo + hi); if (beyond(m) > Q) lo = m; else hi = m; }
    const h = 0.5 * (lo + hi);
    let c = 0;
    for (let i = 0; i < comps.length; i += 2) { const s = comps[i + 1]; c += (comps[i] * s * Math.exp(-0.5 * (h / s) ** 2)) / 2.50662827; }
    out[j] = c / wt;
  }
}
/** CPU mirror of the GLSL ringColumnCentroid: centroid height (units of H) of the column slice between fractions qa < qb */
export function columnCentroid(table: Float32Array, qa: number, qb: number): number {
  const C = (Q: number) => {
    const x = Math.min(1, Math.max(0, Q)) * LOD_COLQ_N;
    const i = Math.min(Math.floor(x), LOD_COLQ_N - 1);
    return table[i] + (table[i + 1] - table[i]) * (x - i);
  };
  return (C(qb) - C(qa)) / Math.max(qb - qa, 1e-6);
}

/** normalized vertical density of the layer's optical depth at height z (1/m) */
function gaussPdfMix(l: RingLod, z: number): number {
  let g = 0, w = 0;
  for (let k = 0; k < LOD_CLASSES; k++) {
    if (l.tauFrac[k] <= 0) continue;
    const s = Math.max(l.sigZFrac[k] * l.H, 0.02);
    g += (l.tauFrac[k] * Math.exp(-0.5 * (z / s) ** 2)) / (2.50662827 * s);
    w += l.tauFrac[k];
  }
  return w > 0 ? g / w : 0;
}

export class RingLod {
  readonly aLo = new Float32Array(LOD_CLASSES);
  readonly aHi = new Float32Array(LOD_CLASSES);
  readonly tauFrac = new Float32Array(LOD_CLASSES);
  readonly nPerTau = new Float32Array(LOD_CLASSES);
  readonly aEff = new Float32Array(LOD_CLASSES);
  readonly sigZFrac = new Float32Array(LOD_CLASSES);
  /** largest box half-size of class k (m, horizontal) = distance beyond which no class-k particle exists (uLodBox) */
  readonly box = new Float32Array(LOD_CLASSES);
  /**
   * Radius / box sampler per class (LOD_PIECES pieces of 4 floats each, class k at offset k * LOD_PIECES * 4):
   * piece i covers radii [x0, x1] with slot density ~ a^(p - q) and box half-size D1 (a / x1)^(p/2).
   * pieceP: (x1, 1/E (0: log-uniform), (x0/x1)^E (log-uniform: ln(x0/x1)), cumulative slot share), E = p - q + 1;
   * pieceB: (D1 (m), p/2, x0, 0). Unused pieces have share 1 and are never selected.
   */
  readonly pieceP = new Float32Array(LOD_CLASSES * LOD_PIECES * 4);
  readonly pieceB = new Float32Array(LOD_CLASSES * LOD_PIECES * 4);
  /** per class: largest tau over the radial span of its box (particles are generated at it and thinned) */
  readonly tauMax = new Float32Array(LOD_CLASSES);
  /** particles allocated per class (at tauMax[k]) */
  readonly count = new Float64Array(LOD_CLASSES);
  /** integer particle slots per class (what the near-field pass allocates) */
  readonly slots = new Int32Array(LOD_CLASSES);
  /** 3-D reach factor: a particle of radius a can be drawn out to cAlloc a (zoom headroom included) */
  cAlloc = 0;
  /** display pixel angle the allocation was fitted to */
  allocPixelAngle = 0;
  /** zoom-in headroom of the allocation (options.margin unless the slot cap took some of it) */
  marginEff = DEFAULT_LOD_OPTIONS.margin;
  /** height band below allocHeight that the allocation serves (factor; HEIGHT_HYST unless the cap took some) */
  hystEff = HEIGHT_HYST;
  /**
   * 0: the allocation is independent of the camera position (the normal case). Otherwise (slot cap binding,
   * dense rings) the camera height (>= the slab half-thickness) it was fitted to: valid for camera heights in
   * [allocHeight / hystEff, allocHeight * HEIGHT_HYST]; boxes then only span the horizontal distance at which a
   * particle can still be drawn from the lowest of them.
   */
  allocHeight = 0;
  /** common radius at which the slot cap clipped the boxes (Infinity: not capped) */
  capRadius = Infinity;
  /** fraction of the particles >= 1 px that the cap / rMax left out (0 = complete) */
  deficit = 0;
  /** share of tau in particles below the smallest class (never drawn) and its vertical std-dev / H */
  tauSub = 0;
  sigZFracSub = 0.4;
  /** per class (vec4-packed, k = 4i + c): participation in the wakes and share in the spin-aligned population */
  readonly partP = new Float32Array(16);
  readonly alignF = new Float32Array(16);
  /** tau-weighted participation / aligned share of the whole column (sub-class particles: 0) */
  pbarTot = 1;
  fAlignTot = 0;
  /** anisotropy of the aligned population (vec4-packed): G at mu = i / (ANISO_N - 1), then T at the same nodes */
  readonly aniso = new Float32Array(20);
  /** tidally locked share of the aligned population (Hill-parameter criterion; 0 in every main-ring zone) */
  tidal = 0;
  /** packing ceiling: (participating / other particles' mid-plane filling per unit tau_dyn, density cap, 1 = can bind) */
  readonly pack = new Float32Array(4);
  /** slab half-thickness in units of H (4 sigma of the thickest class, x the packing ceiling's largest thickening) */
  slabK = 1.6;
  /** tau_dyn / tau_profile of the anchor's zone at LOD_DYN_N log-spaced tau nodes (uLodTauDyn) */
  readonly dynTab = new Float32Array(LOD_DYN_N);
  wakesOn = true;
  /** column-centroid table of the PARTICIPATING column (the wake density averaged along paths; uLodColC) */
  readonly colC = new Float32Array(LOD_COLQ_N + 1);
  private colComps: number[] = [];
  /** the particle population's optical depth at the anchor (tauDyn with wakes, tauIso without) */
  tau = 0;
  /** photometric (profile) optical depth at the anchor */
  tauPhot = 0;
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
  private I2all = 0;

  readonly uniforms = {
    uLodActive: { value: 0 },
    uLodTauFrac: { value: this.tauFrac },
    uLodAEff: { value: this.aEff },
    uLodSigZ: { value: this.sigZFrac },
    uLodBox: { value: this.box },
    uLodPixelAngle: { value: 1e-3 },
    uLodCullTau: { value: 7 },
    uLodH: { value: 10 },
    uLodTau: { value: 0 },
    uLodTauSub: { value: 0 },
    uLodSigZSub: { value: 0.4 },
    uLodARange: { value: new Float32Array(LOD_CLASSES * 2) },
    uLodQ: { value: 3 },
    uLodColC: { value: this.colC },
    uLodClassP: { value: this.partP },
    uLodClassF: { value: this.alignF },
    uLodAniso: { value: this.aniso },
    // (tidal share, tau-weighted participation of the column, aligned share of the column, 0)
    uLodTidal: { value: new Float32Array(4) },
    uLodPack: { value: this.pack },
    uLodSlabK: { value: 1.6 },
    uLodTauDyn: { value: this.dynTab },
  };

  /** Rebuild colC when the participating column's vertical profile changed (in units of H). */
  private updateColumnTable(): void {
    const H = Math.max(this.H, 1e-3);
    const c: number[] = [];
    for (let k = 0; k < LOD_CLASSES; k++) {
      const w = this.tauFrac[k] * this.partP[k];
      if (w > 0) c.push(w, Math.max(this.sigZFrac[k] * H, 0.02) / H);
    }
    if (c.length === 0) c.push(1, Math.max(0.3 * H, 0.02) / H);
    const p = this.colComps;
    if (p.length === c.length && c.every((x, i) => Math.abs(x - p[i]) < 1e-6)) return;
    this.colComps = c;
    columnCentroidTable(c, this.colC);
  }

  /** The former universal vertical law (zones without an N-body calibration keep it: ringRegions.ts sigZFracLegacy). */
  static sigZFracForRadius(a: number): number {
    return sigZFracLegacy(a);
  }

  /** tau_dyn / tau_profile of the anchor's zone at photometric tau (CPU mirror of lodTauDyn: the near field's presence) */
  tauDynFactor(tau: number): number {
    const t = this.dynTab;
    if (!(tau > LOD_DYN_LO)) return t[0];
    const x = (Math.log(Math.min(tau, LOD_DYN_HI) / LOD_DYN_LO) / Math.log(LOD_DYN_HI / LOD_DYN_LO)) * (LOD_DYN_N - 1);
    const i = Math.min(LOD_DYN_N - 2, Math.floor(x)), f = x - i;
    return t[i] + (t[i + 1] - t[i]) * f;
  }
  /** packing-ceiling thickening of the participating particles at particle optical depth tauDyn and wake density D
   *  (CPU mirror of lodPackM) */
  packM(tauDyn: number, D: number): number {
    const p = this.pack;
    if (p[3] < 0.5) return 1;
    return Math.max(1, (tauDyn * p[0] * Math.min(D, p[2])) / Math.max(PACKING_MAX - tauDyn * p[1], 0.1 * PACKING_MAX));
  }

  /** Vertical / radial displacement dispersion (m) of class k at the configured layer thickness. */
  sigZ(k: number): number {
    return Math.max(this.sigZFrac[k] * this.H, 0.02);
  }
  sigX(k: number): number {
    return EPI_RATIO * this.sigZ(k);
  }

  /** Largest class box (m, horizontal half-size around the camera). */
  get maxBox(): number {
    let m = 0;
    for (let k = 0; k < LOD_CLASSES; k++) if (this.slots[k] > 0) m = Math.max(m, this.box[k]);
    return m;
  }

  /** Largest 3-D distance (m) at which an allocated particle can be drawn: the near field's activation height. */
  get maxReach(): number {
    let m = 0;
    for (let k = 0; k < LOD_CLASSES; k++) if (this.slots[k] > 0) m = Math.max(m, Math.min(this.options.rMax, this.cAlloc * this.aHi[k]));
    return m;
  }

  /** Display pixel angle of the current frame (the count contract is evaluated with it). */
  setPixelAngle(pa: number): void {
    this.uniforms.uLodPixelAngle.value = pa;
  }

  /** Whether the allocation must be re-fitted for this display pixel angle (zoom beyond the headroom). */
  needsRefit(pa: number): boolean {
    if (this.allocPixelAngle <= 0) return true;
    return pa < this.allocPixelAngle / this.marginEff || pa > this.allocPixelAngle * this.options.zoomOutTolerance;
  }

  /** Half-thickness (m) of the slab containing essentially all particles (as ringSlabHalfThickness). */
  get slabHalf(): number {
    return this.slabHalfFor(this.H);
  }
  /** The same for a layer thickness H (m) other than the anchor's (ringSlabHalfThickness(H)). */
  slabHalfFor(H: number): number {
    return this.slabK * H + 0.5;
  }
  /** Half-thickness (m) of the layer at its mean density (4 sigma of the thickest class with the packing ceiling's
   *  thickening at D = 1): the near-field shadow map's tube (the thicker wake cores are shadowed statistically). */
  get layerHalf(): number {
    let s = this.tauSub > 0 ? this.sigZFracSub : 0;
    for (let k = 0; k < LOD_CLASSES; k++) if (this.tauFrac[k] > 0) s = Math.max(s, this.sigZFrac[k]);
    return Math.max(1.6, 4 * s * this.packM(this.tau, 1)) * this.H + 0.5;
  }

  /** Allocation height for a camera at height camZ (m) above the mid-plane. */
  heightFor(camZ: number): number {
    return Math.max(Math.abs(camZ), this.layerHalf);
  }

  /** Camera heights (m, [lo, hi]) a height-fitted allocation serves; null if it does not depend on the height. */
  get heightBand(): [number, number] | null {
    return this.allocHeight > 0 ? [this.allocHeight / this.hystEff, this.allocHeight * HEIGHT_HYST] : null;
  }

  /**
   * Whether the allocation must be re-fitted: zoom beyond the headroom, or - only when the slot cap binds,
   * which makes the allocation depend on the camera height - the height left the range it was made for.
   */
  needsRealloc(pa: number, camZ: number): boolean {
    if (this.needsRefit(pa)) return true;
    if (this.allocHeight <= 0) return false;
    const h = this.heightFor(camZ);
    return h < this.allocHeight / this.hystEff || h > this.allocHeight * HEIGHT_HYST;
  }

  /**
   * Radius / box sampler of class k for 3-D reach factor c, height dz (m, see ALLOCATION) and class box nat (m):
   * returns the slot weight W = Int a^-q D(a)^2 da over the instantiated radii (slots = 4 tauMax W / (pi I2all))
   * and, if `write`, stores the pieces in pieceP / pieceB. D(a) = min(sqrt((c a)^2 - dz^2), nat) is bounded from
   * above by a power of a on each piece, touching it at the piece's upper end (exact for dz = 0).
   */
  private buildPieces(k: number, c: number, dz: number, nat: number, write: boolean): number {
    const P = this.pieceP, Bx = this.pieceB, o = k * LOD_PIECES * 4;
    if (write) {
      P.fill(0, o, o + LOD_PIECES * 4);
      Bx.fill(0, o, o + LOD_PIECES * 4);
      for (let i = 0; i < LOD_PIECES; i++) P[o + i * 4 + 3] = 1;
    }
    const lo = this.aLo[k], hi = this.aHi[k], q = this.q;
    if (this.nPerTau[k] <= 0 || hi <= lo || nat <= 0 || this.I2all <= 0) return 0;
    const az = dz / c;                    // reach c a = dz: smaller particles can never be drawn
    const al = Math.max(lo, az);
    if (al >= hi) return 0;
    // radius from which the horizontal reach exceeds the class box (constant box nat above it)
    const as = Math.min(hi, Math.max(al, Math.sqrt(nat * nat + dz * dz) / c));
    const xs: number[] = [al];            // piece boundaries over [al, as]: geometric in b = a^2 - az^2
    if (as > al) {
      const bs = (as - az) * (as + az);
      const bl = Math.max(0, (al - az) * (al + az));
      if (dz <= 0) xs.push(as);
      else {
        const b0 = Math.max(bl, bs * 1e-3);
        if (bl < b0 * 0.999) xs.push(Math.sqrt(b0 + az * az));   // tiny first piece where the reach ~ dz
        const m = LOD_PIECES - xs.length;                        // keep one piece for the constant box
        for (let j = 1; j <= m; j++) xs.push(j === m ? as : Math.sqrt(b0 * Math.pow(bs / b0, j / m) + az * az));
      }
    }
    // pieces: [x0, x1, p (box exponent of D^2), D1 (box at x1)]
    const pcs: [number, number, number, number][] = [];
    for (let j = 0; j + 1 < xs.length; j++) {
      const x0 = xs[j], x1 = xs[j + 1];
      if (!(x1 > x0)) continue;
      const b1 = (x1 - az) * (x1 + az);
      pcs.push([x0, x1, (2 * x1 * x1) / b1, c * Math.sqrt(b1)]);
    }
    if (as < hi) pcs.push([as, hi, 0, nat]);
    let W = 0;
    const w: number[] = [];
    for (const [x0, x1, p, D1] of pcs) {
      // Int_x0^x1 a^-q D1^2 (a/x1)^p da = D1^2 x1^(1-q) Int_(x0/x1)^1 t^(p-q) dt
      const E = p - q + 1, rl = Math.log(x0 / x1);
      const J = Math.abs(E) < 1e-6 ? -rl : -Math.expm1(E * rl) / E;
      const wi = D1 * D1 * Math.pow(x1, 1 - q) * J;
      w.push(wi);
      W += wi;
    }
    if (write && W > 0) {
      let cum = 0;
      pcs.forEach(([x0, x1, p, D1], i) => {
        const E = p - q + 1, rl = Math.log(x0 / x1);
        cum += w[i] / W;
        const j = o + i * 4;
        P[j] = x1;
        P[j + 1] = Math.abs(E) < 1e-6 ? 0 : 1 / E;
        P[j + 2] = Math.abs(E) < 1e-6 ? rl : Math.exp(E * rl);
        P[j + 3] = i === pcs.length - 1 ? 1 : cum;
        Bx[j] = D1;
        Bx[j + 1] = p / 2;
        Bx[j + 2] = x0;
      });
    }
    return W;
  }

  /** Box half-size (m) of an instantiated class-k particle of radius a (CPU mirror of nearRadiusBox). */
  boxOf(k: number, a: number): number {
    const o = k * LOD_PIECES * 4;
    let i = 0;
    while (i < LOD_PIECES - 1 && this.pieceP[o + i * 4 + 3] < 1 && a > this.pieceP[o + i * 4]) i++;
    const x1 = this.pieceP[o + i * 4];
    return x1 > 0 ? this.pieceB[o + i * 4] * Math.pow(Math.min(a / x1, 1), this.pieceB[o + i * 4 + 1]) : 0;
  }

  /**
   * Allocation for zoom-in margin `margin`, box height dz and box clip radius R: the slot total, and (`write`)
   * the class tables (box, tauMax, count, slots, samplers).
   */
  private plan(tau: number, tauMaxAt: (halfWidth: number) => number, pa: number, margin: number, dz: number, R: number, write: boolean): number {
    const c = margin / (pa * LOD_RHO_LO);
    let total = 0;
    for (let k = 0; k < LOD_CLASSES; k++) {
      const reach = Math.min(this.options.rMax, c * this.aHi[k]);
      const nat = Math.min(R, reach > dz ? Math.sqrt((reach - dz) * (reach + dz)) : 0);
      // the max tau over the class's (possibly clipped) box
      const t = this.nPerTau[k] > 0 && nat > 0 ? Math.max(tau, tauMaxAt(nat + 500)) : tau;
      const n = (4 * t * this.buildPieces(k, c, dz, nat, write)) / (Math.PI * this.I2all);
      total += n;
      if (!write) continue;
      this.slots[k] = n > 0.5 ? Math.ceil(n) : 0;
      this.count[k] = n;
      this.tauMax[k] = t;
      this.box[k] = this.slots[k] > 0 ? nat : 0;
    }
    return total;
  }

  /**
   * Configure for a local ring patch at display pixel angle opts.pixelAngle. `tauMaxAt(halfWidth)` = max tau
   * within +-halfWidth (m) of the camera's radius: each class's particles are generated at the max over its box
   * and thinned by tau(r)/tauMax[k].
   */
  configure(local: RingLocal, tauMaxAt: (halfWidth: number) => number, camZ: number, opts: Partial<LodOptions> = {}): void {
    const o = (this.options = { ...this.options, ...opts });
    const prevLo = Float64Array.from(this.aLo);
    const prevHi = Float64Array.from(this.aHi);
    this.wakesOn = o.wakes;
    this.tauPhot = local.tau;
    this.tau = o.wakes ? local.tauDyn : local.tauIso;
    this.H = local.H;
    this.q = local.q;
    this.aMin = local.aMin;
    this.aMax = local.aMax;
    const q = local.q;
    const H = Math.max(local.H, 1e-3);
    const I2all = (this.I2all = powInt(local.aMin, local.aMax, 2 - q));
    const ap = local.partAp;
    for (let k = 0; k < LOD_CLASSES; k++) {
      const lo = Math.max(LOD_A0 * 2 ** k, local.aMin);
      const hi = k === LOD_CLASSES - 1 ? local.aMax : Math.min(LOD_A0 * 2 ** (k + 1), local.aMax);
      this.aLo[k] = lo;
      this.aHi[k] = Math.max(hi, lo);
      if (!local.macroscopic || hi <= lo || I2all <= 0) {
        this.tauFrac[k] = 0;
        this.nPerTau[k] = 0;
        this.aEff[k] = LOD_A0 * 2 ** (k + 0.5);
        this.sigZFrac[k] = local.sigZ(this.aEff[k]) / H;
        this.partP[k] = 1;
        this.alignF[k] = 0;
        continue;
      }
      const I0 = powInt(lo, hi, -q);
      const I2 = powInt(lo, hi, 2 - q);
      const I4 = powInt(lo, hi, 4 - q);
      this.tauFrac[k] = I2 / I2all;
      this.nPerTau[k] = I0 / (Math.PI * I2all);
      this.aEff[k] = Math.sqrt(I4 / I2);
      // the zone's vertical law at the class's cross-section-weighted rms radius (one sigma per class: particles and
      // medium share it exactly)
      this.sigZFrac[k] = local.sigZ(this.aEff[k]) / H;
      // size rules: the class's cross-section-weighted participation and aligned share (ringDynamics.ts)
      this.partP[k] = crossSectionMean(lo, hi, q, (a) => participation(a, ap), [ap]);
      this.alignF[k] = crossSectionMean(lo, hi, q, spinAlignedShare, [0.05, 1]);
    }
    for (let k = LOD_CLASSES; k < 16; k++) { this.partP[k] = 0; this.alignF[k] = 0; }
    // sub-class residual (particles with a < A0 = 1 mm): never drawn, carried by the medium (no participation, random)
    let fsum = 0;
    for (let k = 0; k < LOD_CLASSES; k++) fsum += this.tauFrac[k];
    if (local.macroscopic && I2all > 0 && local.aMin < LOD_A0) {
      this.tauSub = Math.max(0, 1 - fsum);
      const hiS = Math.min(LOD_A0, local.aMax);
      const I2s = powInt(local.aMin, hiS, 2 - q), I4s = powInt(local.aMin, hiS, 4 - q);
      this.sigZFracSub = local.sigZ(I2s > 0 ? Math.sqrt(I4s / I2s) : LOD_A0) / H;
    } else {
      this.tauSub = 0;
      this.sigZFracSub = local.sigZ(LOD_A0) / H;
    }
    // column totals of the size rules
    let pT = 0, fT = 0, wT = this.tauSub;
    for (let k = 0; k < LOD_CLASSES; k++) { pT += this.tauFrac[k] * this.partP[k]; fT += this.tauFrac[k] * this.alignF[k]; wT += this.tauFrac[k]; }
    this.pbarTot = wT > 0 ? pT / wT : 1;
    this.fAlignTot = wT > 0 ? fT / wT : 0;
    // anisotropy of the aligned population (CPU mirror of the shapes / orientations) and the tidally locked share
    const at = anisotropyTables();
    for (let i = 0; i < ANISO_N; i++) { this.aniso[i] = at.G[i]; this.aniso[ANISO_N + i] = at.T[i]; }
    this.tidal = local.macroscopic ? tidalShare(hillParameter(local.rhoBulk, local.rKm * 1000)) : 0;
    // tau_dyn / tau_profile of the anchor's zone (presence of the particles; the medium has the profile's per-radius
    // values, RingProfile.tauDyn, from the same function)
    for (let i = 0; i < LOD_DYN_N; i++) {
      const t = LOD_DYN_LO * Math.pow(LOD_DYN_HI / LOD_DYN_LO, i / (LOD_DYN_N - 1));
      this.dynTab[i] = local.dynFactor(t, o.wakes);
    }
    this.updateColumnTable();
    // packing ceiling (ringDynamics.ts): mid-plane filling per unit tau_dyn of the participating / other particles with
    // the classes' sigma (as rendered), the density cap (densest 0.4 % of the field), and the slab that holds the layer
    // thickened up to the cap at the highest tau near the camera
    let ffP = 0, ffNP = 0, sigP = 0, sigAll = this.tauSub > 0 ? this.sigZFracSub : 0;
    for (let k = 0; k < LOD_CLASSES; k++) {
      if (this.tauFrac[k] <= 0) continue;
      const sk = Math.max(this.sigZFrac[k] * H, 0.02), pk = this.partP[k];
      const ff = midplaneFilling(this.aLo[k], this.aHi[k], q, I2all, () => sk);
      ffP += pk * ff;
      ffNP += (1 - pk) * ff;
      sigAll = Math.max(sigAll, this.sigZFrac[k]);
      if (pk > 0) sigP = Math.max(sigP, this.sigZFrac[k]);
    }
    const dCap = o.wakes && local.wakeStrength > 1e-3 ? densityQuantileHigh(local.wakeB >= 0.5 ? 'B' : 'A', local.wakeStrength) : 1;
    this.pack[0] = ffP;
    this.pack[1] = ffNP;
    this.pack[2] = dCap;
    this.pack[3] = 1;
    const tauNear = Math.max(this.tau, tauMaxAt(5000));
    const mSlab = this.packM(tauNear, dCap);
    this.pack[3] = mSlab > 1.0001 ? 1 : 0;
    this.slabK = Math.max(1.6, 4 * Math.max(sigAll, sigP * mSlab));

    // keep the allocation (same particles) unless the size bins, the max tau over a class's box or the display
    // pixel angle (beyond the zoom headroom) changed
    let keep = this.allocVersion > 0 && !this.needsRealloc(o.pixelAngle, camZ);
    if (keep) {
      for (let k = 0; k < LOD_CLASSES; k++) {
        if (Math.abs(this.aLo[k] - prevLo[k]) > 1e-6 * prevLo[k] || Math.abs(this.aHi[k] - prevHi[k]) > 1e-6 * prevHi[k]) { keep = false; break; }
        if (this.slots[k] <= 0) continue;
        const tm = Math.max(this.tau, tauMaxAt(this.box[k] + 500));
        if (tm > this.tauMax[k] * 1.0001 || tm < this.tauMax[k] * 0.7) { keep = false; break; }
      }
    }
    if (!keep) this.allocate(this.tau, tauMaxAt, o.pixelAngle, camZ);
    this.version++;
    this.uniforms.uLodCullTau.value = this.cullTau;
    this.uniforms.uLodH.value = this.H;
    this.uniforms.uLodTau.value = this.tau;
    this.uniforms.uLodTauSub.value = this.tauSub;
    this.uniforms.uLodSigZSub.value = this.sigZFracSub;
    const ar = this.uniforms.uLodARange.value;
    for (let k = 0; k < LOD_CLASSES; k++) { ar[2 * k] = this.aLo[k]; ar[2 * k + 1] = this.aHi[k]; }
    this.uniforms.uLodQ.value = this.q;
    this.uniforms.uLodSlabK.value = this.slabK;
    // (tidal share, pbar, aligned share, tau_iso / tau_profile = 1 / (1 + fAlign G(1)): the two-stream layer)
    const td = this.uniforms.uLodTidal.value;
    td[0] = this.tidal; td[1] = this.pbarTot; td[2] = this.fAlignTot; td[3] = 1 / (1 + this.fAlignTot * this.aniso[ANISO_N - 1]);
  }

  /** Spin-aligned anisotropy g - 1 of the aligned population along a unit direction (ring-frame components: x radial,
   *  y azimuthal, z normal) -- CPU mirror of lodAniso */
  anisoAt(dx: number, dy: number, dz: number): number {
    const x = Math.min(1, Math.abs(dz)) * (ANISO_N - 1);
    const i = Math.min(ANISO_N - 2, Math.floor(x)), f = x - i;
    const G = this.aniso[i] + (this.aniso[i + 1] - this.aniso[i]) * f;
    if (this.tidal <= 0) return G;
    const T = this.aniso[ANISO_N + i] + (this.aniso[ANISO_N + i + 1] - this.aniso[ANISO_N + i]) * f;
    const hh = dx * dx + dy * dy;
    return G + this.tidal * T * (hh > 1e-12 ? (dx * dx - dy * dy) / hh : 0);
  }

  private allocate(tau: number, tauMaxAt: (halfWidth: number) => number, pa: number, camZ: number): void {
    const o = this.options;
    this.allocPixelAngle = pa;
    let margin = o.margin, hyst = HEIGHT_HYST, dz = 0, R = Infinity;
    this.allocHeight = 0;
    // normally independent of the camera position
    let total = this.plan(tau, tauMaxAt, pa, margin, 0, R, false);
    if (total > o.maxSlots) {
      // dense rings: fitted to the camera height h. A particle is needed only within the horizontal distance at
      // which it can still reach the handover band from the lowest height the allocation serves (h / hyst).
      const h = (this.allocHeight = this.heightFor(camZ));
      const at = (lam: number, Rc: number): number => {
        margin = Math.pow(o.margin, lam);
        hyst = Math.pow(HEIGHT_HYST, lam);
        dz = Math.max(0, h / hyst - this.layerHalf);
        return this.plan(tau, tauMaxAt, pa, margin, dz, Rc, false);
      };
      let lam = 1;
      total = at(lam, R);
      // above the layer: give up headroom (zoom-in margin, height band - no particle drawn now) before clipping
      if (total > o.maxSlots && h > HEADROOM_MIN_HEIGHT * this.layerHalf) {
        if (at(HEADROOM_MIN, R) > o.maxSlots) lam = HEADROOM_MIN;
        else {
          let lo = HEADROOM_MIN, hi = 1;
          for (let it = 0; it < 14; it++) {
            const mid = 0.5 * (lo + hi);
            if (at(mid, R) <= o.maxSlots) lo = mid; else hi = mid;
          }
          lam = lo;
        }
        total = at(lam, R);
      }
      // slot cap: clip the largest boxes at a common radius R (water-filling, bisection on R)
      if (total > o.maxSlots) {
        let lo = 0, hi = o.rMax;
        for (let it = 0; it < 50; it++) {
          const mid = 0.5 * (lo + hi);
          if (at(lam, mid) > o.maxSlots) hi = mid; else lo = mid;
        }
        R = lo;
      }
      at(lam, R);
    }
    this.marginEff = margin;
    this.hystEff = hyst;
    this.capRadius = R;
    this.cAlloc = margin / (pa * LOD_RHO_LO);
    this.totalParticles = this.plan(tau, tauMaxAt, pa, margin, dz, R, true);
    let tauBoxMax = tau;
    for (let k = 0; k < LOD_CLASSES; k++) if (this.slots[k] > 0) tauBoxMax = Math.max(tauBoxMax, this.tauMax[k]);
    this.tauBoxMax = tauBoxMax;
    // count deficit: of the particles >= 1 px (rho >= LOD_RHO_FULL at this pixel angle, seen from the allocation
    // height), the share beyond 0.9 box[k] (where the window starts) that the slot cap / rMax leave out
    const dzC = Math.max(0, this.allocHeight - this.layerHalf);
    let need = 0, have = 0;
    for (let k = 0; k < LOD_CLASSES; k++) {
      if (this.nPerTau[k] <= 0) continue;
      const lo = this.aLo[k], hi = this.aHi[k], N = 24;
      for (let i = 0; i < N; i++) {
        const a0 = lo * Math.pow(hi / lo, i / N), a1 = lo * Math.pow(hi / lo, (i + 1) / N);
        const r1 = Math.min(o.rMax, Math.sqrt(a0 * a1) / (pa * LOD_RHO_FULL));
        const R1 = r1 > dzC ? Math.sqrt((r1 - dzC) * (r1 + dzC)) : 0;
        const Rh = Math.min(R1, 0.9 * this.box[k]);
        const nA = powInt(a0, a1, -this.q);
        need += nA * R1 * R1;
        have += nA * Rh * Rh;
      }
    }
    this.deficit = need > 0 ? Math.max(0, 1 - have / need) : 0;
    this.allocVersion++;
  }

  setActive(on: boolean): void {
    this.active = on;
    this.uniforms.uLodActive.value = on ? 1 : 0;
  }

  /**
   * CPU mirror of the GLSL lodClassCarry: share of class k's optical depth whose particles are carried at 3-D
   * distance s (cross-section-weighted mean of the per-particle smoothstep over the class's radii).
   */
  classCarry(k: number, s: number, pa = this.uniforms.uLodPixelAngle.value): number {
    const lo = this.aLo[k], hi = this.aHi[k], e = 2 - this.q;
    const X = Math.max(s, 1e-4) * pa, b0 = LOD_RHO_LO * X, b1 = LOD_RHO_FULL * X;
    if (hi <= b0) return 0;
    if (lo >= b1) return 1;
    let c = powInt(Math.max(lo, b1), hi, e);
    const x0 = Math.max(lo, b0), x1 = Math.min(hi, b1);
    if (x1 > x0) {
      const m = 0.5 * (x0 + x1), h = 0.5 * (x1 - x0), g = 0.7745966692 * h;
      const f = (a: number) => Math.pow(a, e) * smoothstep(b0, b1, a);
      c += h * ((5 / 9) * (f(m - g) + f(m + g)) + (8 / 9) * f(m));
    }
    const n = powInt(lo, hi, e);
    return n > 0 ? Math.min(1, Math.max(0, c / n)) : 0;
  }

  /** CPU mirror of the GLSL lodCarry: share of class k carried at 3-D distance s, height dz relative to the camera. */
  carry(k: number, s: number, pa = this.uniforms.uLodPixelAngle.value, dz = 0): number {
    if (!this.active) return 0;
    const D = this.box[k];
    const R = Math.sqrt(Math.max(s * s - dz * dz, 0));
    return D > 0 ? this.classCarry(k, s, pa) * (1 - smoothstep(0.9 * D, D, R)) : 0;
  }

  /** Fraction of the layer's optical depth above height z (m) (same vertical model as ringLayerTauBeyond). */
  private fracAbove(z: number): number {
    let f = 0, w = 0;
    for (let k = 0; k < LOD_CLASSES; k++) {
      if (this.tauFrac[k] <= 0) continue;
      f += this.tauFrac[k] * gaussQ(z, Math.max(this.sigZFrac[k] * this.H, 0.02));
      w += this.tauFrac[k];
    }
    if (this.tauSub > 0) { f += this.tauSub * gaussQ(z, Math.max(this.sigZFracSub * this.H, 0.02)); w += this.tauSub; }
    return w > 0 ? f / w : gaussQ(z, Math.max(0.3 * this.H, 0.02));
  }

  /**
   * Visible count deficit: of the particles >= 1 display px across that would be VISIBLE from camera height
   * camZ (slab model, mean wake density: line-of-sight transmission through the layer), the fraction the slot
   * cap leaves out. ~0 inside dense rings (everything beyond the clipped boxes is hidden by the layer itself),
   * > 0 above them. (deficit = the same without the visibility weighting.)
   */
  visibleDeficit(camZ: number, pa = this.uniforms.uLodPixelAngle.value): number {
    if (this.deficit <= 0) return 0;
    const tau = this.tau, H = this.H;
    const hermite = [[-2.0202, 0.0200], [-0.9586, 0.3936], [0, 0.9453], [0.9586, 0.3936], [2.0202, 0.0200]];
    let need = 0, miss = 0;
    for (let k = 0; k < LOD_CLASSES; k++) {
      if (this.nPerTau[k] <= 0 || this.slots[k] <= 0) continue;
      // >= 1 px range of the class (cross-section-weighted radius); classes not clipped only add to the total
      const s1 = this.aEff[k] / (pa * LOD_RHO_FULL);
      const D = 0.9 * this.box[k];
      const sig = Math.max(this.sigZFrac[k] * H, 0.02);
      const N = 24;
      const r0 = Math.min(0.5, 0.1 * s1);
      for (let i = 0; i < N; i++) {
        const ra = r0 * Math.pow(s1 / r0, i / N), rb = r0 * Math.pow(s1 / r0, (i + 1) / N);
        const R = Math.sqrt(ra * rb), dA = Math.PI * (rb * rb - ra * ra);
        let v = 0, wsum = 0;
        for (const [x, wt] of hermite) {
          wsum += wt;
          const zp = x * Math.SQRT2 * sig;
          const dz = zp - camZ;
          const L = Math.hypot(R, dz);
          if (L > s1) continue;   // not >= 1 px at this 3-D distance
          const col = tau * Math.abs(this.fracAbove(camZ) - this.fracAbove(zp));
          const tv = Math.abs(dz) > 0.04 * H + 1e-3 ? (col * L) / Math.abs(dz) : (tau * gaussPdfMix(this, 0.5 * (camZ + zp)) * L);
          v += wt * Math.exp(-tv);
        }
        const c = this.nPerTau[k] * (v / wsum) * dA;
        need += c;
        if (R > D) miss += c;
      }
    }
    return need > 0 ? miss / need : 0;
  }

  /**
   * Distance (m) beyond which the near field carries less than `frac` of the layer's optical depth: where the
   * medium may stop subtracting it (ring-layer march range).
   */
  carryRange(frac = 0.005, pa = this.uniforms.uLodPixelAngle.value): number {
    if (!this.active) return 0;
    const carried = (s: number) => {
      let t = 0;
      for (let k = 0; k < LOD_CLASSES; k++) if (this.tauFrac[k] > 0) t += this.tauFrac[k] * this.carry(k, s, pa);
      return t;
    };
    let lo = 0.01, hi = Math.max(this.maxBox, 0.02);
    if (carried(hi) >= frac) return hi;
    if (carried(lo) < frac) return 0;
    for (let it = 0; it < 40; it++) {
      const mid = Math.sqrt(lo * hi);
      if (carried(mid) >= frac) lo = mid; else hi = mid;
    }
    return hi;
  }
}
