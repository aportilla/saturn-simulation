// Moon orbit model: mean elements (precessing ellipse + libration series) + fitted residual table.
// Runtime mirror of scripts/data/moons/model.mjs (the build-side reference implementation used to fit the
// parameters to JPL Horizons); keep the two numerically identical. Format: docs/data-sources.md.
//
// tau = days since EPOCH_JD (2025-01-01T00:00 TDB); angles rad; lengths km; output km, km/s.
//   lambda(tau) = lambda0 + n*tau + sum_j sum_m [cl cos(m nu_j tau) + sl sin(m nu_j tau)] + dLambda(tau)
//   a(tau)      = a + sum [ca cos + sa sin] + dA(tau)
//   (k, h)      = rot(k0 + sum[ck cos + sk sin], h0 + sum[ch cos + sh sin]; pidot*tau) + (dK, dH)(tau)
//   (q, p)      = rot(q0, p0; Omdot*tau) + (dQ, dP)(tau)
//   k + i h = e exp(i varpi), q + i p = tan(i/2) exp(i Omega) in the moon's reference frame R (ref -> SEF).
//   Residual tables (4-point Lagrange on a uniform grid, faded out by a smoothstep over `taper` days at both
//   ends so the model reverts continuously to the mean elements outside the fitted span):
//     kind 'elements':  (dLambda, dA, dK, dH, dQ, dP) added to the elements
//     kind 'cartesian': (dx, dy, dz) km added to the SEF position
//   Velocity: central difference of the full model (+-2 s), exactly consistent with the positions.

export const EPOCH_JD = 2460676.5;
export const J2000_JD = 2451545.0;
/** EPOCH_JD - J2000 in days */
export const EPOCH_FROM_J2000_DAYS = EPOCH_JD - J2000_JD;
const TWO_PI = Math.PI * 2;
const DAY = 86400;
const VEL_DT = 2 / DAY;

export interface OrbitLibTermJson {
  nu: number;
  cl: number[]; sl: number[];
  ca?: number[]; sa?: number[];
  ck?: number[]; sk?: number[]; ch?: number[]; sh?: number[];
}
export interface OrbitTableJson {
  kind: 'elements' | 'cartesian';
  /** which shared table file holds the values: int16 (value = int16 * scale[field]) or float32 */
  store: 'i16' | 'f32';
  startJd: number; step: number; count: number; taper: number;
  /** element offset of this table in its shared table file */
  offset: number;
  /** per-field dequantisation scale (1 for float32) */
  scale: number[];
}
export interface OrbitTables {
  i16: Int16Array | null;
  f32: Float32Array | null;
}
export interface OrbitJson {
  /** reference frame -> SEF, row-major 3x3 */
  R: number[];
  a: number; n: number; lambda0: number;
  k0: number; h0: number; pidot: number;
  q0: number; p0: number; Omdot: number;
  lib: OrbitLibTermJson[];
  table: OrbitTableJson | null;
}

/** Output of OrbitModel.evaluate (all SEF). */
export class OrbitSample {
  /** position km */
  x = 0; y = 0; z = 0;
  /** velocity km/s */
  vx = 0; vy = 0; vz = 0;
  /** unit vector from Saturn toward the moon's MEAN position (mean longitude in the orbit plane) */
  ux = 1; uy = 0; uz = 0;
  /** unit orbit normal */
  wx = 0; wy = 0; wz = 1;
  /** mean anomaly (rad) and eccentricity */
  M = 0; e = 0;
}

function smoothstep(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

interface LibCompiled {
  nu: number; M: number;
  cl: Float64Array; sl: Float64Array;
  ca: Float64Array | null; sa: Float64Array | null;
  ck: Float64Array | null; sk: Float64Array | null; ch: Float64Array | null; sh: Float64Array | null;
}

export class OrbitModel {
  private readonly R: Float64Array;
  private readonly a: number; private readonly n: number; private readonly lambda0: number;
  private readonly k0: number; private readonly h0: number; private readonly pidot: number;
  private readonly q0: number; private readonly p0: number; private readonly Omdot: number;
  private readonly lib: LibCompiled[];
  private readonly tb: Int16Array | Float32Array | null;
  private readonly tbCart: boolean;
  private readonly tbOff: number;
  private readonly tbCount: number;
  private readonly tbStep: number;
  /** table start, in tau days */
  private readonly tbStart: number;
  private readonly tbTaper: number;
  private readonly sc: Float64Array;
  // scratch outputs of position()
  private px = 0; private py = 0; private pz = 0;
  private ux = 0; private uy = 0; private uz = 0;
  private wx = 0; private wy = 0; private wz = 0;
  private mAnom = 0; private ecc = 0;

  constructor(p: OrbitJson, tables: OrbitTables) {
    this.R = Float64Array.from(p.R);
    this.a = p.a; this.n = p.n; this.lambda0 = p.lambda0;
    this.k0 = p.k0; this.h0 = p.h0; this.pidot = p.pidot;
    this.q0 = p.q0; this.p0 = p.p0; this.Omdot = p.Omdot;
    const f = (v?: number[]) => (v ? Float64Array.from(v) : null);
    this.lib = p.lib.map((L) => ({
      nu: L.nu, M: L.cl.length, cl: Float64Array.from(L.cl), sl: Float64Array.from(L.sl),
      ca: f(L.ca), sa: f(L.sa), ck: f(L.ck), sk: f(L.sk), ch: f(L.ch), sh: f(L.sh),
    }));
    const store = p.table ? (p.table.store === 'f32' ? tables.f32 : tables.i16) : null;
    if (p.table && store) {
      this.tb = store;
      this.tbCart = p.table.kind === 'cartesian';
      this.tbOff = p.table.offset;
      this.tbCount = p.table.count;
      this.tbStep = p.table.step;
      this.tbStart = p.table.startJd - EPOCH_JD;
      this.tbTaper = p.table.taper;
      this.sc = Float64Array.from(p.table.scale);
    } else {
      this.tb = null; this.tbCart = false; this.tbOff = 0; this.tbCount = 0; this.tbStep = 1; this.tbStart = 0;
      this.tbTaper = 0; this.sc = new Float64Array(6);
    }
  }

  /** Span (JD TDB) where the fitted residual table is fully applied, or null. */
  tableSpanJd(): [number, number] | null {
    if (!this.tb) return null;
    return [EPOCH_JD + this.tbStart + this.tbStep + this.tbTaper, EPOCH_JD + this.tbStart + (this.tbCount - 2) * this.tbStep - this.tbTaper];
  }

  /** Position (km, SEF) at tau into px/py/pz; with `frame` also the mean direction, normal, M, e. */
  private position(tau: number, frame: boolean): void {
    let lam = this.lambda0 + this.n * tau;
    let a = this.a;
    let k0 = this.k0, h0 = this.h0;
    const lib = this.lib;
    for (let j = 0; j < lib.length; j++) {
      const L = lib[j];
      const c1 = Math.cos(L.nu * tau), s1 = Math.sin(L.nu * tau);
      let c = c1, s = s1;
      for (let m = 0; m < L.M; m++) {
        lam += L.cl[m] * c + L.sl[m] * s;
        if (L.ca) a += L.ca[m] * c + L.sa![m] * s;
        if (L.ck) { k0 += L.ck[m] * c + L.sk![m] * s; h0 += L.ch![m] * c + L.sh![m] * s; }
        const cn = c * c1 - s * s1;
        s = s * c1 + c * s1;
        c = cn;
      }
    }
    const cp = Math.cos(this.pidot * tau), sp = Math.sin(this.pidot * tau);
    let k = k0 * cp - h0 * sp;
    let h = k0 * sp + h0 * cp;
    const co = Math.cos(this.Omdot * tau), so = Math.sin(this.Omdot * tau);
    let q = this.q0 * co - this.p0 * so;
    let p = this.q0 * so + this.p0 * co;
    // residual table lookup
    let w0 = 0, w1 = 0, w2 = 0, w3 = 0, wt = 0, b = -1;
    const tb = this.tb;
    if (tb) {
      const f = (tau - this.tbStart) / this.tbStep;
      const i1 = Math.floor(f);
      if (i1 >= 1 && i1 <= this.tbCount - 3) {
        const u = f - i1;
        w0 = (-u * (u - 1) * (u - 2)) / 6;
        w1 = ((u + 1) * (u - 1) * (u - 2)) / 2;
        w2 = (-(u + 1) * u * (u - 2)) / 2;
        w3 = ((u + 1) * u * (u - 1)) / 6;
        const tLo = this.tbStart + this.tbStep;
        const tHi = this.tbStart + (this.tbCount - 2) * this.tbStep;
        wt = this.tbTaper > 0 ? smoothstep((tau - tLo) / this.tbTaper) * smoothstep((tHi - tau) / this.tbTaper) : 1;
        b = i1 - 1;
      }
    }
    if (b >= 0 && !this.tbCart) {
      const o = this.tbOff + b * 6, t = tb!, sc = this.sc;
      lam += wt * sc[0] * (w0 * t[o] + w1 * t[o + 6] + w2 * t[o + 12] + w3 * t[o + 18]);
      a += wt * sc[1] * (w0 * t[o + 1] + w1 * t[o + 7] + w2 * t[o + 13] + w3 * t[o + 19]);
      k += wt * sc[2] * (w0 * t[o + 2] + w1 * t[o + 8] + w2 * t[o + 14] + w3 * t[o + 20]);
      h += wt * sc[3] * (w0 * t[o + 3] + w1 * t[o + 9] + w2 * t[o + 15] + w3 * t[o + 21]);
      q += wt * sc[4] * (w0 * t[o + 4] + w1 * t[o + 10] + w2 * t[o + 16] + w3 * t[o + 22]);
      p += wt * sc[5] * (w0 * t[o + 5] + w1 * t[o + 11] + w2 * t[o + 17] + w3 * t[o + 23]);
    }
    // ---- equinoctial Kepler ellipse
    let L = lam % TWO_PI;
    if (L < 0) L += TWO_PI;
    let F = L + k * Math.sin(L) - h * Math.cos(L);
    for (let it = 0; it < 40; it++) {
      const sF = Math.sin(F), cF = Math.cos(F);
      const d = (F + h * cF - k * sF - L) / (1 - h * sF - k * cF);
      F -= d;
      if (Math.abs(d) < 1e-15) break;
    }
    const sF = Math.sin(F), cF = Math.cos(F);
    const e2 = k * k + h * h;
    const beta = 1 / (1 + Math.sqrt(1 - e2));
    const X1 = a * ((1 - beta * h * h) * cF + h * k * beta * sF - k);
    const Y1 = a * ((1 - beta * k * k) * sF + h * k * beta * cF - h);
    const ss = 1 + p * p + q * q;
    const fx = (1 - p * p + q * q) / ss, fy = (2 * p * q) / ss, fz = (-2 * p) / ss;
    const gx = (2 * p * q) / ss, gy = (1 + p * p - q * q) / ss, gz = (2 * q) / ss;
    const rx = X1 * fx + Y1 * gx, ry = X1 * fy + Y1 * gy, rz = X1 * fz + Y1 * gz;
    const R = this.R;
    let x = R[0] * rx + R[1] * ry + R[2] * rz;
    let y = R[3] * rx + R[4] * ry + R[5] * rz;
    let z = R[6] * rx + R[7] * ry + R[8] * rz;
    if (b >= 0 && this.tbCart) {
      const o = this.tbOff + b * 3, t = tb!, sc = this.sc;
      x += wt * sc[0] * (w0 * t[o] + w1 * t[o + 3] + w2 * t[o + 6] + w3 * t[o + 9]);
      y += wt * sc[1] * (w0 * t[o + 1] + w1 * t[o + 4] + w2 * t[o + 7] + w3 * t[o + 10]);
      z += wt * sc[2] * (w0 * t[o + 2] + w1 * t[o + 5] + w2 * t[o + 8] + w3 * t[o + 11]);
    }
    this.px = x; this.py = y; this.pz = z;
    if (frame) {
      const cl = Math.cos(L), sl = Math.sin(L);
      const ux = cl * fx + sl * gx, uy = cl * fy + sl * gy, uz = cl * fz + sl * gz;
      const wx = (2 * p) / ss, wy = (-2 * q) / ss, wz = (1 - p * p - q * q) / ss;
      this.ux = R[0] * ux + R[1] * uy + R[2] * uz;
      this.uy = R[3] * ux + R[4] * uy + R[5] * uz;
      this.uz = R[6] * ux + R[7] * uy + R[8] * uz;
      this.wx = R[0] * wx + R[1] * wy + R[2] * wz;
      this.wy = R[3] * wx + R[4] * wy + R[5] * wz;
      this.wz = R[6] * wx + R[7] * wy + R[8] * wz;
      this.ecc = Math.sqrt(e2);
      this.mAnom = L - Math.atan2(h, k);
    }
  }

  /** Position only (km, SEF) at tau = days since EPOCH_JD, written to out[0..2]. No allocations. */
  positionAt(tau: number, out: Float64Array | number[], o = 0): void {
    this.position(tau, false);
    out[o] = this.px; out[o + 1] = this.py; out[o + 2] = this.pz;
  }

  /** Full state at tau = days since EPOCH_JD. No allocations. */
  evaluate(tau: number, s: OrbitSample): OrbitSample {
    this.position(tau + VEL_DT, false);
    const ax = this.px, ay = this.py, az = this.pz;
    this.position(tau - VEL_DT, false);
    const bx = this.px, by = this.py, bz = this.pz;
    this.position(tau, true);
    const inv = 1 / (2 * VEL_DT * DAY);
    s.x = this.px; s.y = this.py; s.z = this.pz;
    s.vx = (ax - bx) * inv; s.vy = (ay - by) * inv; s.vz = (az - bz) * inv;
    s.ux = this.ux; s.uy = this.uy; s.uz = this.uz;
    s.wx = this.wx; s.wy = this.wy; s.wz = this.wz;
    s.M = this.mAnom; s.e = this.ecc;
    return s;
  }
}

/** Days since EPOCH_JD for t = seconds since J2000 TDB (avoids the large-JD cancellation). */
export function tauFromT(t: number): number {
  return t / DAY - EPOCH_FROM_J2000_DAYS;
}
