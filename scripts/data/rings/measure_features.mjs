#!/usr/bin/env node
// Measure gap / ringlet / plateau edges in public/data/rings/tau_main.f32 so that the named features in
// src/rings/ringRegions.ts (HUD labels) sit exactly where the rendered profile has them.
//
//   node scripts/data/rings/measure_features.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const meta = JSON.parse(readFileSync(resolve(ROOT, 'public/data/rings/tau_main.json'), 'utf8'));
const b = readFileSync(resolve(ROOT, 'public/data/rings/tau_main.f32'));
const tau = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
const { r0_km: R0, dr_km: DR } = meta;
const idx = (r) => Math.round((r - R0) / DR);
const rad = (i) => R0 + i * DR;

/** runs where pred(tau) holds within [a, b] km, at least minKm wide */
function runs(a, b, pred, minKm = 0.5) {
  const out = [];
  let s = -1;
  for (let i = idx(a); i <= idx(b) + 1; i++) {
    const ok = i <= idx(b) && Number.isFinite(tau[i]) && pred(tau[i]);
    if (ok && s < 0) s = i;
    if (!ok && s >= 0) {
      if ((i - s) * DR >= minKm) {
        let sum = 0, mx = 0;
        for (let k = s; k < i; k++) { sum += tau[k]; mx = Math.max(mx, tau[k]); }
        out.push({ inner: +rad(s).toFixed(2), outer: +rad(i - 1).toFixed(2), center: +((rad(s) + rad(i - 1)) / 2).toFixed(1), width: +((i - s) * DR).toFixed(2), mean: +(sum / (i - s)).toFixed(3), max: +mx.toFixed(2) });
      }
      s = -1;
    }
  }
  return out;
}
const gap = (t) => t < 0.02;
const show = (name, list) => console.log(name.padEnd(28), JSON.stringify(list));

show('C inner edge (tau>0.01)', runs(74_300, 74_700, (t) => t > 0.01, 2).slice(0, 1));
show('Colombo gap', runs(77_600, 78_000, gap, 3));
show('Titan ringlet', runs(77_700, 78_000, (t) => t > 0.2, 3));
show('Maxwell gap', runs(87_300, 87_700, gap, 3));
show('Maxwell ringlet', runs(87_300, 87_700, (t) => t > 0.2, 3));
show('Bond gap', runs(88_600, 88_800, gap, 1));
show('Bond ringlet', runs(88_650, 88_760, (t) => t > 0.2, 1));
show('Dawes gap', runs(90_100, 90_300, gap, 1));
show('Dawes ringlet', runs(90_100, 90_260, (t) => t > 0.15, 2));
show('C gaps (all, >1.5km)', runs(74_500, 91_000, gap, 1.5).map((g) => `${g.inner}-${g.outer}`));
show('C plateaus (tau>0.2)', runs(78_000, 90_600, (t) => t > 0.2, 15).map((g) => `${g.inner}-${g.outer} m=${g.mean}`));
show('B edge (last tau>0.1)', runs(117_300, 117_800, (t) => t > 0.1, 1).slice(-1));
show('Huygens gap', runs(117_550, 117_960, gap, 5));
show('Huygens ringlet', runs(117_700, 117_900, (t) => t > 0.2, 2));
show('CD gaps (all, >1.5km)', runs(117_700, 122_000, gap, 1.5).map((g) => `${g.inner}-${g.outer}`));
show('CD ringlets in gaps', runs(117_700, 120_400, (t) => t > 0.3, 2).map((g) => `${g.inner}-${g.outer} max=${g.max}`));
show('A inner edge (tau>0.4)', runs(121_800, 122_400, (t) => t > 0.4, 3).slice(0, 1));
show('Encke gap', runs(133_300, 133_900, gap, 10));
show('Keeler gap', runs(136_400, 136_600, gap, 5));
show('A outer edge (tau>0.1)', runs(136_600, 136_800, (t) => t > 0.1, 0.5).slice(-1));
// zone means for the table
for (const [n, a, c] of [['C', 74_491, 90_620], ['C_ramp', 90_620, 91_975], ['B1', 91_975, 99_000], ['B2', 99_000, 104_000], ['B3', 104_000, 110_000], ['B4', 110_000, 116_500], ['B5', 116_500, 117_660], ['CD', 117_660, 120_900], ['CD_ramp', 120_900, 122_050], ['A_in', 122_050, 133_423], ['A_out', 133_745, 136_770]]) {
  const v = [];
  let sw = 0, st = 0;
  for (let i = idx(a); i < idx(c); i++) if (Number.isFinite(tau[i])) { v.push(tau[i]); sw += rad(i); st += tau[i] * rad(i); }
  v.sort((x, y) => x - y);
  const q = (p) => v[Math.floor(p * (v.length - 1))];
  console.log(`zone ${n.padEnd(8)} area-mean tau ${(st / sw).toFixed(3)}  median ${q(0.5).toFixed(3)}  p10 ${q(0.1).toFixed(3)}  p90 ${q(0.9).toFixed(3)}  frac>4 ${(v.filter((x) => x > 4).length / v.length).toFixed(3)} frac>5 ${(v.filter((x) => x > 5).length / v.length).toFixed(3)}`);
}
