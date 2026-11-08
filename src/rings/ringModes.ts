// Normal modes of eccentric ring edges for the 2-D ring structure (sv_ringStructure, src/rings/streamlines.ts):
// a sharp edge whose streamlines are r = a' - sum_k A_k g_k(a') cos(m_k (theta - varpi_k(t))), varpi_k(t) =
// varpi0_k + OmegaP_k (t - t0) (varpi = longitude of a radial MINIMUM). Self-contained (no imports) so Node scripts
// can use it. Used by RingProfile (de-projection of the 2005 snapshot), RingStructure (uniforms, CPU mirror) and
// the GLSL (rsModes in ringStructure.glsl).
//
// Radial profile of each mode, u = distance into the material from the edge streamline (u < 0: gap side):
//   material side  g = exp(-u / L_k), tapered to 0 over the last quarter of `reach`;
//   gap side       g = max(0, 1 + u / G): the displacement ramps linearly to 0 across the gap (keeps r(a') monotonic;
//                  the gap holds no material of the feature).
// Decay lengths. Spitale & Porco (2010) give the free modes' cavities (m = 1: 253 km from its ILR to the edge, free
// m = 2: 30 km, m = 3: 24 km; all nodeless) and a 60-90 km half-width of the Mimas resonance zone for the forced m = 2.
// A kinematic streamline edge with those widths would cross streamlines (free m = 2: 37 km amplitude over 30 km), which
// a real ring prevents nonlinearly; L_k = max(cavity, 5 A_k) keeps each mode's |dxi/da'| <= 0.2 (all four together
// <= 0.68, J <= 3.1 when their phases align). The interior radial structure is therefore schematic; the edge position
// (what images and occultations measure) is the fitted one.

export interface EdgeMode {
  label: string;
  m: number;
  /** a e (m) */
  amp: number;
  /** longitude of a radial minimum at the epoch (rad, SEF = inertial J2000 ring longitude) */
  varpi0: number;
  /** pattern speed (rad/s) */
  omegaP: number;
  /** decay length into the material (m) */
  decay: number;
}

export interface EdgeFeature {
  id: string;
  name: string;
  /** mean (Lagrangian) radius of the edge streamline (m) */
  aEdge: number;
  /** -1: the material lies inward of the edge (the outer edge of a ring); +1: outward (an inner edge) */
  material: -1 | 1;
  /** gap side: the displacement ramps to 0 over this length (m) */
  gap: number;
  /** material side: the displacement is tapered to 0 at this distance from the edge (m) */
  reach: number;
  /** epoch of varpi0 (s TDB past J2000) */
  epoch: number;
  modes: EdgeMode[];
  /**
   * The radial profile (public/data/rings/tau_main, RSS Rev 7 egress 2005-123) caught this edge displaced: its
   * longitude, time and the edge radius there. RingProfile de-projects the profile around the feature to the mean
   * (Lagrangian) radii with the feature's own displacement field at that instant, scaled to the measured offset.
   */
  snapshot: { lon: number; t: number; edge: number };
  source: string;
}

const DEG = Math.PI / 180;
const DAY = 86_400;
/** JED -> s TDB past J2000 */
const jed = (jd: number) => (jd - 2_451_545.0) * DAY;

export const EDGE_FEATURES: EdgeFeature[] = [
  {
    id: 'b-ring-edge',
    name: 'B-ring outer edge',
    aEdge: 117_568e3,
    material: -1,
    gap: 238e3, // to the Huygens ringlet's inner edge (mean 117,806 km)
    reach: 1000e3,
    epoch: jed(2_454_256.9),
    // Spitale & Porco 2010, AJ 140, 1747, Table 2: a0 = 117,568(4) km, RMS 7.9 km, Cassini ISS, central epoch 2007-06-09
    // (m, e, varpi0, OmegaP): (1, 1.78e-4, 73 deg, 5.098 deg/d) free; (2, 2.94e-4, 7.2, 381.9835 = Mimas' mean motion)
    // forced by the Mimas 2:1 ILR (lags Mimas by 2.9 deg); (2, 3.17e-4, 123.1, 382.0731) free; (3, 1.00e-4, 23.8,
    // 507.700) free. r = a0 [1 - e cos(m (lambda - varpi))], varpi the longitude of a radial minimum.
    modes: [
      { label: 'm=1 free', m: 1, amp: 1.78e-4 * 117_568e3, varpi0: 73 * DEG, omegaP: (5.098 * DEG) / DAY, decay: Math.max(253e3, 5 * 1.78e-4 * 117_568e3) },
      { label: 'm=2 forced (Mimas 2:1)', m: 2, amp: 2.94e-4 * 117_568e3, varpi0: 7.2 * DEG, omegaP: (381.9835 * DEG) / DAY, decay: Math.max(75e3, 5 * 2.94e-4 * 117_568e3) },
      { label: 'm=2 free', m: 2, amp: 3.17e-4 * 117_568e3, varpi0: 123.1 * DEG, omegaP: (382.0731 * DEG) / DAY, decay: Math.max(30e3, 5 * 3.17e-4 * 117_568e3) },
      { label: 'm=3 free', m: 3, amp: 1.0e-4 * 117_568e3, varpi0: 23.8 * DEG, omegaP: (507.7 * DEG) / DAY, decay: Math.max(24e3, 5 * 1.0e-4 * 117_568e3) },
    ],
    // RSS_2005_123_X43_E_TAU_01KM.TAB at the edge: ring longitude 60.317 deg, ring event time 2005-123T08:09:48.7 UTC
    // (= 168,379,853 s TDB past J2000; no leap second 2000-2005), edge (half-level) at 117,649.2 km (pole- and
    // timing-corrected radius, as tau_main)
    snapshot: { lon: 60.317 * DEG, t: 168_379_853, edge: 117_649.2e3 },
    source: 'Spitale & Porco 2010 (AJ 140, 1747) Table 2; RSS Rev 7 egress geometry (CORSS_8001)',
  },
];

/** Radial profile g(u) and dg/du of a mode (u = distance into the material, < 0 on the gap side). */
export function modeProfile(f: EdgeFeature, mode: EdgeMode, u: number, out: number[]): void {
  if (u < 0) {
    const g = 1 + u / f.gap;
    out[0] = g > 0 ? g : 0;
    out[1] = g > 0 ? 1 / f.gap : 0;
    return;
  }
  const e = Math.exp(-u / mode.decay);
  const t0 = 0.75 * f.reach;
  let tp = 1, dtp = 0;
  if (u > t0) {
    const x = Math.min(1, (u - t0) / (f.reach - t0));
    tp = 1 - x * x * (3 - 2 * x);
    dtp = x < 1 ? (-6 * x * (1 - x)) / (f.reach - t0) : 0;
  }
  out[0] = e * tp;
  out[1] = -e * tp / mode.decay + e * dtp;
}

const _g = [0, 0];
/**
 * Displacement of a feature at Lagrangian radius aP (m), SEF azimuth theta (rad), time t (s TDB):
 * o = [xi, dxi/da', dxi/dS] (S = arc length).
 */
export function featureDisplacement(f: EdgeFeature, aP: number, theta: number, t: number, o: number[]): void {
  o[0] = o[1] = o[2] = 0;
  const u = f.material * (aP - f.aEdge);
  if (u < -f.gap || u > f.reach) return;
  for (const md of f.modes) {
    modeProfile(f, md, u, _g);
    const psi = md.m * (theta - md.varpi0 - md.omegaP * (t - f.epoch));
    const c = Math.cos(psi), s = Math.sin(psi);
    o[0] += -md.amp * _g[0] * c;
    o[1] += -md.amp * _g[1] * f.material * c;
    o[2] += (md.amp * _g[0] * md.m * s) / aP;
  }
}

/**
 * De-projection of the snapshot profile around a feature: the displacement of the Lagrangian radius aP at the snapshot,
 * the feature's own field scaled so that the edge streamline lands on the measured snapshot edge.
 * Returns [xi_s, dxi_s/da'] (m, -).
 */
export function snapshotDisplacement(f: EdgeFeature, aP: number, out: number[]): void {
  const e = [0, 0, 0];
  featureDisplacement(f, f.aEdge, f.snapshot.lon, f.snapshot.t, e);
  const scale = Math.abs(e[0]) > 1 ? (f.snapshot.edge - f.aEdge) / e[0] : 1;
  featureDisplacement(f, aP, f.snapshot.lon, f.snapshot.t, e);
  out[0] = scale * e[0];
  out[1] = scale * e[1];
}
