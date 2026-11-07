#!/usr/bin/env node
// "What it is like inside the rings": derived numbers for docs/ring-physics.md, computed from the zone table
// (src/rings/ringRegions.ts), the real tau profile (public/data/rings/tau_main), the J2..J6 orbital frequencies
// (src/core/constants.ts) and the vertical-structure law of src/rings/RingLod.ts (sigma_z(a) = sigZFrac(a) * H).
//
//   node scripts/data/rings/inside_numbers.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { zoneParamsAtKm } = await import(resolve(ROOT, 'src/rings/ringRegions.ts'));
const { orbitalFrequencies, shearParameter, G } = await import(resolve(ROOT, 'src/core/constants.ts'));
const meta = JSON.parse(readFileSync(resolve(ROOT, 'public/data/rings/tau_main.json'), 'utf8'));
const buf = readFileSync(resolve(ROOT, 'public/data/rings/tau_main.f32'));
const TAU = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const pint = (lo, hi, p) => (hi <= lo ? 0 : Math.abs(p + 1) < 1e-9 ? Math.log(hi / lo) : (hi ** (p + 1) - lo ** (p + 1)) / (p + 1));
// RingLod.sigZFracForRadius
const sigZFrac = (a) => { const t = Math.min(1, Math.max(0, Math.log2(a / 0.01) / 9)); return 0.4 * (1 - t) + 0.15 * t; };
const tauMean = (rKm, halfKm) => {
  let s = 0, c = 0;
  for (let i = Math.round((rKm - halfKm - meta.r0_km) / meta.dr_km); i <= Math.round((rKm + halfKm - meta.r0_km) / meta.dr_km); i++) if (Number.isFinite(TAU[i])) { s += TAU[i]; c++; }
  return s / c;
};

const SITES = [
  ['C ring (background, 82,000 km)', 82_000],
  ['C ring plateau P7 (86,490 km)', 86_490],
  ['B ring B1 (95,000 km)', 95_000],
  ['B ring core B3 (107,000 km)', 107_000],
  ['Cassini Division (119,000 km)', 119_000],
  ['A ring (mid, 128,000 km)', 128_000],
  ['A ring (outer, 135,000 km)', 135_000],
];

const fmt = (v, d = 2) => (v === Infinity ? '∞' : Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0) ? v.toExponential(d - 1 > 0 ? d - 1 : 1) : v.toPrecision(Math.max(2, d)));
const out = [];
for (const [name, rKm] of SITES) {
  const half = name.includes('plateau') ? 40 : 100;
  const tau = tauMean(rKm, half);
  const z = zoneParamsAtKm(rKm);
  const { q, aMin, aMax, H } = z;
  const sigmaAff = z.sigma0 * smooth(0.002, 0.02, tau) + z.sigmaSlope * tau;
  const sigmaProp = z.sigmaPerTau * tau;
  const r = rKm * 1e3;
  const f = orbitalFrequencies(r);
  const qs = shearParameter(r);
  const C = tau / (Math.PI * pint(aMin, aMax, 2 - q));
  const Ncol = (a) => C * pint(Math.max(a, aMin), aMax, -q);
  // midplane quantities: integrate in log a with the size-dependent Gaussian thickness
  const nMid = (a0) => {
    let s = 0;
    const lo = Math.max(a0, aMin), K = 400;
    if (lo >= aMax) return 0;
    for (let k = 0; k < K; k++) {
      const a1 = lo * (aMax / lo) ** (k / K), a2 = lo * (aMax / lo) ** ((k + 1) / K), a = Math.sqrt(a1 * a2);
      s += (C * pint(a1, a2, -q)) / (Math.sqrt(2 * Math.PI) * sigZFrac(a) * H);
    }
    return s;
  };
  // Mid-plane extinction coefficient and volume filling factor, accounting for finite particle size: a sphere of
  // radius a centred at height z' (Gaussian, sigma_z(a)) blocks a horizontal mid-plane ray if y'^2 + z'^2 < a^2
  // (chord width 2 sqrt(a^2 - z'^2)) and fills a cross-section pi (a^2 - z'^2) of the mid-plane.
  let kMid = 0, Dmid = 0;
  {
    const K = 300, M = 80;
    for (let k = 0; k < K; k++) {
      const a1 = aMin * (aMax / aMin) ** (k / K), a2 = aMin * (aMax / aMin) ** ((k + 1) / K), a = Math.sqrt(a1 * a2);
      const nb = C * pint(a1, a2, -q); // column number density in the bin (m^-2)
      const sz = sigZFrac(a) * H;
      let chord = 0, area = 0;
      for (let m = 0; m < M; m++) {
        const z = -a + ((m + 0.5) * 2 * a) / M, dz = (2 * a) / M;
        const g = Math.exp(-0.5 * (z / sz) ** 2) / (Math.sqrt(2 * Math.PI) * sz);
        chord += g * 2 * Math.sqrt(Math.max(0, a * a - z * z)) * dz;
        area += g * Math.PI * Math.max(0, a * a - z * z) * dz;
      }
      kMid += nb * chord; // m^-1
      Dmid += nb * area; // dimensionless
    }
  }
  const mfpH = 1 / kMid;
  // vertical: height above the mid-plane at which the overlying optical depth reaches 1 (vertical mean free path);
  // infinite if tau/2 < 1 (a vertical ray from the mid-plane escapes with transmission e^(-tau/2)).
  const tHalf = Math.exp(-tau / 2);
  let mfpV = Infinity;
  if (tau / 2 > 1) {
    const K = 200;
    const cls = [];
    for (let k = 0; k < K; k++) {
      const a1 = aMin * (aMax / aMin) ** (k / K), a2 = aMin * (aMax / aMin) ** ((k + 1) / K), a = Math.sqrt(a1 * a2);
      cls.push({ t: Math.PI * C * pint(a1, a2, 2 - q), s: sigZFrac(a) * H });
    }
    const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return Math.sign(x) * y; };
    const cum = (z) => cls.reduce((s, c) => s + 0.5 * c.t * erf(z / (Math.SQRT2 * c.s)), 0);
    let lo = 0, hi = 5 * H;
    for (let i = 0; i < 60; i++) { const m = 0.5 * (lo + hi); if (cum(m) < 1) lo = m; else hi = m; }
    mfpV = 0.5 * (lo + hi);
  }
  const MU0 = Math.sin(8.24 * Math.PI / 180); // solar elevation above the ring plane on 2026-11-07
  const sunMid = Math.exp(-tau / 2 / MU0);
  // velocity dispersion: vertical rms velocity ~ nu * sigma_z (harmonic vertical oscillation)
  const cSmall = f.nu * sigZFrac(0.01) * H, cLarge = f.nu * sigZFrac(Math.min(aMax, 5.12)) * H;
  const P = (2 * Math.PI) / f.omega;
  const lambda = (4 * Math.PI * Math.PI * G * sigmaAff) / (f.kappa * f.kappa);
  const lambdaProp = (4 * Math.PI * Math.PI * G * sigmaProp) / (f.kappa * f.kappa);
  const cToomre = (3.36 * G * sigmaAff) / f.kappa; // c for Q = 1
  const aHalf = (() => { let lo = aMin, hi = aMax; for (let i = 0; i < 60; i++) { const m = Math.sqrt(lo * hi); if (pint(m, aMax, 2 - q) / pint(aMin, aMax, 2 - q) > 0.5) lo = m; else hi = m; } return Math.sqrt(lo * hi); })();
  out.push({
    site: name, tau, q, aMin, aMax, H,
    sigma: sigmaAff, sigmaLoader: sigmaProp,
    N1cm: Ncol(0.01), N10cm: Ncol(0.1), N1m: Ncol(1),
    n1cm: nMid(0.01), n10cm: nMid(0.1), n1m: nMid(1),
    sep10cm: nMid(0.1) > 0 ? nMid(0.1) ** (-1 / 3) : Infinity,
    sep1m: nMid(1) > 0 ? nMid(1) ** (-1 / 3) : Infinity,
    Dmid, mfpH, see1pct: 4.6 * mfpH, tHalf, tFull: Math.exp(-tau), mfpV, sunMid,
    cSmall, cLarge, cToomre,
    collPerOrbitSmall: 2 * (1 - Math.exp(-tau)), collPerOrbit3: 6 * Math.PI * tau,
    P, v: f.omega * r, shear100: qs * f.omega * 100, epi: (2 * Math.PI) / f.kappa, vert: (2 * Math.PI) / f.nu,
    lambda, lambdaProp, aHalf,
  });
}

const rows = [
  ['normal optical depth τ (local mean)', (o) => fmt(o.tau, 3)],
  ['size distribution q / aMin / aMax', (o) => `${o.q} / ${fmt(o.aMin * 100, 2)} cm / ${o.aMax} m`],
  ['radius splitting τ in half', (o) => `${fmt(o.aHalf * 100, 2)} cm`],
  ['full layer thickness H (m)', (o) => `${o.H}`],
  ['Σ (kg/m², literature-calibrated; loader value)', (o) => `${fmt(o.sigma, 3)} (${fmt(o.sigmaLoader, 3)})`],
  ['particles per m² of ring > 1 cm', (o) => fmt(o.N1cm, 2)],
  ['particles per m² > 10 cm', (o) => fmt(o.N10cm, 2)],
  ['particles per m² > 1 m', (o) => fmt(o.N1m, 2)],
  ['per m³ at mid-plane > 1 cm', (o) => fmt(o.n1cm, 2)],
  ['per m³ at mid-plane > 10 cm', (o) => fmt(o.n10cm, 2)],
  ['per m³ at mid-plane > 1 m', (o) => fmt(o.n1m, 2)],
  ['typical spacing of > 10 cm particles (m)', (o) => fmt(o.sep10cm, 2)],
  ['typical spacing of > 1 m particles (m)', (o) => fmt(o.sep1m, 2)],
  ['mid-plane volume filling factor', (o) => fmt(o.Dmid, 2)],
  ['horizontal mean free path at mid-plane (m)', (o) => fmt(o.mfpH, 3)],
  ['horizontal visibility to 1 % (m)', (o) => fmt(o.see1pct, 3)],
  ['vertical transmission, mid-plane → outside', (o) => fmt(o.tHalf, 2)],
  ['vertical transmission, whole layer e^-τ', (o) => fmt(o.tFull, 2)],
  ['vertical mean free path from mid-plane (m)', (o) => (o.mfpV === Infinity ? 'escapes (τ/2 < 1)' : fmt(o.mfpV, 2))],
  ['direct sunlight at mid-plane, Sun 8.2° up', (o) => fmt(o.sunMid, 2)],
  ['random velocity, cm grains / m boulders (mm/s)', (o) => `${fmt(o.cSmall * 1e3, 2)} / ${fmt(o.cLarge * 1e3, 2)}`],
  ['c for Toomre Q = 1 (mm/s)', (o) => fmt(o.cToomre * 1e3, 2)],
  ['collisions per orbit: cm grain ≈ 2(1-e^-τ); ω_c = 3Ωτ', (o) => `${fmt(o.collPerOrbitSmall, 2)}; ${fmt(o.collPerOrbit3, 2)}`],
  ['orbital period (h)', (o) => fmt(o.P / 3600, 4)],
  ['orbital speed (km/s)', (o) => fmt(o.v / 1e3, 4)],
  ['Keplerian shear speed 100 m away (cm/s)', (o) => fmt(o.shear100 * 100, 3)],
  ['epicycle period (h)', (o) => fmt(o.epi / 3600, 4)],
  ['vertical oscillation period (h)', (o) => fmt(o.vert / 3600, 4)],
  ['Toomre wavelength 4π²GΣ/κ² (m; loader Σ)', (o) => `${fmt(o.lambda, 3)} (${fmt(o.lambdaProp, 3)})`],
];
console.log('| quantity | ' + out.map((o) => o.site).join(' | ') + ' |');
console.log('|---|' + out.map(() => '---').join('|') + '|');
for (const [label, fn] of rows) console.log(`| ${label} | ` + out.map(fn).join(' | ') + ' |');
