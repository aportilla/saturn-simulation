#!/usr/bin/env node
// Measured shapes of Saturn's small inner moons for the far-field renderer (src/moons/shapes.ts,
// src/render/far/glsl/moons.ts). Source: P. C. Thomas, J. Joseph & T. Ansty (2018), "Saturn Small Moon Shape Models
// V1.0", NASA Planetary Data System, Small Bodies Node, urn:nasa:pds:saturn_satellite_shape_models::1.0,
// doi:10.26033/ewy3-jy61 -- Cassini ISS NAC stereo control points + limbs, 30k-plate models (incl. the 2016-17
// ring-grazing close flybys for Pan, Daphnis and Atlas). US-government (NASA) data: no copyright, free to use.
//
// usage: node scripts/data/moons/build_shapes.mjs [--moons pan,daphnis,...] [--step 1] [--raw DIR] [--out DIR]
//                                                 [--check N] [--profiles] [--no-download]
//   --moons     PDS file stems (default: pan,daphnis,atlas,prometheus,pandora,epimetheus,janus; the bundle also has
//               telesto, calypso, helene, hyperion)
//   --step      grid step in degrees (default 1: 360 x 181 samples per moon)
//   --raw       download / cache directory (default data-raw/moon_shapes/pds; git-ignored)
//   --out       output directory (default public/data/moons)
//   --check N   random directions for the map-vs-mesh reconstruction error (default 40000; 0 = skip)
//   --profiles  print ridge profiles (radius vs latitude at lon 0/90/180/270 E)
//
// Steps: download once (<moon>_30k_plt.tab/.xml + <moon>_document.pdf); parse the plate model (km, body frame =
// the app's: +x = prime meridian, Saturn-facing; +z = north spin pole; +y = 90E = trailing side); verify that it is
// star-shaped about the origin (every plate faces outward seen from the origin and the plates' solid angles add up
// to 4 pi, so each direction crosses the surface exactly once); sample the radial function r(lat, lonE) by exact
// ray-plate intersection on a lat-lon grid that includes both poles and the equator (the ridge crests of Pan, Atlas
// and Daphnis are a vertex chain at z = 0, so a grid row on the equator keeps the crest sharp); quantise to uint16.
// Writes <out>/shapes.json (grid + per-moon metadata) and <out>/shapes.u16 (all maps, little-endian, south row
// first, r = value * scaleKm). The renderer interpolates the map bilinearly in (lon, lat) - the same function the
// CPU uses for the camera's surface radius - and the reported errors are of that interpolant against the mesh.
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BASE = 'https://sbnarchive.psi.edu/pds4/cassini/saturn_satellite_shape_models_V1_0';
const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------------ CLI
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (k) => argv.includes(`--${k}`);
if (has('help')) {
  console.log('usage: node scripts/data/moons/build_shapes.mjs [--moons a,b] [--step deg] [--raw DIR] [--out DIR] [--check N] [--profiles] [--no-download]');
  process.exit(0);
}
const MOONS = opt('moons', 'pan,daphnis,atlas,prometheus,pandora,epimetheus,janus').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const STEP = Number(opt('step', '1'));
const RAW = resolve(ROOT, opt('raw', 'data-raw/moon_shapes/pds'));
const OUT = resolve(ROOT, opt('out', 'public/data/moons'));
const NCHECK = Number(opt('check', '40000'));
if (!(360 / STEP === Math.round(360 / STEP)) || !(90 / STEP === Math.round(90 / STEP))) throw new Error('--step must divide 90');

// Model radius uncertainties as stated in the bundle's <moon>_document.pdf ("Likely uncertainty of model radii ...").
const UNCERTAINTY_KM = {
  pan: '0.2-0.3', daphnis: '0.2-0.7', atlas: '0.1-0.3', prometheus: '0.2-0.4', pandora: '0.2-0.3',
  epimetheus: '0.15-0.3', janus: '0.3-1.3',
};
// Published mean radii for the check (km): Thomas et al. 2013 (Icarus 226, 999; Table 1, pre-2016 models; their a,b,c
// are the IAU/moons.json radii) and, for the ring moons, Thomas & Helfenstein 2020 (Icarus 344, 113355) as tabulated
// by Rambaux et al. 2022 (A&A 667, A78, Table 1).
const LIT_RM_KM = {
  pan: '14.0 +- 1.2 (T13), 13.7 +- 0.3 (TH20)', daphnis: '3.8 +- 0.8 (T13), 3.9 +- 0.5 (TH20)',
  atlas: '15.1 +- 0.8 (T13), 14.9 +- 0.2 (TH20)', prometheus: '43.1 +- 1.2 (T13)', pandora: '40.6 +- 1.5 (T13)',
  epimetheus: '58.2 +- 1.2 (T13)', janus: '89.2 +- 0.8 (T13)',
};

// ------------------------------------------------------------------------------------------------ download
async function download(url, out) {
  if (existsSync(out) && statSync(out).size > 0) return false;
  if (has('no-download')) throw new Error(`missing ${out} (--no-download)`);
  mkdirSync(dirname(out), { recursive: true });
  const res = await fetch(url, { headers: { 'user-agent': 'space-viz data build' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(out + '.part'));
  renameSync(out + '.part', out);
  console.log(`  downloaded ${url} (${(statSync(out).size / 1e6).toFixed(2)} MB)`);
  return true;
}

// ------------------------------------------------------------------------------------------------ plate model
/** Parse a PDS plate model (header "nv nf", nv vertex rows "x y z" in km, nf rows of zero-based vertex indices). */
function parsePlates(text, name) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const [nv, nf] = lines[0].trim().split(/\s+/).map(Number);
  if (!(nv > 3 && nf > 3) || lines.length < 1 + nv + nf) throw new Error(`${name}: bad header / truncated (${lines.length} lines)`);
  const V = new Float64Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const p = lines[1 + i].trim().split(/\s+/).map(Number);
    if (p.length !== 3 || p.some((x) => !Number.isFinite(x))) throw new Error(`${name}: bad vertex row ${i}`);
    V.set(p, 3 * i);
  }
  const F = new Int32Array(nf * 3);
  for (let i = 0; i < nf; i++) {
    const p = lines[1 + nv + i].trim().split(/\s+/).map(Number);
    if (p.length !== 3 || p.some((x) => !(x >= 0 && x < nv))) throw new Error(`${name}: bad plate row ${i}`);
    F.set(p, 3 * i);
  }
  return { nv, nf, V, F };
}

/** Volume, centroid, area, star-shapedness (orientation + total solid angle seen from the origin). */
function analyse({ nf, V, F }) {
  let vol = 0, cx = 0, cy = 0, cz = 0, area = 0, negative = 0, omega = 0;
  for (let f = 0; f < nf; f++) {
    const a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
    const ax = V[a], ay = V[a + 1], az = V[a + 2], bx = V[b], by = V[b + 1], bz = V[b + 2], qx = V[c], qy = V[c + 1], qz = V[c + 2];
    const det = ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
    if (det <= 0) negative++;
    vol += det / 6;
    cx += (det * (ax + bx + qx)) / 24; cy += (det * (ay + by + qy)) / 24; cz += (det * (az + bz + qz)) / 24;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = qx - ax, vy = qy - ay, vz = qz - az;
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    // solid angle (Van Oosterom & Strackee 1983)
    const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(qx, qy, qz);
    const den = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (ax * qx + ay * qy + az * qz) * lb + (bx * qx + by * qy + bz * qz) * la;
    omega += 2 * Math.atan2(det, den);
  }
  return { vol, centroid: [cx / vol, cy / vol, cz / vol], area, negative, omegaOver4pi: omega / (4 * Math.PI) };
}

/**
 * Exact radial function of a star-shaped plate model: r(direction) by ray-plate intersection from the origin,
 * accelerated by a lat-lon bucket grid (each plate is registered in every bucket its bounding cap can touch).
 */
class RadialFunction {
  constructor({ nf, V, F }, cellDeg = 1.5) {
    this.V = V; this.F = F; this.nf = nf;
    const nLat = Math.round(180 / cellDeg), nLon = Math.round(360 / cellDeg);
    this.nLat = nLat; this.nLon = nLon; this.h = (cellDeg * DEG);
    const buckets = Array.from({ length: nLat * nLon }, () => []);
    // angular radius of a cell (centre to corner), per latitude row
    const rowRad = new Float64Array(nLat);
    for (let j = 0; j < nLat; j++) {
      const la = -Math.PI / 2 + (j + 0.5) * this.h;
      const c = dirLL(la, 0);
      let m = 0;
      for (const [dla, dlo] of [[-0.5, -0.5], [-0.5, 0.5], [0.5, -0.5], [0.5, 0.5]]) {
        m = Math.max(m, angle(c, dirLL(la + dla * this.h, dlo * this.h)));
      }
      rowRad[j] = m;
    }
    for (let f = 0; f < nf; f++) {
      const vs = [0, 1, 2].map((k) => { const i = 3 * F[3 * f + k]; return norm([V[i], V[i + 1], V[i + 2]]); });
      const cen = norm([vs[0][0] + vs[1][0] + vs[2][0], vs[0][1] + vs[1][1] + vs[2][1], vs[0][2] + vs[1][2] + vs[2][2]]);
      const rad = Math.max(...vs.map((v) => angle(cen, v)));
      const lat = Math.asin(cen[2]), lon = Math.atan2(cen[1], cen[0]);
      const reach = rad + Math.max(...rowRad) + 1e-6;
      const j0 = Math.max(0, Math.floor((lat - reach + Math.PI / 2) / this.h)), j1 = Math.min(nLat - 1, Math.floor((lat + reach + Math.PI / 2) / this.h));
      for (let j = j0; j <= j1; j++) {
        const la = -Math.PI / 2 + (j + 0.5) * this.h;
        const cmin = Math.min(Math.cos(la - 0.5 * this.h), Math.cos(la + 0.5 * this.h));
        const near = Math.abs(la) + 0.5 * this.h > Math.PI / 2 - reach;
        const span = near || cmin < 1e-6 ? Math.PI : Math.min(Math.PI, Math.asin(Math.min(1, Math.sin(reach) / cmin)) + this.h);
        const i0 = Math.floor((lon - span + Math.PI) / this.h), i1 = Math.floor((lon + span + Math.PI) / this.h);
        const all = i1 - i0 + 1 >= nLon;
        for (let ii = all ? 0 : i0; ii <= (all ? nLon - 1 : i1); ii++) {
          const i = ((ii % nLon) + nLon) % nLon;
          const cc = dirLL(la, -Math.PI + (i + 0.5) * this.h);
          if (angle(cc, cen) <= rad + rowRad[j] + 1e-9) buckets[j * nLon + i].push(f);
        }
      }
    }
    this.buckets = buckets.map((b) => Int32Array.from(b));
  }

  /** Radius (km) along the unit direction d (exact; throws if no plate is hit). */
  radius(d) {
    const lat = Math.asin(Math.max(-1, Math.min(1, d[2]))), lon = Math.atan2(d[1], d[0]);
    const j = Math.min(this.nLat - 1, Math.max(0, Math.floor((lat + Math.PI / 2) / this.h)));
    const i = ((Math.floor((lon + Math.PI) / this.h) % this.nLon) + this.nLon) % this.nLon;
    const list = this.buckets[j * this.nLon + i];
    let best = -1, tol = 0;
    for (let pass = 0; pass < 3 && best < 0; pass++, tol = pass === 1 ? 1e-9 : 1e-6) {
      for (let k = 0; k < list.length; k++) {
        const t = this.hit(list[k], d, tol);
        if (t > 0 && (best < 0 || t > best)) best = t;
      }
    }
    if (best < 0) throw new Error(`no plate hit at lat ${(lat / DEG).toFixed(4)} lon ${(lon / DEG).toFixed(4)}`);
    return best;
  }

  /** Moller-Trumbore from the origin: distance along d to plate f, or -1. */
  hit(f, d, tol) {
    const V = this.V, F = this.F;
    const a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
    const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
    const e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-15) return -1;
    const inv = 1 / det;
    const tx = -V[a], ty = -V[a + 1], tz = -V[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -tol || u > 1 + tol) return -1;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < -tol || u + v > 1 + tol) return -1;
    return (e2x * qx + e2y * qy + e2z * qz) * inv;
  }
}

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const angle = (a, b) => Math.atan2(Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
const dirLL = (lat, lon) => [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];

// ------------------------------------------------------------------------------------------------ grid / interpolant
// Row j: lat = -90 + j*step (j = 0 .. H-1, both poles included); column i: lonE = -180 + i*step (i = 0 .. W-1,
// periodic). Bilinear in (lon, lat) - exactly what src/moons/shapes.ts and the shader evaluate.
const W = Math.round(360 / STEP), H = Math.round(180 / STEP) + 1;
function sampleGrid(rf) {
  const r = new Float64Array(W * H);
  for (let j = 0; j < H; j++) {
    const lat = (-90 + j * STEP) * DEG;
    if (j === 0 || j === H - 1) {
      const v = rf.radius([0, 0, j === 0 ? -1 : 1]);
      for (let i = 0; i < W; i++) r[j * W + i] = v;
      continue;
    }
    for (let i = 0; i < W; i++) r[j * W + i] = rf.radius(dirLL(lat, (-180 + i * STEP) * DEG));
  }
  return r;
}
function bilinear(map, d) {
  const lat = Math.atan2(d[2], Math.hypot(d[0], d[1])), lon = Math.atan2(d[1], d[0]);
  const y = Math.min(H - 1, Math.max(0, (lat / DEG + 90) / STEP));
  const x = (lon / DEG + 180) / STEP;
  const j0 = Math.min(H - 2, Math.floor(y)), fy = y - j0;
  const i0f = Math.floor(x), fx = x - i0f;
  const i0 = ((i0f % W) + W) % W, i1 = (i0 + 1) % W;
  const a = map[j0 * W + i0] * (1 - fx) + map[j0 * W + i1] * fx;
  const b = map[(j0 + 1) * W + i0] * (1 - fx) + map[(j0 + 1) * W + i1] * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * Max arc-length slope L = max |grad r| (km/rad) of the bilinear interpolant. Within a cell the lon / lat
 * derivatives are linear, so their maxima are the cell-edge differences; pole rows are constant (no lon term).
 */
function maxSlope(map) {
  let L = 0;
  const h = STEP * DEG;
  for (let j = 0; j < H - 1; j++) {
    const c0 = Math.cos((-90 + j * STEP) * DEG), c1 = Math.cos((-90 + (j + 1) * STEP) * DEG);
    for (let i = 0; i < W; i++) {
      const i1 = (i + 1) % W;
      const a = map[j * W + i], b = map[j * W + i1], c = map[(j + 1) * W + i], d = map[(j + 1) * W + i1];
      const sLat = Math.max(Math.abs(c - a), Math.abs(d - b)) / h;
      const sLon = Math.max(j === 0 ? 0 : Math.abs(b - a) / c0, j + 1 === H - 1 ? 0 : Math.abs(d - c) / c1) / h;
      L = Math.max(L, Math.hypot(sLat, sLon));
    }
  }
  return L;
}

/**
 * Best-fit axis-aligned ellipsoid (centre fixed at the origin) by radial least squares over directions uniform in
 * solid angle: min sum (r - r_e(u))^2, r_e = (sum u_i^2/a_i^2)^-1/2 (Gauss-Newton from the linear 1/r^2 fit).
 * Informational: published "best-fit ellipsoids" also free the centre and use surface points, so expect ~1 km
 * differences for these far-from-ellipsoidal bodies.
 */
function fitEllipsoid(rf, n = 20000) {
  const dirs = [], rs = [];
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const z = 1 - (2 * (k + 0.5)) / n, phi = k * 2.399963229728653;
    const s = Math.sqrt(1 - z * z), d = [s * Math.cos(phi), s * Math.sin(phi), z];
    const r = rf.radius(d), w = [d[0] * d[0], d[1] * d[1], d[2] * d[2]], y = 1 / (r * r);
    dirs.push(w); rs.push(r);
    for (let p = 0; p < 3; p++) { B[p] += w[p] * y; for (let q = 0; q < 3; q++) A[p][q] += w[p] * w[q]; }
  }
  let ax = solve3(A, B).map((v) => 1 / Math.sqrt(v));
  for (let it = 0; it < 20; it++) {
    const JJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Je = [0, 0, 0];
    for (let k = 0; k < n; k++) {
      const w = dirs[k];
      const S = w[0] / (ax[0] * ax[0]) + w[1] / (ax[1] * ax[1]) + w[2] / (ax[2] * ax[2]);
      const re = 1 / Math.sqrt(S), e = rs[k] - re;
      const J = [0, 1, 2].map((i) => (re * re * re * w[i]) / (ax[i] * ax[i] * ax[i]));
      for (let p = 0; p < 3; p++) { Je[p] += J[p] * e; for (let q = 0; q < 3; q++) JJ[p][q] += J[p] * J[q]; }
    }
    const dx = solve3(JJ, Je);
    ax = ax.map((v, i) => v + dx[i]);
    if (Math.max(...dx.map(Math.abs)) < 1e-6) break;
  }
  return ax;
}
function solve3(A, b) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

// ------------------------------------------------------------------------------------------------ main
mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });
console.log(`shape models: ${MOONS.join(', ')}  grid ${W} x ${H} (${STEP} deg)  raw ${RAW}`);
for (const f of ['bundle_description.txt', 'ref.txt']) await download(`${BASE}/document/${f}`, resolve(RAW, f));

const entries = {};
const chunks = [];
let offset = 0;
const iauRadii = loadIauRadii();
for (const key of MOONS) {
  const tab = resolve(RAW, `${key}_30k_plt.tab`);
  await download(`${BASE}/data/${key}_30k_plt.tab`, tab);
  await download(`${BASE}/data/${key}_30k_plt.xml`, resolve(RAW, `${key}_30k_plt.xml`));
  await download(`${BASE}/document/${key}_document.pdf`, resolve(RAW, `${key}_document.pdf`));
  const t0 = Date.now();
  const mesh = parsePlates(readFileSync(tab, 'utf8'), key);
  const an = analyse(mesh);
  if (an.negative > 0 || Math.abs(an.omegaOver4pi - 1) > 1e-9) {
    throw new Error(`${key}: not star-shaped about the origin (${an.negative} inward plates, solid angle ${an.omegaOver4pi} x 4pi)`);
  }
  const rf = new RadialFunction(mesh);
  const map = sampleGrid(rf);
  let rMax = 0, rMin = Infinity;
  for (const v of map) { rMax = Math.max(rMax, v); rMin = Math.min(rMin, v); }
  // quantise: r = q * scale, scale = rMax / 65535
  const scale = rMax / 65535;
  const q = new Uint16Array(W * H);
  const deq = new Float64Array(W * H);
  for (let k = 0; k < q.length; k++) { q[k] = Math.max(1, Math.min(65535, Math.round(map[k] / scale))); deq[k] = q[k] * scale; }
  // reconstruction error of the (quantised) bilinear map against the exact mesh, at uniform random directions
  // (seeded, so rebuilds are byte-identical)
  let se = 0, me = 0, mAt = null;
  const rnd = mulberry32(0x5eed + offset);
  for (let k = 0; k < NCHECK; k++) {
    const z = 2 * rnd() - 1, phi = 2 * Math.PI * rnd(), s = Math.sqrt(1 - z * z);
    const d = [s * Math.cos(phi), s * Math.sin(phi), z];
    const e = bilinear(deq, d) - rf.radius(d);
    se += e * e;
    if (Math.abs(e) > me) { me = Math.abs(e); mAt = [Math.asin(z) / DEG, phi / DEG > 180 ? phi / DEG - 360 : phi / DEG]; }
  }
  const L = maxSlope(deq);
  const ell = fitEllipsoid(rf);
  const vmax = mesh.V.reduce((m, _, i) => (i % 3 === 0 ? Math.max(m, Math.hypot(mesh.V[i], mesh.V[i + 1], mesh.V[i + 2])) : m), 0);
  const ext = [0, 1, 2].map((c) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = c; i < mesh.V.length; i += 3) { lo = Math.min(lo, mesh.V[i]); hi = Math.max(hi, mesh.V[i]); }
    return [lo, hi];
  });
  const e = {
    offset, count: W * H, scaleKm: scale,
    rMaxKm: rMax, rMinKm: rMin,
    // step factor bound for the sphere-traced march: |grad r| / r_min (arc-length slope over the smallest radius)
    slopeOverRmin: L / rMin,
    maxSlopeKmPerRad: L,
    volumeKm3: an.vol, meanRadiusKm: Math.cbrt((3 * an.vol) / (4 * Math.PI)), areaKm2: an.area,
    centroidKm: an.centroid,
    extentsKm: { x: ext[0], y: ext[1], z: ext[2] },
    ellipsoidFitKm: ell,
    iauRadiiKm: iauRadii[key] ?? null,
    meshMaxRadiusKm: vmax,
    uncertaintyKm: UNCERTAINTY_KM[key] ?? null,
    mapErrorKm: NCHECK > 0 ? { rms: Math.sqrt(se / NCHECK), max: me, maxAtLatLon: mAt, samples: NCHECK } : null,
    plates: mesh.nf, vertices: mesh.nv,
    source: `${key}_30k_plt.tab`,
  };
  entries[key] = e;
  chunks.push(q);
  offset += q.length;
  console.log(`${key.padEnd(11)} ${mesh.nv} vertices ${mesh.nf} plates (star-shaped: solid angle ${an.omegaOver4pi.toFixed(12)} x 4pi)  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`            V = ${an.vol.toFixed(1)} km3, R_vol = ${e.meanRadiusKm.toFixed(3)} km (published ${LIT_RM_KM[key] ?? '-'}), area ${an.area.toFixed(1)} km2, centroid (${an.centroid.map((v) => v.toFixed(3)).join(', ')}) km`);
  console.log(`            r ${rMin.toFixed(3)} .. ${rMax.toFixed(3)} km (mesh vertices max ${vmax.toFixed(3)}), extents x ${ext[0].map((v) => v.toFixed(2)).join('..')} y ${ext[1].map((v) => v.toFixed(2)).join('..')} z ${ext[2].map((v) => v.toFixed(2)).join('..')}`);
  console.log(`            best-fit ellipsoid ${ell.map((v) => v.toFixed(2)).join(' x ')} km (IAU ${iauRadii[key] ? iauRadii[key].join(' x ') : '-'}), max slope ${L.toFixed(1)} km/rad = ${(L / rMin).toFixed(2)} r_min`);
  if (NCHECK > 0) console.log(`            map vs mesh: rms ${(e.mapErrorKm.rms * 1e3).toFixed(1)} m, max ${(me * 1e3).toFixed(0)} m at lat ${mAt[0].toFixed(1)} lon ${mAt[1].toFixed(1)} (model uncertainty ${e.uncertaintyKm} km)`);
  if (has('profiles')) {
    for (const lon of [0, 90, 180, -90]) {
      const row = [];
      for (let lat = -40; lat <= 40; lat += 4) row.push(rf.radius(dirLL(lat * DEG, lon * DEG)).toFixed(2));
      console.log(`            lon ${String(lon).padStart(4)}: lat -40..40 step 4: ${row.join(' ')}`);
    }
  }
}

const all = new Uint16Array(offset);
let o = 0;
for (const c of chunks) { all.set(c, o); o += c.length; }
const bytes = Buffer.from(all.buffer, all.byteOffset, all.byteLength);   // little-endian on every supported host
if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('big-endian host: write explicitly');
writeFileSync(resolve(OUT, 'shapes.u16'), bytes);
const json = {
  format: 'space-viz moon shape maps v1',
  source: 'P. C. Thomas, J. Joseph, T. Ansty (2018), Saturn Small Moon Shape Models V1.0, NASA Planetary Data System, '
    + 'Small Bodies Node, urn:nasa:pds:saturn_satellite_shape_models::1.0, doi:10.26033/ewy3-jy61 (Cassini ISS NAC; '
    + '30k-plate models). Built by scripts/data/moons/build_shapes.mjs.',
  license: 'NASA PDS data (US government work): no copyright restrictions; please cite the data set.',
  file: 'data/moons/shapes.u16',
  bytes: bytes.length,
  grid: {
    projection: 'equirectangular radius map, bilinear in (lon, lat)',
    width: W, height: H, lonStartDeg: -180, latStartDeg: -90, stepDeg: STEP,
    rows: 'south pole (row 0) to north pole (row height-1); both pole rows constant',
    lon: 'east longitude, column i at -180 + i*step, periodic',
    frame: 'body: +x = prime meridian (Saturn-facing), +z = north spin pole, +y = 90E (trailing)',
    encoding: 'uint16 little-endian, radius_km = value * scaleKm; moon k occupies [offset, offset + width*height)',
  },
  moons: entries,
};
const text = JSON.stringify(json, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(7)) : v), 1)
  .replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, inner) => `[${inner.replace(/\s+/g, ' ')}]`);   // number arrays on one line
writeFileSync(resolve(OUT, 'shapes.json'), text + '\n');
console.log(`wrote ${resolve(OUT, 'shapes.u16')} (${(bytes.length / 1024).toFixed(0)} KiB) and shapes.json`);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadIauRadii() {
  try {
    const j = JSON.parse(readFileSync(resolve(ROOT, 'public/data/moons/moons.json'), 'utf8'));
    return Object.fromEntries(j.moons.map((m) => [m.name.toLowerCase(), m.radiiKm]));
  } catch {
    return {};
  }
}
