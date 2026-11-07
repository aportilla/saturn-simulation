// Verification of the RUNTIME TypeScript modules (src/moons/MoonSystem.ts, src/core/ephemeris.ts) against
// fresh JPL Horizons state vectors. Bundle + run (see docs/data-sources.md):
//   node_modules/.bin/rolldown scripts/data/moons/verify_runtime.ts --file <tmp>/verify.mjs --format esm --platform node
//   SV_ROOT=$PWD node <tmp>/verify.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { createMoonSystem, type MoonsFileJson } from '../../../src/moons/MoonSystem';
import type { MoonState } from '../../../src/core/FrameState';
import { loadSunTable, sunFromSaturnSef, ICRF_TO_SEF } from '../../../src/core/ephemeris';
import { tdbFromJd } from '../../../src/core/time';
// @ts-ignore - JS build helpers
import { loadEpochs } from './fitcore.mjs';
// @ts-ignore
import { horizonsVectors } from '../ephemeris/horizons.mjs';

const ROOT = process.env.SV_ROOT ?? process.cwd();
const pub = (p: string) => resolve(ROOT, 'public', p);
const buf = (p: string) => { const b = readFileSync(pub(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const json = JSON.parse(readFileSync(pub('data/moons/moons.json'), 'utf8')) as MoonsFileJson;
const sys = createMoonSystem(json, buf(json.tables.i16.file), buf(json.tables.f32.file), buf('data/moons/hyperion_rotation.f32'));
const states: MoonState[] = [];

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const JD2020 = 2458849.5, JD2035 = 2464328.5, JD_A = 2461351.5, JD_B = 2461352.0;

// ------------------------------------------------------------------ 1. positions vs Horizons
console.log('## Moon positions: runtime MoonSystem vs Horizons (random epochs 2020-2035, n=40 each)');
console.log('| moon | along-track max (deg) | rms (deg) | |dr| max (km) | max error (km) | rel. velocity error max | 2026-11-07 00:00 / 12:00 TDB error (km) |');
console.log('|---|---|---|---|---|---|---|');
let worstAlong = 0;
for (let i = 0; i < json.moons.length; i++) {
  const m = json.moons[i];
  const r = rng(m.id * 7919);
  const jds: number[] = [];
  for (let k = 0; k < 40; k++) jds.push(JD2020 + r() * (JD2035 - JD2020));
  jds.push(JD_A, JD_B);
  const cov = m.ephemeris.horizonsCoverageJd;
  const ok = jds.filter((j) => j > cov[0] + 1 && j < cov[1] - 1);
  if (!ok.length) { console.log(`| ${m.name} | n/a (no Horizons ephemeris after ${(2000 + (cov[1] - 2451545) / 365.25).toFixed(2)}) | | | | | |`); continue; }
  const ep = await loadEpochs(m.id, ok);
  let amax = 0, a2 = 0, drmax = 0, dmax = 0, dvmax = 0, n = 0;
  const at: string[] = [];
  for (let k = 0; k < ep.jd.length; k++) {
    sys.getStates(tdbFromJd(ep.jd[k]), states);
    const s = states[i];
    const tp = new Vector3(ep.pos[3 * k], ep.pos[3 * k + 1], ep.pos[3 * k + 2]);
    const tv = new Vector3(ep.vel[3 * k], ep.vel[3 * k + 1], ep.vel[3 * k + 2]);
    const mp = s.pos.clone().multiplyScalar(1e-3);
    const mv = s.vel.clone().multiplyScalar(1e-3);
    const d = mp.clone().sub(tp);
    const R = tp.clone().normalize();
    const N = tp.clone().cross(tv).normalize();
    const T = N.clone().cross(R);
    const along = Math.atan2(d.dot(T), tp.length()) * 180 / Math.PI;
    const dist = d.length();
    if (ep.jd[k] === JD_A || ep.jd[k] === JD_B) { at.push(dist.toFixed(2)); continue; }
    n++;
    amax = Math.max(amax, Math.abs(along)); a2 += along * along;
    drmax = Math.max(drmax, Math.abs(d.dot(R))); dmax = Math.max(dmax, dist);
    dvmax = Math.max(dvmax, mv.clone().sub(tv).length() / tv.length());
  }
  worstAlong = Math.max(worstAlong, amax);
  console.log(`| ${m.name} | ${amax.toPrecision(3)} | ${Math.sqrt(a2 / n).toPrecision(3)} | ${drmax.toPrecision(3)} | ${dmax.toPrecision(3)} | ${dvmax.toPrecision(2)} | ${at.join(' / ')} |`);
}
console.log(`worst along-track error over all moons: ${worstAlong.toPrecision(3)} deg`);

// ------------------------------------------------------------------ 2. performance & allocation
{
  const t0 = tdbFromJd(JD_A);
  for (let k = 0; k < 2000; k++) sys.getStates(t0 + k * 37.3, states); // warm-up
  const N = 20000;
  const h0 = process.memoryUsage().heapUsed;
  const c0 = performance.now();
  for (let k = 0; k < N; k++) sys.getStates(t0 + k * 61.7 * (k % 2 ? 1 : -1), states);
  const c1 = performance.now();
  const h1 = process.memoryUsage().heapUsed;
  console.log(`\n## Performance: getStates for ${json.moons.length} moons: ${((c1 - c0) * 1000 / N).toFixed(1)} us/call (Node ${process.version}); heap delta over ${N} calls: ${((h1 - h0) / 1024).toFixed(0)} KiB`);
}

// ------------------------------------------------------------------ 2b. robustness far outside the fitted spans
{
  const years = [-3000, 0, 1000, 1700, 1800, 1900, 1950, 1994, 2056, 2100, 2200, 2500, 3000, 5000];
  let bad = 0;
  const rows: string[] = [];
  for (const y of years) {
    const t = (y - 2000) * 365.25 * 86400;
    sys.getStates(t, states);
    let worst = 0, worstName = '';
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      const r = s.pos.length() / 1e3, a = json.moons[i].orbit.a;
      const ok = Number.isFinite(r) && Number.isFinite(s.vel.x) && Number.isFinite(s.orient.w) && r > 0.3 * a && r < 2.5 * a;
      if (!ok) { bad++; rows.push(`  ${y}: ${s.name} r=${r} a=${a}`); }
      const dev = Math.abs(r / a - 1);
      if (dev > worst) { worst = dev; worstName = s.name; }
    }
    rows.push(`  year ${y}: all finite; largest |r/a - 1| = ${worst.toFixed(3)} (${worstName})`);
  }
  console.log(`\n## Robustness outside the fitted spans (${years.length} epochs from 3000 BC to 5000 AD): ${bad === 0 ? 'OK' : bad + ' FAILURES'}`);
  console.log(rows.join('\n'));
}

// ------------------------------------------------------------------ 3. rotation checks
{
  const iM = sys.indexOf('Mimas');
  const iH = sys.indexOf('Hyperion');
  const iP = sys.indexOf('Phoebe');
  const t0 = tdbFromJd(JD_A);
  // synchronous: body +x vs. direction to Saturn over one orbit (optical + physical libration)
  let maxLib = 0, minDot = 1;
  for (let k = 0; k < 200; k++) {
    sys.getStates(t0 + k * 0.9424 * 86400 / 200, states);
    const s = states[iM];
    const bx = new Vector3(1, 0, 0).applyQuaternion(s.orient);
    const bz = new Vector3(0, 0, 1).applyQuaternion(s.orient);
    const toS = s.pos.clone().multiplyScalar(-1).normalize();
    const lib = Math.atan2(bx.clone().cross(toS).dot(bz), bx.dot(toS)) * 180 / Math.PI;
    maxLib = Math.max(maxLib, Math.abs(lib));
    const h = s.pos.clone().cross(s.vel).normalize();
    minDot = Math.min(minDot, bz.dot(h));
  }
  console.log(`\n## Rotation\nMimas: max angle between body +x and the Saturn direction over an orbit = ${maxLib.toFixed(3)} deg (expect ~2e+0.84 = ${(2 * 0.0196 * 180 / Math.PI + 0.84).toFixed(2)}); min cos(+z, orbit normal) = ${minDot.toFixed(6)}`);
  // Hyperion: smoothness across checkpoint boundaries (step 4 d) incl. the forward/backward switch points
  const q0 = new Quaternion(), q1 = new Quaternion();
  let maxStep = 0, maxRate = 0;
  const dt = 0.01 * 86400;
  const tStart = t0 - 3 * 86400;
  sys.getStates(tStart, states); q0.copy(states[iH].orient);
  for (let k = 1; k <= 1200; k++) {
    sys.getStates(tStart + k * dt, states); q1.copy(states[iH].orient);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(q0.dot(q1)))) * 180 / Math.PI;
    maxStep = Math.max(maxStep, ang);
    q0.copy(q1);
  }
  maxRate = maxStep / 0.01;
  // switch-point continuity: orientation just before/after the midpoint between two checkpoints
  const spec = json.moons[iH].rotation as any;
  const tMid = tdbFromJd(spec.startJd + (Math.round((JD_A - spec.startJd) / spec.step) + 0.5) * spec.step);
  sys.getStates(tMid - 1e-3, states); q0.copy(states[iH].orient);
  sys.getStates(tMid + 1e-3, states); q1.copy(states[iH].orient);
  const jump = 2 * Math.acos(Math.min(1, Math.abs(q0.dot(q1)))) * 180 / Math.PI;
  console.log(`Hyperion: over 12 days sampled every 0.01 d the largest per-step rotation is ${maxStep.toFixed(3)} deg (=> max ${maxRate.toFixed(1)} deg/day); orientation jump across a checkpoint switch point (2 ms apart): ${jump.toExponential(2)} deg`);
  // time reversal: same orientation when approached backwards
  sys.getStates(t0 + 1.2345 * 86400, states); q0.copy(states[iH].orient);
  sys.getStates(t0 + 100 * 86400, states);
  sys.getStates(t0 + 1.2345 * 86400, states); q1.copy(states[iH].orient);
  console.log(`Hyperion determinism (revisit after jumping ahead): ${(2 * Math.acos(Math.min(1, Math.abs(q0.dot(q1)))) * 180 / Math.PI).toExponential(2)} deg`);
  // Phoebe rotation period check
  sys.getStates(t0, states); q0.copy(states[iP].orient);
  sys.getStates(t0 + 9.2735 * 3600, states); q1.copy(states[iP].orient);
  console.log(`Phoebe: rotation after 9.2735 h = ${(2 * Math.acos(Math.min(1, Math.abs(q0.dot(q1)))) * 180 / Math.PI).toFixed(3)} deg (IAU W rate 931.639 deg/d => period 9.27354 h)`);
}

// ------------------------------------------------------------------ 4. Sun table and Standish fallback
{
  const sunJson = readFileSync(pub('data/ephemeris/sun_from_saturn.json'), 'utf8');
  const realFetch = globalThis.fetch;
  const mock = async () => new Response(sunJson, { status: 200, headers: { 'content-type': 'application/json' } });
  // Standish first (no table loaded yet)
  const r = rng(424242);
  const jds: number[] = [];
  for (let k = 0; k < 60; k++) jds.push(2447892.5 + r() * (2473459.5 - 2447892.5));
  jds.push(JD_A, JD_B);
  const truth: any[] = [];
  for (let k = 0; k < jds.length; k += 50) truth.push(...(await horizonsVectors({ target: '10', center: '500@699', tlist: jds.slice(k, k + 50), vecTable: '2' })));
  const v = new Vector3();
  const ang = (a: Vector3, b: Vector3) => Math.acos(Math.min(1, a.clone().normalize().dot(b.clone().normalize()))) * 180 / Math.PI;
  let stdMax = 0, stdMaxIn = 0;
  for (const row of truth) {
    const tv = new Vector3(row.x, row.y, row.z).applyMatrix3(ICRF_TO_SEF);
    sunFromSaturnSef(tdbFromJd(row.jd), v);
    const e = ang(v, tv);
    stdMax = Math.max(stdMax, e);
    if (row.jd >= JD2020 && row.jd <= JD2035) stdMaxIn = Math.max(stdMaxIn, e);
  }
  (globalThis as any).fetch = mock;
  const ok = await loadSunTable('x');
  (globalThis as any).fetch = realFetch;
  let tabMax = 0, distMax = 0;
  for (const row of truth) {
    const tv = new Vector3(row.x, row.y, row.z).applyMatrix3(ICRF_TO_SEF);
    sunFromSaturnSef(tdbFromJd(row.jd), v);
    tabMax = Math.max(tabMax, ang(v, tv));
    distMax = Math.max(distMax, Math.abs(v.length() / 1000 - tv.length()));
  }
  console.log(`\n## Sun direction from Saturn vs Horizons (${truth.length} random epochs 1990-2060 incl. 2026-11-07)`);
  console.log(`table loaded: ${ok}; table max error ${(tabMax * 3600).toFixed(4)} arcsec (${tabMax.toExponential(2)} deg), max distance error ${distMax.toFixed(1)} km`);
  console.log(`Standish fallback (no table): max error ${stdMax.toFixed(4)} deg over 1990-2060, ${stdMaxIn.toFixed(4)} deg over 2020-2035`);
}
