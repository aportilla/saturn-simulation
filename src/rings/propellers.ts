// "Propeller" moonlets embedded in Saturn's A ring: populations, named giants, per-frame uniforms and the CPU mirror of
// src/render/shaders/ringPropellers.glsl (chunk sv_ringPropellers: rsTauModPropellers, rsReliefPropellers, two of the
// hooks of sv_ringStructure). RingStructure owns an instance. Model, data and sources: docs/ring-physics.md section 11.
//
// Data
// * Propeller belts (Tiscareno et al. 2008, AJ 135, 1083): three belts 126,750-128,000, 128,500-130,200, 131,300-
//   132,000 km; N(>dr) = 2.5e-6 km^-2 (dr / 0.8 km)^-4.84 inside them (dr = radial separation of the two lobes): 7,400
//   propellers with dr > 0.8 km (quoted 7,000-8,000; 1.5e-6 averaged over 126,000-132,000 km, quoted ~2e-6) and
//   7.0e-4 km^-2 with dr > 0.25 km (the SOI value); Q = 4.84 (quoted 4.5-5.4) is fixed by those two numbers. dr 0.11 ..
//   1.4 km (moonlet diameters 40 .. 500 m, R = 0.18 dr). These dr were measured on bright features of mostly unlit-face
//   images, i.e. the partial gaps: dr = 4 r_H (Seiss et al. 2005), so r_H = dr / 4. Lobe separation dl = 5.5 dr.
// * Trans-Encke giants (Tiscareno et al. 2010, ApJL 718, L92; arXiv 1007.1008 with its supplementary tables): 11
//   named ones with orbit fits (Table 1), dr of their lit-face bright lobes (Table S2) and dl (Table S4, lit-face
//   apparitions), equinox shadow heights (Table S3). On the lit face the bright lobes are the density-ENHANCED
//   regions, ~9 r_H apart (Sremcevic et al. 2007; Tiscareno et al. 2010 sec. 2.1: "R <= 0.18 dr should be regarded
//   as an upper limit"): r_H = dr_lit / 9 (Bleriot: r_H 0.61 km, R 0.44 km ~ its 0.43 km shadow height; the 4 r_H
//   reading, R = 0.95 km, would put its partial gaps 5.5 km apart where the lit-face dark lobes are 1.8 km apart).
//   Unlit-face bright features (the depleted gaps) of Bleriot are ~120 km long against ~50 km for the lit-face
//   lobes: the gaps' downstream scale is 2.4x the enhanced lobes'. Procedural trans-Encke population: 2e-8 km^-2 with
//   dr_lit >= 2 km over 133,780-136,450 km (19 found in a complete scan of 133,700-135,000 km), minus the named ones.
// * Bleriot's non-keplerian motion (Fig. 4 of the 2010 paper): a sinusoid of 0.11 deg amplitude and 3.68 yr period
//   on top of the linear fit; the phase is not tabulated: 2.0 rad at the epoch, from the two piecewise fits (angular
//   acceleration -0.0096"/day^2 in mid-2006 .. early 2007, +0.0023 in late 2007 .. early 2009; A w^2 = 0.0086"/d^2).
//
// Hash grid (procedural populations, identical in the GLSL): mean motions in "n-units" of 2^-24 revolutions per day
// (2.7 mm of radius each). Radial cells are intervals of n; each holds ONE orbit (n_i = cell start + hash), so all
// propellers of a cell move rigidly and their azimuthal cells (2^B per orbit) co-move with them. A propeller's longitude
// is lambda = Phi + n_i t / (2^24 day): with t = (k + f) days the integer part n_i k mod 2^24 is exact in uint
// arithmetic, so every moonlet keeps an exact, smooth longitude for decades while drifting at its own Keplerian rate
// relative to the co-orbiting camera. Cells are at least the structure's reach (13.5 r_H radially, 6 gap scales along
// the orbit), so 3 x 3 cells around a point find every propeller that can touch it; existence is a Bernoulli trial
// with the expected number per cell (<= 0.1).
import { Vector4 } from 'three';
import { DAY, DEG, orbitalFrequencies } from '../core/constants';
import type { MoonletTable } from './streamlines';
import { omegaModel, omegaSlope, type RingTexture } from './ringTexture';

export const RP_GIANTS = 12;
export const RP_CLASSES = 5;
/** peak depletion of the partial gaps (Seiss et al. 2005; Sremcevic et al. 2002: partial gaps of ~half the density) */
export const RP_D0 = 0.6;
/** n-units (2^-24 rev/day) per rad/s */
export const K_N = (DAY * 2 ** 24) / (2 * Math.PI);
/** the moonlet: mean radius of a Roche-lobe-filling body (Porco et al. 2007), in Hill radii */
export const RP_R_PER_H = 0.72;
/** height of the excited region / r_H when no equinox shadow was measured (median of Bleriot 0.70, Earhart 0.45,
 *  Santos-Dumont 0.25 with r_H = dr_lit / 9) */
export const RP_Z_PER_H = 0.45;
/** downstream scale of the partial gaps / of the enhanced lobes (Bleriot: unlit-face bright ~120 km, lit ~50 km) */
export const RP_GAP_PER_LOBE = 2.4;
const T32 = 4294967296;

// ------------------------------------------------------------------ hashing (mirror of sv_common pcgHash)
export function pcg(v: number): number {
  const state = (Math.imul(v | 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) | 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}
const u24 = (h: number) => (h >>> 8) / 16777216;
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const wrapPi = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));

// ------------------------------------------------------------------ named giants (Tiscareno et al. 2010)
export interface NamedPropeller {
  name: string;
  /** Table 1: longitude at the epoch (deg), mean motion (deg/day), semimajor axis (km) */
  lonDeg: number;
  nDegDay: number;
  aKm: number;
  /** Table S2: radial separation of the lit-face bright (density-enhanced) lobes (km) */
  drLitKm: number;
  /** Table S4: azimuthal separation of the lobes in lit-face apparitions (km, median) */
  dlLitKm: number;
  /** Table S4: the same for unlit-face bright features (the partial gaps), where measured */
  dlUnlitKm?: number;
  /** Table S3: vertical height from equinox shadows (km) */
  hEqKm?: number;
  /** non-keplerian longitude term: amplitude (deg), period (days), phase at the epoch (rad) */
  sinusoid?: { ampDeg: number; periodDays: number; phase: number };
}
/** Epoch of Table 1: 2007-01-01 12:00:00 UTC = JD 2454102.0 UTC; TT - UTC = 65.184 s in 2007 (33 leap seconds). */
export const PROPELLER_EPOCH = (2_454_102.0 - 2_451_545.0) * DAY + 65.184;
export const NAMED_PROPELLERS: NamedPropeller[] = [
  { name: 'Earhart', lonDeg: 57.85, nDegDay: 624.529897, aKm: 133_797.8401, drLitKm: 5.17, dlLitKm: 37.6, hEqKm: 0.26 },
  { name: 'Post', lonDeg: 58.09, nDegDay: 624.4867, aKm: 133_803.99, drLitKm: 3.34, dlLitKm: 38.8 },
  { name: 'Sikorsky', lonDeg: 70.37, nDegDay: 623.917736, aKm: 133_885.0475, drLitKm: 2.56, dlLitKm: 16.2 },
  { name: 'Curtiss', lonDeg: 210.04, nDegDay: 623.7473, aKm: 133_909.36, drLitKm: 3.11, dlLitKm: 17.7 },
  { name: 'Lindbergh', lonDeg: 112.08, nDegDay: 623.3176, aKm: 133_970.69, drLitKm: 1.33, dlLitKm: 13.8 },
  { name: 'Wright', lonDeg: 251.85, nDegDay: 622.5527, aKm: 134_080.03, drLitKm: 2.94, dlLitKm: 14.3, dlUnlitKm: 22.1 },
  { name: 'Kingsford Smith', lonDeg: 202.44, nDegDay: 620.761649, aKm: 134_336.935, drLitKm: 5.32, dlLitKm: 29.7 },
  { name: 'Hinkler', lonDeg: 58.85, nDegDay: 619.80519, aKm: 134_474.639, drLitKm: 1.85, dlLitKm: 11.2 },
  { name: 'Santos-Dumont', lonDeg: 324.11, nDegDay: 619.458729, aKm: 134_524.6067, drLitKm: 4.34, dlLitKm: 28.8, hEqKm: 0.12 },
  { name: 'Richthofen', lonDeg: 122.9, nDegDay: 617.7011, aKm: 134_778.83, drLitKm: 2.44, dlLitKm: 15.1 },
  {
    name: 'Blériot', lonDeg: 193.65, nDegDay: 616.7819329, aKm: 134_912.24521, drLitKm: 5.5, dlLitKm: 50, dlUnlitKm: 120, hEqKm: 0.43,
    sinusoid: { ampDeg: 0.11, periodDays: 3.68 * 365.25, phase: 2.0 },
  },
];
/** lit-face bright-lobe separation in Hill radii (density-enhanced lobes, Sremcevic et al. 2007) */
export const RP_GIANT_DR_PER_H = 9;

export interface GiantState {
  name: string;
  /** model radius (m): where the flow model's angular velocity equals the fitted mean motion (co-moves with the ring) */
  a: number;
  /** Table 1 radius (m) */
  aFit: number;
  /** SEF longitude now (rad) */
  theta: number;
  /** current height of the moonlet and the excited region (m) */
  z: number;
  /** Hill radius, enhanced-lobe and gap downstream scales (m), gap depth, vertical amplitude (m), moonlet radius (m) */
  h: number;
  dB: number;
  dD: number;
  D0: number;
  Z: number;
  R: number;
  /** angular rate (rad/s) */
  n: number;
}

// ------------------------------------------------------------------ procedural classes
export interface PropellerClass {
  id: string;
  /** radial windows (km) and their smooth edge half-width (km) */
  regionKm: [number, number][];
  edgeKm: number;
  /** measured lobe separation range (km) and the cumulative slope */
  drLoKm: number;
  drHiKm: number;
  Q: number;
  /** number density in this dr range (km^-2) */
  densityKm2: number;
  /** r_H per dr, enhanced-lobe downstream scale dB per dr, gap scale dD per dr, Z / r_H */
  hPerDr: number;
  dBPerDr: number;
  dDPerDr: number;
  zPerH: number;
}
const BELTS_KM: [number, number][] = [[126_750, 128_000], [128_500, 130_200], [131_300, 132_000]];
/** belt population: N(>dr) = N08 (dr / 0.8 km)^-Q */
const BELT_N08 = 2.5e-6, BELT_Q = 4.84;
const beltN = (dr: number) => BELT_N08 * (dr / 0.8) ** -BELT_Q;
// belt dl = 5.5 dr is the gap features' (unlit-face) separation: dD = dl / 2, dB = dD / 2.4
const beltClass = (id: string, lo: number, hi: number): PropellerClass => ({
  id, regionKm: BELTS_KM, edgeKm: 25, drLoKm: lo, drHiKm: hi, Q: BELT_Q, densityKm2: beltN(lo) - beltN(hi),
  hPerDr: 1 / 4, dBPerDr: 2.75 / RP_GAP_PER_LOBE, dDPerDr: 2.75, zPerH: RP_Z_PER_H,
});
const TE_REGION: [number, number] = [133_780, 136_450];
const TE_AREA_KM2 = Math.PI * (TE_REGION[1] ** 2 - TE_REGION[0] ** 2);
const TE_DENSITY = 2e-8;
export const PROPELLER_CLASSES: PropellerClass[] = [
  beltClass('belt-0', 0.11, 0.22),
  beltClass('belt-1', 0.22, 0.44),
  beltClass('belt-2', 0.44, 0.88),
  beltClass('belt-3', 0.88, 1.4),
  {
    // giants not tracked by name: dr_lit >= 2 km at 2e-8 km^-2, minus the named ones with dr_lit >= 2 km; lit-face dl ~6.3 dr
    id: 'trans-encke', regionKm: [TE_REGION], edgeKm: 10, drLoKm: 2, drHiKm: 6, Q: 5,
    densityKm2: TE_DENSITY - NAMED_PROPELLERS.filter((p) => p.drLitKm >= 2).length / TE_AREA_KM2,
    hPerDr: 1 / RP_GIANT_DR_PER_H, dBPerDr: 6.3 / 2, dDPerDr: (6.3 / 2) * RP_GAP_PER_LOBE, zPerH: RP_Z_PER_H,
  },
];

/** lattice of one class (radial cell in n-units, azimuthal bits) and derived bounds */
interface ClassLattice {
  N: number;
  B: number;
  hMax: number;
  reachR: number;
  reachS: number;
  pMax: number;
  salt: number;
}

/** one moonlet (CPU enumeration for the bodies, presets, tests) */
export interface Moonlet {
  /** 'giant' name or `${class}:${i}:${j}` */
  key: string;
  name: string;
  cls: number;
  /** orbit radius (m), SEF longitude now (rad), height (m) */
  a: number;
  theta: number;
  z: number;
  /** Hill radius, moonlet mean radius (m), lobe scales (m) */
  h: number;
  R: number;
  dB: number;
  dD: number;
  /** procedural: orbit (n-units), phase in it (2^-32 turns), vertical phase (turns), vertical amplitude (m); giants: index */
  n: number;
  phi: number;
  psi: number;
  Z: number;
}

// ------------------------------------------------------------------ the system
export class PropellerSystem {
  /** 1 = on, 0 = off (tests) */
  scale = 1;
  readonly lattice: ClassLattice[];
  readonly giants: GiantState[];
  readonly uniforms: {
    uRpCtl: { value: Vector4 };
    uRpT: { value: Int32Array };
    uRpTF: { value: Vector4 };
    uRpG0: { value: Vector4[] };
    uRpG1: { value: Vector4[] };
    uRpGiantN: { value: number };
    uRpC0: { value: Vector4[] };
    uRpC1: { value: Vector4[] };
    uRpC2: { value: Vector4[] };
    uRpC3: { value: Vector4[] };
    uRpCI: { value: Int32Array };
    /** bit k: a propeller can reach the guiding centres of near-field size class k (nearClassMask; nearUpdate.glsl) */
    uRpNearMask: { value: number };
  };
  // per-frame state (CPU mirror)
  private r0 = 1.3e8;
  private phi0 = 0;
  private t = 0;
  private kDay = 0;
  private fDay = 0;
  private nRef = 0;
  private dn0 = 0;
  private P = 0;
  private dnu = 0;
  private readonly giantG = Array.from({ length: RP_GIANTS }, () => [0, 0, 0, 0, 0, 0, 0, 0]);
  private readonly range: [number, number];
  private readonly psiZ: number[];

  /** tex: the flow model of the tau mirror (tauModAt); null for a positions-only instance (presets: findLargest) */
  constructor(private readonly tex: RingTexture | null, private readonly table: MoonletTable | null) {
    // giants: static parameters
    this.giants = NAMED_PROPELLERS.map((p) => {
      const h = (p.drLitKm * 1e3) / RP_GIANT_DR_PER_H;
      const dB = (p.dlLitKm * 1e3) / 2;
      const dD = p.dlUnlitKm && p.dlUnlitKm > p.dlLitKm ? (p.dlUnlitKm * 1e3) / 2 : RP_GAP_PER_LOBE * dB;
      const n = (p.nDegDay * DEG) / DAY;
      return {
        name: p.name, a: radiusForOmega(n, p.aKm * 1e3), aFit: p.aKm * 1e3, theta: 0, z: 0,
        h, dB, dD, D0: RP_D0, Z: p.hEqKm !== undefined ? p.hEqKm * 1e3 : RP_Z_PER_H * h, R: RP_R_PER_H * h, n,
      };
    });
    this.psiZ = NAMED_PROPELLERS.map((p) => u24(pcg(hashString(p.name))) * 2 * Math.PI);
    // procedural lattices
    let lo = Infinity, hi = -Infinity;
    this.lattice = PROPELLER_CLASSES.map((c, ci) => {
      const aIn = Math.min(...c.regionKm.map((r) => r[0])) * 1e3 - c.edgeKm * 1e3;
      const aOut = Math.max(...c.regionKm.map((r) => r[1])) * 1e3 + c.edgeKm * 1e3;
      const hMax = c.drHiKm * 1e3 * c.hPerDr;
      const reachR = 13.5 * hMax;
      const reachS = Math.max(6 * c.dDPerDr, 8 * c.dBPerDr) * c.drHiKm * 1e3;
      const dndaMax = K_N * omegaSlopeAbs(aIn);
      const N = Math.ceil(reachR * dndaMax * 1.02);
      const B = Math.floor(Math.log2((2 * Math.PI * aIn) / reachS));
      const cellArea = (N / (K_N * omegaSlopeAbs(aOut))) * ((2 * Math.PI * aOut) / 2 ** B);
      const pMax = c.densityKm2 * 1e-6 * cellArea;
      lo = Math.min(lo, aIn - 2 * reachR);
      hi = Math.max(hi, aOut + 2 * reachR);
      if (pMax > 0.2) console.warn(`[propellers] class ${c.id}: ${pMax.toFixed(3)} expected per cell (Bernoulli approximation)`);
      return { N, B, hMax, reachR, reachS, pMax, salt: Math.imul(ci + 1, 0x6c8e9cf5) >>> 0 };
    });
    this.range = [lo, hi];
    this.uniforms = {
      uRpCtl: { value: new Vector4(0, K_N, 0, 0) },
      uRpT: { value: new Int32Array(4) },
      uRpTF: { value: new Vector4(0, lo, hi, 0) },
      uRpG0: { value: Array.from({ length: RP_GIANTS }, () => new Vector4(1e12, 0, 1, 1)) },
      uRpG1: { value: Array.from({ length: RP_GIANTS }, () => new Vector4()) },
      uRpGiantN: { value: 0 },
      uRpC0: { value: Array.from({ length: RP_CLASSES }, () => new Vector4()) },
      uRpC1: { value: Array.from({ length: RP_CLASSES }, () => new Vector4()) },
      uRpC2: { value: Array.from({ length: RP_CLASSES }, () => new Vector4()) },
      uRpC3: { value: Array.from({ length: RP_CLASSES }, () => new Vector4()) },
      uRpCI: { value: new Int32Array(4 * RP_CLASSES) },
      uRpNearMask: { value: 0 },
    };
    PROPELLER_CLASSES.forEach((c, ci) => {
      const L = this.lattice[ci];
      this.uniforms.uRpC0.value[ci].set(c.drLoKm * 1e3, 1 - (c.drHiKm / c.drLoKm) ** -c.Q, -1 / c.Q, c.hPerDr);
      this.uniforms.uRpC1.value[ci].set(c.dBPerDr, c.dDPerDr, c.densityKm2 * 1e-6, c.zPerH);
      const r = c.regionKm.map(([a, b]) => [a * 1e3, b * 1e3]);
      this.uniforms.uRpC2.value[ci].set(r[0][0], r[0][1], r[1]?.[0] ?? 0, r[1]?.[1] ?? 0);
      this.uniforms.uRpC3.value[ci].set(r[2]?.[0] ?? 0, r[2]?.[1] ?? 0, c.edgeKm * 1e3, L.hMax);
    });
  }

  /** Per frame (after the texture's update: the flow model at the frame origin). */
  update(t: number, r0: number, phi0: number): void {
    const u = this.uniforms;
    this.t = t;
    this.r0 = r0;
    this.phi0 = phi0;
    const on = this.scale > 0;
    // ---- time split and the frame origin's phase in orbit n_ref (exact integer part)
    const days = t / DAY;
    this.kDay = Math.floor(days);
    this.fDay = days - this.kDay;
    const n0 = K_N * omegaModel(r0);
    this.nRef = Math.round(n0);
    this.dn0 = n0 - this.nRef;
    const intPart = mod2_24(this.nRef, this.kDay);
    const P = fract(phi0 / (2 * Math.PI) - intPart / 2 ** 24 - (this.nRef * this.fDay) / 2 ** 24);
    this.P = P;
    const Pu = Math.floor(P * T32);
    const fr = orbitalFrequencies(r0);
    this.dnu = Math.round(K_N * (fr.nu - fr.omega));
    u.uRpCtl.value.set(on ? 1 : 0, K_N, this.dn0, this.fDay);
    const T = u.uRpT.value;
    T[0] = this.kDay; T[1] = this.nRef; T[2] = Pu | 0; T[3] = this.dnu;
    u.uRpTF.value.x = P - Pu / T32;
    for (let ci = 0; ci < RP_CLASSES; ci++) {
      const L = this.lattice[ci];
      const I = Math.floor(this.nRef / L.N);
      const CI = u.uRpCI.value;
      CI[4 * ci] = on ? L.N : 0; CI[4 * ci + 1] = L.B; CI[4 * ci + 2] = I; CI[4 * ci + 3] = this.nRef - I * L.N;
    }
    // ---- named giants
    let ng = 0;
    for (let k = 0; k < this.giants.length; k++) {
      const g = this.giants[k], p = NAMED_PROPELLERS[k];
      let lon = p.lonDeg * DEG + g.n * (t - PROPELLER_EPOCH);
      if (p.sinusoid) lon += p.sinusoid.ampDeg * DEG * Math.sin((2 * Math.PI * (t - PROPELLER_EPOCH)) / (p.sinusoid.periodDays * DAY) + p.sinusoid.phase);
      g.theta = wrapPi(lon);
      const nu = orbitalFrequencies(g.a).nu;
      g.z = g.Z * Math.cos(this.psiZ[k] + wrapPi(nu * (t - PROPELLER_EPOCH)));
      if (!on || ng >= RP_GIANTS) continue;
      const s0 = g.a * wrapPi(phi0 - g.theta);
      const G = this.giantG[ng];
      G[0] = g.a - r0; G[1] = s0; G[2] = g.h; G[3] = g.dB; G[4] = g.D0; G[5] = g.z; G[6] = 6 * g.dD; G[7] = g.dD;
      u.uRpG0.value[ng].set(G[0], G[1], G[2], G[3]);
      u.uRpG1.value[ng].set(G[4], G[5], G[6], G[7]);
      ng++;
    }
    u.uRpGiantN.value = ng;
  }

  // ---------------------------------------------------------------- CPU mirror of the GLSL
  /** the propellers at (aL, dth) and footprint fp: [mean tau factor, variance, wake-strength factor] (rsPropellersMod) */
  tauModAt(aL: number, dth: number, fp: number, out: number[] = [1, 0, 1]): number[] {
    const acc = [1, 0, 1, 0];
    if (this.scale > 0) this.enumerate(aL, dth, fp, 0, acc);
    out[0] = acc[0];
    out[1] = acc[1];
    out[2] = acc[2];
    return out;
  }
  /** relief: [height (m), d/da', d/dS] (rsReliefPropellers). */
  reliefAt(aL: number, dth: number, out: number[] = [0, 0, 0]): number[] {
    const acc = [0, 0, 0, 0];
    if (this.scale > 0) this.enumerate(aL, dth, 0, 1, acc);
    out[0] = acc[0]; out[1] = acc[1]; out[2] = acc[2];
    return out;
  }

  private enumerate(aL: number, dth: number, fp: number, mode: number, acc: number[]): void {
    const ng = this.uniforms.uRpGiantN.value;
    for (let k = 0; k < ng; k++) {
      const G = this.giantG[k];
      const h = G[2];
      const x = aL - G[0];
      if (Math.abs(x) > 13.5 * h) continue;
      const ap = this.r0 + G[0];
      let s = G[1] + ap * dth;
      const hc = Math.PI * ap;
      if (Math.abs(s) > hc) s -= 2 * hc * Math.floor(s / (2 * hc) + 0.5);
      if (Math.abs(s) > G[6]) continue;
      if (mode === 0) combine(acc, this.structure(x, s, fp, h, G[3], G[7], G[4]));
      else addRelief(acc, rpRelief(x, s, h, G[3], G[5]));
    }
    const a = this.r0 + aL;
    if (!this.tex || !(a > this.range[0] && a < this.range[1])) return;
    const dnq = this.dn0 + K_N * this.tex.deltaOmega(aL);
    const dnda = K_N * omegaSlope(aL / this.r0, this.tex.omegaK0, this.tex.flowC, 1 / this.r0);
    for (let c = 0; c < RP_CLASSES; c++) {
      const L = this.lattice[c], C = PROPELLER_CLASSES[c];
      const cf = 1 - smooth(8 * L.hMax, 16 * L.hMax, fp);
      if (cf <= 0) continue;
      const I = Math.floor(this.nRef / L.N), R = this.nRef - I * L.N;
      const i0 = Math.floor((R + dnq) / L.N);
      for (let di = -1; di <= 1; di++) {
        const ic = i0 + di;
        const orb = this.orbit(c, I + ic);
        const dni = ic * L.N + orb.offset - R;
        const x = (dni - dnq) / dnda;
        if (Math.abs(x) > 13.5 * L.hMax) continue;
        // the query's phase in this orbit's frame (2^-32 turns) and its sub-unit remainder
        const ph = this.queryPhase(dni, dth);
        const ai = a - x;
        const arc = (2 * Math.PI * ai) / T32;
        const jq0 = Math.floor(ph.U / 2 ** (32 - L.B));
        for (let dj = -1; dj <= 1; dj++) {
          const jc = mod(jq0 + dj, 2 ** L.B);
          const p = this.cell(c, orb.hR, jc, ai, dnda);
          if (!p) continue;
          let d = mod(p.phi - ph.U, T32);
          if (d >= 2 ** 31) d -= T32;
          const s = (ph.rem - d) * arc;
          if (Math.abs(x) > 13.5 * p.h || Math.abs(s) > 6 * p.dD) continue;
          if (mode === 0) {
            const q = this.structure(x, s, fp, p.h, p.dB, p.dD, RP_D0);
            combine(acc, [1 + cf * (q[0] - 1), cf * cf * q[1], 1 + cf * (q[2] - 1)]);
          } else {
            const nz = (this.nRef + dni + this.dnu) >>> 0;
            const phz = p.psi + (Math.imul(nz, this.kDay) & 0xffffff) / 2 ** 24 + (nz * this.fDay) / 2 ** 24;
            const zm = C.zPerH * p.h * Math.cos(2 * Math.PI * fract(phz));
            addRelief(acc, rpRelief(x, s, p.h, p.dB, zm));
          }
        }
      }
    }
  }

  /** radial cell -> its orbit (hash, offset in n-units within the cell) */
  private orbit(c: number, i: number): { hR: number; offset: number } {
    const L = this.lattice[c];
    const hR = pcg((Math.imul(i | 0, 0x9e3779b1) ^ L.salt) >>> 0);
    return { hR, offset: hR % L.N };
  }
  /** the query's phase (2^-32 turns) in the frame of orbit n_ref + dni */
  private queryPhase(dni: number, dth: number): { U: number; rem: number } {
    const t1 = (Math.imul(dni | 0, this.kDay | 0) & 0xffffff) >>> 0;
    let fr = dth / (2 * Math.PI) - (dni * this.fDay) / 2 ** 24 + this.uniforms.uRpTF.value.x;
    fr -= Math.floor(fr + 0.5);
    const frs = fr * T32;
    const fi = Math.floor(frs + 0.5);
    const U = mod(this.uniforms.uRpT.value[2] + fi - t1 * 256, T32);
    return { U, rem: frs - fi };
  }
  /** the propeller of azimuthal cell jc of an orbit, if there is one */
  private cell(c: number, hR: number, jc: number, ai: number, dnda: number): { phi: number; h: number; dB: number; dD: number; psi: number; dr: number } | null {
    const L = this.lattice[c], C = PROPELLER_CLASSES[c];
    const hC = pcg((hR ^ Math.imul(jc, 0x85ebca77) ^ 0x27d4eb2f) >>> 0);
    const area = (L.N / dnda) * ((2 * Math.PI * ai) / 2 ** L.B);
    const pc = C.densityKm2 * 1e-6 * regionWeight(C, ai) * area;
    if (u24(pcg((hC ^ 0x165667b1) >>> 0)) >= pc) return null;
    const phi = jc * 2 ** (32 - L.B) + Math.floor(pcg((hC ^ 0xd3a2646c) >>> 0) / 2 ** L.B);
    const c0 = 1 - (C.drHiKm / C.drLoKm) ** -C.Q;
    const dr = C.drLoKm * 1e3 * Math.pow(1 - u24(pcg((hC ^ 0xfd7046c5) >>> 0)) * c0, -1 / C.Q);
    return { phi, h: dr * C.hPerDr, dB: dr * C.dBPerDr, dD: dr * C.dDPerDr, psi: u24(pcg((hC ^ 0xb55a4f09) >>> 0)), dr };
  }

  /** one propeller's [mean factor, variance, wake-strength factor] (rpStructure) */
  structure(x: number, s: number, fp: number, h: number, dB: number, dD: number, D0: number): number[] {
    const sf = 0.5 * fp;
    const wo = smooth(-0.5 * h, 0.5 * h, x);
    const gaz = dB / Math.sqrt(dB * dB + fp * fp);
    const lo = wo > 0 ? rpLobes(x, -s, h, dB, dD, sf, D0) : [0, 0, 0, 0];
    const li = wo < 1 ? rpLobes(-x, s, h, dB, dD, sf, D0) : [0, 0, 0, 0];
    const l = [0, 1, 2, 3].map((i) => (wo * lo[i] + (1 - wo) * li[i]) * (i % 2 === 0 ? gaz : gaz * gaz));
    let m = Math.max(1 - l[0] + l[2], 0.02);
    let v = l[1] + l[3];
    const sn = 1.5 * h + sf;
    const near = Math.exp((-0.5 * (x * x + s * s)) / (sn * sn)) * ((1.5 * h) / sn) * gaz;
    const dist = Math.min(1, Math.max(0, l[0] / Math.max(D0, 1e-3) + l[2] / Math.max(0.433 * D0, 1e-3) + near));
    const w = this.wake(x, s, h, dB);
    if (w !== 0) {
      const fw = 1 - smooth(0.3 * h, 1.5 * h, fp);
      v += (1 - fw * fw) * w * w * m * m;
      m *= Math.max(1 + fw * w, 0.02);
    }
    return [m, v, 1 - 0.9 * dist];
  }
  private readonly _k = [0, 0, 0];
  /** moonlet wakes: density factor - 1 of the Hill response at |x| >= 6 h (rpWake) */
  wake(x: number, s: number, h: number, dB: number): number {
    if (!this.table) return 0;
    const b = Math.abs(x) / h;
    const tb = smooth(5.5, 6.5, b) * (1 - smooth(10, 13, b));
    if (tb <= 0) return 0;
    const d = x >= 0 ? -s : s;
    const td = 1 - smooth(6 * dB, 8 * dB, d);
    if (td <= 0) return 0;
    const t = d / (1.5 * b * h);
    this.table.eval(0, b, t, this._k);
    const K = this._k, ib = 1 / b;
    const dxi = K[1] * ib * ib - 2 * K[0] * ib * ib * ib - K[2] * ib * ib * t * ib;
    return (1 / Math.max(1 + dxi, 0.2) - 1) * tb * td;
  }

  // ---------------------------------------------------------------- moonlets (bodies, presets, tests)
  /**
   * Moonlets around the SEF point (radius rc, longitude thc): the named giants within `maxDist` and the procedural ones
   * whose radius is at least `minAngle` (rad) seen from `maxDist`... per class within min(maxDist, R_max / minAngle).
   * Positions are now (the last update's time).
   */
  moonletsNear(rc: number, thc: number, maxDist: number, minAngle = 0, out: Moonlet[] = []): Moonlet[] {
    out.length = 0;
    if (this.scale <= 0) return out;
    for (let k = 0; k < this.giants.length; k++) {
      const g = this.giants[k];
      const dx = g.a * Math.cos(g.theta) - rc * Math.cos(thc), dy = g.a * Math.sin(g.theta) - rc * Math.sin(thc);
      if (Math.hypot(dx, dy) - g.R > maxDist) continue;
      out.push({ key: g.name, name: g.name, cls: -1, a: g.a, theta: g.theta, z: g.z, h: g.h, R: g.R, dB: g.dB, dD: g.dD, n: k, phi: 0, psi: 0, Z: g.Z });
    }
    for (let c = 0; c < RP_CLASSES; c++) {
      const Rmax = RP_R_PER_H * this.lattice[c].hMax;
      const dist = Math.min(maxDist, minAngle > 0 ? Rmax / minAngle : maxDist);
      if (dist > 0) this.scanClass(c, rc, thc, dist, dist, true, out);
    }
    return out;
  }

  /**
   * Procedural propellers of class c within radial distance distR and arc distS of the SEF point (rc, thc); `round`:
   * the horizontal distance (minus the moonlet radius) must also be within distR.
   */
  private scanClass(c: number, rc: number, thc: number, distR: number, distS: number, round: boolean, out: Moonlet[]): void {
    const L = this.lattice[c], C = PROPELLER_CLASSES[c];
    const aLo = rc - distR, aHi = rc + distR;
    if (aHi < this.range[0] || aLo > this.range[1]) return;
    const nHi = K_N * omegaModel(Math.max(aLo, 1e7)), nLo = K_N * omegaModel(aHi);
    const iLo = Math.floor(nLo / L.N), iHi = Math.floor(nHi / L.N);
    if (iHi - iLo > 4000) return;
    for (let i = iLo; i <= iHi; i++) {
      const orb = this.orbit(c, i);
      const ni = i * L.N + orb.offset;
      const ai = radiusForOmega(ni / K_N, rc);
      if (Math.abs(ai - rc) > distR) continue;
      // the point's phase in this orbit's frame -> azimuthal cells within +-distS
      const turns = this.orbitTurns(ni);
      const psiCam = fract(thc / (2 * Math.PI) - turns);
      const cells = 2 ** L.B;
      const jc0 = Math.floor(psiCam * cells);
      const m = Math.min(Math.ceil(distS / ((2 * Math.PI * ai) / cells)) + 1, cells / 2);
      const dnda = K_N * omegaSlopeAbs(ai);
      for (let dj = -m; dj <= m; dj++) {
        const jc = mod(jc0 + dj, cells);
        const p = this.cell(c, orb.hR, jc, ai, dnda);
        if (!p) continue;
        const th = wrapPi(2 * Math.PI * (p.phi / T32 + turns));
        const R = RP_R_PER_H * p.h;
        if (Math.abs(ai * wrapPi(th - thc)) > distS) continue;
        if (round && Math.hypot(ai * Math.cos(th) - rc * Math.cos(thc), ai * Math.sin(th) - rc * Math.sin(thc)) - R > distR) continue;
        const Z = C.zPerH * p.h;
        const m: Moonlet = { key: `${C.id}:${i}:${jc}`, name: `${C.id} propeller`, cls: c, a: ai, theta: th, z: 0, h: p.h, R, dB: p.dB, dD: p.dD, n: ni, phi: p.phi, psi: p.psi, Z };
        m.z = this.moonletHeight(m);
        out.push(m);
      }
    }
  }

  /** current height of a procedural moonlet (its vertical oscillation; same formula as the GLSL relief) */
  private moonletHeight(m: Moonlet): number {
    const nz = (m.n + this.dnu) >>> 0;
    const phz = m.psi + (Math.imul(nz, this.kDay) & 0xffffff) / 2 ** 24 + (nz * this.fDay) / 2 ** 24;
    return m.Z * Math.cos(2 * Math.PI * fract(phz));
  }
  /** Move a moonlet found earlier to the current time (longitude, height): cheap, for every frame. */
  refresh(m: Moonlet): void {
    if (m.cls < 0) {
      const g = this.giants[m.n];
      m.theta = g.theta;
      m.z = g.z;
      return;
    }
    m.theta = wrapPi(2 * Math.PI * (m.phi / T32 + this.orbitTurns(m.n)));
    m.z = this.moonletHeight(m);
  }
  /** turns travelled by orbit n (n-units) since J2000 at the current time, mod 1 (exact integer part) */
  private orbitTurns(n: number): number {
    return fract(mod2_24(n, this.kDay) / 2 ** 24 + (n * this.fDay) / 2 ** 24);
  }

  /**
   * Near-field allocation bounds: collect the propellers whose structure can reach within `reach` (m) of the SEF point
   * (r, th) (call once per re-fit), then boxFactor(hw) = upper bound of their tau factor within a box of half-width hw
   * around it (the near field thins its particles by tau / tauMax, so tauMax must cover the densest lobe in the box).
   */
  collectNear(r: number, th: number, reach: number): void {
    this.nearR = r;
    this.nearTh = th;
    this.nearReach = reach;
    this.nearT = this.t;
    const out: Moonlet[] = [];
    if (this.scale > 0) {
      this.giants.forEach((g, k) => {
        if (Math.abs(g.a - r) < reach + 13.5 * g.h && Math.abs(g.a * wrapPi(g.theta - th)) < reach + 6 * g.dD) {
          out.push({ key: g.name, name: g.name, cls: -1, a: g.a, theta: g.theta, z: g.z, h: g.h, R: g.R, dB: g.dB, dD: g.dD, n: k, phi: 0, psi: 0, Z: g.Z });
        }
      });
      for (let c = 0; c < RP_CLASSES; c++) this.scanClass(c, r, th, reach + this.lattice[c].reachR, reach + this.lattice[c].reachS, false, out);
    }
    this.nearList = out;
  }
  boxFactor(hw: number): number {
    let f = 1;
    for (const m of this.nearList) {
      // the box in this propeller's coordinates: x = radial offset from its orbit, s = arc from it
      const x0 = this.nearR - m.a, s0 = m.a * wrapPi(this.nearTh - m.theta);
      let fp = 1;
      for (const side of [1, -1]) {
        // |x| range of the box on this side of the moonlet's orbit, and its downstream range (outer d = -s, inner d = s)
        const lo = side > 0 ? x0 - hw : -(x0 + hw), hi = side > 0 ? x0 + hw : -(x0 - hw);
        if (hi <= 0) continue;
        const xLo = Math.max(lo, 0), xHi = hi;
        const dl = side > 0 ? -s0 - hw : s0 - hw, dh = side > 0 ? -s0 + hw : s0 + hw;
        // density-enhanced lobes: |x| in [3h, 6.5h], downstream 0 .. 6 dD
        if (xHi > 3 * m.h && xLo < 6.5 * m.h && dh > 0 && dl < 6 * m.dD) fp = Math.max(fp, RP_LOBE_MAX);
        // moonlet wakes: |x| in [5.5h, 13h], downstream 0 .. 8 dB
        if (xHi > 5.5 * m.h && xLo < 13 * m.h && dh > 0 && dl < 8 * m.dB) fp = Math.max(fp, RP_LOBE_MAX * this.wakeMax(m.dB / m.h));
      }
      f = Math.max(f, fp);
    }
    return f;
  }
  /** largest moonlet-wake density factor for wakes truncated after 8 dB (dB in Hill radii), from the Hill table */
  wakeMax(dBh: number): number {
    const key = Math.round(dBh * 4) / 4;
    let v = this.wakeMaxCache.get(key);
    if (v === undefined) {
      v = 1;
      if (this.table) {
        for (let b = 5.6; b <= 13; b += 0.2) {
          for (let d = 0; d <= 8 * key; d += 0.25) v = Math.max(v, 1 + this.wake(b, -d, 1, key));
        }
      }
      this.wakeMaxCache.set(key, v);
    }
    return v;
  }
  private readonly wakeMaxCache = new Map<number, number>();
  private nearR = 0;
  private nearTh = 0;
  private nearReach = 0;
  private nearT = 0;
  private nearList: Moonlet[] = [];
  /** tests: a fixed near-field class mask (-1 = enumerate for every class) instead of nearClassMask's */
  nearMaskOverride: number | null = null;

  /**
   * Near-field cost gate (per frame): bit k set when a propeller's structure (13.5 r_H radially, 6 dD along the orbit)
   * may reach the guiding centres of size class k -- within 2.5 box half-sizes (epicycles) + `margin` of the camera's
   * Lagrangian radius r and SEF azimuth th. nearUpdate.glsl enumerates the propellers only for those classes; outside
   * every reach their factor is exactly 1, so the mask changes no result. Uses the collectNear list; conservative (bit
   * set) where the camera has moved so far that the list may be incomplete.
   */
  nearClassMask(r: number, th: number, boxes: ArrayLike<number>, margin: number): number {
    if (this.nearMaskOverride !== null) return this.nearMaskOverride;
    if (this.scale <= 0) return 0;
    // the camera's displacement from the collection point, in the frame co-moving with the material at r
    const dt = this.t - this.nearT;
    const moved = Math.hypot(r - this.nearR, r * wrapPi(th - this.nearTh - omegaModel(r) * dt));
    const nk = Math.min(boxes.length, 31);
    const hw: number[] = [];
    let mask = 0, open = 0;
    for (let k = 0; k < nk; k++) {
      hw.push(boxes[k] > 0 ? 2.5 * boxes[k] + margin : -1);
      if (hw[k] < 0) continue;
      open |= 1 << k;
      if (moved + hw[k] > this.nearReach) mask |= 1 << k;   // the list may be incomplete there: conservative
    }
    for (const m of this.nearList) {
      if ((mask & open) === open) break;
      // the moonlet now (its own Keplerian rate since the collection)
      const dr = Math.abs(r - m.a), ds = Math.abs(m.a * wrapPi(th - m.theta - omegaModel(m.a) * dt));
      for (let k = 0; k < nk; k++) {
        if (hw[k] >= 0 && dr < hw[k] + 13.5 * m.h && ds < hw[k] + 6 * m.dD) mask |= 1 << k;
      }
    }
    return mask;
  }

  /**
   * The largest procedural propeller of classes >= minClass within radial distance distR and arc distS of the SEF
   * point (r, th), at the last update's time (presets: a belt propeller to fly to).
   */
  findLargest(r: number, th: number, distR: number, distS: number, minClass = 2): Moonlet | null {
    let best: Moonlet | null = null;
    for (let c = minClass; c < RP_CLASSES; c++) {
      if (PROPELLER_CLASSES[c].id === 'trans-encke') continue;
      const out: Moonlet[] = [];
      this.scanClass(c, r, th, distR, distS, false, out);
      for (const m of out) if (!best || m.h > best.h) best = m;
    }
    return best;
  }

  /** the state of a named giant (positions at the last update) */
  giant(name: string): GiantState | undefined {
    const k = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return this.giants.find((g) => g.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') === k);
  }
}

/**
 * Upper bound of the density-enhanced lobes' factor: max over d of 1 + D0 L_D(d / dD) 0.7 / (0.6 (1 + d / dB)) with
 * dD = 2.4 dB: 1 + 0.6 x 0.433 = 1.26 (rounded up)
 */
export const RP_LOBE_MAX = 1.27;

let positionsOnly: PropellerSystem | null = null;
/** A positions-only propeller system at time t (s TDB): named giants and the procedural populations (presets). */
export function propellersAt(t: number): PropellerSystem {
  if (!positionsOnly) positionsOnly = new PropellerSystem(null, null);
  positionsOnly.update(t, 1.3e8, 0);
  return positionsOnly;
}

// ------------------------------------------------------------------ shared pieces (same as the GLSL)
function rpGauss(y: number, sg: number, sf: number): [number, number] {
  const s1 = sg * sg + sf * sf, s2 = sg * sg + 2 * sf * sf;
  return [(sg / Math.sqrt(s1)) * Math.exp((-0.5 * y * y) / s1), (sg / Math.sqrt(s2)) * Math.exp((-y * y) / s2)];
}
function rpLD(u: number): number {
  return u > 0 ? u * Math.exp(1 - u) * (1 - smooth(4.5, 6, u)) : 0;
}
function rpLobes(y: number, d: number, h: number, dB: number, dD: number, sf: number, D0: number): number[] {
  const L = D0 * rpLD(d / dD);
  if (L <= 0) return [0, 0, 0, 0];
  const gd = rpGauss(y - 2 * h, 0.7 * h, sf);
  const sB = 0.6 * h * (1 + Math.max(d, 0) / dB);
  const E = (L * 0.7 * h) / sB;
  const gb = rpGauss(y - 4.5 * h, sB, sf);
  return [L * gd[0], L * L * Math.max(gd[1] - gd[0] * gd[0], 0), E * gb[0], E * E * Math.max(gb[1] - gb[0] * gb[0], 0)];
}
export function rpRelief(x: number, s: number, h: number, dB: number, zm: number): number[] {
  if (zm === 0) return [0, 0, 0];
  const sr = 2.5 * h;
  const G = Math.exp((-0.5 * x * x) / (sr * sr));
  const wo = smooth(-0.5 * h, 0.5 * h, x);
  const dwo = Math.abs(x) < 0.5 * h ? (6 * (x / h + 0.5) * (0.5 - x / h)) / h : 0;
  const dO = -s, dI = s;
  const LO = dO >= 0 ? Math.exp(-dO / dB) : Math.exp(dO / (2 * h));
  const LI = dI >= 0 ? Math.exp(-dI / dB) : Math.exp(dI / (2 * h));
  const LOd = dO >= 0 ? -LO / dB : LO / (2 * h);
  const LId = dI >= 0 ? -LI / dB : LI / (2 * h);
  const Lz = wo * LO + (1 - wo) * LI;
  return [zm * G * Lz, zm * ((-x / (sr * sr)) * G * Lz + G * dwo * (LO - LI)), zm * G * (-wo * LOd + (1 - wo) * LId)];
}
function combine(acc: number[], p: number[]): void {
  acc[1] = acc[1] * p[0] * p[0] + p[1] * acc[0] * acc[0] + acc[1] * p[1];
  acc[0] *= p[0];
  acc[2] = Math.min(acc[2], p[2]);
}
function addRelief(acc: number[], r: number[]): void {
  acc[0] += r[0]; acc[1] += r[1]; acc[2] += r[2];
}
function regionWeight(C: PropellerClass, a: number): number {
  const e = Math.max(C.edgeKm * 1e3, 1);
  let w = 0;
  for (const [lo, hi] of C.regionKm) w += smooth(lo * 1e3 - e, lo * 1e3 + e, a) * (1 - smooth(hi * 1e3 - e, hi * 1e3 + e, a));
  return Math.min(w, 1);
}
/** |dOmega/da| of the flow model at radius a (rad/s/m) */
function omegaSlopeAbs(a: number): number {
  const h = a * 1e-5;
  return Math.abs(omegaModel(a + h) - omegaModel(a - h)) / (2 * h);
}
/** the radius whose flow-model angular velocity is omega (Newton from a0) */
export function radiusForOmega(omega: number, a0: number): number {
  let a = a0;
  for (let i = 0; i < 30; i++) {
    const f = omegaModel(a) - omega;
    const d = (omegaModel(a * (1 + 1e-7)) - omegaModel(a * (1 - 1e-7))) / (2e-7 * a);
    const da = f / d;
    a -= da;
    if (Math.abs(da) < 1e-6) break;
  }
  return a;
}
/** (n k) mod 2^24 for non-negative integers (exact) */
function mod2_24(n: number, k: number): number {
  return (Math.imul(n | 0, k | 0) & 0xffffff) >>> 0;
}
const fract = (x: number) => x - Math.floor(x);
const mod = (x: number, m: number) => x - m * Math.floor(x / m);
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
