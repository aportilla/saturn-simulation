#!/usr/bin/env node
// Prints the vertical-relief model's numbers (src/rings/relief.ts, docs/ring-physics.md section 10): per bending wave
// the resonance radius, pattern speed, length scale W, damping length, linear-theory amplitude (forcing from the
// moon's mass and inclination via the Laplace coefficient, SCL83) vs the calibrated one, peak height and maximum slope
// and their distances from the resonance, the local wavelength at a few distances; the corrugation's wavelengths and
// amplitudes at a few epochs and radii; the relief sites; equinox shadow lengths h / tan B. Node >= 23 (imports the
// TypeScript sources directly, type stripping).
// usage: node scripts/data/rings/relief_check.mjs [--t ISO]
import { orbitalFrequencies } from '../../../src/core/constants.ts';
import { BENDING_WAVES, CORRUGATION, REGION_A, REGION_A_CELLS, RingRelief, buildWaveTable, regionACell, sampleWave, tFromIso } from '../../../src/rings/relief.ts';

const args = process.argv.slice(2);
const ti = args.indexOf('--t');
const tIso = ti >= 0 ? args[ti + 1] : '2026-11-08T12:00:00Z';
const DEG = Math.PI / 180, DAY = 86400;
const km = (x) => (x / 1e3).toFixed(1);

console.log('# Bending waves (SCL83 linear theory, tables of src/rings/relief.ts)');
for (const d of BENDING_WAVES) {
  const T = buildWaveTable(d, orbitalFrequencies);
  console.log(`\n${d.name} (m = ${d.m}, ${d.kind}): r_V = ${km(T.rV)} km${d.rV ? ' (given)' : ' (J2..J6 resonance condition)'}, pattern speed ${((T.patternSpeed / DEG) * DAY).toFixed(4)} deg/day, propagates ${T.side > 0 ? 'outward' : 'inward'}`);
  console.log(`  sigma ${d.sigma} kg/m^2, nu ${(d.nuVisc * 1e4).toFixed(1)} cm^2/s: W = ${km(T.W)} km, x_D = ${km(T.xD)} km, D' = ${T.dD.toExponential(4)} s^-2 m^-1`);
  console.log(`  linear A_V = ${Number.isFinite(T.AVlinear) ? T.AVlinear.toFixed(0) + ' m (forcing ' + T.forcing.toExponential(3) + ' m/s^2)' : 'n/a'}; used A_V = ${T.AV.toFixed(0)} m${d.calib ? ' (calibrated: ' + JSON.stringify(d.calib) + ')' : ''}`);
  console.log(`  peak |h| = ${T.peak.toFixed(0)} m at ${km(T.peakX)} km; max slope ${(T.maxSlope / DEG).toFixed(1)} deg at ${km(T.maxSlopeX)} km; relief over x = ${km(T.xLo)} .. ${km(T.xHi)} km`);
  const w = [0, 0, 0, 0];
  const row = [];
  for (const xk of [5, 10, 20, 30, 45, 60, 80, 120, 160]) {
    const x = T.side * xk * 1e3;
    sampleWave(T, x, w);
    if (w[0] === 0) continue;
    row.push(`${xk} km: |h| ${w[0].toFixed(0)} m, lambda ${(2 * Math.PI / Math.abs(w[3]) / 1e3).toFixed(2)} km, slope ${((Math.atan(Math.hypot(w[2], w[0] * w[3])) / DEG)).toFixed(1)} deg`);
  }
  console.log('  ' + row.join('\n  '));
}

console.log('\n# Corrugation (1983 impact)');
const rel = new RingRelief(orbitalFrequencies);
for (const iso of ['2009-08-11T00:00:00Z', '2017-01-01T00:00:00Z', tIso]) {
  const t = tFromIso(iso);
  const dt = t - CORRUGATION.tImpact;
  const parts = [];
  for (const rKm of [70_000, 76_000, 80_000, 86_000, 90_000]) {
    const r = rKm * 1e3, h = 20;
    const k1 = Math.abs((rel.nodalRate(r + h) - rel.nodalRate(r - h)) / (2 * h)) * dt;
    const f = (x) => orbitalFrequencies(x);
    const k0 = Math.abs((f(r + h).nu - f(r - h).nu) / (2 * h)) * dt;
    const A1 = (r < CORRUGATION.rCD ? CORRUGATION.tiltD : CORRUGATION.tiltC) * r;
    parts.push(`${rKm} km: m=1 lambda ${(2 * Math.PI / k1 / 1e3).toFixed(1)} km A ${A1.toFixed(1)} m slope ${(A1 * k1).toExponential(2)}; m=0 lambda ${(2 * Math.PI / k0 / 1e3).toFixed(2)} km`);
  }
  const ripA = CORRUGATION.ripA2017 * Math.exp(-(t - CORRUGATION.ripT2017) / CORRUGATION.ripTau);
  console.log(`${iso} (t - t_i = ${(dt / 365.25 / DAY).toFixed(2)} yr): ripples m=0/m=2 amplitude ${ripA.toFixed(2)} m each\n  ${parts.join('\n  ')}`);
}

console.log('\n# Sites');
{
  const cells = [];
  for (let j = 0; j < REGION_A_CELLS; j++) { const c = regionACell(j); if (c) cells.push(c); }
  const hs = cells.map((c) => c.h).sort((a, b) => a - b);
  const q = (f) => hs[Math.min(hs.length - 1, Math.floor(f * hs.length))].toFixed(0);
  console.log(`region A: ${cells.length} structures in ${REGION_A_CELLS} cells of ${REGION_A.cellArc / 1e3} km over ${(2 * REGION_A.halfSpan / DEG).toFixed(0)} deg; heights median ${q(0.5)} m, 90 % ${q(0.9)} m, max ${hs[hs.length - 1].toFixed(0)} m; ${hs.filter((h) => h > 2500).length} above 2.5 km; a' ${km(Math.min(...cells.map((c) => c.a)))}..${km(Math.max(...cells.map((c) => c.a)))} km (${REGION_A.source})`);
  const tA = tFromIso('2009-07-26T09:57:40.704Z');
  const lonA = (((REGION_A.lon0 + REGION_A.n * (tA - REGION_A.t0)) / DEG) % 360 + 360) % 360;
  console.log(`region A centre at 2009-07-26T09:57:40.7Z: ${lonA.toFixed(2)} deg (NAC frame N1627295980 ring footprint 165.8..168.4 deg, PIA11668)`);
}
for (const s of rel.sites) {
  const hs = s.peaks.map((p) => p.h);
  console.log(`${s.name}: ${s.peaks.length} peak(s), height ${Math.max(...hs).toFixed(0)} m, a' ${km(s.peaks[0].a)} km, n = ${((s.n / DEG) * DAY).toFixed(3)} deg/day (${s.source})`);
}

console.log('\n# Equinox shadow lengths L = h / tan(B)');
for (const [what, h] of [['S/2009 S1 (150 m)', 150], ['Daphnis edge (1 km)', 1000], ['region A tallest (3.5 km)', 3500], ['Mimas 5:3 crest (450 m)', 450]]) {
  console.log(`${what}: B = 0.24 deg ${(h / Math.tan(0.24 * DEG) / 1e3).toFixed(1)} km, 0.125 deg ${(h / Math.tan(0.125 * DEG) / 1e3).toFixed(0)} km, 0.03 deg ${(h / Math.tan(0.03 * DEG) / 1e3).toFixed(0)} km`);
}
