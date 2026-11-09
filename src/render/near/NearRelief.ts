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
// (The cross-section anisotropy of the spin-aligned population -- bodies spinning about their short axis near the
// orbit normal present more area from above than edge-on -- is part of the LOD contract: src/rings/ringDynamics.ts.)
// Used by scripts/test/particles.mjs (in the page, through the Vite dev server).
import nearCommonSrc from './nearCommon.glsl?raw';
import { CLAST_N, CLAST_P, NOISE_N, NOISE_P, nearClastData, nearNoiseData, sampleTex3, valueRange } from './NearNoise';
import { regolithIF } from './NearRegolith';

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

/** A random body (radius a, m: unused -- every size has the full shape spread) from the nearShape / nearReliefParams
 *  distributions (high quality). */
export function randomBody(rnd: () => number, _a = 1.5, _K = reliefConstants()): ReliefBody {
  const b = 1 - 0.3 * rnd();
  const c = b * (1 - 0.25 * rnd());
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

/** nearRelief (value + gradient dh/du) with 2, 4 or 5 layers, CPU mirror */
export function reliefFull(body: ReliefBody, wc: number, ux: number, uy: number, uz: number, K = reliefConstants(), layers = 5): [number, number, number, number] {
  const nd = nearNoiseData(), cd = nearClastData();
  const [sx, sy, sz] = body.so;
  const t = new Float64Array(4);
  let h = 0, gx = 0, gy = 0, gz = 0;
  const add = (data: Float32Array, N: number, P: number, F: number, A: number, ox: number, oy: number, oz: number) => {
    sampleTex3(data, N, P, ux * F + ox, uy * F + oy, uz * F + oz, t);
    h += A * t[0]; gx += A * F * t[1]; gy += A * F * t[2]; gz += A * F * t[3];
  };
  add(nd, NOISE_N, NOISE_P, K.NR_FN1, K.NR_AN1, sx, sy, sz);
  if (wc > 0) add(cd, CLAST_N, CLAST_P, K.NR_FC1, wc * K.NR_AC1, sy * 0.5, sz * 0.5, sx * 0.5);
  if (layers >= 3) add(nd, NOISE_N, NOISE_P, K.NR_FN2, K.NR_AN2, sz + 5.3, sx + 5.3, sy + 5.3);
  if (layers >= 4 && wc > 0) add(cd, CLAST_N, CLAST_P, K.NR_FC2, wc * K.NR_AC2, sx * 0.5 + 2.7, sy * 0.5 + 2.7, sz * 0.5 + 2.7);
  if (layers >= 5) add(nd, NOISE_N, NOISE_P, K.NR_FN3, K.NR_AN3, sy + 9.1, sz + 9.1, sx + 9.1);
  return [h, gx, gy, gz];
}

export interface PhotometryResult {
  alphasDeg: number[];
  /** disk-integrated Phi(alpha) of the smooth ellipsoids, the bump-mapped ones (analytic path) and the displaced,
   *  self-shadowed ones (ray-marched path), and the ratios to the smooth ellipsoids */
  smooth: number[];
  bump: number[];
  relief: number[];
  ratioBump: number[];
  ratioRelief: number[];
  ms: number;
}

/**
 * Disk-integrated photometry of the relief (CPU ray tracer mirroring nearDraw.frag.glsl: regolith law, relief
 * normals, the macro-normal guard, albedo patchiness, self-shadowing (binary here, soft over a pixel on the GPU)).
 * Random bodies of radius a (shapes as nearShape, clast weight wc, full relief amplitude) seen along random
 * directions with the Sun at phase angle alpha, orthographic res x res rays over the outer shell; ratios to the
 * smooth ellipsoids (for which the LUT factor holds up to the ellipsoid / sphere difference) quantify what the
 * resolved relief adds to the photometry the medium assumes.
 */
export function measureReliefPhotometry({ bodies = 24, res = 40, alphasDeg = [5, 20, 40, 60, 90, 120, 150], wc = 1, w = 0.95, a = 1.5, seed = 3, bumpLayers = 3 } = {}): PhotometryResult {
  const t0 = performance.now();
  const K = reliefConstants();
  const rnd = mulberry32(seed);
  // the shader's visible-normal clamp: n.v >= 0.05
  const visible = (n: number[], v: number[]) => {
    const d = Math.max(0.05 - (n[0] * v[0] + n[1] * v[1] + n[2] * v[2]), 0);
    const m = [n[0] + d * v[0], n[1] + d * v[1], n[2] + d * v[2]];
    const l = Math.hypot(m[0], m[1], m[2]);
    return [m[0] / l, m[1] / l, m[2] / l];
  };
  const kap = reliefKappa(1, wc, K);
  const [hLo, hHi] = reliefBounds(wc, K);
  const rOut = kap * (1 + hHi), rIn = kap * (1 + hLo);
  const nA = alphasDeg.length;
  const sm = new Array(nA).fill(0), bu = new Array(nA).fill(0), re = new Array(nA).fill(0);
  const F = (body: ReliefBody, y: number[]) => {
    const r = Math.hypot(y[0], y[1], y[2]);
    return r - kap * (1 + reliefH(reliefLayers(body, y[0] / r, y[1] / r, y[2] / r, K), wc, K));
  };
  const norm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  for (let bi = 0; bi < bodies; bi++) {
    const body = randomBody(rnd, a, K);
    const D = body.ax;
    for (let ia = 0; ia < nA; ia++) {
      const al = (alphasDeg[ia] * Math.PI) / 180;
      // view direction v (toward the viewer), sun s at angle alpha from v
      const z = 2 * rnd() - 1, ph = 2 * Math.PI * rnd(), rr = Math.sqrt(1 - z * z);
      const v = [rr * Math.cos(ph), rr * Math.sin(ph), z];
      const tt = Math.abs(v[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const e1 = norm([v[1] * tt[2] - v[2] * tt[1], v[2] * tt[0] - v[0] * tt[2], v[0] * tt[1] - v[1] * tt[0]]);
      const e2 = [v[1] * e1[2] - v[2] * e1[1], v[2] * e1[0] - v[0] * e1[2], v[0] * e1[1] - v[1] * e1[0]];
      const ps = 2 * Math.PI * rnd();
      const ep = [Math.cos(ps) * e1[0] + Math.sin(ps) * e2[0], Math.cos(ps) * e1[1] + Math.sin(ps) * e2[1], Math.cos(ps) * e1[2] + Math.sin(ps) * e2[2]];
      const s = [Math.cos(al) * v[0] + Math.sin(al) * ep[0], Math.cos(al) * v[1] + Math.sin(al) * ep[1], Math.cos(al) * v[2] + Math.sin(al) * ep[2]];
      const cg = Math.cos(al);
      const sb = [s[0] / D[0], s[1] / D[1], s[2] / D[2]];
      const ssl = Math.hypot(sb[0], sb[1], sb[2]);
      const R = rOut * Math.max(D[0], D[1], D[2]) * 1.02;
      const dA = (2 * R / res) ** 2;
      const db = [-v[0] / D[0], -v[1] / D[1], -v[2] / D[2]];
      const A2 = dot(db, db);
      for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
        const x = -R + (2 * R * (i + 0.5)) / res, y = -R + (2 * R * (j + 0.5)) / res;
        const o = [3 * v[0] + x * e1[0] + y * e2[0], 3 * v[1] + x * e1[1] + y * e2[1], 3 * v[2] + x * e1[2] + y * e2[2]];
        const ob = [o[0] / D[0], o[1] / D[1], o[2] / D[2]];
        const B = dot(ob, db), C = dot(ob, ob);
        // smooth / bump: unit sphere of the scaled frame
        const disc = B * B - A2 * (C - 1);
        if (disc >= 0) {
          const t = (-B - Math.sqrt(disc)) / A2;
          const yb = [ob[0] + t * db[0], ob[1] + t * db[1], ob[2] + t * db[2]];
          const ng = norm([yb[0] / D[0], yb[1] / D[1], yb[2] / D[2]]);
          const m0 = dot(ng, s);
          if (m0 > 0) sm[ia] += regolithIF(m0, Math.max(dot(ng, v), 0.02), cg, w) * dA;
          // analytic path: coarse layers as a normal perturbation (3 layers: sprites 14 .. ~40 px), visible-normal clamp
          const hf = reliefFull(body, wc, yb[0], yb[1], yb[2], K, bumpLayers);
          const gu = dot(hf.slice(1), yb);
          const n = visible(norm([(yb[0] - (hf[1] - gu * yb[0])) / D[0], (yb[1] - (hf[2] - gu * yb[1])) / D[1], (yb[2] - (hf[3] - gu * yb[2])) / D[2]]), v);
          const mb = dot(n, s);
          if (mb > 0 && m0 > -0.1) bu[ia] += regolithIF(mb, Math.max(dot(n, v), 0.02), cg, w) * (1 + 0.6 * hf[0]) * dA;
        }
        // relief: sphere-trace the displaced surface between the shells
        const dO = B * B - A2 * (C - rOut * rOut);
        if (dO < 0) continue;
        let tk = (-B - Math.sqrt(dO)) / A2;
        let t1 = (-B + Math.sqrt(dO)) / A2;
        const dI = B * B - A2 * (C - rIn * rIn);
        if (dI > 0) t1 = Math.min(t1, (-B - Math.sqrt(dI)) / A2);
        const step = (t1 - tk) / 64;
        let yh: number[] | null = null;
        let prev = tk;
        for (; tk <= t1 + 1e-9; tk += step) {
          const yy = [ob[0] + tk * db[0], ob[1] + tk * db[1], ob[2] + tk * db[2]];
          if (F(body, yy) < 0) {
            let lo = prev, hi = tk;
            for (let m = 0; m < 12; m++) { const tm = 0.5 * (lo + hi); if (F(body, [ob[0] + tm * db[0], ob[1] + tm * db[1], ob[2] + tm * db[2]]) < 0) hi = tm; else lo = tm; }
            const tm = 0.5 * (lo + hi);
            yh = [ob[0] + tm * db[0], ob[1] + tm * db[1], ob[2] + tm * db[2]];
            break;
          }
          prev = tk;
        }
        if (!yh) continue;
        const pr = Math.hypot(yh[0], yh[1], yh[2]);
        const u = [yh[0] / pr, yh[1] / pr, yh[2] / pr];
        const hf = reliefFull(body, wc, u[0], u[1], u[2], K, 5);
        const gu = dot(hf.slice(1), u);
        const gt = [(hf[1] - gu * u[0]) * kap / pr, (hf[2] - gu * u[1]) * kap / pr, (hf[3] - gu * u[2]) * kap / pr];
        const ng = norm([(u[0] - gt[0]) / D[0], (u[1] - gt[1]) / D[1], (u[2] - gt[2]) / D[2]]);
        const n = visible(ng, v);
        const m0 = dot(n, s);
        if (m0 <= 0 || dot(ng, s) <= -0.1) continue;
        // self-shadow: toward the Sun inside the outer shell
        let shadow = false;
        const bq = dot(yh, sb), cq = pr * pr - rOut * rOut;
        const tEx = (-bq + Math.sqrt(Math.max(bq * bq - ssl * ssl * cq, 0))) / (ssl * ssl);
        for (let k = 1; k <= 40 && !shadow; k++) {
          const ts = tEx * (k / 40) * (k / 40) + 2e-3;
          if (F(body, [yh[0] + ts * sb[0], yh[1] + ts * sb[1], yh[2] + ts * sb[2]]) < 0) shadow = true;
        }
        if (!shadow) re[ia] += regolithIF(m0, Math.max(dot(n, v), 0.02), cg, w) * (1 + 0.6 * hf[0]) * dA;
      }
    }
  }
  return {
    alphasDeg, smooth: sm.map((x) => x / (Math.PI * bodies)), bump: bu.map((x) => x / (Math.PI * bodies)), relief: re.map((x) => x / (Math.PI * bodies)),
    ratioBump: bu.map((x, i) => x / sm[i]), ratioRelief: re.map((x, i) => x / sm[i]), ms: performance.now() - t0,
  };
}

/**
 * Photometric correction of the resolved relief (uniform uNearReliefPhot, nearReliefPhotFix in nearCommon.glsl):
 * the per-particle factor is multiplied by 1 / (disk-integrated brightness relative to the smooth ellipsoid) of
 * its rendering path, so that relief normals and resolved self-shadowing - part of the roughness the power law
 * already contains - do not change the particles' mean brightness. Nodes: phase angle 0, 20, ..., 160 deg (180 =
 * 160), clast weight 0, 0.5, 1; bump = analytic ellipsoid with relief normals, march = ray-marched relief with
 * self-shadowing (mixed by the relief amplitude). Measured by measureReliefPhotometry (48 bodies, 32^2 rays,
 * seed 3; reproduced by scripts/test/particles.mjs, which prints a new table when the relief changes).
 */
export const RELIEF_PHOT_ALPHAS = [0, 20, 40, 60, 80, 100, 120, 140, 160];
export const RELIEF_PHOT_WCS = [0, 0.5, 1];
export const RELIEF_PHOT = {
  bump: [
    [1.001, 1.006, 1.002, 1.002, 1.007, 0.988, 0.991, 0.931, 0.852],
    [1.002, 1.015, 1.009, 1.006, 1.002, 0.974, 0.957, 0.868, 0.699],
    [1.005, 1.040, 1.029, 1.019, 0.999, 0.953, 0.890, 0.773, 0.633],
  ],
  march: [
    [0.996, 1.000, 0.998, 0.998, 1.011, 1.003, 1.007, 0.940, 1.031],
    [1.002, 1.010, 1.011, 1.020, 1.043, 1.077, 1.124, 1.169, 1.618],
    [0.992, 1.011, 1.028, 1.058, 1.123, 1.250, 1.422, 1.833, 3.176],
  ],
};
/**
 * The table as the GLSL uniform: [path][wc][alpha node], 10 alpha nodes (the last repeats 160 deg); capped at 2
 * (beyond ~140 deg, where the scattered light is < 0.3% of its peak, a larger boost only over-brightens the
 * thin unshadowed crescent).
 */
export function reliefPhotUniform(): Float32Array {
  const out = new Float32Array(60);
  [RELIEF_PHOT.bump, RELIEF_PHOT.march].forEach((tab, p) => tab.forEach((row, j) => {
    for (let i = 0; i < 10; i++) out[(p * 3 + j) * 10 + i] = Math.min(row[Math.min(i, row.length - 1)], 2);
  }));
  return out;
}
/** measure the correction table (1 / brightness ratio) at the nodes */
export function measureReliefPhotTable({ bodies = 48, res = 32 } = {}): { bump: number[][]; march: number[][]; ms: number } {
  const t0 = performance.now();
  const bump: number[][] = [], march: number[][] = [];
  for (const wc of RELIEF_PHOT_WCS) {
    const r = measureReliefPhotometry({ bodies, res, wc, alphasDeg: RELIEF_PHOT_ALPHAS });
    bump.push(r.ratioBump.map((x) => 1 / x));
    march.push(r.ratioRelief.map((x) => 1 / x));
  }
  return { bump, march, ms: performance.now() - t0 };
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
