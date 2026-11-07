// Least-squares machinery for fitting the moon orbit model (model.mjs) to Horizons state vectors.
import {
  EPOCH_JD, TWO_PI, elementsToState, orbitElements, orbitStateSef, orbitPosSef, frameMatrix, lagrangeWeights,
} from './model.mjs';

// ---------------------------------------------------------------- small dense solver
/** Solve A x = b (A symmetric positive (semi)definite, n x n, row-major Float64Array) via Cholesky w/ jitter. */
export function solveSPD(A, b, n) {
  const L = new Float64Array(n * n);
  let jitter = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    let ok = true;
    L.fill(0);
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i * n + j] + (i === j ? jitter * (A[i * n + i] || 1) : 0);
        for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
        if (i === j) {
          if (s <= 0) { ok = false; break; }
          L[i * n + i] = Math.sqrt(s);
        } else L[i * n + j] = s / L[j * n + j];
      }
    }
    if (ok) {
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
        y[i] = s / L[i * n + i];
      }
      const x = new Float64Array(n);
      for (let i = n - 1; i >= 0; i--) {
        let s = y[i];
        for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
        x[i] = s / L[i * n + i];
      }
      return x;
    }
    jitter = jitter ? jitter * 100 : 1e-14;
  }
  throw new Error('solveSPD failed');
}

/** Linear least squares: minimize |M x - y|^2, M given as array of rows. */
export function linLSQ(rows, y) {
  const n = rows[0].length;
  const A = new Float64Array(n * n);
  const b = new Float64Array(n);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let i = 0; i < n; i++) {
      b[i] += row[i] * y[r];
      for (let j = 0; j <= i; j++) A[i * n + j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) A[j * n + i] = A[i * n + j];
  return solveSPD(A, b, n);
}

// ---------------------------------------------------------------- parameter packing
function getPath(o, p) {
  let x = o;
  for (const k of p) x = x[k];
  return x;
}
function setPath(o, p, v) {
  let x = o;
  for (let i = 0; i < p.length - 1; i++) x = x[p[i]];
  x[p[p.length - 1]] = v;
}

/** Default free-parameter list for an orbit. */
export function paramPaths(orbit, { frame = false, libNu = false, fixRates = false } = {}) {
  const P = [['lambda0'], ['n'], ['a'], ['k0'], ['h0'], ['q0'], ['p0']];
  if (!fixRates) P.push(['pidot'], ['Omdot']);
  if (frame) P.push(['tu'], ['tv']);
  (orbit.lib ?? []).forEach((L, j) => {
    if (libNu && !L.fixNu) P.push(['lib', j, 'nu']);
    for (let m = 0; m < L.cl.length; m++) {
      P.push(['lib', j, 'cl', m], ['lib', j, 'sl', m]);
      if (L.ca) P.push(['lib', j, 'ca', m], ['lib', j, 'sa', m]);
      if (L.ck) P.push(['lib', j, 'ck', m], ['lib', j, 'sk', m], ['lib', j, 'ch', m], ['lib', j, 'sh', m]);
    }
  });
  return P;
}
const STEP = { lambda0: 1e-8, n: 1e-12, a: 1e-4, k0: 1e-9, h0: 1e-9, q0: 1e-9, p0: 1e-9, pidot: 1e-12, Omdot: 1e-12, tu: 1e-9, tv: 1e-9, nu: 1e-12, cl: 1e-8, sl: 1e-8, ca: 1e-4, sa: 1e-4, ck: 1e-9, sk: 1e-9, ch: 1e-9, sh: 1e-9 };
function stepFor(path) {
  for (let i = path.length - 1; i >= 0; i--) if (typeof path[i] === 'string' && STEP[path[i]] !== undefined) return STEP[path[i]];
  return 1e-8;
}

// ---------------------------------------------------------------- residuals
const _s = new Float64Array(6);
/** obs: { jd: Float64Array, pos: Float64Array (3n, SEF km) } -> residual vector (model - obs), km */
export function residuals(orbit, obs, out = new Float64Array(obs.jd.length * 3)) {
  orbit.R = frameMatrix(orbit);
  const n = obs.jd.length;
  for (let i = 0; i < n; i++) {
    orbitPosSef(orbit, obs.jd[i], _s);
    out[3 * i] = _s[0] - obs.pos[3 * i];
    out[3 * i + 1] = _s[1] - obs.pos[3 * i + 1];
    out[3 * i + 2] = _s[2] - obs.pos[3 * i + 2];
  }
  return out;
}
function sumsq(r) {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i] * r[i];
  return s;
}

/** Levenberg–Marquardt on the global (mean-element) parameters. Table (if any) is held fixed. */
export function fitGlobal(orbit, obs, paths, { iters = 30, verbose = false, tol = 1e-10 } = {}) {
  const np = paths.length;
  const m = obs.jd.length * 3;
  let r0 = residuals(orbit, obs);
  let cost = sumsq(r0);
  let mu = 1e-3;
  const cols = paths.map(() => new Float64Array(m));
  const rp = new Float64Array(m), rm = new Float64Array(m);
  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < np; j++) {
      const p = paths[j];
      const v = getPath(orbit, p);
      const h = stepFor(p);
      setPath(orbit, p, v + h); residuals(orbit, obs, rp);
      setPath(orbit, p, v - h); residuals(orbit, obs, rm);
      setPath(orbit, p, v);
      const c = cols[j];
      for (let i = 0; i < m; i++) c[i] = (rp[i] - rm[i]) / (2 * h);
    }
    const A = new Float64Array(np * np);
    const g = new Float64Array(np);
    for (let a = 0; a < np; a++) {
      const ca = cols[a];
      let s = 0;
      for (let i = 0; i < m; i++) s += ca[i] * r0[i];
      g[a] = -s;
      for (let b = 0; b <= a; b++) {
        const cb = cols[b];
        let t = 0;
        for (let i = 0; i < m; i++) t += ca[i] * cb[i];
        A[a * np + b] = t;
        A[b * np + a] = t;
      }
    }
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const Ad = A.slice();
      for (let a = 0; a < np; a++) Ad[a * np + a] *= 1 + mu;
      let dx;
      try { dx = solveSPD(Ad, g, np); } catch { mu *= 10; continue; }
      const saved = paths.map((p) => getPath(orbit, p));
      paths.forEach((p, j) => setPath(orbit, p, saved[j] + dx[j]));
      const r1 = residuals(orbit, obs);
      const c1 = sumsq(r1);
      if (c1 < cost) {
        const rel = (cost - c1) / cost;
        cost = c1; r0 = r1; mu = Math.max(mu / 5, 1e-9); improved = true;
        if (verbose) console.log(`  LM it ${it} rms ${Math.sqrt(cost / m).toFixed(4)} km  mu ${mu.toExponential(1)}`);
        if (rel < tol) return { rms: Math.sqrt(cost / m), iters: it };
        break;
      }
      paths.forEach((p, j) => setPath(orbit, p, saved[j]));
      mu *= 8;
    }
    if (!improved) break;
  }
  return { rms: Math.sqrt(cost / m) };
}

// ---------------------------------------------------------------- residual table (banded LSQ)
const NF = 6;
/**
 * Fit the residual table (uniform grid, fields dl, da, dk, dh, dq, dp) by Gauss–Newton with a banded normal
 * matrix. orbit.table must exist ({startJd, step, count, data}); its taper is ignored during the fit.
 * ridge: per-field prior sigmas (rad, km, -, -, -, -). smooth: weight of a 3rd-difference penalty (per field, in
 * units of the field^-2), optional.
 */
export function fitTable(orbit, obs, { iters = 4, ridge = [3, 300, 0.05, 0.05, 0.05, 0.05], smooth = null, verbose = false, fields = [0, 1, 2, 3, 4, 5] } = {}) {
  const tb = orbit.table;
  const N = tb.count;
  const NU = N * NF;
  const B = NF * 3 + NF - 1; // half bandwidth
  const W = B + 1;
  const savedTaper = tb.taper;
  tb.taper = 0;
  orbit.R = frameMatrix(orbit);
  const R = orbit.R;
  const el = {};
  const st = new Float64Array(6), sp = new Float64Array(6), sm = new Float64Array(6);
  const w = new Float64Array(4);
  const D = new Float64Array(3 * NF);
  const hstep = [1e-7, 1e-4, 1e-7, 1e-7, 1e-7, 1e-7];
  const active = new Uint8Array(NF);
  for (const f of fields) active[f] = 1;
  let lastRms = 0;
  // initial dLambda: along-track residual (obs - model) binned onto the nodes
  {
    const at = alongTrackDeg(orbit, obs);
    const sum = new Float64Array(N), cnt = new Float64Array(N);
    for (let o = 0; o < obs.jd.length; o++) {
      const j = Math.round((obs.jd[o] - tb.startJd) / tb.step);
      if (j < 0 || j >= N) continue;
      sum[j] += -at[o] * (Math.PI / 180);
      cnt[j]++;
    }
    let last = 0;
    for (let j = 0; j < N; j++) {
      if (cnt[j] > 0) last = sum[j] / cnt[j];
      tb.data[j * NF] += last;
    }
  }
  for (let it = 0; it < iters; it++) {
    const band = new Float64Array(NU * W);
    const rhs = new Float64Array(NU);
    let cost = 0, nobs = 0;
    for (let o = 0; o < obs.jd.length; o++) {
      const jd = obs.jd[o];
      const f = (jd - tb.startJd) / tb.step;
      const i1 = Math.floor(f);
      if (i1 < 1 || i1 > N - 3) continue;
      orbitElements(orbit, jd, el);
      const base = [el.a, el.lambda, el.k, el.h, el.q, el.p];
      // order of table fields: dl, da, dk, dh, dq, dp -> element indices
      const elIdx = [1, 0, 2, 3, 4, 5];
      elementsToState(el.a, el.lambda, el.k, el.h, el.q, el.p, el.ldot, st);
      const px = R[0] * st[0] + R[1] * st[1] + R[2] * st[2];
      const py = R[3] * st[0] + R[4] * st[1] + R[5] * st[2];
      const pz = R[6] * st[0] + R[7] * st[1] + R[8] * st[2];
      const rx = px - obs.pos[3 * o], ry = py - obs.pos[3 * o + 1], rz = pz - obs.pos[3 * o + 2];
      cost += rx * rx + ry * ry + rz * rz; nobs++;
      for (let fi = 0; fi < NF; fi++) {
        if (!active[fi]) { D[fi] = D[NF + fi] = D[2 * NF + fi] = 0; continue; }
        const ei = elIdx[fi];
        const e1 = base.slice(), e2 = base.slice();
        e1[ei] += hstep[fi]; e2[ei] -= hstep[fi];
        elementsToState(e1[0], e1[1], e1[2], e1[3], e1[4], e1[5], el.ldot, sp);
        elementsToState(e2[0], e2[1], e2[2], e2[3], e2[4], e2[5], el.ldot, sm);
        const dx = (sp[0] - sm[0]) / (2 * hstep[fi]), dy = (sp[1] - sm[1]) / (2 * hstep[fi]), dz = (sp[2] - sm[2]) / (2 * hstep[fi]);
        D[fi] = R[0] * dx + R[1] * dy + R[2] * dz;
        D[NF + fi] = R[3] * dx + R[4] * dy + R[5] * dz;
        D[2 * NF + fi] = R[6] * dx + R[7] * dy + R[8] * dz;
      }
      lagrangeWeights(f - i1, w);
      // DtD (NF x NF) and Dtr
      const DtD = new Float64Array(NF * NF);
      const Dtr = new Float64Array(NF);
      for (let a = 0; a < NF; a++) {
        Dtr[a] = D[a] * rx + D[NF + a] * ry + D[2 * NF + a] * rz;
        for (let b = 0; b <= a; b++) DtD[a * NF + b] = D[a] * D[b] + D[NF + a] * D[NF + b] + D[2 * NF + a] * D[2 * NF + b];
      }
      for (let m1 = 0; m1 < 4; m1++) {
        const n1 = i1 - 1 + m1;
        for (let a = 0; a < NF; a++) rhs[n1 * NF + a] -= w[m1] * Dtr[a];
        // lower triangle only: block (n1, n2) with n1 >= n2 (one contribution per ordered pair m1 > m2;
        // the transposed upper block is implied by symmetry)
        for (let m2 = 0; m2 <= m1; m2++) {
          const n2 = i1 - 1 + m2;
          const ww = w[m1] * w[m2];
          for (let a = 0; a < NF; a++) {
            const ia = n1 * NF + a;
            for (let b = 0; b < NF; b++) {
              const ib = n2 * NF + b;
              if (ib > ia) continue;
              const val = ww * (a >= b ? DtD[a * NF + b] : DtD[b * NF + a]);
              band[ia * W + (ia - ib)] += val;
            }
          }
        }
      }
    }
    // ridge prior (toward zero total value)
    for (let n = 0; n < N; n++) {
      for (let a = 0; a < NF; a++) {
        const u = n * NF + a;
        const s2 = 1 / (ridge[a] * ridge[a]);
        band[u * W] += active[a] ? s2 : 1;
        rhs[u] -= (active[a] ? s2 : 1) * tb.data[u];
      }
    }
    // optional 3rd-difference smoothness penalty
    if (smooth) {
      const c = [1, -3, 3, -1];
      for (let n = 0; n + 3 < N; n++) {
        for (let a = 0; a < NF; a++) {
          const wgt = smooth[a];
          if (!wgt) continue;
          let dd = 0;
          for (let x = 0; x < 4; x++) dd += c[x] * tb.data[(n + x) * NF + a];
          for (let x = 0; x < 4; x++) {
            const ux = (n + x) * NF + a;
            rhs[ux] -= wgt * c[x] * dd;
            for (let y = 0; y <= x; y++) {
              const uy = (n + y) * NF + a;
              band[ux * W + (ux - uy)] += wgt * c[x] * c[y];
            }
          }
        }
      }
    }
    // banded Cholesky
    const L = band; // in place
    for (let i = 0; i < NU; i++) {
      const j0 = Math.max(0, i - B);
      for (let j = j0; j <= i; j++) {
        let s = L[i * W + (i - j)];
        const k0 = Math.max(j0, j - B);
        for (let k = k0; k < j; k++) s -= L[i * W + (i - k)] * L[j * W + (j - k)];
        if (i === j) L[i * W] = Math.sqrt(Math.max(s, 1e-300));
        else L[i * W + (i - j)] = s / L[j * W];
      }
    }
    const y = new Float64Array(NU);
    for (let i = 0; i < NU; i++) {
      let s = rhs[i];
      for (let k = Math.max(0, i - B); k < i; k++) s -= L[i * W + (i - k)] * y[k];
      y[i] = s / L[i * W];
    }
    const x = new Float64Array(NU);
    for (let i = NU - 1; i >= 0; i--) {
      let s = y[i];
      for (let k = i + 1; k <= Math.min(NU - 1, i + B); k++) s -= L[k * W + (k - i)] * x[k];
      x[i] = s / L[i * W];
    }
    for (let u = 0; u < NU; u++) tb.data[u] += x[u];
    lastRms = Math.sqrt(cost / Math.max(1, nobs * 3));
    if (verbose) console.log(`  table it ${it}: rms before step ${lastRms.toFixed(4)} km (${nobs} obs)`);
  }
  tb.taper = savedTaper;
  return { rms: lastRms };
}

// ---------------------------------------------------------------- helpers
/** Unwrap an angle series (rad). */
export function unwrap(a) {
  const out = new Float64Array(a.length);
  let off = 0;
  out[0] = a[0];
  for (let i = 1; i < a.length; i++) {
    let d = a[i] - a[i - 1];
    if (d > Math.PI) off -= TWO_PI * Math.round(d / TWO_PI);
    else if (d < -Math.PI) off -= TWO_PI * Math.round(d / TWO_PI);
    out[i] = a[i] + off;
  }
  return out;
}

/** Reference-frame coordinates of SEF positions for a frame matrix R (row-major, ref -> SEF). */
export function toRef(R, pos) {
  const n = pos.length / 3;
  const out = new Float64Array(pos.length);
  for (let i = 0; i < n; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    // R^T * v
    out[3 * i] = R[0] * x + R[3] * y + R[6] * z;
    out[3 * i + 1] = R[1] * x + R[4] * y + R[7] * z;
    out[3 * i + 2] = R[2] * x + R[5] * y + R[8] * z;
  }
  return out;
}

/** Along-track (in-plane angular) residual of model vs obs in degrees, per observation. */
export function alongTrackDeg(orbit, obs) {
  const s = new Float64Array(6);
  const n = obs.jd.length;
  const out = new Float64Array(n);
  orbit.R = frameMatrix(orbit);
  for (let i = 0; i < n; i++) {
    orbitStateSef(orbit, obs.jd[i], s);
    const ox = obs.pos[3 * i], oy = obs.pos[3 * i + 1], oz = obs.pos[3 * i + 2];
    // angle from obs to model about the model angular momentum direction
    const hx = s[1] * s[5] - s[2] * s[4], hy = s[2] * s[3] - s[0] * s[5], hz = s[0] * s[4] - s[1] * s[3];
    const cx = oy * s[2] - oz * s[1], cy = oz * s[0] - ox * s[2], cz = ox * s[1] - oy * s[0];
    const sinA = (cx * hx + cy * hy + cz * hz) / Math.hypot(hx, hy, hz);
    const cosA = ox * s[0] + oy * s[1] + oz * s[2];
    out[i] = (Math.atan2(sinA, cosA) * 180) / Math.PI;
  }
  return out;
}

/** Simple periodogram of a (possibly unevenly sampled) series: amplitude of best-fit sinusoid per period. */
export function periodogram(t, y, periods) {
  const out = [];
  for (const P of periods) {
    const w = TWO_PI / P;
    let cc = 0, ss = 0, cs = 0, yc = 0, ys = 0;
    for (let i = 0; i < t.length; i++) {
      const c = Math.cos(w * t[i]), s = Math.sin(w * t[i]);
      cc += c * c; ss += s * s; cs += c * s; yc += y[i] * c; ys += y[i] * s;
    }
    const det = cc * ss - cs * cs;
    const A = (yc * ss - ys * cs) / det, Bv = (ys * cc - yc * cs) / det;
    out.push({ P, amp: Math.hypot(A, Bv) });
  }
  return out;
}

export { EPOCH_JD };
