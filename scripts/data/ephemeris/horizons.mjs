// Minimal JPL Horizons API client (https://ssd-api.jpl.nasa.gov/doc/horizons.html) with an on-disk cache
// under data-raw/horizons/. Used by the moon / Sun ephemeris build scripts.
//
//   import { horizonsVectors } from './horizons.mjs';
//   const rows = await horizonsVectors({ target: '602', center: '500@699', start: '2020-01-01', stop: '2021-01-01', step: '1d' });
//   // rows: [{ jd, x, y, z, vx, vy, vz }]  (TDB Julian dates, ICRF, km, km/s, geometric states)
//
// Discrete epochs: horizonsVectors({ target, tlist: [jd1, jd2, ...] }).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Project root (overridable with SV_ROOT when this module is bundled elsewhere). */
export const ROOT = process.env.SV_ROOT ?? resolve(HERE, '../../..');
const CACHE = resolve(ROOT, 'data-raw/horizons');
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';

function q(v) {
  return `'${v}'`;
}

async function fetchText(params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const key = createHash('sha1').update(qs).digest('hex').slice(0, 20);
  const file = resolve(CACHE, `${key}.txt`);
  if (existsSync(file)) return readFileSync(file, 'utf8');
  mkdirSync(CACHE, { recursive: true });
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${API}?${qs}`);
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 400)}`);
      if (!txt.includes('$$SOE')) throw new Error(`no ephemeris in response:\n${txt.slice(0, 3000)}`);
      writeFileSync(file, txt);
      writeFileSync(file.replace(/\.txt$/, '.query'), qs + '\n');
      return txt;
    } catch (e) {
      lastErr = e;
      if (String(e).includes('no ephemeris')) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Parse a CSV VECTORS table (VEC_TABLE=2, CSV_FORMAT=YES, CAL_FORMAT=JD). */
export function parseVectors(txt) {
  const a = txt.indexOf('$$SOE');
  const b = txt.indexOf('$$EOE');
  const body = txt.slice(a + 5, b).trim().split('\n');
  const rows = [];
  for (const line of body) {
    const f = line.split(',').map((s) => s.trim()).filter((s) => s.length);
    if (f.length < 4) continue;
    const jd = parseFloat(f[0]);
    const nums = f.slice(1).map(Number).filter((v) => Number.isFinite(v));
    rows.push({ jd, x: nums[0], y: nums[1], z: nums[2], vx: nums[3], vy: nums[4], vz: nums[5] });
  }
  return rows;
}

/** Source line(s) from the Horizons header, e.g. "{source: sat441l}". */
export function parseSource(txt) {
  const m = txt.match(/Target body name:.*?\{source:\s*([^}]+)\}/);
  return m ? m[1].trim() : '';
}

export async function horizonsRaw(opts) {
  const base = {
    format: 'text',
    COMMAND: q(opts.target),
    OBJ_DATA: q('NO'),
    MAKE_EPHEM: q('YES'),
    EPHEM_TYPE: q('VECTORS'),
    CENTER: q(opts.center ?? '500@699'),
    REF_SYSTEM: q('ICRF'),
    REF_PLANE: q('FRAME'),
    VEC_CORR: q('NONE'),
    OUT_UNITS: q('KM-S'),
    VEC_TABLE: q(opts.vecTable ?? '2'),
    CSV_FORMAT: q('YES'),
    CAL_FORMAT: q('JD'),
    VEC_LABELS: q('NO'),
    TIME_DIGITS: q('FRACSEC'),
  };
  if (opts.tlist) {
    base.TLIST = opts.tlist.map((j) => j.toFixed(9)).join(' ');
    base.TLIST_TYPE = q('JD');
    base.TIME_TYPE = q('TDB');
  } else {
    base.START_TIME = q(opts.start);
    base.STOP_TIME = q(opts.stop);
    base.STEP_SIZE = q(opts.step);
  }
  return fetchText(base);
}

export async function horizonsVectors(opts) {
  const txt = await horizonsRaw(opts);
  return parseVectors(txt);
}

/** Fetch a long span in chunks of at most `maxRows` rows. step given in days (number). */
export async function horizonsSpan(target, jd0, jd1, stepDays, { center = '500@699', maxRows = 80000, vecTable = '1' } = {}) {
  const out = [];
  const chunk = maxRows * stepDays;
  let s = jd0;
  let source = '';
  while (s < jd1 - 1e-9) {
    const e = Math.min(jd1, s + chunk);
    const n = Math.max(1, Math.round((e - s) / stepDays));
    const txt = await horizonsRaw({ target, center, start: `JD${s.toFixed(6)}`, stop: `JD${e.toFixed(6)}`, step: String(n), vecTable });
    source = parseSource(txt) || source;
    const rows = parseVectors(txt);
    for (const r of rows) if (out.length === 0 || r.jd > out[out.length - 1].jd + 1e-9) out.push(r);
    s = e;
  }
  return { rows: out, source };
}
