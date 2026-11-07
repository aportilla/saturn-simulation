// Locate the axis tick marks of the PIA07775 Phoebe chart to confirm that the plot box spans exactly
// 360 x 180 degrees (ticks every 30 deg in longitude, 30 deg in latitude).
import { readFileSync } from 'node:fs';
const b = readFileSync(process.argv[2]);
const off = b.readUInt32LE(10), w = b.readInt32LE(18), h0 = b.readInt32LE(22), bpp = b.readUInt16LE(28);
const h = Math.abs(h0), stride = Math.ceil((w * bpp) / 32) * 4, by = bpp / 8;
const px = (x, y) => { const row = h0 < 0 ? y : h - 1 - y; const p = off + row * stride + x * by; return [b[p + 2], b[p + 1], b[p]]; };
const blue = (x, y) => { const [r, , bl] = px(x, y); return bl > r + 40 && bl > 90; };
const [fx0, fx1, fy0, fy1] = process.argv.slice(3).map(Number);
// ticks below the bottom frame line: columns with bluish pixels at y = fy1 + 4..8
const cols = [];
for (let x = fx0 - 5; x <= fx1 + 5; x++) { let n = 0; for (let y = fy1 + 3; y <= fy1 + 9; y++) if (blue(x, y)) n++; if (n >= 4) cols.push(x); }
const groups = []; for (const x of cols) { if (!groups.length || x - groups[groups.length - 1].at(-1) > 2) groups.push([x]); else groups.at(-1).push(x); }
console.log('x ticks:', groups.map((g) => ((g[0] + g.at(-1)) / 2).toFixed(1)).join(' '));
const rows = [];
for (let y = fy0 - 5; y <= fy1 + 5; y++) { let n = 0; for (let x = fx0 - 9; x <= fx0 - 3; x++) if (blue(x, y)) n++; if (n >= 4) rows.push(y); }
const rg = []; for (const y of rows) { if (!rg.length || y - rg[rg.length - 1].at(-1) > 2) rg.push([y]); else rg.at(-1).push(y); }
console.log('y ticks:', rg.map((g) => ((g[0] + g.at(-1)) / 2).toFixed(1)).join(' '));
