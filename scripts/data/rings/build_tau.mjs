#!/usr/bin/env node
// Build public/data/rings/tau_main.{json,f32}: the main-ring NORMAL (visible-equivalent, geometric)
// optical depth on a regular 0.25 km grid, 70,000-140,000 km, from Cassini occultation data.
//
//   node scripts/data/rings/fetch.mjs        # downloads into data-raw/rings/ (gitignored)
//   node scripts/data/rings/build_tau.mjs    # writes public/data/rings/tau_main.* (+ data-raw/rings/derived/*)
//
// Method (see docs/ring-physics.md, "Optical depth profile"):
//  1. MASTER SHAPE = Cassini RSS X-band (3.6 cm) Rev 7 egress (RSS_2005_123_X43_E), 1 km resolution, 0.25 km
//     sampling, radii corrected for the improved pole + timing offset given in the product. A single profile
//     is used (not an average) so eccentric ringlets/edges and spiral density waves stay sharp (they are at
//     different radii / phases in occultations at other longitudes).
//  2. RADIO -> VISIBLE. The RSS optical depth is an EXTINCTION optical depth of the coherent signal:
//     Q_ext = 2 for particles much larger than the wavelength (diffracted power is removed), and the X band
//     is blind to sub-cm particles. Measured in wake-free regions: tau_X / tau_UVIS = 2.00 (C ring,
//     Cassini Division floor), 1.7 in the C-ring and CD ramps (more sub-cm grains). In the A and B rings
//     self-gravity wakes make tau depend on viewing geometry (RSS B = 23.6 deg sees ~25-45 % lower tau
//     than UVIS at B = 66.7 deg). We therefore rescale the RSS profile by a smooth ratio map
//       R(r) = <tau_UVIS> / <tau_X / 2>   (50 km windows)
//     so the result has the RSS fine structure and the visible, high-elevation calibration of UVIS.
//  3. OPAQUE B RING. RSS saturates where tau_X/2 > ~2 (most of B2-B4). Between 92,150 and 116,850 km the
//     profile is the UVIS HSP beta Cen (B = 66.7 deg) result: six occultations, each re-registered to the RSS
//     radius scale (offsets < 0.5 km), averaged in TRANSMISSION (not tau), tau = -mu ln(<T>). Where <T> is
//     below twice its photon-noise sigma, tau is a lower limit and is capped at -mu ln(2 sigma) (~7-8.5).
//  4. GAP FLOORS / EDGES. Negative noise clipped to 0; deep gaps (local max < 0.02) smoothed over +-1.5 km;
//     gap edges (gap <-> ring) deconvolved to a step at the half-level crossing (data resolution is ~1 km;
//     real gap edges are sharp at tens of metres).
//  5. NaN (= no data; the app's procedural model is used) below 74,300 km (D ring: tau ~1e-3, below detection)
//     and beyond the A ring's outer edge (Roche Division, F ring).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRssTau, readUvisTau, sortByR, resample } from './pds.mjs';
import { RSS, UVIS, rssPath, uvisPath } from './fetch.mjs';
// zone boundaries for the summary statistics (Node >= 23 imports TypeScript with type stripping)
const { RING_ZONES } = await import('../../../src/rings/ringRegions.ts');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = resolve(ROOT, 'public/data/rings');
const DERIVED = resolve(ROOT, 'data-raw/rings/derived');

// output grid (aligned with RingProfile's 66,000 km + i*0.25 km grid)
const R0 = 70_000, DR = 0.25, R1 = 140_000;
const N = Math.round((R1 - R0) / DR) + 1;
const idx = (rKm) => Math.round((rKm - R0) / DR);
const rad = (i) => R0 + i * DR;

const MU_UV = Math.sin(66.7 * Math.PI / 180); // beta Cen ring-plane elevation
const DATA_MIN_KM = 74_300; // below: D ring -> NaN
const B_UVIS = [92_150, 117_020]; // UVIS-only interval (RSS saturated somewhere in every 50 km of it)
const B_BLEND_KM = 60; // linear blend width at both ends of B_UVIS

// ------------------------------------------------------------------ helpers
function boxMean(v, halfKm, { valid } = {}) {
  const h = Math.max(0, Math.round(halfKm / DR));
  const ps = new Float64Array(N + 1), pc = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    const ok = Number.isFinite(v[i]) && (!valid || valid[i]);
    ps[i + 1] = ps[i] + (ok ? v[i] : 0);
    pc[i + 1] = pc[i] + (ok ? 1 : 0);
  }
  const out = new Float64Array(N).fill(NaN);
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - h), b = Math.min(N, i + h + 1);
    const c = pc[b] - pc[a];
    if (c > 0) out[i] = (ps[b] - ps[a]) / c;
  }
  return { mean: out, count: (i) => pc[Math.min(N, i + h + 1)] - pc[Math.max(0, i - h)] };
}
const runMax = (v, halfKm) => {
  const h = Math.round(halfKm / DR), out = new Float64Array(N).fill(NaN);
  for (let i = 0; i < N; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - h); j <= Math.min(N - 1, i + h); j++) if (Number.isFinite(v[j]) && v[j] > m) m = v[j];
    if (m > -Infinity) out[i] = m;
  }
  return out;
};
/** normalized cross-correlation of band-passed profiles; returns offset s (km) with b(r+s) ~ a(r) */
function xcorr(a, b, ra, rb, maxKm = 4) {
  const bp = (t) => {
    const lo = boxMean(t, 1.0).mean, hi = boxMean(t, 40).mean;
    return Float64Array.from(lo, (v, i) => v - hi[i]);
  };
  const A = bp(a), B = bp(b);
  const i0 = idx(ra), i1 = idx(rb), S = Math.round(maxKm / DR);
  const cc = [];
  for (let s = -S; s <= S; s++) {
    let sab = 0, saa = 0, sbb = 0;
    for (let i = i0; i < i1; i++) {
      const x = A[i], y = B[i + s];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      sab += x * y; saa += x * x; sbb += y * y;
    }
    cc.push(saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : -1);
  }
  let k = 0;
  for (let j = 1; j < cc.length; j++) if (cc[j] > cc[k]) k = j;
  let frac = 0;
  if (k > 0 && k < cc.length - 1) {
    const y0 = cc[k - 1], y1 = cc[k], y2 = cc[k + 1];
    const den = y0 - 2 * y1 + y2;
    if (den < 0) frac = (0.5 * (y0 - y2)) / den;
  }
  return { off: (k - S + frac) * DR, cc: cc[k] };
}

// ------------------------------------------------------------------ 1. RSS master
const rssId = RSS[0].id;
const rss = sortByR(readRssTau(rssPath(rssId)), ['tau', 'thr', 'elev']);
const tauX = resample(rss.r, rss.tau, R0, DR, N, { maxGap: 0.6 });
const thrX = resample(rss.r, rss.thr, R0, DR, N, { maxGap: 0.6 });
const rssElev = rss.elev[0];
// geometric-equivalent radio tau (Q_ext = 2) and reliability (unsaturated)
const gX = Float64Array.from(tauX, (v) => v / 2);
const relX = Float64Array.from(tauX, (v, i) => {
  if (!Number.isFinite(v) || !Number.isFinite(thrX[i])) return 0;
  const f = v / thrX[i];
  return f < 0.5 ? 1 : f > 0.75 ? 0 : (0.75 - f) / 0.25;
});

// ------------------------------------------------------------------ 2. UVIS beta Cen, registered, averaged in T
const uv = [];
for (const id of UVIS) {
  const d = sortByR(readUvisTau(uvisPath(id)), ['tau', 'tmax', 'flag', 'sig', 'star', 'bg', 'nsamp']);
  const bad = (i) => d.sig[i] < 0 || (d.flag[i] & (8 | 32 | 64)) !== 0 || !(d.star[i] > 0);
  // transmission from the raw columns (the tabulated tau is capped near the detection limit)
  const T = Float64Array.from(d.sig, (s, i) => (bad(i) ? NaN : (s - d.bg[i]) / d.star[i]));
  // photon noise of the bin-mean count rate: var = (mean counts per sample) / (samples per bin)
  const varT = Float64Array.from(d.sig, (s, i) => Math.max(s, 0.05) / Math.max(d.nsamp[i], 1) / (d.star[i] * d.star[i]));
  uv.push({ id, r: d.r, T, varT });
}
// provisional tau per occultation on the grid (for registration)
const tauFromT = (T) => Float64Array.from(T, (t) => (Number.isFinite(t) ? -MU_UV * Math.log(Math.max(t, 2e-4)) : NaN));
const REG_WINDOWS = [[84_600, 86_700], [88_000, 89_950], [92_200, 95_500], [99_000, 101_500]];
const registration = [];
for (const u of uv) {
  const g = tauFromT(resample(u.r, u.T, R0, DR, N, { maxGap: 1.6 }));
  // C-ring windows against RSS (wake-free, circular plateaus); B windows against RSS (B1) / skipped if saturated
  const res = REG_WINDOWS.map(([a, b]) => xcorr(gX, g, a, b));
  const good = res.filter((x) => x.cc > 0.8 && Math.abs(x.off) < 1.5);
  const off = good.length ? good.reduce((s, x) => s + x.off * x.cc, 0) / good.reduce((s, x) => s + x.cc, 0) : 0;
  registration.push({ id: u.id, off: +off.toFixed(3), windows: res.map((x) => `${x.off.toFixed(2)}@${x.cc.toFixed(2)}`) });
  u.off = off;
}
// grid the transmissions with the registration shift (U(r + off) ~ RSS(r)  =>  r_grid = r_uvis - off)
const Tsum = new Float64Array(N), Vsum = new Float64Array(N), Tn = new Float64Array(N);
for (const u of uv) {
  const rr = Float64Array.from(u.r, (r) => r - u.off);
  const Tg = resample(rr, u.T, R0, DR, N, { maxGap: 1.6 });
  const Vg = resample(rr, u.varT, R0, DR, N, { maxGap: 1.6 });
  for (let i = 0; i < N; i++) if (Number.isFinite(Tg[i]) && Number.isFinite(Vg[i])) { Tsum[i] += Tg[i]; Vsum[i] += Vg[i]; Tn[i]++; }
}
const tauU = new Float64Array(N).fill(NaN), tauUcap = new Float64Array(N).fill(NaN), lowerLimit = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  if (Tn[i] < 2) continue;
  const T = Tsum[i] / Tn[i], sd = Math.sqrt(Vsum[i]) / Tn[i];
  const floor = 2 * sd;
  tauUcap[i] = -MU_UV * Math.log(floor);
  if (T < floor) lowerLimit[i] = 1;
  tauU[i] = -MU_UV * Math.log(Math.max(T, floor));
}

// ------------------------------------------------------------------ 3. ratio map R(r) and fusion
// R is computed from ring material only (both tau > 0.03, RSS unsaturated, UVIS detected), excluding zones
// where eccentric features sit at different radii in the RSS snapshot and the longitude-averaged UVIS mean.
// Excluded zones are filled from their surroundings ('left' = value at the inner end, 'right' = outer end,
// 'interp' = linear), then R is smoothed.
const R_EXCLUDE = [
  [77_690, 77_960, 'interp'], // Colombo gap, Titan ringlet (e = 2.6e-4)
  [87_440, 87_630, 'interp'], // Maxwell gap + ringlet
  [88_670, 88_750, 'interp'], // Bond gap, 1.470 Rs ringlet
  [90_140, 90_250, 'interp'], // Dawes gap, 1.495 Rs ringlet
  [117_450, 117_670, 'ref', 117_050, 117_450], // outer B ring edge: m = 2 distorted (+-~75 km); R = ratio of sums over the 400 km inside it
  [117_670, 117_960, 'right'], // Huygens gap + eccentric Huygens ringlet
  [119_820, 120_110, 'interp'], // Laplace gap + ringlet
  [133_400, 133_770, 'interp'], // Encke gap
  [136_440, 136_800, 'left'], // Keeler gap, A-ring outer edge (m = 7)
];
const both = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  both[i] = Number.isFinite(gX[i]) && Number.isFinite(tauU[i]) && relX[i] > 0.99 && !lowerLimit[i] && gX[i] > 0.03 && tauU[i] > 0.03 ? 1 : 0;
}
for (const [a, b] of R_EXCLUDE) for (let i = idx(a); i <= idx(b); i++) both[i] = 0;
const RW = 25; // half-window (km)
const mU = boxMean(tauU, RW, { valid: both }), mX = boxMean(gX, RW, { valid: both });
let ratio = new Float64Array(N).fill(NaN);
for (let i = 0; i < N; i++) {
  if (mU.count(i) < Math.round(5 / DR)) continue; // need >= 5 km of ring material in the window
  ratio[i] = Math.min(3.5, Math.max(0.8, mU.mean[i] / mX.mean[i]));
}
for (const [a, b, mode, refA, refB] of R_EXCLUDE) {
  const ia = idx(a), ib = idx(b);
  let L = NaN, Rr = NaN;
  for (let i = ia - 1; i >= 0 && !Number.isFinite(L); i--) L = ratio[i];
  for (let i = ib + 1; i < N && !Number.isFinite(Rr); i++) Rr = ratio[i];
  let ref = NaN;
  if (mode === 'ref') {
    let su = 0, sx = 0;
    for (let i = idx(refA); i < idx(refB); i++) if (Number.isFinite(tauU[i]) && Number.isFinite(gX[i]) && !lowerLimit[i]) { su += tauU[i]; sx += gX[i]; }
    ref = su / sx;
  }
  for (let i = ia; i <= ib; i++) {
    const f = (i - ia) / Math.max(1, ib - ia);
    ratio[i] = mode === 'left' ? L : mode === 'right' ? Rr : mode === 'ref' ? ref : L * (1 - f) + Rr * f;
  }
}
{
  // remaining holes (gaps without ring material in +-25 km): linear interpolation between valid neighbours
  let i = 0;
  while (i < N) {
    if (Number.isFinite(ratio[i])) { i++; continue; }
    let j = i;
    while (j < N && !Number.isFinite(ratio[j])) j++;
    const L = i > 0 ? ratio[i - 1] : NaN, Rr = j < N ? ratio[j] : NaN;
    for (let k = i; k < j; k++) {
      const f = (k - i + 1) / (j - i + 1);
      ratio[k] = Number.isFinite(L) && Number.isFinite(Rr) ? L * (1 - f) + Rr * f : Number.isFinite(L) ? L : Rr;
    }
    i = j;
  }
  ratio = boxMean(ratio, 10).mean;
}
const tauXv = Float64Array.from(gX, (g, i) => g * ratio[i]); // visible-calibrated RSS
// UVIS replaces RSS only inside the B ring (RSS saturated over most of B2-B4), or where RSS is missing.
// Elsewhere, isolated near-threshold RSS samples (density-wave crests) are kept: the longitude-averaged
// UVIS mean has a different wave phase there.
const wU = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const r = rad(i);
  const [b0, b1] = B_UVIS;
  let w = 0;
  if (r >= b0 && r <= b1) w = 1;
  else if (r > b0 - B_BLEND_KM && r < b0) w = (r - (b0 - B_BLEND_KM)) / B_BLEND_KM;
  else if (r > b1 && r < b1 + B_BLEND_KM) w = (b1 + B_BLEND_KM - r) / B_BLEND_KM;
  if (!Number.isFinite(tauU[i])) w = 0;
  if (!Number.isFinite(tauXv[i])) w = 1;
  wU[i] = w;
}
// Detection-limited UVIS samples: mean transmission below 2 sigma of photon noise. Their tau is a lower limit;
// it is set to TAU_OPAQUE (indistinguishable from opaque at B = 66.7 deg: T_normal < 2e-4).
const TAU_OPAQUE = 8.0;
for (let i = 0; i < N; i++) if (Number.isFinite(tauU[i]) && (lowerLimit[i] || tauU[i] > TAU_OPAQUE)) tauU[i] = TAU_OPAQUE;
const tau = new Float64Array(N).fill(NaN);
for (let i = 0; i < N; i++) {
  const a = tauXv[i], b = tauU[i], w = wU[i];
  if (w <= 0) tau[i] = a;
  else if (w >= 1) tau[i] = b;
  else tau[i] = Number.isFinite(a) && Number.isFinite(b) ? a * (1 - w) + b * w : Number.isFinite(a) ? a : b;
}

// ------------------------------------------------------------------ 4. gap floors and edges
for (let i = 0; i < N; i++) if (Number.isFinite(tau[i]) && tau[i] < 0) tau[i] = 0;
{
  const mx = runMax(tau, 1.5);
  const sm = boxMean(tau, 1.5).mean;
  for (let i = 0; i < N; i++) if (mx[i] < 0.02 && Number.isFinite(sm[i])) tau[i] = Math.max(0, sm[i]);
}
const edges = [];
{
  // A "gap" is a run of >= 1.5 km with tau < 0.02. At each end, if the adjacent ring reaches > 0.08 within
  // 2.5 km, replace the ramp by a step at the half-level crossing.
  const GAP = 0.02, MINW = Math.round(1.5 / DR), SEARCH = Math.round(2.5 / DR);
  let i = 0;
  const isGap = (k) => Number.isFinite(tau[k]) && tau[k] < GAP;
  while (i < N) {
    if (!isGap(i)) { i++; continue; }
    let j = i;
    while (j + 1 < N && isGap(j + 1)) j++;
    if (j - i + 1 >= MINW && rad(i) > DATA_MIN_KM) {
      const gapLevel = (() => { let s = 0, c = 0; for (let k = i; k <= j; k++) { s += tau[k]; c++; } return s / c; })();
      for (const side of [-1, +1]) {
        // side -1: ring is inward of the gap (edge at i), +1: ring outward (edge at j)
        const e = side < 0 ? i : j;
        const k1 = e + side * SEARCH;
        if (k1 < 0 || k1 >= N || !Number.isFinite(tau[k1])) continue;
        // plateau level = mean over [SEARCH, SEARCH+1km] beyond the edge
        let s = 0, c = 0;
        for (let k = e + side * SEARCH; Math.abs(k - e) <= SEARCH + 4; k += side) if (Number.isFinite(tau[k])) { s += tau[k]; c++; }
        const plateau = c ? s / c : NaN;
        if (!(plateau > 0.08)) continue;
        const half = 0.5 * (gapLevel + plateau);
        // first crossing of `half` moving away from the gap
        let x = -1;
        for (let k = e; Math.abs(k - e) <= SEARCH; k += side) if (tau[k] >= half) { x = k; break; }
        if (x < 0) continue;
        // ring side: hold the plateau-side value reached at the end of the ramp; gap side: gap level
        const kEnd = x + side * Math.round(0.75 / DR);
        const hold = Number.isFinite(tau[kEnd]) ? Math.max(tau[kEnd], half) : plateau;
        for (let k = e; k !== x; k += side) tau[k] = gapLevel;
        for (let k = x; k !== kEnd + side; k += side) if (tau[k] < hold) tau[k] = hold;
        edges.push({ r_km: +rad(x).toFixed(2), type: side < 0 ? 'outer edge of ring (inner edge of gap)' : 'inner edge of ring (outer edge of gap)' });
      }
    }
    i = j + 1;
  }
}

// ------------------------------------------------------------------ 5. masks, output
// A ring outer edge: last sample with tau > 0.1 before the Roche Division
let aEdge = idx(136_700);
while (aEdge < idx(136_900) && !(tau[aEdge] < 0.02 && tau[aEdge + 1] < 0.02 && tau[aEdge + 4] < 0.02)) aEdge++;
const dataMax = aEdge + Math.round(5 / DR);
for (let i = 0; i < N; i++) if (rad(i) < DATA_MIN_KM || i > dataMax) tau[i] = NaN;

const f32 = new Float32Array(N);
for (let i = 0; i < N; i++) f32[i] = Number.isFinite(tau[i]) ? tau[i] : NaN;
mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'tau_main.f32'), Buffer.from(f32.buffer));

// zone statistics
const stat = (a, b) => {
  let s = 0, c = 0, mx = 0, sT = 0;
  for (let i = idx(a); i < idx(b); i++) if (Number.isFinite(tau[i])) { s += tau[i]; c++; mx = Math.max(mx, tau[i]); sT += Math.exp(-tau[i] / 0.5); }
  return { mean: +(s / c).toFixed(3), max: +mx.toFixed(2) };
};
const nLower = lowerLimit.reduce((s, v) => s + v, 0);
const meta = {
  source: 'Cassini RSS Rev7E X-band + UVIS beta Cen x6 (visible tau)',
  r0_km: R0,
  dr_km: DR,
  n: N,
  quantity: 'normal optical depth, geometric / visible-equivalent (extinction efficiency 1)',
  notes: [
    `Shape: ${rssId} (Marouf, CO-SR-RSS-4/5-OCC-V2.0, 2018), 1 km resolution, 0.25 km sampling, ring elevation ${rssElev.toFixed(2)} deg, radii + pole/timing corrections.`,
    'Radio tau is an extinction tau (Q_ext = 2 for particles >> 3.6 cm): measured tau_X/tau_UVIS = 2.00 in the C ring and Cassini Division; RSS is rescaled by a 50 km smooth ratio map R = <tau_UVIS>/<tau_X/2> (R ~1.0 C ring, ~1.15 ramps, ~1.3-1.9 A ring, wake/geometry effects).',
    `B ring ${B_UVIS[0]}-${B_UVIS[1]} km (RSS saturated): mean TRANSMISSION of ${UVIS.length} UVIS HSP beta Cen occultations (Colwell et al., CO-SR-UVIS-HSP-2/4-OCC-V3.0), B = 66.7 deg, 1 km bins, registered to the RSS radius scale (offsets < 0.35 km); tau = -mu ln<T>; ${nLower} samples (${(nLower * DR).toFixed(0)} km, ${(100 * nLower * DR / (B_UVIS[1] - B_UVIS[0])).toFixed(1)}% of the B ring) are detection-limited (<T> < 2 sigma photon noise, i.e. tau > ~8) and are set to ${TAU_OPAQUE} (opaque).`,
    'Low-elevation views of the real A/B rings are more transparent than a homogeneous slab with this tau (self-gravity wakes): RSS at B = 23.6 deg sees ~25-45% lower normal tau in the A ring and ~40% lower in B1.',
    'Eccentric features (Titan, Maxwell, Huygens ringlets; B-ring outer edge m=2; A-ring outer edge m=7) and density-wave phases are a snapshot at the RSS Rev7E longitude (2005-123).',
    'Gap floors smoothed (+-1.5 km), negative noise clipped; gap edges deconvolved to steps at the half-level crossing (data resolution ~1 km; real edges are sharp at tens of m).',
    `NaN = no data: r < ${DATA_MIN_KM} km (D ring, tau ~1e-3 below detection) and r > ${rad(dataMax).toFixed(0)} km (Roche Division / F ring).`,
  ].join(' '),
  products: { rss: [rssId], uvis: UVIS, uvisRegistrationKm: Object.fromEntries(registration.map((x) => [x.id, x.off])) },
  zones: Object.fromEntries(RING_ZONES.filter((z) => z.macroscopic).map((z) => [z.key, stat(z.rInnerKm, z.rOuterKm)])),
  edges: edges.length,
};
writeFileSync(resolve(OUT, 'tau_main.json'), JSON.stringify(meta, null, 2) + '\n');

// derived components for diagnostics (sandbox/ringplot.html loads these in dev if present)
mkdirSync(DERIVED, { recursive: true });
const comp = { r0_km: R0, dr_km: DR, n: N, layers: ['tauX_geom', 'tauUVIS', 'ratio', 'wUVIS', 'tauUVIS_cap', 'final'] };
const L = [gX, tauU, ratio, wU, tauUcap, tau];
const buf = new Float32Array(N * L.length);
L.forEach((a, k) => { for (let i = 0; i < N; i++) buf[k * N + i] = Number.isFinite(a[i]) ? a[i] : NaN; });
writeFileSync(resolve(DERIVED, 'tau_components.f32'), Buffer.from(buf.buffer));
writeFileSync(resolve(DERIVED, 'tau_components.json'), JSON.stringify({ ...comp, edges, registration }, null, 2));

console.log('registration (km):', registration);
console.log('zones:', meta.zones);
console.log(`edges sharpened: ${edges.length}; lower-limit samples: ${nLower}; A ring edge at ${rad(aEdge)} km`);
console.log(`wrote ${resolve(OUT, 'tau_main.f32')} (${N} samples)`);
