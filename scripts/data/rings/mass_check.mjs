#!/usr/bin/env node
// Ring-mass check: integrate M = Int 2 pi r Sigma(r) dr over the real tau profile (public/data/rings/tau_main)
// with the zone table (src/rings/ringRegions.ts, imported directly: Node >= 23 strips TS types), for both the
// proportional (Sigma = sigmaPerTau * tau, current RingProfile loader) and the affine model
// (Sigma = sigma0 * smooth(0.002, 0.02, tau) + sigmaSlope * tau). Also prints the implied particle bulk
// density rho = 3 Sigma / (4 tau a_V) with a_V = Int a^3 n / Int a^2 n for each zone's size distribution.
//
//   node scripts/data/rings/mass_check.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { RING_ZONES, zoneParamsAtKm } = await import(resolve(ROOT, 'src/rings/ringRegions.ts'));
const meta = JSON.parse(readFileSync(resolve(ROOT, 'public/data/rings/tau_main.json'), 'utf8'));
const b = readFileSync(resolve(ROOT, 'public/data/rings/tau_main.f32'));
const tau = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
const { r0_km: R0, dr_km: DR, n: N } = meta;

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const pint = (lo, hi, p) => (Math.abs(p + 1) < 1e-9 ? Math.log(hi / lo) : (hi ** (p + 1) - lo ** (p + 1)) / (p + 1));
const aV = (z) => pint(z.aMin, z.aMax, 3 - z.q) / pint(z.aMin, z.aMax, 2 - z.q);

// literature zone masses / mean Sigma (kg, kg/m^2) for comparison (see docs/ring-physics.md)
const LIT = {
  total: { m: 1.54e19, s: 0.49e19, src: 'Iess et al. 2019 (Cassini Grand Finale gravity)' },
  B: { lo: 7e18, hi: 12e18, src: 'Hedman & Nicholson 2016 (up to 2.4e19 incl. Janus 3:2 values)' },
  A: { m: 3.7e18, src: 'Miller et al. 2024 compilation (Tiscareno & Harris 2018 Sigma)' },
  C: { lo: 3.7e16, hi: 3.4e17, src: 'Baillie et al. 2011 .. Miller et al. 2024' },
  CD: { m: 1.7e17, src: 'Miller et al. 2024' },
};

const rows = [];
let Mp = 0, Ma = 0;
const groups = { C: [0, 0], B: [0, 0], CD: [0, 0], A: [0, 0], dust: [0, 0] };
for (const z of RING_ZONES) {
  let mp = 0, ma = 0, area = 0, tauA = 0;
  for (let i = Math.max(0, Math.ceil((z.rInnerKm - R0) / DR)); i < N; i++) {
    const r = R0 + i * DR;
    if (r >= z.rOuterKm) break;
    const t = tau[i];
    if (!Number.isFinite(t)) continue;
    const dA = 2 * Math.PI * r * 1e3 * DR * 1e3; // m^2
    const zp = zoneParamsAtKm(r);
    mp += zp.sigmaPerTau * t * dA;
    ma += (zp.sigma0 * smooth(0.002, 0.02, t) + zp.sigmaSlope * t) * dA;
    area += dA;
    tauA += t * dA;
  }
  Mp += mp; Ma += ma;
  const g = z.key.startsWith('B') ? 'B' : z.key.startsWith('CD') ? 'CD' : z.key.startsWith('C') ? 'C' : z.key.startsWith('A') ? 'A' : 'dust';
  groups[g][0] += mp; groups[g][1] += ma;
  const tbar = area ? tauA / area : NaN;
  const sbar = area ? mp / area : NaN;
  const rho = z.macroscopic && tbar > 0 ? (3 * sbar) / (4 * tbar * aV(z)) : NaN;
  rows.push({ key: z.key, 'tau(area mean)': +tbar.toFixed(3), 'Sigma prop (kg/m2)': +sbar.toFixed(1), 'Sigma affine': +(ma / area).toFixed(1), 'mass prop (kg)': mp.toExponential(2), 'mass affine': ma.toExponential(2), 'a_V (m)': z.macroscopic ? +aV(z).toFixed(3) : '-', 'rho implied (kg/m3)': Number.isFinite(rho) ? Math.round(rho) : '-' });
}
console.table(rows);
console.log('group masses (proportional / affine):');
for (const [g, [p, a]] of Object.entries(groups)) console.log(`  ${g.padEnd(5)} ${p.toExponential(2)}  ${a.toExponential(2)}`);
console.log(`TOTAL proportional ${Mp.toExponential(3)} kg, affine ${Ma.toExponential(3)} kg;  ${LIT.total.src}: ${LIT.total.m.toExponential(2)} +- ${LIT.total.s.toExponential(2)}  -> (model - obs)/sigma = ${((Mp - LIT.total.m) / LIT.total.s).toFixed(2)}`);
console.log(`  B ring literature ${LIT.B.lo.toExponential(1)}-${LIT.B.hi.toExponential(1)} (${LIT.B.src}); A ring ${LIT.A.m.toExponential(1)} (${LIT.A.src}); C ring ${LIT.C.lo.toExponential(1)}-${LIT.C.hi.toExponential(1)}; CD ${LIT.CD.m.toExponential(1)}`);
console.log(`  in Mimas masses (3.75e19 kg): ${(Mp / 3.7493e19).toFixed(3)}`);
