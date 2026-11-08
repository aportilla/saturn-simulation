// Streamline model of the main rings' 2-D structure: CPU mirror of src/render/shaders/ringStructure.glsl
// (sv_ringStructure). Self-contained (no imports) so Node scripts (scripts/test/edges.mjs, scripts/data/rings/*) can
// import it directly; RingStructure.ts wraps it with the loader, the GPU uniforms and the per-frame update.
//
// Material is labelled by its Lagrangian (unperturbed streamline) radius a'. At azimuth theta and time t the
// streamline sits at r = a' + xi(a', theta, t) and at height zeta(a', theta, t). The Eulerian optical depth is
//   tau(r, theta) = tau0(a') * J * M,    J = 1 / (dr/da')   (surface-density conservation: streamline crowding)
// with tau0 the radial profile and M a multiplicative 2-D modulation (hook, 1 for now). a'(r, theta) is found by
// Newton iteration from a' = r. A gap is empty by construction: no material streamline maps into it.
//
// Sources of xi / zeta (summed):
//   * moonlets in gaps (Pan, Daphnis): the universal Hill-problem response (scripts/data/rings/moonlet_response.mjs)
//     at b = |a' - a_moon(t_conj)| / r_H and the Hill time since conjunction t = s / (1.5 b r_H), s the downstream arc
//     from the moonlet; xi = sign * r_H * K(b, t) / b^2, zeta = [Z cos(psi_c) Wc(b, t) - Z sin(psi_c) Ws(b, t)] / b^3,
//     psi_c = the moonlet's vertical phase at the particle's conjunction, a_moon(t_conj) its radius then (its own
//     epicycle).
//   * normal modes of eccentric edges (src/rings/ringModes.ts, added by RingStructure.evalAt);
//   * (hooks for later work packages: relief = mid-plane height and slope, tauMod = 2-D optical-depth modulation.)
// Precision: all inputs are offsets (m) from the ring-frame origin r0 / the moonlet, so the float32 GPU version
// stays precise near the camera.

/** Header of public/data/rings/moonlet_response.json (see scripts/data/rings/moonlet_response.mjs). */
export interface MoonletTableMeta {
  bLo: number;
  bHi: number;
  nb: number;
  t0: number;
  t1: number;
  dt: number;
  nt: number;
  envelope: { dampingWavelengths: number; crossingCap: number; jFloor: number };
  moonlets: { id: number; name: string; gmKm3s2: number; aKm: number; rHillKm: number }[];
}

/** Inner limit (Hill radii) of the table's use: closer to the moonlet (inside the gap) xi is interpolated linearly
 *  between the two sides, which keeps r(a') monotonic (the gap edges are at b >= 3.3). */
export const B_IN = 3.0;

/** Per-moonlet state for one frame (all lengths in m). */
export interface MoonletParams {
  /** guiding-centre radius minus the ring-frame origin radius r0 */
  agMinusR0: number;
  /** arc coordinate (m, prograde) of the ring-frame origin relative to the moonlet: a_g * wrap(phi0 - theta_m) */
  s0: number;
  /** Hill radius */
  rH: number;
  /** amplitude multiplier (edgeWaveScale; 0 = off) */
  amp: number;
  /** the moonlet's radial offset from its guiding centre now, and its radial velocity / kappa */
  xEpi: number;
  xEpiDot: number;
  /** Z cos(psi), Z sin(psi): the moonlet's vertical oscillation z_m = Z cos(nu t + psi) now */
  zCos: number;
  zSin: number;
  /** guiding-centre radius (arc length scale) */
  ag: number;
}

export interface StreamPoint {
  /** a' - r (m): add to the Eulerian radius offset to get the Lagrangian one */
  da: number;
  /** surface-density factor 1 / max(dr/da', jFloor) */
  J: number;
  /** dr/da' (unclamped) */
  drda: number;
  /** multiplicative 2-D optical-depth modulation (hook) */
  tauMod: number;
  /** mid-plane height of the material (m) */
  zeta: number;
  /** d zeta / dr, d zeta / (r dtheta) (Eulerian) */
  slopeR: number;
  slopeT: number;
}

export function wrapPi(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

/** The universal moonlet response table with bicubic Hermite evaluation (identical to rsTab in the GLSL). */
export class MoonletTable {
  readonly meta: MoonletTableMeta;
  readonly data: Float32Array;
  readonly dlnb: number;
  constructor(meta: MoonletTableMeta, data: Float32Array) {
    if (data.length !== 3 * meta.nb * meta.nt * 4) throw new Error(`moonlet table size ${data.length} != 3 x ${meta.nb} x ${meta.nt} x 4`);
    this.meta = meta;
    this.data = data;
    this.dlnb = Math.log(meta.bHi / meta.bLo) / (meta.nb - 1);
  }

  /**
   * Group g (0: K, 1: Wc, 2: Ws) at (b, t): out = [F, dF/db, dF/dt]. Zero outside the time range (the table is
   * tapered to 0 at both ends) and beyond bHi; b is clamped to bLo (the caller never asks inside B_IN).
   */
  eval(g: number, b: number, t: number, out: number[]): void {
    const m = this.meta;
    out[0] = out[1] = out[2] = 0;
    const ft = (t - m.t0) / m.dt;
    if (!(ft >= 0 && ft < m.nt - 1) || !(b < m.bHi)) return;
    const bb = Math.max(b, m.bLo);
    const fi = Math.min(Math.log(bb / m.bLo) / this.dlnb, m.nb - 1 - 1e-6);
    const i = Math.floor(fi);
    const b0 = m.bLo * Math.exp(i * this.dlnb);
    const hb = b0 * (Math.exp(this.dlnb) - 1);
    const u = (bb - b0) / hb;
    const j = Math.floor(ft);
    const v = ft - j;
    const ht = m.dt;
    const d = this.data;
    const row = (ii: number) => ((g * m.nb + ii) * m.nt + j) * 4;
    // t-direction Hermite basis (values, d/dt)
    const v2 = v * v, v3 = v2 * v;
    const hv0 = 2 * v3 - 3 * v2 + 1, hv1 = -2 * v3 + 3 * v2, gv0 = (v3 - 2 * v2 + v) * ht, gv1 = (v3 - v2) * ht;
    const dv0 = (6 * v2 - 6 * v) / ht, dv1 = (-6 * v2 + 6 * v) / ht, ev0 = 3 * v2 - 4 * v + 1, ev1 = 3 * v2 - 2 * v;
    const f = [0, 0], fb = [0, 0], ft_ = [0, 0], fbt = [0, 0];
    for (let a = 0; a < 2; a++) {
      const p = row(i + a), q = p + 4;
      // node (F, Ft, Fb, Fbt) at (i+a, j) = d[p..p+3], (i+a, j+1) = d[q..q+3]
      f[a] = hv0 * d[p] + hv1 * d[q] + gv0 * d[p + 1] + gv1 * d[q + 1];
      fb[a] = hv0 * d[p + 2] + hv1 * d[q + 2] + gv0 * d[p + 3] + gv1 * d[q + 3];
      ft_[a] = dv0 * d[p] + dv1 * d[q] + ev0 * d[p + 1] + ev1 * d[q + 1];
      fbt[a] = dv0 * d[p + 2] + dv1 * d[q + 2] + ev0 * d[p + 3] + ev1 * d[q + 3];
    }
    const u2 = u * u, u3 = u2 * u;
    const hu0 = 2 * u3 - 3 * u2 + 1, hu1 = -2 * u3 + 3 * u2, gu0 = (u3 - 2 * u2 + u) * hb, gu1 = (u3 - u2) * hb;
    const du0 = (6 * u2 - 6 * u) / hb, du1 = (-6 * u2 + 6 * u) / hb, eu0 = 3 * u2 - 4 * u + 1, eu1 = 3 * u2 - 2 * u;
    out[0] = hu0 * f[0] + hu1 * f[1] + gu0 * fb[0] + gu1 * fb[1];
    out[1] = b < m.bLo ? 0 : du0 * f[0] + du1 * f[1] + eu0 * fb[0] + eu1 * fb[1];
    out[2] = hu0 * ft_[0] + hu1 * ft_[1] + gu0 * fbt[0] + gu1 * fbt[1];
  }
}

const _k = [0, 0, 0], _wc = [0, 0, 0], _ws = [0, 0, 0];

/** One side (sgn = +1 outer, -1 inner) of a moonlet at guiding-centre offset bg (Hill radii, >= B_IN). */
function moonletSide(
  T: MoonletTable, p: MoonletParams, sgn: number, bg: number, S: number, wantZ: boolean, o: number[],
): void {
  const rH = p.rH;
  const sd = -sgn * S;
  const t = sd / (1.5 * bg * rH);
  const ct = Math.cos(t), st = Math.sin(t);
  const dm = p.xEpi * ct - p.xEpiDot * st;
  const dmdt = -p.xEpi * st - p.xEpiDot * ct;
  let b = bg - (sgn * dm) / rH;
  const clamped = b < T.meta.bLo;
  if (clamped) b = T.meta.bLo;
  // derivatives of (b, t) w.r.t. a' (at fixed S) and S (at fixed a')
  const dtda = (-t * sgn) / (bg * rH);
  const dtdS = -sgn / (1.5 * bg * rH);
  const dbda = clamped ? 0 : sgn / rH - (sgn * dmdt * dtda) / rH;
  const dbdS = clamped ? 0 : -(sgn * dmdt * dtdS) / rH;
  T.eval(0, b, t, _k);
  const ib = 1 / b;
  const xiH = _k[0] * ib * ib;
  const xib = _k[1] * ib * ib - 2 * _k[0] * ib * ib * ib;
  const xit = _k[2] * ib * ib;
  const s = sgn * rH * p.amp;
  o[0] = s * xiH;                                   // xi
  o[1] = s * (xib * dbda + xit * dtda);             // dxi/da'
  o[2] = s * (xib * dbdS + xit * dtdS);             // dxi/dS
  if (!wantZ) { o[3] = o[4] = o[5] = 0; return; }
  T.eval(1, b, t, _wc);
  T.eval(2, b, t, _ws);
  // moonlet vertical phase at the particle's conjunction: psi_c = psi_now - t
  const zc = p.zCos * ct + p.zSin * st, zs = p.zSin * ct - p.zCos * st;
  const ib3 = ib * ib * ib;
  const z = (zc * _wc[0] - zs * _ws[0]) * ib3;
  const zt = (zs * _wc[0] + zc * _wc[2] + zc * _ws[0] - zs * _ws[2]) * ib3;
  const zb = (zc * _wc[1] - zs * _ws[1]) * ib3 - (3 * z) / b;
  o[3] = p.amp * z;
  o[4] = p.amp * (zb * dbda + zt * dtda);            // dzeta/da'
  o[5] = p.amp * (zb * dbdS + zt * dtdS);            // dzeta/dS
}

const _o1 = [0, 0, 0, 0, 0, 0], _o2 = [0, 0, 0, 0, 0, 0];

/**
 * Displacement of moonlet p at Lagrangian offset dag = a' - a_g (m) and arc S (m, prograde from the moonlet):
 * o = [xi, dxi/da', dxi/dS, zeta, dzeta/da', dzeta/dS]. Zero beyond bHi; linear across the gap inside B_IN.
 */
export function moonletDisplacement(T: MoonletTable, p: MoonletParams, dag: number, S: number, wantZ: boolean, o: number[]): void {
  for (let i = 0; i < 6; i++) o[i] = 0;
  if (!(p.amp !== 0) || !(p.rH > 0)) return;
  const bg = Math.abs(dag) / p.rH;
  if (bg >= T.meta.bHi) return;
  if (bg >= B_IN) {
    moonletSide(T, p, dag >= 0 ? 1 : -1, bg, S, wantZ, o);
    return;
  }
  moonletSide(T, p, 1, B_IN, S, wantZ, _o1);
  moonletSide(T, p, -1, B_IN, S, wantZ, _o2);
  const w = (dag / (B_IN * p.rH) + 1) * 0.5;
  for (const [k, kd] of [[0, 1], [3, 4]] as const) {
    o[k] = _o2[k] + (_o1[k] - _o2[k]) * w;
    o[kd] = (_o1[k] - _o2[k]) / (2 * B_IN * p.rH);
  }
  o[2] = _o2[2] + (_o1[2] - _o2[2]) * w;
  o[5] = _o2[5] + (_o1[5] - _o2[5]) * w;
}

/** Footprint fade of a moonlet's displacement field: sub-pixel waves are not resolved (prefiltering). */
export function moonletFootprintFade(rH: number, fp: number): number {
  const x = Math.min(1, Math.max(0, (fp - 0.3 * rH) / (1.2 * rH)));
  return 1 - x * x * (3 - 2 * x);
}

/** All structure sources at one Lagrangian point: o = [xi, dxi/da', dxi/dS, zeta, dzeta/da', dzeta/dS]. */
export type StructureEval = (aL: number, dth: number, fp: number, wantZ: boolean, o: number[]) => void;

/** Number of Newton iterations of the inversion r -> a' (shader: RS_NEWTON). */
export const NEWTON_ITERATIONS = 4;
/** Floor of dr/da' inside the Newton step (robustness near streamline crowding). */
const NEWTON_FLOOR = 0.2;

const _e = [0, 0, 0, 0, 0, 0];
/**
 * Invert the streamline map at the Eulerian point (dr = r - r0, dth = azimuth offset from the ring-frame origin):
 * Lagrangian offset, density factor, height. `evalAt(aL, dth, fp, wantZ, o)` sums all sources at Lagrangian offset
 * aL = a' - r0.
 */
export function invertStreamlines(evalAt: StructureEval, dr: number, dth: number, fp: number, jFloor: number, wantZ: boolean, out: StreamPoint): StreamPoint {
  let x = dr;
  for (let it = 0; it < NEWTON_ITERATIONS; it++) {
    evalAt(x, dth, fp, false, _e);
    const f = x + _e[0] - dr;
    x -= f / Math.max(1 + _e[1], NEWTON_FLOOR);
  }
  evalAt(x, dth, fp, wantZ, _e);
  const drda = 1 + _e[1];
  const J = 1 / Math.max(drda, jFloor);
  out.da = x - dr;
  out.drda = drda;
  out.J = J;
  out.tauMod = 1;
  out.zeta = _e[3];
  // Eulerian slopes: d/dr = J d/da'; d/dS at fixed r = d/dS|a' - (dxi/dS) J d/da'
  out.slopeR = _e[4] * J;
  out.slopeT = _e[5] - _e[2] * J * _e[4];
  return out;
}
