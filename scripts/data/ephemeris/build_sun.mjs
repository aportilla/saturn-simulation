// Build public/data/ephemeris/sun_from_saturn.json from JPL Horizons:
// Sun (10) relative to Saturn's body centre (500@699), ICRF, geometric (VEC_CORR=NONE), km, TDB,
// 1990-01-01 .. 2060-01-01 (+ 2 steps margin each side for the 4-point Lagrange stencil), 5-day step.
// Format (see src/core/ephemeris.ts loadSunTable):
//   { frame:"ICRF", center:"699", target:"10", start_jd_tdb, step_days, pos_km:[x0,y0,z0,...], ...metadata }
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, horizonsRaw, parseVectors, parseSource } from './horizons.mjs';

const STEP = 5;
const START = 2447892.5 - 2 * STEP; // 1990-01-01 0h TDB minus 2 steps
const END = 2473459.5 + 3 * STEP; // 2060-01-01 0h TDB plus 3 steps
const N = Math.round((END - START) / STEP);
const txt = await horizonsRaw({
  target: '10', center: '500@699', start: `JD${START.toFixed(1)}`, stop: `JD${(START + N * STEP).toFixed(1)}`, step: `${STEP}d`, vecTable: '1',
});
const rows = parseVectors(txt);
if (rows.length !== N + 1) throw new Error(`expected ${N + 1} rows, got ${rows.length}`);
for (let i = 0; i < rows.length; i++) {
  if (Math.abs(rows[i].jd - (START + i * STEP)) > 1e-6) throw new Error(`irregular epoch at ${i}: ${rows[i].jd}`);
}
const pos = [];
for (const r of rows) pos.push(+r.x.toFixed(1), +r.y.toFixed(1), +r.z.toFixed(1));
const out = {
  frame: 'ICRF',
  center: '699',
  target: '10',
  start_jd_tdb: START,
  step_days: STEP,
  count: rows.length,
  pos_km: pos,
  source: `JPL Horizons (${parseSource(txt) || 'DE440'}), geometric state of the Sun relative to Saturn's centre, VEC_CORR=NONE, retrieved ${new Date().toISOString().slice(0, 10)}`,
  notes: 'Positions in km rounded to 0.1 km. 4-point Lagrange interpolation error < 1e-6 deg (see docs/data-sources.md).',
};
mkdirSync(resolve(ROOT, 'public/data/ephemeris'), { recursive: true });
writeFileSync(resolve(ROOT, 'public/data/ephemeris/sun_from_saturn.json'), JSON.stringify(out));
console.log(`wrote ${rows.length} epochs ${rows[0].jd} .. ${rows[rows.length - 1].jd}, source ${parseSource(txt)}`);
