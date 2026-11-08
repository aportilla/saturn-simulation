// CPU mirror of the particle shapes of the near field (nearShape, nearRelief, nearSpinAxis in nearCommon.glsl) for
// the statistics the LOD / medium contract depends on. The relief constants (NR_*) are read from nearCommon.glsl
// itself, so the two cannot drift apart; the noise textures are the same deterministic data (NearNoise.ts).
//
// 1. Projected-area renormalization (kappa): a displaced body r(u) = kappa (1 + amp h(u)) D u (D = the ellipsoid
//    semi-axes) must keep the orientation-averaged projected area of its base ellipsoid (pi a^2). For a view
//    direction v the projection is star-shaped about the centre, so A(v) = 1/2 Int R(phi)^2 dphi with the outline
//    radius R(phi) = rho(phi) / |E_perp(phi)|: in the axis-scaled frame (S = D^-1 v, E = D^-1 e_phi, E_perp = E
//    minus its S component) the world half-plane through e_phi is the plane spanned by S^ and E_perp^, and
//    rho(phi) = max_theta kappa (1 + amp h(cos(theta) S^ + sin(theta) E_perp^)) sin(theta) (theta from S^).
//    measureReliefArea() averages A over random bodies (the nearShape / nearReliefParams distributions) and
//    random directions (common random numbers for every (amp, wc) pair) and returns G = <A> / <A_ellipsoid> at
//    kappa = 1; nearKappa() = G^-1/2 is fitted as kappa^-2 = 1 + amp (K0 + K1 wc) + amp^2 (K2 + K3 wc).
// 2. Cross-section anisotropy of the principal-axis rotation (crossSectionVsElevation): bodies spinning about
//    their short axis with near-vertical spin axes (large particles) present more area from above than edge-on.
// Used by scripts/test/particles.mjs (in the page, through the Vite dev server).
import nearCommonSrc from './nearCommon.glsl?raw';
import { CLAST_N, CLAST_P, NOISE_N, NOISE_P, nearClastData, nearNoiseData, valueRange } from './NearNoise';

/** NR_* constants of nearCommon.glsl */
export function reliefConstants(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of nearCommonSrc.matchAll(/^#define\s+(NR_\w+)\s+(-?[\d.]+(?:e-?\d+)?)/gm)) out[m[1]] = Number(m[2]);
  return out;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smoothstep = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** value-only trilinear sample of a periodic texture (texture(t, x / P).x) */
function sampleV(data: Float32Array, N: number, P: number, x: number, y: number, z: number): number {
  const s = N / P;
  const u = x * s - 0.5, v = y * s - 0.5, w = z * s - 0.5;
  const i0 = Math.floor(u), j0 = Math.floor(v), k0 = Math.floor(w);
  const fx = u - i0, fy = v - j0, fz = w - k0;
  const ia = ((i0 % N) + N) % N, ib = (ia + 1) % N, ja = ((j0 % N) + N) % N, jb = (ja + 1) % N, ka = ((k0 % N) + N) % N, kb = (ka + 1) % N;
  const at = (i: number, j: number, k: number) => data[((k * N + j) * N + i) * 4];
  const x00 = at(ia, ja, ka) + fx * (at(ib, ja, ka) - at(ia, ja, ka));
  const x10 = at(ia, jb, ka) + fx * (at(ib, jb, ka) - at(ia, jb, ka));
  const x01 = at(ia, ja, kb) + fx * (at(ib, ja, kb) - at(ia, ja, kb));
  const x11 = at(ia, jb, kb) + fx * (at(ib, jb, kb) - at(ia, jb, kb));
  const y0 = x00 + fy * (x10 - x00), y1 = x01 + fy * (x11 - x01);
  return y0 + fz * (y1 - y0);
}

export interface ReliefBody {
  /** ellipsoid semi-axes in units of a (nearShape) */
  ax: [number, number, number];
  /** texture offset (lattice units) */
  so: [number, number, number];
}

/** nearSpinAlign */
export const spinAlign = (a: number) => 0.85 * smoothstep(0.05, 1, a);

/** A random body of radius a (m) from the nearShape / nearReliefParams distributions (high quality). */
export function randomBody(rnd: () => number, a = 1.5, K = reliefConstants()): ReliefBody {
  const sp = 1 - (K.NR_ISO ?? 0) * spinAlign(a) / 0.85;
  const b = 1 - 0.3 * sp * rnd();
  const c = b * (1 - 0.25 * sp * rnd());
  const P = 1.6075, bp = Math.pow(b, P), cp = Math.pow(c, P);
  const m = Math.pow((bp * cp + bp + cp) / 3, 1 / P);
  const k = 1 / Math.sqrt(m);
  const so: [number, number, number] = [Math.floor(rnd() * 1024) * (16 / 1024), Math.floor(rnd() * 1024) * (16 / 1024), Math.floor(rnd() * 1024) * (16 / 1024)];
  return { ax: [k, k * b, k * c], so };
}

/** The four geometric relief layers (values) of a body at unit direction u: [n1, c1, n2, c2] (unscaled). */
export function reliefLayers(body: ReliefBody, ux: number, uy: number, uz: number, K = reliefConstants()): [number, number, number, number] {
  const nd = nearNoiseData(), cd = nearClastData();
  const [sx, sy, sz] = body.so;
  const n1 = sampleV(nd, NOISE_N, NOISE_P, ux * K.NR_FN1 + sx, uy * K.NR_FN1 + sy, uz * K.NR_FN1 + sz);
  const c1 = sampleV(cd, CLAST_N, CLAST_P, ux * K.NR_FC1 + sy * 0.5, uy * K.NR_FC1 + sz * 0.5, uz * K.NR_FC1 + sx * 0.5);
  const n2 = sampleV(nd, NOISE_N, NOISE_P, ux * K.NR_FN2 + sz + 5.3, uy * K.NR_FN2 + sx + 5.3, uz * K.NR_FN2 + sy + 5.3);
  const c2 = sampleV(cd, CLAST_N, CLAST_P, ux * K.NR_FC2 + sx * 0.5 + 2.7, uy * K.NR_FC2 + sy * 0.5 + 2.7, uz * K.NR_FC2 + sz * 0.5 + 2.7);
  return [n1, c1, n2, c2];
}
/** h from the layer values (nearRelief, layers = 4) */
export function reliefH(L: [number, number, number, number], wc: number, K = reliefConstants()): number {
  return K.NR_AN1 * L[0] + wc * K.NR_AC1 * L[1] + K.NR_AN2 * L[2] + wc * K.NR_AC2 * L[3];
}
/** exact bounds of h (nearReliefBounds) */
export function reliefBounds(wc: number, K = reliefConstants()): [number, number] {
  const c = valueRange(nearClastData()), n = valueRange(nearNoiseData());
  return [(K.NR_AN1 + K.NR_AN2) * n[0] + wc * (K.NR_AC1 + K.NR_AC2) * c[0], (K.NR_AN1 + K.NR_AN2) * n[1] + wc * (K.NR_AC1 + K.NR_AC2) * c[1]];
}
/** kappa(amp, wc) as nearKappa in GLSL */
export function reliefKappa(amp: number, wc: number, K = reliefConstants()): number {
  return 1 / Math.sqrt(Math.max(1 + amp * (K.NR_K0 + K.NR_K1 * wc) + amp * amp * (K.NR_K2 + K.NR_K3 * wc), 0.25));
}

export interface AreaResult {
  amps: number[];
  wcs: number[];
  /** G[i][j] = <A(amp_i, wc_j)> / <A_ellipsoid> at kappa = 1 */
  G: number[][];
  /** the same with the fitted kappa (GLSL constants): should be 1 */
  Gk: number[][];
  /** least-squares fit of kappa^-2 - 1 = amp (K0 + K1 wc) + amp^2 (K2 + K3 wc) */
  fit: { K0: number; K1: number; K2: number; K3: number };
  /** standard error of the ensemble mean ratio (shot noise of bodies x directions) */
  sem: number;
  /** mean projected area of the base ellipsoids / pi a^2 (Knud Thomsen normalization: ~1) */
  ellipsoid: number;
  bodies: number;
  dirs: number;
  ms: number;
}

/**
 * Orientation-averaged projected area of displaced bodies relative to their ellipsoids (see the header).
 * nPhi outline directions, nTh limb samples (+-50 deg about the ellipsoid limb, parabolic refinement of the max).
 */
export function measureReliefArea({ bodies = 160, dirs = 12, amps = [0.25, 0.5, 0.75, 1], wcs = [0, 0.5, 1], nPhi = 96, nTh = 25, seed = 99, a = 1.5 } = {}): AreaResult {
  const t0 = performance.now();
  const K = reliefConstants();
  const rnd = mulberry32(seed);
  const nA = amps.length, nW = wcs.length;
  const sumD: number[][] = amps.map(() => wcs.map(() => 0));
  const sumDk: number[][] = amps.map(() => wcs.map(() => 0));
  let sumB = 0;
  const ratios: number[] = [];
  const th0 = Math.PI / 2 - (50 * Math.PI) / 180, dth = ((100 * Math.PI) / 180) / (nTh - 1);
  const sinT = Array.from({ length: nTh }, (_, k) => Math.sin(th0 + k * dth));
  const cosT = Array.from({ length: nTh }, (_, k) => Math.cos(th0 + k * dth));
  const kap = amps.map((a) => wcs.map((w) => reliefKappa(a, w, K)));
  const hv = new Float64Array(nTh);
  let sumE = 0;
  for (let bi = 0; bi < bodies; bi++) {
    const body = randomBody(rnd, a, K);
    const [ax, ay, az] = body.ax;
    for (let di = 0; di < dirs; di++) {
      // random direction, orthonormal basis of its plane
      const z = 2 * rnd() - 1, ph = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
      const v = [r * Math.cos(ph), r * Math.sin(ph), z];
      const t = Math.abs(v[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      let e1 = [v[1] * t[2] - v[2] * t[1], v[2] * t[0] - v[0] * t[2], v[0] * t[1] - v[1] * t[0]];
      const l1 = Math.hypot(e1[0], e1[1], e1[2]);
      e1 = e1.map((x) => x / l1);
      const e2 = [v[1] * e1[2] - v[2] * e1[1], v[2] * e1[0] - v[0] * e1[2], v[0] * e1[1] - v[1] * e1[0]];
      // scaled frame S^
      let S = [v[0] / ax, v[1] / ay, v[2] / az];
      const ls = Math.hypot(S[0], S[1], S[2]);
      S = S.map((x) => x / ls);
      let aBase = 0;
      const aD: number[][] = amps.map(() => wcs.map(() => 0));
      const aDk: number[][] = amps.map(() => wcs.map(() => 0));
      for (let pi = 0; pi < nPhi; pi++) {
        const f = (2 * Math.PI * pi) / nPhi, cf = Math.cos(f), sf = Math.sin(f);
        const E = [(cf * e1[0] + sf * e2[0]) / ax, (cf * e1[1] + sf * e2[1]) / ay, (cf * e1[2] + sf * e2[2]) / az];
        const es = E[0] * S[0] + E[1] * S[1] + E[2] * S[2];
        const Ep = [E[0] - es * S[0], E[1] - es * S[1], E[2] - es * S[2]];
        const lp = Math.hypot(Ep[0], Ep[1], Ep[2]);
        const Eh = [Ep[0] / lp, Ep[1] / lp, Ep[2] / lp];
        const r2b = 1 / (lp * lp);
        aBase += r2b;
        // layer values along the limb meridian
        const Ls: [number, number, number, number][] = [];
        for (let k = 0; k < nTh; k++) {
          const ux = cosT[k] * S[0] + sinT[k] * Eh[0], uy = cosT[k] * S[1] + sinT[k] * Eh[1], uz = cosT[k] * S[2] + sinT[k] * Eh[2];
          Ls.push(reliefLayers(body, ux, uy, uz, K));
        }
        for (let ia = 0; ia < nA; ia++) for (let iw = 0; iw < nW; iw++) {
          let best = -1, kb = 0;
          for (let k = 0; k < nTh; k++) {
            hv[k] = (1 + amps[ia] * reliefH(Ls[k], wcs[iw], K)) * sinT[k];
            if (hv[k] > best) { best = hv[k]; kb = k; }
          }
          // parabolic refinement of the maximum
          if (kb > 0 && kb < nTh - 1) {
            const y0 = hv[kb - 1], y1 = hv[kb], y2 = hv[kb + 1], d = y0 - 2 * y1 + y2;
            if (d < 0) best = y1 - (0.125 * (y2 - y0) * (y2 - y0)) / d;
          }
          aD[ia][iw] += best * best * r2b;
          aDk[ia][iw] += kap[ia][iw] * kap[ia][iw] * best * best * r2b;
        }
      }
      sumB += aBase;
      sumE += aBase / nPhi;
      for (let ia = 0; ia < nA; ia++) for (let iw = 0; iw < nW; iw++) { sumD[ia][iw] += aD[ia][iw]; sumDk[ia][iw] += aDk[ia][iw]; }
      ratios.push(aD[nA - 1][nW - 1] / aBase);
    }
  }
  const G = sumD.map((row) => row.map((x) => x / sumB));
  const Gk = sumDk.map((row) => row.map((x) => x / sumB));
  // least squares: y = G - 1 ~ a (K0 + K1 w) + a^2 (K2 + K3 w)  (kappa^-2 = G)
  const rows: number[][] = [], ys: number[] = [];
  for (let ia = 0; ia < nA; ia++) for (let iw = 0; iw < nW; iw++) {
    const a = amps[ia], w = wcs[iw];
    rows.push([a, a * w, a * a, a * a * w]);
    ys.push(G[ia][iw] - 1);
  }
  const fit = lsq(rows, ys);
  const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
  const sd = Math.sqrt(ratios.reduce((s, x) => s + (x - mean) * (x - mean), 0) / Math.max(1, ratios.length - 1));
  return {
    amps, wcs, G, Gk, fit: { K0: fit[0], K1: fit[1], K2: fit[2], K3: fit[3] }, sem: sd / mean / Math.sqrt(ratios.length),
    ellipsoid: sumE / (bodies * dirs), bodies, dirs, ms: performance.now() - t0,
  };
}

/** least-squares kappa fit over measured points: kappa^-2 - 1 = G - 1 = amp (K0 + K1 wc) + amp^2 (K2 + K3 wc) */
export function fitKappa(points: { amp: number; wc: number; G: number }[]): { K0: number; K1: number; K2: number; K3: number } {
  const x = lsq(points.map((p) => [p.amp, p.amp * p.wc, p.amp * p.amp, p.amp * p.amp * p.wc]), points.map((p) => p.G - 1));
  return { K0: x[0], K1: x[1], K2: x[2], K3: x[3] };
}

function lsq(A: number[][], y: number[]): number[] {
  const n = A[0].length;
  const M = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let r = 0; r < A.length; r++) for (let i = 0; i < n; i++) { b[i] += A[r][i] * y[r]; for (let j = 0; j < n; j++) M[i][j] += A[r][i] * A[r][j]; }
  // Gaussian elimination
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    [b[i], b[p]] = [b[p], b[i]];
    for (let k = i + 1; k < n; k++) {
      const f = M[k][i] / M[i][i];
      for (let j = i; j < n; j++) M[k][j] -= f * M[i][j];
      b[k] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
  return x;
}

/**
 * Mean projected area (units of pi a^2) of ellipsoids spinning about their short axis, as seen at elevation
 * `elevDeg` above the ring plane, for particles of radius a (m): spin axes from nearSpinAxis (near-vertical for
 * large particles), spin phase uniform, shapes from nearShape. 1 = the isotropic value the medium assumes.
 */
export function crossSectionVsElevation(a: number, elevDeg: number, { n = 20000, seed = 5 } = {}): number {
  const rnd = mulberry32(seed);
  const el = (elevDeg * Math.PI) / 180;
  const v = [Math.cos(el), 0, Math.sin(el)];
  const align = 0.85 * smoothstep(0.05, 1, a);
  let s = 0;
  const K = reliefConstants();
  for (let i = 0; i < n; i++) {
    const body = randomBody(rnd, a, K);
    // spin axis (nearSpinAxis) and a random spin phase: body frame (x, y, z = spin axis)
    const cz = 2 * rnd() - 1, ph = 2 * Math.PI * rnd(), r = Math.sqrt(Math.max(0, 1 - cz * cz));
    let ax = [(1 - align) * r * Math.cos(ph), (1 - align) * r * Math.sin(ph), (1 - align) * cz + align];
    const la = Math.hypot(ax[0], ax[1], ax[2]);
    ax = ax.map((x) => x / la);
    const t = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let x0 = [ax[1] * t[2] - ax[2] * t[1], ax[2] * t[0] - ax[0] * t[2], ax[0] * t[1] - ax[1] * t[0]];
    const lx = Math.hypot(x0[0], x0[1], x0[2]);
    x0 = x0.map((q) => q / lx);
    const y0 = [ax[1] * x0[2] - ax[2] * x0[1], ax[2] * x0[0] - ax[0] * x0[2], ax[0] * x0[1] - ax[1] * x0[0]];
    const sp = 2 * Math.PI * rnd(), cs = Math.cos(sp), sn = Math.sin(sp);
    const bx = [cs * x0[0] + sn * y0[0], cs * x0[1] + sn * y0[1], cs * x0[2] + sn * y0[2]];
    const by = [-sn * x0[0] + cs * y0[0], -sn * x0[1] + cs * y0[1], -sn * x0[2] + cs * y0[2]];
    const d = [v[0] * bx[0] + v[1] * bx[1] + v[2] * bx[2], v[0] * by[0] + v[1] * by[1] + v[2] * by[2], v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2]];
    const [A, B, C] = body.ax;
    s += Math.sqrt(B * B * C * C * d[0] * d[0] + A * A * C * C * d[1] * d[1] + A * A * B * B * d[2] * d[2]);
  }
  return s / n;
}
