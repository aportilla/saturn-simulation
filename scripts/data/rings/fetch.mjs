#!/usr/bin/env node
// Download the Cassini occultation products used by build_tau.mjs into data-raw/rings/ (gitignored).
//
//   node scripts/data/rings/fetch.mjs            # fetch everything missing
//   node scripts/data/rings/fetch.mjs --labels   # labels only
//
// Sources (PDS Ring-Moon Systems Node, https://pds-rings.seti.org):
//   CORSS_8001  Marouf, E., Cassini Orbiter Saturn RSS ring radio occultations 2.0, CO-SR-RSS-4/5-OCC-V2.0 (2018)
//   COUVIS_8001 Colwell, J. et al., Cassini UVIS HSP stellar occultation ring profiles, CO-SR-UVIS-HSP-2/4-OCC-V3.0 (2020)
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RAW = resolve(ROOT, 'data-raw/rings');
const PDS = 'https://pds-rings.seti.org/holdings/volumes';

/** Cassini RSS X-band reconstructed profiles, 1 km resolution (0.25 km sampling). Rev 7 (2005, B = -23.6 deg). */
export const RSS = [
  { id: 'RSS_2005_123_X43_E', dir: 'CORSS_8xxx/CORSS_8001/data/Rev007/Rev007E/Rev007E_RSS_2005_123_X43_E' },
  { id: 'RSS_2005_123_X43_I', dir: 'CORSS_8xxx/CORSS_8001/data/Rev007/Rev007I/Rev007I_RSS_2005_123_X43_I' },
];

/** Cassini UVIS HSP stellar occultations of beta Centauri (B = 66.7 deg), 1 km bins. */
export const UVIS = [
  'UVIS_HSP_2008_231_BETCEN_I',
  'UVIS_HSP_2008_202_BETCEN_I',
  'UVIS_HSP_2008_260_BETCEN_I',
  'UVIS_HSP_2008_290_BETCEN_I',
  'UVIS_HSP_2008_343_BETCEN_I',
  'UVIS_HSP_2009_065_BETCEN_I',
];

async function get(url, out) {
  if (existsSync(out) && statSync(out).size > 0) return false;
  mkdirSync(dirname(out), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log('fetched', url);
  return true;
}

export function rssPath(id, ext = 'TAB') {
  return resolve(RAW, 'rss', id, `${id}_TAU_01KM.${ext}`);
}
export function uvisPath(id, ext = 'TAB') {
  return resolve(RAW, 'uvis', `${id}_TAU01KM.${ext}`);
}

async function main() {
  const labelsOnly = process.argv.includes('--labels');
  const exts = labelsOnly ? ['LBL'] : ['LBL', 'TAB'];
  for (const r of RSS) for (const e of exts) await get(`${PDS}/${r.dir}/${r.id}_TAU_01KM.${e}`, rssPath(r.id, e));
  for (const u of UVIS) for (const e of exts) await get(`${PDS}/COUVIS_8xxx/COUVIS_8001/data/${u}_TAU01KM.${e}`, uvisPath(u, e));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
