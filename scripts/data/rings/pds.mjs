// Minimal readers for the PDS3 ring-occultation tables used by build_tau.mjs.
// Column layouts are taken from the detached .LBL files (see comments below); we parse the
// comma-separated ASCII rows rather than fixed byte offsets, which is equivalent for these products.
import { readFileSync } from 'node:fs';

/**
 * Cassini RSS reconstructed profile (CORSS_8001, *_TAU_01KM.TAB), 13 columns:
 *  1 RING RADIUS (km)                     2 RADIUS CORRECTION DUE TO IMPROVED POLE (km)
 *  3 RADIUS CORRECTION DUE TO TIMING OFFSET (km)   4 RING LONGITUDE (deg)   5 OBSERVED RING AZIMUTH (deg)
 *  6 NORMALIZED SIGNAL POWER   7 NORMAL OPTICAL DEPTH   8 PHASE SHIFT (deg)
 *  9 NORMAL OPTICAL DEPTH THRESHOLD   10-12 event times (s)   13 OBSERVED RING ELEVATION (deg)
 * Returns typed arrays; `r` already includes both additive radius corrections (as the label recommends).
 */
export function readRssTau(path) {
  const txt = readFileSync(path, 'latin1');
  const lines = txt.split(/\r?\n/);
  const n = lines.length;
  const r = new Float64Array(n), tau = new Float32Array(n), thr = new Float32Array(n), pow = new Float32Array(n);
  const lon = new Float32Array(n), elev = new Float32Array(n);
  let k = 0;
  for (const line of lines) {
    if (line.length < 50) continue;
    const c = line.split(',');
    if (c.length < 13) continue;
    r[k] = parseFloat(c[0]) + parseFloat(c[1]) + parseFloat(c[2]);
    lon[k] = parseFloat(c[3]);
    pow[k] = parseFloat(c[5]);
    tau[k] = parseFloat(c[6]);
    thr[k] = parseFloat(c[8]);
    elev[k] = parseFloat(c[12]);
    k++;
  }
  return { n: k, r: r.subarray(0, k), tau: tau.subarray(0, k), thr: thr.subarray(0, k), pow: pow.subarray(0, k), lon: lon.subarray(0, k), elev: elev.subarray(0, k) };
}

/**
 * Cassini UVIS HSP stellar occultation (COUVIS_8001, *_TAU01KM.TAB), 12 columns:
 *  1 RING RADIUS (km, bin midpoint)  2 RING LONGITUDE  3 RING OCC PHI  4 MEAN SIGNAL (-1 = missing)
 *  5 NORMAL OPTICAL DEPTH (-1 = missing)  6 MAXIMUM DETECTABLE NORMAL OPTICAL DEPTH (25% photon-noise error)
 *  7 OBSERVED EVENT TDB  8 RING EVENT TDB  9 UNOCCULTED STAR MODEL  10 BACKGROUND MODEL
 *  11 NUMBER OF SAMPLES PER BIN  12 NOTE_FLAG (bit 8 = planet in line of sight, 32 = unmodeled, 64 = corrupted)
 */
export function readUvisTau(path) {
  const txt = readFileSync(path, 'latin1');
  const lines = txt.split(/\r?\n/);
  const n = lines.length;
  const r = new Float64Array(n), tau = new Float32Array(n), tmax = new Float32Array(n), sig = new Float32Array(n);
  const star = new Float32Array(n), bg = new Float32Array(n), flag = new Int32Array(n), lon = new Float32Array(n), phi = new Float32Array(n);
  const nsamp = new Float32Array(n);
  let k = 0;
  for (const line of lines) {
    if (line.length < 40) continue;
    const c = line.split(',');
    if (c.length < 12) continue;
    r[k] = parseFloat(c[0]);
    lon[k] = parseFloat(c[1]);
    phi[k] = parseFloat(c[2]);
    sig[k] = parseFloat(c[3]);
    tau[k] = parseFloat(c[4]);
    tmax[k] = parseFloat(c[5]);
    star[k] = parseFloat(c[8]);
    bg[k] = parseFloat(c[9]);
    nsamp[k] = parseInt(c[10], 10);
    flag[k] = parseInt(c[11], 10);
    k++;
  }
  return {
    n: k, r: r.subarray(0, k), tau: tau.subarray(0, k), tmax: tmax.subarray(0, k), sig: sig.subarray(0, k),
    star: star.subarray(0, k), bg: bg.subarray(0, k), flag: flag.subarray(0, k), lon: lon.subarray(0, k), phi: phi.subarray(0, k),
    nsamp: nsamp.subarray(0, k),
  };
}

/** Parse "KEY = value" pairs from a PDS3 label (top-level scalars only). */
export function readLabel(path) {
  const txt = readFileSync(path, 'latin1');
  const out = {};
  for (const m of txt.matchAll(/^\s*([A-Z_]+)\s*=\s*("?)([^"\r\n]*)\2\s*$/gm)) {
    if (!(m[1] in out)) out[m[1]] = m[3].trim();
  }
  return out;
}

/**
 * Resample (r, v) onto a regular grid r0 + i*dr by bin-averaging (when the source is finer than dr)
 * or linear interpolation (when coarser). Invalid samples (NaN) are skipped. Returns Float64Array with NaN gaps.
 * maxGap: do not interpolate across source gaps wider than this (km).
 */
export function resample(r, v, r0, dr, n, { maxGap = 3 } = {}) {
  const out = new Float64Array(n).fill(NaN);
  // assume r sorted ascending
  let j = 0;
  const m = r.length;
  for (let i = 0; i < n; i++) {
    const x = r0 + i * dr;
    while (j + 1 < m && r[j + 1] <= x) j++;
    if (j + 1 >= m || r[j] > x) continue;
    const a = v[j], b = v[j + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const span = r[j + 1] - r[j];
    if (span > maxGap || span <= 0) continue;
    const f = (x - r[j]) / span;
    out[i] = a * (1 - f) + b * f;
  }
  return out;
}

/** Sort parallel arrays by r ascending (profiles may be ingress = decreasing radius). */
export function sortByR(obj, keys) {
  const n = obj.r.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => obj.r[a] - obj.r[b]);
  const out = { n };
  for (const k of ['r', ...keys]) {
    const src = obj[k];
    const dst = new src.constructor(n);
    for (let i = 0; i < n; i++) dst[i] = src[idx[i]];
    out[k] = dst;
  }
  return out;
}
