// Assemble public/data/moons/ from the per-moon fits in data-raw/moons_fit/ (run build_moons.mjs first):
//   moons.json             catalog, physical data, rotation models, orbit models (format: docs/data-sources.md)
//   moon_tables.i16        all residual tables, little-endian int16 (value = int16 * scale[field])
//   hyperion_rotation.f32  Hyperion rotation checkpoints, little-endian float32 [qx,qy,qz,qw, wx,wy,wz] each
// It re-validates every moon with the *quantised* tables against the (cached) Horizons test epochs and writes
// the accuracy summary into moons.json and data-raw/moons_fit/accuracy.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../ephemeris/horizons.mjs';
import { MOONS, moonConfig } from './catalog.mjs';
import { reflectanceTint } from './colors.mjs';
import { DEG, EPOCH_JD, orbitPosSef, orbitStateSef, ricError } from './model.mjs';
import { loadEpochs } from './fitcore.mjs';
import { GM_SATURN, WOBBLE_MOONS } from './wobble.mjs';
import * as HR from './hyperion_rot.mjs';

const OUTDIR = resolve(ROOT, 'public/data/moons');
mkdirSync(OUTDIR, { recursive: true });
const G = 6.6743e-20; // km^3 kg^-1 s^-2

const fits = MOONS.map((m) => {
  const r = JSON.parse(readFileSync(resolve(ROOT, 'data-raw/moons_fit', `${m.name.toLowerCase()}.json`), 'utf8'));
  return { cfg: moonConfig(m.name), fit: r };
});
// Output order (= MoonState array order). Shaders take only the first MAX_MOONS (32) entries, so the major
// moons come first, then the ring moons, then the rest by distance (orchestrator/far-field requirement).
const ORDER = ['Mimas', 'Enceladus', 'Tethys', 'Dione', 'Rhea', 'Titan', 'Iapetus', 'Hyperion', 'Phoebe',
  'Pan', 'Daphnis', 'Atlas', 'Prometheus', 'Pandora', 'Janus', 'Epimetheus'];
const rank = (f) => { const i = ORDER.indexOf(f.cfg.name); return i >= 0 ? i : ORDER.length; };
fits.sort((a, b) => rank(a) - rank(b) || a.fit.orbit.a - b.fit.orbit.a);

// ---------------------------------------------------------------- quantise tables
// element tables -> int16 with per-field scales (quantisation error << fit error);
// Cartesian tables (residuals up to ~1e7 km for the irregulars) -> float32
const chunks = [];
const chunksF = [];
let offset = 0, offsetF = 0;
for (const f of fits) {
  const tb = f.fit.orbit.table;
  tb.kind = tb.kind ?? 'elements';
  const NF = tb.kind === 'cartesian' ? 3 : 6;
  const deq = new Float64Array(tb.data.length);
  if (tb.kind === 'cartesian') {
    const q = Float32Array.from(tb.data);
    for (let j = 0; j < q.length; j++) deq[j] = q[j];
    chunksF.push(q);
    f.table = { kind: tb.kind, store: 'f32', startJd: tb.startJd, step: tb.step, count: tb.count, taper: tb.taper, offset: offsetF, scale: [1, 1, 1] };
    offsetF += q.length;
  } else {
    const scale = [];
    for (let c = 0; c < NF; c++) {
      let mx = 0;
      for (let j = c; j < tb.data.length; j += NF) mx = Math.max(mx, Math.abs(tb.data[j]));
      scale.push(mx > 0 ? mx / 32767 : 1);
    }
    const q = new Int16Array(tb.data.length);
    for (let j = 0; j < tb.data.length; j++) {
      const s = scale[j % NF];
      q[j] = Math.max(-32767, Math.min(32767, Math.round(tb.data[j] / s)));
      deq[j] = q[j] * s;
    }
    chunks.push(q);
    f.table = { kind: tb.kind, store: 'i16', startJd: tb.startJd, step: tb.step, count: tb.count, taper: tb.taper, offset, scale };
    offset += q.length;
  }
  f.orbitQ = { ...f.fit.orbit, Rfix: f.fit.orbit.R, table: { ...tb, data: deq } };
  delete f.orbitQ.R;
}
const all = new Int16Array(offset);
let o = 0;
for (const c of chunks) { all.set(c, o); o += c.length; }
writeFileSync(resolve(OUTDIR, 'moon_tables.i16'), Buffer.from(all.buffer));
const allF = new Float32Array(offsetF);
o = 0;
for (const c of chunksF) { allF.set(c, o); o += c.length; }
writeFileSync(resolve(OUTDIR, 'moon_tables.f32'), Buffer.from(allF.buffer));

// ---------------------------------------------------------------- wobble (Saturn reflex) from quantised models
const byName = Object.fromEntries(fits.map((f) => [f.cfg.name, f]));
const wobTerms = WOBBLE_MOONS.map((n) => ({ mu: byName[n].cfg.gm / GM_SATURN, orbit: byName[n].orbitQ }));
const musum = wobTerms.reduce((s, t) => s + t.mu, 0);
const wp = new Float64Array(3);
function wobble(jd, out) {
  out[0] = out[1] = out[2] = 0;
  for (const t of wobTerms) {
    orbitPosSef(t.orbit, jd, wp);
    for (let c = 0; c < 3; c++) out[c] += (t.mu * wp[c]) / (1 + musum);
  }
  return out;
}

// ---------------------------------------------------------------- re-validate (quantised) against cached Horizons epochs
function rngf(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const JD2020 = 2458849.5, JD2035 = 2464328.5, JD_A = 2461351.5, JD_B = 2461352.0;
async function validate(f) {
  const cfg = f.cfg;
  const r = rngf(cfg.id * 7919);
  const ins = [];
  for (let i = 0; i < 40; i++) ins.push(JD2020 + r() * (JD2035 - JD2020));
  ins.push(JD_A, JD_B);
  const inside = ins.filter((j) => j > cfg.cover[0] + 1 && j < cfg.cover[1] - 1);
  if (!inside.length) return null;
  const ep = await loadEpochs(cfg.id, inside);
  const s = new Float64Array(6), w0 = new Float64Array(3), wa = new Float64Array(3), wb = new Float64Array(3);
  const rows = [];
  for (let i = 0; i < ep.jd.length; i++) {
    orbitStateSef(f.orbitQ, ep.jd[i], s);
    if (f.fit.center === 'barycenter') {
      const dt = 2 / 86400;
      wobble(ep.jd[i], w0); wobble(ep.jd[i] + dt, wa); wobble(ep.jd[i] - dt, wb);
      for (let c = 0; c < 3; c++) { s[c] += w0[c]; s[3 + c] += (wa[c] - wb[c]) / (2 * dt * 86400); }
    }
    const tp = ep.pos.subarray(3 * i, 3 * i + 3), tv = ep.vel.subarray(3 * i, 3 * i + 3);
    const e = ricError(tp, tv, s);
    const dv = Math.hypot(s[3] - tv[0], s[4] - tv[1], s[5] - tv[2]) / Math.hypot(tv[0], tv[1], tv[2]);
    rows.push({ jd: ep.jd[i], ...e, dvRel: dv });
  }
  const main = rows.filter((x) => x.jd !== JD_A && x.jd !== JD_B);
  const mx = (a, k) => Math.max(...a.map((x) => Math.abs(x[k])));
  const rms = (a, k) => Math.sqrt(a.reduce((t, x) => t + x[k] * x[k], 0) / a.length);
  const a1 = rows.find((x) => x.jd === JD_A), b1 = rows.find((x) => x.jd === JD_B);
  return {
    n: main.length,
    alongDegMax: +mx(main, 'alongDeg').toPrecision(3), alongDegRms: +rms(main, 'alongDeg').toPrecision(3),
    angDegMax: +mx(main, 'angDeg').toPrecision(3),
    distKmMax: +mx(main, 'dist').toPrecision(3), distKmRms: +rms(main, 'dist').toPrecision(3),
    radialKmMax: +mx(main, 'dr').toPrecision(3), normalKmMax: +mx(main, 'dn').toPrecision(3),
    velRelMax: +mx(main, 'dvRel').toPrecision(2),
    at20261107: [a1, b1].filter(Boolean).map((x) => ({ jd: x.jd, alongDeg: +x.alongDeg.toPrecision(3), distKm: +x.dist.toPrecision(3) })),
  };
}

// ---------------------------------------------------------------- Hyperion rotation checkpoints
const hyp = byName.Hyperion;
const HYP_STEP = 4;
const hypTb = hyp.table;
const hStart = hypTb.startJd + hypTb.step; // checkpoint grid inside the orbit table's interpolation range
const hEnd = hypTb.startJd + (hypTb.count - 2) * hypTb.step;
const hCount = Math.floor((hEnd - hStart) / HYP_STEP) + 1;
{
  const pos = new Float64Array(3);
  const sat = (jd, out) => {
    orbitPosSef(hyp.orbitQ, jd, pos);
    const r = Math.hypot(pos[0], pos[1], pos[2]);
    out[0] = -pos[0] / r; out[1] = -pos[1] / r; out[2] = -pos[2] / r;
    out[3] = (3 * HR.GM_SATURN_KM3_D2) / (r * r * r);
  };
  const h = 0.005;
  const ck = new Float32Array(hCount * 7);
  const put = (k, y) => { for (let i = 0; i < 7; i++) ck[7 * k + i] = y[i]; };
  const kEpoch = (HR.HYP_EPOCH_JD - hStart) / HYP_STEP;
  // forward
  let y = HR.initialState();
  let t = HR.HYP_EPOCH_JD;
  let kf = Math.ceil(kEpoch - 1e-9);
  while (kf < hCount) {
    const target = hStart + kf * HYP_STEP;
    const n = Math.round((target - t) / h);
    for (let i = 0; i < n; i++) { HR.rk4(y, t, h, sat); t += h; }
    t = target;
    put(kf, y);
    kf++;
  }
  // backward
  y = HR.initialState();
  t = HR.HYP_EPOCH_JD;
  let kb = Math.floor(kEpoch + 1e-9);
  if (kb === Math.ceil(kEpoch - 1e-9)) kb--; // already stored
  while (kb >= 0) {
    const target = hStart + kb * HYP_STEP;
    const n = Math.round((t - target) / h);
    for (let i = 0; i < n; i++) { HR.rk4(y, t, -h, sat); t -= h; }
    t = target;
    put(kb, y);
    kb--;
  }
  writeFileSync(resolve(OUTDIR, 'hyperion_rotation.f32'), Buffer.from(ck.buffer));
  // sanity: spin period statistics
  let wsum = 0;
  for (let k = 0; k < hCount; k++) wsum += Math.hypot(ck[7 * k + 4], ck[7 * k + 5], ck[7 * k + 6]);
  console.log(`Hyperion: ${hCount} rotation checkpoints, mean |w| = ${((wsum / hCount) / DEG).toFixed(1)} deg/day`);
}

// ---------------------------------------------------------------- catalogue JSON
const moonsOut = [];
const accRows = [];
for (const f of fits) {
  const c = f.cfg;
  const [ra, rb, rc] = c.radii;
  const meanR = Math.cbrt(ra * rb * rc);
  let gm = c.gm, gmEstimated = !!c.gmEstimated;
  if (gm == null || gmEstimated) {
    const rho = c.density ?? (c.kind === 'irregular' ? 1500 : 500);
    gm = G * rho * 1e9 * ((4 / 3) * Math.PI * ra * rb * rc);
    gmEstimated = true;
  }
  let rotation;
  if (c.rot === 'sync') rotation = { type: 'synchronous', librationDeg: c.librationDeg ?? 0 };
  else if (c.rot === 'iau') rotation = { type: 'iau', poleRaDeg: c.iau.ra, poleDecDeg: c.iau.dec, w0Deg: c.iau.w0, wDotDegPerDay: c.iau.wdot, estimated: !!c.iau.estimated };
  else rotation = {
    type: 'chaotic', file: 'data/moons/hyperion_rotation.f32', startJd: hStart, step: HYP_STEP, count: hCount,
    k: HR.HYP_K, gmSaturnKm3PerDay2: HR.GM_SATURN_KM3_D2, epochJd: HR.HYP_EPOCH_JD, maxSubstepDays: 0.05,
  };
  const acc = await validate(f);
  const ob = f.fit.orbit;
  moonsOut.push({
    id: c.id, name: c.name, kind: c.kind, textureKey: c.name.toLowerCase(),
    radiiKm: c.radii, meanRadiusKm: +meanR.toFixed(3), gmKm3s2: +gm.toPrecision(6), gmEstimated,
    albedo: c.albedo, color: reflectanceTint(c.colorIdx.bv, c.colorIdx.vr).map((v) => +v.toFixed(4)),
    colorIndex: c.colorIdx,
    rotation,
    center: f.fit.center ?? 'saturn',
    orbit: {
      R: ob.R, a: ob.a, n: ob.n, lambda0: ob.lambda0, k0: ob.k0, h0: ob.h0, pidot: ob.pidot,
      q0: ob.q0, p0: ob.p0, Omdot: ob.Omdot, lib: ob.lib, table: f.table,
    },
    ephemeris: {
      source: `JPL Horizons ${f.fit.source}`, horizonsCoverageJd: c.cover, globalFitJd: f.fit.globalSpan,
      tableJd: [f.table.startJd, f.table.startJd + (f.table.count - 1) * f.table.step],
    },
    accuracy2020to2035: acc,
  });
  accRows.push({ name: c.name, H: f.table.step, kind: f.table.kind, acc, out: f.fit.validation.outside, globalOnly: f.fit.validation.in2020_2035_globalOnly });
}

const out = {
  format: 'space-viz-moons/1',
  generated: new Date().toISOString(),
  frame: 'SEF',
  epochJdTdb: EPOCH_JD,
  units: { length: 'km', time: 'day (TDB)', angle: 'rad', rate: 'rad/day', velocity: 'km/s' },
  tables: {
    i16: { file: 'data/moons/moon_tables.i16', type: 'int16le', count: all.length },
    f32: { file: 'data/moons/moon_tables.f32', type: 'float32le', count: allF.length },
  },
  wobble: { moons: WOBBLE_MOONS, mu: wobTerms.map((t) => t.mu), note: 'Saturn centre - system barycentre offset W = sum mu_i r_i / (1 + sum mu); barycentric moons: r = r_model + W' },
  moons: moonsOut,
};
writeFileSync(resolve(OUTDIR, 'moons.json'), JSON.stringify(out));

// accuracy table (markdown) for docs
let md = '| moon | table | 2020–2035 along-track max (°) | rms (°) | max error (km) | 2026-11-07 00:00 / 12:00 (km) | global model only, max (°) | outside table (°, Saturn-centred angle) |\n|---|---|---|---|---|---|---|---|\n';
for (const r of accRows) {
  const a = r.acc;
  md += `| ${r.name} | ${r.kind ?? 'elements'} ${r.H} d | ${a ? a.alongDegMax : 'n/a'} | ${a ? a.alongDegRms : 'n/a'} | ${a ? a.distKmMax : 'n/a'} | ${a ? a.at20261107.map((x) => x.distKm).join(' / ') : 'n/a'} | ${r.globalOnly ? r.globalOnly.alongDegMax.toFixed(3) : 'n/a'} | ${r.out.map((x) => `${(2000 + (x.jd - 2451545) / 365.25).toFixed(0)}: ${x.angDeg.toFixed(2)}`).join(', ')} |\n`;
}
writeFileSync(resolve(ROOT, 'data-raw/moons_fit/accuracy.md'), md);
console.log(md);
console.log(`tables: ${all.length} int16 (${(all.length * 2 / 1024).toFixed(0)} KiB) + ${allF.length} float32 (${(allF.length * 4 / 1024).toFixed(0)} KiB); moons.json ${(JSON.stringify(out).length / 1024).toFixed(0)} KiB`);
