// Build public/data/stars/ from the Yale Bright Star Catalogue, 5th rev. ed. (Hoffleit & Warren 1991;
// public domain; downloaded from http://tdc-www.harvard.edu/catalogs/bsc5.dat.gz = CDS V/50 "catalog").
//   node scripts/data/stars/build_stars.mjs [--with-hipparcos [Vmax]]
// Output:
//   stars.bin   little-endian records, 12 bytes each, sorted by V (brightest first):
//                 float32 RA (rad, ICRS), float32 Dec (rad, ICRS)   -- epoch J2026.0 (proper motion applied)
//                 int16   V * 1000 (mag), int16 (B-V) * 1000 (mag)
//   stars.json  { format, count, recordBytes, epoch, magLimit, source, license, fields, named: [[index, "Bayer/Flamsteed"], ...] }
// --with-hipparcos (NOT used for the shipped data): appends Hipparcos stars (ESA 1997) with BSC5 V < V <= Vmax
// (default 8.5) after a positional cross-match. Hipparcos/Tycho/Gaia are CC BY-NC 3.0 IGO (non-commercial), so the
// result is written to stars_hip_nc.bin/.json instead and must not be shipped unless that licence is acceptable.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEG = Math.PI / 180;
const EPOCH = 2026.0;
const args = process.argv.slice(2);
const withHip = args.includes('--with-hipparcos');
const hipVmax = withHip ? parseFloat(args[args.indexOf('--with-hipparcos') + 1]) || 8.5 : 0;

// rough B-V from the spectral class when the catalogue has none (Allen's Astrophysical Quantities, dwarfs)
const BV_BY_CLASS = { O: -0.31, B: -0.16, A: 0.1, F: 0.45, G: 0.68, K: 1.1, M: 1.55, C: 2.0, S: 1.6, N: 2.0, R: 1.7, W: -0.3 };

function propagate(ra, dec, pmra, pmdec, years) {
  // pmra includes cos(dec); small-angle linear propagation on the sphere
  const ca = Math.cos(ra), sa = Math.sin(ra), cd = Math.cos(dec), sd = Math.sin(dec);
  const p = [cd * ca, cd * sa, sd];
  const a = [-sa, ca, 0];
  const d = [-sd * ca, -sd * sa, cd];
  const x = p[0] + years * (pmra * a[0] + pmdec * d[0]);
  const y = p[1] + years * (pmra * a[1] + pmdec * d[1]);
  const z = p[2] + years * (pmra * a[2] + pmdec * d[2]);
  const n = Math.hypot(x, y, z);
  let r = Math.atan2(y, x);
  if (r < 0) r += 2 * Math.PI;
  return [r, Math.asin(z / n)];
}

// ---------------------------------------------------------------- BSC5
const lines = readFileSync(resolve(ROOT, 'data-raw/stars/bsc5/bsc5.dat'), 'latin1').split('\n');
const stars = [];
const f = (s, a, b) => s.slice(a - 1, b).trim();
let noBV = 0;
for (const L of lines) {
  if (L.length < 110) continue;
  const raH = f(L, 76, 77);
  if (!raH) continue; // removed objects (novae, galaxies)
  const vStr = f(L, 103, 107);
  if (!vStr) continue;
  const hr = parseInt(f(L, 1, 4), 10);
  const ra = (parseInt(raH, 10) + parseInt(f(L, 78, 79), 10) / 60 + parseFloat(f(L, 80, 83)) / 3600) * 15 * DEG;
  const sgn = f(L, 84, 84) === '-' ? -1 : 1;
  const dec = sgn * (parseInt(f(L, 85, 86), 10) + parseInt(f(L, 87, 88), 10) / 60 + parseInt(f(L, 89, 90), 10) / 3600) * DEG;
  const V = parseFloat(vStr);
  let bvStr = f(L, 110, 114);
  let bv;
  if (bvStr) bv = parseFloat(bvStr);
  else {
    const sp = f(L, 128, 147).replace(/^(sd|d|g|c)/, '');
    bv = BV_BY_CLASS[sp[0]] ?? 0.65;
    noBV++;
  }
  const pmra = (parseFloat(f(L, 149, 154)) || 0) * (DEG / 3600);
  const pmde = (parseFloat(f(L, 155, 160)) || 0) * (DEG / 3600);
  const [r2, d2] = propagate(ra, dec, pmra, pmde, EPOCH - 2000);
  const name = f(L, 5, 14);
  stars.push({ hr, ra: r2, dec: d2, V, bv, name, src: 'BSC5' });
}
console.log(`BSC5: ${stars.length} stars (${noBV} B-V estimated from spectral class)`);

// ---------------------------------------------------------------- optional Hipparcos extension (CC BY-NC)
if (withHip) {
  const txt = readFileSync(resolve(ROOT, 'data-raw/stars/hip/heasarc_hipparcos.tdat'), 'latin1');
  const hdr = txt.match(/line\[1\] = (.*)/)[1].trim().split(/\s+/);
  const col = (n) => hdr.indexOf(n);
  const iV = col('vmag'), iRa = col('ra_deg'), iDe = col('dec_deg'), iPa = col('pm_ra'), iPd = col('pm_dec'), iBV = col('bv_color'), iHip = col('hip_number');
  // spatial hash of BSC5 stars for the cross-match
  const cell = (ra, dec) => `${Math.floor(dec / (0.5 * DEG))}:${Math.floor((ra * Math.cos(dec)) / (0.5 * DEG))}`;
  const unit = (ra, dec) => [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  const grid = new Map();
  for (const s of stars) { const k = cell(s.ra, s.dec); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(s); }
  let added = 0;
  for (const L of txt.slice(txt.indexOf('<DATA>') + 7).split('\n')) {
    const p = L.split('|');
    if (p.length < hdr.length) continue;
    const V = parseFloat(p[iV]);
    if (!(V <= hipVmax)) continue;
    const ra0 = parseFloat(p[iRa]) * DEG, de0 = parseFloat(p[iDe]) * DEG;
    if (!Number.isFinite(ra0) || !Number.isFinite(de0)) continue;
    const [ra, dec] = propagate(ra0, de0, (parseFloat(p[iPa]) || 0) * (DEG / 3.6e6), (parseFloat(p[iPd]) || 0) * (DEG / 3.6e6), EPOCH - 1991.25);
    // drop if a BSC5 star lies within 60" and |dV| < 1 (same star) or if V is in the BSC range
    const u = unit(ra, dec);
    let dup = false;
    for (const dd of [-1, 0, 1]) for (const dr of [-1, 0, 1]) {
      const k = `${Math.floor(dec / (0.5 * DEG)) + dd}:${Math.floor((ra * Math.cos(dec)) / (0.5 * DEG)) + dr}`;
      for (const s of grid.get(k) ?? []) {
        const v = unit(s.ra, s.dec);
        if (u[0] * v[0] + u[1] * v[1] + u[2] * v[2] > Math.cos(60 / 3600 * DEG) && Math.abs(s.V - V) < 1.0) dup = true;
      }
    }
    if (dup) continue;
    const bv = parseFloat(p[iBV]);
    stars.push({ hr: 0, hip: parseInt(p[iHip], 10), ra, dec, V, bv: Number.isFinite(bv) ? bv : 0.65, name: '', src: 'HIP' });
    added++;
  }
  console.log(`Hipparcos: added ${added} stars with V <= ${hipVmax}`);
}

// ---------------------------------------------------------------- write
stars.sort((a, b) => a.V - b.V);
const N = stars.length;
const buf = Buffer.alloc(N * 12);
const named = [];
stars.forEach((s, i) => {
  buf.writeFloatLE(s.ra, 12 * i);
  buf.writeFloatLE(s.dec, 12 * i + 4);
  buf.writeInt16LE(Math.round(s.V * 1000), 12 * i + 8);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(3, s.bv)) * 1000), 12 * i + 10);
  if (s.V < 4.0 && s.name) named.push([i, s.name.replace(/\s+/g, ' ')]);
});
const outDir = resolve(ROOT, 'public/data/stars');
mkdirSync(outDir, { recursive: true });
const base = withHip ? 'stars_hip_nc' : 'stars';
writeFileSync(resolve(outDir, `${base}.bin`), buf);
const meta = {
  format: 'space-viz-stars/1',
  count: N,
  recordBytes: 12,
  fields: ['ra_rad:float32', 'dec_rad:float32', 'vmag_milli:int16', 'bv_milli:int16'],
  frame: 'ICRS',
  epoch: `J${EPOCH.toFixed(1)}`,
  magLimit: Math.max(...stars.map((s) => s.V)),
  completeTo: 6.5,
  source: withHip
    ? 'Yale Bright Star Catalogue 5th ed. (Hoffleit & Warren 1991) + Hipparcos (ESA 1997, SP-1200)'
    : 'Yale Bright Star Catalogue, 5th revised ed. (Hoffleit & Warren 1991), CDS V/50 / NASA ADC',
  license: withHip ? 'BSC5: public domain; Hipparcos: CC BY-NC 3.0 IGO, Credit: ESA (non-commercial only)' : 'public domain',
  named,
};
writeFileSync(resolve(outDir, `${base}.json`), JSON.stringify(meta));
console.log(`wrote ${N} stars (V <= ${meta.magLimit}) to ${base}.bin (${(buf.length / 1024).toFixed(0)} KiB), ${named.length} named`);
