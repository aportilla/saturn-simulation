#!/usr/bin/env node
// PNG inspection utilities for screenshots (no dependencies): find seams, compare brightness, zoom into details.
//
//   node scripts/img.mjs profile <x0> <x1> <y0> <y1> <step> a.png [b.png ...]
//        vertical brightness profile of a column strip x0..x1, rows y0..y1 in bins of `step` rows: mean display
//        luma (0..255) and texture (mean |dL/dy|) per bin and file, side by side — a seam is a step in one file's
//        profile that the reference does not have
//   node scripts/img.mjs mean a.png b.png "x0,y0,x1,y1" ["x0,y0,x1,y1" ...] [--linear]
//        mean luma of rectangles in two screenshots and their ratio (--linear: sRGB-decoded; only meaningful at
//        the same fixed exposure, e.g. ?exposure=manual)
//   node scripts/img.mjs crop <out.png> <x0> <y0> <w> <h> <scale> <gain> a.png [b.png ...]
//        crops of the same rectangle from several files, integer-upscaled and contrast-stretched around each
//        crop's mean (gain > 1 makes faint seams visible), stacked vertically into one PNG
// Pixel coordinates are display pixels of the PNG, y down. Helpers: scripts/test/lib.mjs (decodePng, encodePng).
import { writeFileSync } from 'node:fs';
import { decodePng, encodePng, pngLumaMean } from './test/lib.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const luma = (img, x, y) => { const k = (y * img.w + x) * 4; return 0.2126 * img.data[k] + 0.7152 * img.data[k + 1] + 0.0722 * img.data[k + 2]; };

if (cmd === 'profile') {
  const [x0, x1, y0, y1, step] = rest.slice(0, 5).map(Number);
  const files = rest.slice(5);
  const imgs = files.map((f) => decodePng(f));
  console.log('y      ' + files.map((f) => f.split('/').pop().replace(/\.png$/, '').slice(0, 20).padEnd(22)).join(''));
  for (let y = y0; y < y1; y += step) {
    const cols = imgs.map((im) => {
      let m = 0, t = 0, n = 0;
      for (let yy = y; yy < Math.min(y + step, y1, im.h - 1); yy++) {
        for (let x = x0; x < Math.min(x1, im.w); x++) { m += luma(im, x, yy); t += Math.abs(luma(im, x, yy + 1) - luma(im, x, yy)); n++; }
      }
      return `${(m / n).toFixed(1).padStart(6)} t${(t / n).toFixed(2).padStart(5)}        `;
    });
    console.log(String(y).padEnd(7) + cols.join(''));
  }
} else if (cmd === 'mean') {
  const linear = rest.includes('--linear');
  const [pa, pb, ...rects] = rest.filter((r) => r !== '--linear');
  const A = decodePng(pa), B = decodePng(pb);
  for (const r of rects) {
    const rect = r.split(',').map(Number);
    const a = pngLumaMean(A, rect, { linear }), b = pngLumaMean(B, rect, { linear });
    console.log(`${r}: A ${a.toFixed(4)}  B ${b.toFixed(4)}  ratio A/B ${(a / b).toFixed(4)}`);
  }
} else if (cmd === 'crop') {
  const [out, ...r2] = rest;
  const [x0, y0, cw, ch, sc, gain] = r2.slice(0, 6).map(Number);
  const files = r2.slice(6);
  const W = cw * sc, H = ch * sc * files.length + 4 * (files.length - 1);
  const rgba = new Uint8Array(W * H * 4).fill(255);
  files.forEach((f, i) => {
    const im = decodePng(f);
    const mean = [0, 0, 0];
    for (let y = y0; y < y0 + ch; y++) for (let x = x0; x < x0 + cw; x++) for (let c = 0; c < 3; c++) mean[c] += im.data[(y * im.w + x) * 4 + c] / (cw * ch);
    for (let y = 0; y < ch * sc; y++) {
      for (let x = 0; x < W; x++) {
        const q = ((y0 + Math.floor(y / sc)) * im.w + x0 + Math.floor(x / sc)) * 4;
        const o = ((i * (ch * sc + 4) + y) * W + x) * 4;
        for (let c = 0; c < 3; c++) rgba[o + c] = Math.max(0, Math.min(255, Math.round(mean[c] + (im.data[q + c] - mean[c]) * gain)));
        rgba[o + 3] = 255;
      }
    }
  });
  writeFileSync(out, encodePng(W, H, rgba));
  console.log(`${out} ${W}x${H}`);
} else {
  console.log('usage: node scripts/img.mjs profile|mean|crop ... (see the header of scripts/img.mjs)');
  process.exit(cmd ? 1 : 0);
}
