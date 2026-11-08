#!/usr/bin/env node
// Independent check of the measured moon shapes: renders a PDS plate model (the raw mesh downloaded by
// build_shapes.mjs, not the app's radius map) orthographically from a sub-observer point, z-buffered, Lambert-shaded
// (no cast shadows), north up / east right - the orientation of the app's orbit camera. Compare with the app
// (scripts/test/specs/moon-shapes.json) and, after `node scripts/img.mjs rotate <png> <out> <noraz> ...`, with the
// Cassini frame (PDS shape-model documents: image table gives sub-spacecraft / sub-solar lat and W lon, noraz).
//
// usage: node scripts/data/moons/render_shape_model.mjs <moon> <out.png> --lat <deg> --lonW <deg>
//            [--sunLat <deg> --sunLonW <deg>] [--kmPerPx 0.1] [--size 500] [--mode lambert|ambient|normals]
//            [--raw data-raw/moon_shapes/pds]
//   e.g. Pan as in PIA21436 (left): pan out.png --lat 39.21 --lonW 216.71 --sunLat 26.71 --sunLonW 199.29 --kmPerPx 0.147
//   modes: lambert = cos(incidence) (night side black); ambient = + 0.04 (shows the unlit silhouette);
//          normals = 0.5 + 0.5 n (body frame), the app's ?debug=40 colouring
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../../test/lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const [moon, out] = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));
if (!moon || !out || opt('lat') === undefined || opt('lonW') === undefined) {
  console.log('usage: node scripts/data/moons/render_shape_model.mjs <moon> <out.png> --lat deg --lonW deg [--sunLat deg --sunLonW deg] [--kmPerPx 0.1] [--size 500] [--mode lambert|ambient|normals] [--raw DIR]');
  process.exit(1);
}
const D = Math.PI / 180;
const dir = (lat, lonW) => { const la = lat * D, lo = -lonW * D; return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

const tab = resolve(ROOT, opt('raw', 'data-raw/moon_shapes/pds'), `${moon.toLowerCase()}_30k_plt.tab`);
const lines = readFileSync(tab, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const [nv, nf] = lines[0].trim().split(/\s+/).map(Number);
const V = []; for (let i = 0; i < nv; i++) V.push(lines[1 + i].trim().split(/\s+/).map(Number));
const F = []; for (let i = 0; i < nf; i++) F.push(lines[1 + nv + i].trim().split(/\s+/).map(Number));

const w = dir(+opt('lat'), +opt('lonW'));                                   // toward the observer
const s = dir(+opt('sunLat', opt('lat')), +opt('sunLonW', opt('lonW')));      // toward the Sun
const up = nrm(sub([0, 0, 1], w.map((x) => x * w[2])));                       // projected north
const right = cross(up, w);                                                   // east appears to the right
const mode = opt('mode', 'lambert');
const kmPx = +opt('kmPerPx', '0.1'), N = +opt('size', '500');
const Wd = N, Hd = Math.round(N * 0.75);
const zb = new Float64Array(Wd * Hd).fill(-Infinity);
const col = new Float64Array(Wd * Hd * 3);
for (const [a, b, c] of F) {
  const P = [V[a], V[b], V[c]];
  const n = nrm(cross(sub(P[1], P[0]), sub(P[2], P[0])));
  if (dot(n, w) <= 0) continue;
  const L = Math.max(0, dot(n, s)) + (mode === 'ambient' ? 0.04 : 0);
  const rgb = mode === 'normals' ? n.map((v) => 0.5 + 0.5 * v) : [L, L, L];
  const q = P.map((p) => [Wd / 2 + dot(p, right) / kmPx, Hd / 2 - dot(p, up) / kmPx, dot(p, w)]);
  const area = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
  if (Math.abs(area) < 1e-12) continue;
  const x0 = Math.max(0, Math.floor(Math.min(q[0][0], q[1][0], q[2][0]))), x1 = Math.min(Wd - 1, Math.ceil(Math.max(q[0][0], q[1][0], q[2][0])));
  const y0 = Math.max(0, Math.floor(Math.min(q[0][1], q[1][1], q[2][1]))), y1 = Math.min(Hd - 1, Math.ceil(Math.max(q[0][1], q[1][1], q[2][1])));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((q[1][0] - px) * (q[2][1] - py) - (q[2][0] - px) * (q[1][1] - py)) / area;
    const w1 = ((q[2][0] - px) * (q[0][1] - py) - (q[0][0] - px) * (q[2][1] - py)) / area;
    if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
    const z = w0 * q[0][2] + w1 * q[1][2] + (1 - w0 - w1) * q[2][2];
    const k = y * Wd + x;
    if (z > zb[k]) { zb[k] = z; col.set(rgb, 3 * k); }
  }
}
const rgba = new Uint8Array(Wd * Hd * 4);
for (let k = 0; k < Wd * Hd; k++) {
  for (let c = 0; c < 3; c++) rgba[4 * k + c] = Math.round(255 * Math.pow(Math.min(1, col[3 * k + c]), 1 / 2.2));
  rgba[4 * k + 3] = 255;
}
writeFileSync(out, encodePng(Wd, Hd, rgba));
console.log(`wrote ${out} (${Wd}x${Hd}, ${kmPx} km/px, ${mode}; observer ${opt('lat')}N ${opt('lonW')}W)`);
