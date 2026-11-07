// Fit the moon orbit models to JPL Horizons and save per-moon results to data-raw/moons_fit/<name>.json.
//   node scripts/data/moons/build_moons.mjs [Name ...]        (default: all moons)
// Then run assemble_moons.mjs to write public/data/moons/.
//
// Steps per moon:
//  1. global mean-element model (precessing ellipse + libration series) fitted by Levenberg–Marquardt to
//     sparse Horizons positions over the whole Horizons coverage (or cfg.globalSpan)
//  2. residual table (dLambda, dA, dK, dH, dQ, dP on a uniform grid, step cfg.H days) fitted by banded
//     Gauss–Newton to dense Horizons positions over the table span (1995..2055 clipped to coverage)
//  3. validation against *fresh* Horizons state vectors at random epochs 2020–2035 (+ 2026-11-07 00:00 and
//     12:00 TDB) and at epochs outside the table span
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MOONS, TABLE_SPAN, moonConfig } from './catalog.mjs';
import { ROOT } from '../ephemeris/horizons.mjs';
import { initOrbit, loadObs, loadEpochs } from './fitcore.mjs';
import { fitGlobal, fitTable, paramPaths } from './fitlib.mjs';
import { DEG, TWO_PI, frameMatrix, orbitStateSef, orbitPosSef, ricError } from './model.mjs';
import { makeWobble } from './wobble.mjs';

const OUT = resolve(ROOT, 'data-raw/moons_fit');
mkdirSync(OUT, { recursive: true });

// deterministic pseudo-random test epochs
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const JD2020 = 2458849.5, JD2035 = 2464328.5;
export const JD_TEST_A = 2461351.5; // 2026-11-07 00:00 TDB
export const JD_TEST_B = 2461352.0; // 2026-11-07 12:00 TDB

function testEpochs(cfg) {
  const r = rng(cfg.id * 7919);
  const ins = [];
  for (let i = 0; i < 40; i++) ins.push(JD2020 + r() * (JD2035 - JD2020));
  ins.push(JD_TEST_A, JD_TEST_B);
  const outs = [2436934.5, 2444391.5, 2449000.5, 2472884.5, 2480000.5, 2502000.5, 2524000.5] // 1960, 1980.4, 1993, 2059.6, 2079, 2139, 2199
    .filter((j) => j > cfg.cover[0] + 1 && j < cfg.cover[1] - 1);
  return { ins: ins.filter((j) => j > cfg.cover[0] + 1 && j < cfg.cover[1] - 1), outs };
}

function evalErrors(orbit, ep, wob = null) {
  const s = new Float64Array(6);
  const w0 = new Float64Array(3), wa = new Float64Array(3), wb = new Float64Array(3);
  const rows = [];
  for (let i = 0; i < ep.jd.length; i++) {
    orbitStateSef(orbit, ep.jd[i], s);
    if (wob) {
      // barycentric model -> Saturn-centric: add Saturn's reflex offset W (and its rate)
      const dt = 2 / 86400;
      wob(ep.jd[i], w0); wob(ep.jd[i] + dt, wa); wob(ep.jd[i] - dt, wb);
      for (let c = 0; c < 3; c++) { s[c] += w0[c]; s[3 + c] += (wa[c] - wb[c]) / (2 * dt * 86400); }
    }
    const tp = ep.pos.subarray(3 * i, 3 * i + 3), tv = ep.vel.subarray(3 * i, 3 * i + 3);
    const e = ricError(tp, tv, s);
    const dv = Math.hypot(s[3] - tv[0], s[4] - tv[1], s[5] - tv[2]) / Math.hypot(tv[0], tv[1], tv[2]);
    rows.push({ jd: ep.jd[i], ...e, dvRel: dv });
  }
  return rows;
}
function summarize(rows) {
  if (!rows.length) return null;
  const mx = (f) => Math.max(...rows.map((r) => Math.abs(r[f])));
  const rms = (f) => Math.sqrt(rows.reduce((s, r) => s + r[f] * r[f], 0) / rows.length);
  return {
    n: rows.length,
    alongDegMax: mx('alongDeg'), alongDegRms: rms('alongDeg'),
    angDegMax: mx('angDeg'),
    radialKmMax: mx('dr'), normalKmMax: mx('dn'), distKmMax: mx('dist'), distKmRms: rms('dist'),
    dvRelMax: mx('dvRel'),
  };
}

async function buildMoon(spec) {
  const [name, hOverride] = spec.split(':');
  const cfg = moonConfig(name);
  if (hOverride) cfg.H = parseFloat(hOverride);
  const t0 = Date.now();
  // barycentric moons (orbit the Saturn-system barycentre): fit to Horizons positions relative to 500@6
  const bary = cfg.center === 'barycenter';
  const center = bary ? '500@6' : '500@699';
  const wob = bary ? makeWobble() : null;
  // ---- 1. global
  const gs = cfg.globalSpan ?? cfg.cover;
  const gspan = gs[1] - gs[0];
  const longStep = gspan > 60000 ? 7.31 : gspan > 20000 ? 2.31 : 0.731;
  const obsL = await loadObs(cfg.id, gs[0] + 1, gs[1] - 1, longStep, { center });
  const orbit = initOrbit(cfg, obsL);
  const g1 = fitGlobal(orbit, obsL, paramPaths(orbit, { frame: orbit.fitFrame, libNu: true }), { iters: 60 });
  // ---- 2. table
  const tA = Math.max(TABLE_SPAN[0], cfg.cover[0] + 2);
  const tB = Math.min(TABLE_SPAN[1], cfg.cover[1] - 2);
  const H = cfg.H;
  const N = Math.floor((tB - tA) / H) + 1;
  const P = cfg.ssd[6];
  let tf, obsD;
  if (cfg.tableKind === 'cartesian') {
    // long-period, strongly perturbed orbits: Cartesian SEF residual (Horizons - mean model) sampled exactly
    // at the table nodes and Lagrange-interpolated
    orbit.table = null;
    obsD = await loadObs(cfg.id, tA, tA + (N - 1) * H, H, { center });
    if (obsD.jd.length !== N) throw new Error(`node count mismatch ${obsD.jd.length} vs ${N}`);
    const data = new Float64Array(N * 3);
    const s = new Float64Array(3);
    for (let j = 0; j < N; j++) {
      orbitPosSef(orbit, obsD.jd[j], s);
      for (let c = 0; c < 3; c++) data[3 * j + c] = obsD.pos[3 * j + c] - s[c];
    }
    orbit.table = { kind: 'cartesian', startJd: tA, step: H, count: N, taper: cfg.taper ?? 365, data };
    tf = { rms: 0 };
  } else {
  orbit.table = { kind: 'elements', startJd: tA, step: H, count: N, taper: cfg.taper ?? 365, data: new Float64Array(N * 6) };
  // ~7 samples per table interval; if a sample step exceeds ~P/1.5, make the orbital phase advance per
  // sample a golden-ratio fraction of the orbit so that every table interval sees all orbital phases
  const target = H / (cfg.samplesPerStep ?? 7.13);
  let dstep = target;
  if (target > P / 1.5) {
    const kk = Math.max(0, Math.floor(target / P - 0.382));
    dstep = P * (kk + 0.381966);
  }
  obsD = await loadObs(cfg.id, tA, tA + (N - 1) * H, dstep, { center });
  const ridge = cfg.ridge ?? [3, 300, 0.05, 0.05, 0.05, 0.05];
  tf = fitTable(orbit, obsD, { iters: cfg.tableIters ?? 4, ridge, smooth: cfg.smooth ?? null });
  }
  // ---- 3. validation (fresh Horizons queries at epochs not used in the fit)
  const te = testEpochs(cfg);
  const epIn = te.ins.length ? await loadEpochs(cfg.id, te.ins) : null;
  const epOut = te.outs.length ? await loadEpochs(cfg.id, te.outs) : null;
  const rowsIn = epIn ? evalErrors(orbit, epIn, wob) : [];
  const rowsOut = epOut ? evalErrors(orbit, epOut, wob) : [];
  // error of the global model alone (no table) at the in-span test epochs
  const tbSaved = orbit.table;
  orbit.table = null;
  const rowsInGlobal = epIn ? evalErrors(orbit, epIn, wob) : [];
  orbit.table = tbSaved;
  const res = {
    name: cfg.name, id: cfg.id, source: obsL.source, center: bary ? 'barycenter' : 'saturn',
    globalSpan: [gs[0] + 1, gs[1] - 1], globalObs: obsL.jd.length, globalRmsKm: g1.rms,
    tableObs: obsD.jd.length, tableRmsKm: tf.rms,
    orbit: {
      R: frameMatrix(orbit), a: orbit.a, n: orbit.n, lambda0: ((orbit.lambda0 % TWO_PI) + TWO_PI) % TWO_PI,
      k0: orbit.k0, h0: orbit.h0, pidot: orbit.pidot, q0: orbit.q0, p0: orbit.p0, Omdot: orbit.Omdot,
      lib: orbit.lib.map((L) => { const o = { ...L }; delete o.fixNu; return o; }),
      table: { kind: orbit.table.kind, startJd: tA, step: H, count: N, taper: orbit.table.taper, data: Array.from(orbit.table.data) },
    },
    validation: {
      in2020_2035: summarize(rowsIn.filter((r) => r.jd !== JD_TEST_A && r.jd !== JD_TEST_B)),
      in2020_2035_globalOnly: summarize(rowsInGlobal),
      at20261107: rowsIn.filter((r) => r.jd === JD_TEST_A || r.jd === JD_TEST_B),
      outside: rowsOut,
    },
    seconds: (Date.now() - t0) / 1000,
  };
  writeFileSync(resolve(OUT, `${cfg.name.toLowerCase()}.json`), JSON.stringify(res));
  const v = res.validation.in2020_2035;
  const vg = res.validation.in2020_2035_globalOnly;
  const at = res.validation.at20261107;
  console.log(
    `${cfg.name.padEnd(11)} H=${H} N=${N} tableRms=${tf.rms.toFixed(3)}km | 2020-35: along max ${v ? v.alongDegMax.toFixed(4) : '-'}° rms ${v ? v.alongDegRms.toFixed(4) : '-'}°, dist max ${v ? v.distKmMax.toFixed(2) : '-'} km, dv ${v ? v.dvRelMax.toExponential(1) : '-'} | global-only max ${vg ? vg.alongDegMax.toFixed(3) : '-'}° | 2026-11-07: ${at.map((r) => r.alongDeg.toFixed(4) + '°/' + r.dist.toFixed(2) + 'km').join(' ')} | out: ${rowsOut.map((r) => r.angDeg.toFixed(2)).join(',')} (${res.seconds.toFixed(0)}s)`,
  );
  return res;
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : MOONS.map((m) => m.name);
for (const n of names) {
  try {
    await buildMoon(n);
  } catch (e) {
    console.log(`${n}: FAILED ${e.stack ?? e}`);
  }
}
