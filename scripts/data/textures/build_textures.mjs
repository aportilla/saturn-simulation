// Build public/data/textures/moons/<name>.jpg (2048x1024, equirectangular, sRGB-encoded relative reflectance)
// and public/data/textures/manifest.json from public-domain Cassini global mosaics in data-raw/textures/.
//   node scripts/data/textures/build_textures.mjs
// All outputs share ONE layout: centre of the image = 0 deg longitude, EAST longitude increasing to the right
// (= IAU west longitude increasing to the left), north up, planetocentric latitude, +90 at the top row.
// Source layouts were verified from their ISIS labels and from known features (docs/data-sources.md).
// Pixel values: sRGB transfer function over LINEAR relative reflectance (source DN assumed linear in I/F);
// manifest.meanLinear is the area-weighted mean of the decoded linear values.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RAW = resolve(ROOT, 'data-raw/textures');
const TMP = resolve(RAW, 'tmp');
const OUT = resolve(ROOT, 'public/data/textures');
mkdirSync(TMP, { recursive: true });
mkdirSync(resolve(OUT, 'moons'), { recursive: true });
const W = 2048, H = 1024;

// ---------------------------------------------------------------- BMP io (sips writes BMP; we parse/write 24-bit)
function readBmp(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 2) !== 'BM') throw new Error('not a BMP: ' + file);
  const off = b.readUInt32LE(10);
  const w = b.readInt32LE(18);
  let h = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28);
  const comp = b.readUInt32LE(30);
  if (comp !== 0 && comp !== 3) throw new Error(`unsupported BMP compression ${comp}`);
  const topDown = h < 0;
  h = Math.abs(h);
  const bytes = bpp / 8;
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const rgb = new Float32Array(w * h * 3);
  let pal = null;
  if (bpp === 8) {
    pal = [];
    const ncol = b.readUInt32LE(46) || 256;
    for (let i = 0; i < ncol; i++) pal.push([b[54 + 4 * i + 2], b[54 + 4 * i + 1], b[54 + 4 * i]]);
  }
  for (let y = 0; y < h; y++) {
    const row = topDown ? y : h - 1 - y;
    for (let x = 0; x < w; x++) {
      const p = off + row * stride + x * bytes;
      let r, g, bb;
      if (bpp === 8) [r, g, bb] = pal[b[p]];
      else { bb = b[p]; g = b[p + 1]; r = b[p + 2]; }
      const o = 3 * (y * w + x);
      rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = bb;
    }
  }
  return { w, h, rgb };
}
function writeBmp(file, w, h, rgb8) {
  const stride = Math.ceil((w * 3) / 4) * 4;
  const b = Buffer.alloc(54 + stride * h);
  b.write('BM', 0, 'ascii');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(stride * h, 34);
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const o = 3 * (y * w + x), p = 54 + row * stride + 3 * x;
      b[p] = rgb8[o + 2]; b[p + 1] = rgb8[o + 1]; b[p + 2] = rgb8[o];
    }
  }
  writeFileSync(file, b);
}
const sips = (...a) => execFileSync('sips', a, { stdio: ['ignore', 'pipe', 'pipe'] });

// ---------------------------------------------------------------- helpers
const toLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (l) => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
function gray(img) {
  const g = new Float32Array(img.w * img.h);
  for (let i = 0; i < g.length; i++) g[i] = (0.2126 * img.rgb[3 * i] + 0.7152 * img.rgb[3 * i + 1] + 0.0722 * img.rgb[3 * i + 2]) / 255;
  return g;
}
/** roll columns by k (positive: content moves right) */
function roll(g, w, h, k) {
  const o = new Float32Array(g.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + ((x + k + w) % w)] = g[y * w + x];
  return o;
}
/** push-pull hole filling (mask=1 valid): pyramid of masked means, holes filled top-down with a BILINEAR
 *  sample of the next coarser (complete) level, so fills are smooth (no blocks). x wraps (longitude). */
function fillHoles(g, mask, w, h) {
  const levels = [{ w, h, v: Float64Array.from(g, (x, i) => x * mask[i]), c: Float64Array.from(mask) }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const L = levels[levels.length - 1];
    const w2 = Math.max(1, Math.ceil(L.w / 2)), h2 = Math.max(1, Math.ceil(L.h / 2));
    const v = new Float64Array(w2 * h2), c = new Float64Array(w2 * h2);
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const j = (y >> 1) * w2 + (x >> 1);
      v[j] += L.v[y * L.w + x]; c[j] += L.c[y * L.w + x];
    }
    levels.push({ w: w2, h: h2, v, c });
  }
  // normalised values per level; the top level is complete (single pixel)
  for (const L of levels) L.m = Float64Array.from(L.v, (s, i) => (L.c[i] > 0 ? s / L.c[i] : NaN));
  const top = levels[levels.length - 1];
  if (Number.isNaN(top.m[0])) top.m.fill(0.5);
  for (let li = levels.length - 2; li >= 0; li--) {
    const L = levels[li], U = levels[li + 1];
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const i = y * L.w + x;
      const full = 4 ** li; // number of finest-level pixels per pixel of this level (interior)
      if (L.c[i] >= full - 1e-9) continue;
      const sx = (x + 0.5) / 2 - 0.5, sy = Math.min(U.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const y1 = Math.min(U.h - 1, y0 + 1);
      const at = (xx, yy) => U.m[yy * U.w + ((xx % U.w) + U.w) % U.w];
      const b = (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) + fy * ((1 - fx) * at(x0, y1) + fx * at(x0 + 1, y1));
      if (Number.isNaN(L.m[i])) L.m[i] = b;
      else { const wgt = Math.min(1, L.c[i] / full); L.m[i] = wgt * L.m[i] + (1 - wgt) * b; }
    }
  }
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = mask[i] ? g[i] : levels[0].m[i];
  return out;
}
/** separable box blur (wraps in x, clamps in y), radius r px, n passes */
function blur(g, w, h, r, n = 3) {
  let a = Float32Array.from(g), t = new Float32Array(g.length);
  for (let p = 0; p < n; p++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[y * w + ((k + w) % w)];
      for (let x = 0; x < w; x++) {
        t[y * w + x] = s / (2 * r + 1);
        s += a[y * w + ((x + r + 1) % w)] - a[y * w + ((x - r + w) % w)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += t[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = s / (2 * r + 1);
        s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}
const areaMean = (L, w, h) => {
  let s = 0, ws = 0;
  for (let y = 0; y < h; y++) {
    const c = Math.cos((((y + 0.5) / h) * 180 - 90) * (Math.PI / 180));
    for (let x = 0; x < w; x++) { s += c * L[y * w + x]; ws += c; }
  }
  return s / ws;
};
const percentile = (L, q) => {
  const s = Float32Array.from(L).sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** linear values -> sRGB 8-bit gray JPEG (normalised so that the q-percentile maps to 1) */
function emit(key, L, info) {
  const top = percentile(L, info.whiteQuantile ?? 0.999);
  const scale = 1 / top;
  const rgb8 = new Uint8Array(W * H * 3);
  const Ls = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const l = Math.max(0, Math.min(1, L[i] * scale));
    const v = Math.round(255 * toSrgb(l));
    rgb8[3 * i] = rgb8[3 * i + 1] = rgb8[3 * i + 2] = v;
    Ls[i] = toLin(v / 255);
  }
  const bmp = resolve(TMP, `${key}.bmp`);
  writeBmp(bmp, W, H, rgb8);
  const jpg = resolve(OUT, 'moons', `${key}.jpg`);
  sips('-s', 'format', 'jpeg', '-s', 'formatOptions', '85', bmp, '--out', jpg);
  const mean = areaMean(Ls, W, H);
  let mn = 1, mx = 0;
  for (const v of Ls) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  console.log(`${key}: ${(statSync(jpg).size / 1024).toFixed(0)} KiB, meanLinear ${mean.toFixed(4)}, min/max rel ${(mn / mean).toFixed(3)} / ${(mx / mean).toFixed(3)}`);
  return {
    file: `data/textures/moons/${key}.jpg`, width: W, height: H,
    projection: 'equirectangular', lon0Center: 0, lonDirection: 'east', latitude: 'planetocentric', latTop: 90,
    uFromLon: 'u = fract(0.5 + lonEastDeg/360)  (body frame: lonEast = atan2(y, x), +x = 0 deg = sub-Saturn meridian)',
    vFromLat: 'v = 0.5 - latDeg/180  (v measured from the TOP row; flip if your texture origin is bottom-left)',
    encoding: 'srgb', meanLinear: +mean.toFixed(5), relMin: +(mn / mean).toFixed(4), relMax: +(mx / mean).toFixed(4),
    ...info.meta,
  };
}

// ---------------------------------------------------------------- per-moon sources
const manifest = {};
const pdLicense = 'Public domain (NASA/JPL-Caltech/Space Science Institute; USGS Astrogeology products are public domain)';
function fromGray(file, key, meta, opts = {}) {
  const bmp = resolve(TMP, `${key}_src.bmp`);
  sips('-s', 'format', 'bmp', '-z', String(H), String(W), file, '--out', bmp);
  const img = readBmp(bmp);
  let g = gray(img); // DN/255, treated as linear relative reflectance
  if (opts.roll) g = roll(g, W, H, opts.roll);
  // no-data (DN 0) -> push-pull fill
  const mask = Uint8Array.from(g, (v) => (v > 0.6 / 255 ? 1 : 0));
  let holes = 0; for (const m of mask) holes += 1 - m;
  if (holes) {
    g = blurFill(g, mask);
    meta = { ...meta, noData: `${((100 * holes) / mask.length).toFixed(2)}% of pixels were DN 0 (no data) and were filled by smooth interpolation` };
  }
  console.log(`${key}: ${((100 * holes) / mask.length).toFixed(2)}% no-data pixels filled`);
  manifest[key] = emit(key, g, { meta });
}

// USGS Astrogeology mosaics: ISIS SimpleCylindrical/Equirectangular, image centre = 0 deg, east to the right
fromGray(resolve(RAW, 'usgs/Enceladus_Cassini_mosaic_global_110m.tif'), 'enceladus', {
  source: 'USGS Astrogeology "Enceladus Cassini Global Mosaic 110m" (Enceladus_Cassini_mosaic_global_110m.tif; Bland et al./CICLOPS, Cassini ISS 2004-2015; = Photojournal PIA14937 lineage)',
  sourceLayout: 'ISIS SimpleCylindrical, CenterLongitude=180 PositiveWest, UpperLeftCornerX=0 => image centre 0 deg, 14401x7201',
  license: pdLicense,
});
fromGray(resolve(RAW, 'usgs/Tethys_Cassini_mosaic_global_293m.tif'), 'tethys', {
  source: 'USGS Astrogeology "Tethys Cassini Global Mosaic 293m" (Tethys_Cassini_mosaic_global_293m.tif; = Photojournal PIA14931, June 2012)',
  sourceLayout: 'ISIS Equirectangular, CenterLongitude=0 PositiveEast, 11520x5760; verified: Odysseus crater at 129.6W 30.6N (IAU 128.9W 32.8N)',
  license: pdLicense,
});
fromGray(resolve(RAW, 'usgs/Dione_Cassini_Voyager_mosaic_global_154m.tif'), 'dione', {
  source: 'USGS Astrogeology "Dione Cassini-Voyager Global Mosaic 154m" (Dione_Cassini_Voyager_mosaic_global_154m.tif; Cassini ISS + Voyager fill)',
  sourceLayout: 'ISIS Equirectangular, CenterLongitude=0 PositiveEast, 23040x11520; verified: wispy chasmata centred on the trailing hemisphere (270W)',
  license: pdLicense,
});
fromGray(resolve(RAW, 'usgs/Rhea_Cassini_Voyager_mosaic_global_417m.tif'), 'rhea', {
  source: 'USGS Astrogeology "Rhea Cassini-Voyager Global Mosaic 417m" (Rhea_Cassini_Voyager_mosaic_global_417m.tif; = Photojournal PIA14928, March 2012)',
  sourceLayout: 'ISIS SimpleCylindrical, CenterLongitude=180 PositiveWest, UpperLeftCornerX=0 => image centre 0 deg, 11520x5760',
  license: pdLicense,
});
// Photojournal PIA17214 (Mimas Global Map, June 2017): verified centre 0 deg (Herschel at 113W, IAU ~112W)
fromGray(resolve(RAW, 'photojournal/PIA17214.tif'), 'mimas', {
  source: 'NASA Photojournal PIA17214 "Mimas Global Map - June 2017" (NASA/JPL-Caltech/Space Science Institute), 5760x2880, 16 px/deg',
  sourceLayout: 'equidistant cylindrical, image centre 0 deg, west longitude increasing to the left (verified: Herschel crater at 113W)',
  license: 'Public domain (NASA/JPL-Caltech/Space Science Institute)',
});

// ---- Iapetus: Photojournal PIA18436 (Schenk 2014 global colour mosaic) keeps the true leading/trailing
// albedo dichotomy (the grayscale CICLOPS/USGS mosaics are normalised). Its image centre is 180 deg: roll by
// half a turn. Luminance -> two-point calibration to normal albedos 0.04 (Cassini Regio) / 0.55 (trailing side).
{
  const key = 'iapetus';
  const bmp = resolve(TMP, `${key}_src.bmp`);
  sips('-s', 'format', 'bmp', '-z', String(H), String(W), resolve(RAW, 'photojournal/PIA18436.jpg'), '--out', bmp);
  const img = readBmp(bmp);
  let L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    L[i] = 0.2126 * toLin(img.rgb[3 * i] / 255) + 0.7152 * toLin(img.rgb[3 * i + 1] / 255) + 0.0722 * toLin(img.rgb[3 * i + 2] / 255);
  }
  L = roll(L, W, H, W / 2);
  // dark / bright reference levels: equatorial band (|lat| < 30) means within 30 deg of the apex (90W)
  // and of the antapex (270W)
  const lev = (lonW0) => {
    let s = 0, n = 0;
    for (let y = Math.floor(H / 3); y < Math.ceil((2 * H) / 3); y++) for (let x = 0; x < W; x++) {
      const lonE = ((x + 0.5) / W) * 360 - 180;
      const lonW = (((-lonE) % 360) + 360) % 360;
      let d = Math.abs(lonW - lonW0); d = Math.min(d, 360 - d);
      if (d < 30) { s += L[y * W + x]; n++; }
    }
    return s / n;
  };
  const dark = lev(90), bright = lev(270);
  const A_DARK = 0.04, A_BRIGHT = 0.55;
  const k = (A_BRIGHT - A_DARK) / (bright - dark);
  const alb = Float32Array.from(L, (v) => Math.max(0.02, Math.min(0.8, A_DARK + k * (v - dark))));
  const mean = areaMean(alb, W, H);
  console.log(`iapetus calibration: source linear dark ${dark.toFixed(4)} bright ${bright.toFixed(4)} -> area-weighted mean normal albedo ${mean.toFixed(3)}`);
  manifest[key] = emit(key, alb, {
    whiteQuantile: 1.0,
    meta: {
      source: 'NASA Photojournal PIA18436 "Color Maps of Iapetus - 2014" (P. Schenk/LPI; NASA/JPL-Caltech/Space Science Institute/LPI), 11741x5871 global colour mosaic, converted to luminance',
      sourceLayout: 'equidistant cylindrical, image centre 180 deg (verified: Cassini Regio centred at x=0.75, the large trailing-side basin at x=0.27); rolled by 180 deg here',
      calibration: `two-point: equatorial apex (90W) mean -> normal albedo ${A_DARK}, antapex (270W) mean -> ${A_BRIGHT}; linear in between; area-weighted mean albedo ${mean.toFixed(3)}`,
      meanNormalAlbedo: +mean.toFixed(4),
      license: 'Public domain (NASA/JPL-Caltech/Space Science Institute/Lunar and Planetary Institute)',
      note: 'enhanced-colour source used for luminance only; the moon colour comes from MoonState.color',
    },
  });
}

// ---- Phoebe: Photojournal PIA07775 is an annotated chart (3228x1900) -> find the plot frame, crop the data
// (360 x 180 deg, 8 px/deg), fill no-data (pure black) by push-pull interpolation.
{
  const key = 'phoebe';
  const full = resolve(TMP, 'phoebe_full.bmp');
  sips('-s', 'format', 'bmp', resolve(RAW, 'photojournal/PIA07775.tif'), '--out', full);
  const img = readBmp(full);
  if (img.w !== 3228 || img.h !== 1900) throw new Error(`unexpected PIA07775 size ${img.w}x${img.h}`);
  // The plot box drawn around the map is ~25 px larger than the data; the axis ticks (found with
  // check_phoebe_ticks.mjs) are every 240 px = 30 deg: 180W at x=191, 0 at x=1630.5, 180E at x=3070,
  // +90 at y=183, 0 at y=903, -90 at y=1623  =>  data rectangle 2880 x 1440 at (191, 183), 8.0 px/deg.
  const ax = 191, ay = 183, cw = 2880, ch = 1440, bx = ax + cw - 1, by = ay + ch - 1;
  console.log(`phoebe data rectangle ${ax}..${bx} x ${ay}..${by} (${cw}x${ch})`);
  // resample the data rectangle to W x H (bilinear), gray, mask no-data
  const g = new Float32Array(W * H), mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = ax + ((x + 0.5) / W) * cw - 0.5, sy = ay + ((y + 0.5) / H) * ch - 0.5;
    const ix = Math.max(ax, Math.min(bx - 1, Math.floor(sx))), iy = Math.max(ay, Math.min(by - 1, Math.floor(sy)));
    const fx = Math.min(1, Math.max(0, sx - ix)), fy = Math.min(1, Math.max(0, sy - iy));
    let v = 0, valid = 1;
    for (const [dx, dy, wgt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
      const o = 3 * ((iy + dy) * img.w + ix + dx);
      const lum = (0.2126 * img.rgb[o] + 0.7152 * img.rgb[o + 1] + 0.0722 * img.rgb[o + 2]) / 255;
      // pure black = never imaged; very dark = baked-in crater shadow (no albedo information) -> fill both
      if (lum < 0.06) valid = 0;
      v += wgt * lum;
    }
    g[y * W + x] = v; mask[y * W + x] = valid;
  }
  // constant filler rows (south of ~-81 deg the chart is a flat grey band) -> no data
  for (let y = 0; y < H; y++) {
    let s = 0, s2 = 0;
    for (let x = 0; x < W; x++) { const v = g[y * W + x]; s += v; s2 += v * v; }
    const sd = Math.sqrt(Math.max(0, s2 / W - (s / W) ** 2));
    if (sd < 0.004) for (let x = 0; x < W; x++) mask[y * W + x] = 0;
  }
  // dilate the no-data mask by 2 px (removes dark rims left by resampling across hole edges)
  for (let pass = 0; pass < 2; pass++) {
    const m0 = Uint8Array.from(mask);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!m0[y * W + x]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        if (!m0[yy * W + ((x + dx + W) % W)]) { mask[y * W + x] = 0; break; }
      }
    }
  }
  let holes = 0; for (const m of mask) holes += 1 - m;
  const filled = blurFill(g, mask);
  console.log(`phoebe: ${((100 * holes) / mask.length).toFixed(1)}% no-data filled`);
  manifest[key] = emit(key, filled, {
    meta: {
      source: 'NASA Photojournal PIA07775 "Map of Phoebe - December 2005" (NASA/JPL/Space Science Institute), Cassini ISS flyby of 11 June 2004, 8 px/deg; chart frame cropped',
      sourceLayout: 'equidistant cylindrical chart with axes 180..0..180 deg (west longitude increasing to the left): image centre 0 deg; data rectangle 2880x1440 at (191,183) located from the axis ticks',
      noData: `${((100 * holes) / mask.length).toFixed(1)}% of the sphere (mostly north of ~60N) was never imaged; filled by smooth push-pull interpolation`,
      license: 'Public domain (NASA/JPL/Space Science Institute)',
    },
  });
}
function blurFill(g, mask) {
  const f = fillHoles(g, mask, W, H);
  // soften the filled areas only
  const b = blur(f, W, H, 8, 3);
  return Float32Array.from(f, (v, i) => (mask[i] ? v : b[i]));
}

// Manifest format (as specified for the far-field renderer): a flat object { "<textureKey>": entry }, one entry per
// map. Layout/encoding conventions are carried by each entry (lon0Center, lonDirection, latitude, uFromLon, vFromLat,
// encoding, meanLinear) and documented in docs/data-sources.md. No Saturn entry: no public-domain Cassini full-globe
// cylindrical map of Saturn exists (Photojournal has only tile mosaics such as PIA06193).
writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log('wrote manifest with', Object.keys(manifest).length, 'moon maps');
