// Download the ISIS/PDS labels of the USGS Cassini global mosaics and print their mapping groups.
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const base = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/';
const names = [
  'Enceladus_Cassini_mosaic_global_110m', 'Tethys_Cassini_mosaic_global_293m', 'Dione_Cassini_Voyager_mosaic_global_154m',
  'Rhea_Cassini_Voyager_mosaic_global_417m', 'Iapetus_Cassini_Voyager_mosaic_global_783m',
];
for (const n of names) {
  for (const ext of ['.lbl', '_pds3.lbl']) {
    const r = await fetch(base + n + ext);
    if (!r.ok) { console.log(n + ext, r.status); continue; }
    const t = await r.text();
    writeFileSync(resolve(ROOT, 'data-raw/textures/usgs', n + ext), t);
    const keep = t.split('\n').filter((l) => /Samples|Lines|ProjectionName|CenterLongitude|LongitudeDirection|LongitudeDomain|LatitudeType|Minimum|Maximum|EquatorialRadius|PolarRadius|PixelResolution|Scale|UpperLeft|LINE_SAMPLES|LINES |CENTER_LONGITUDE|POSITIVE_LONGITUDE|COORDINATE_SYSTEM|EASTERNMOST|WESTERNMOST|SAMPLE_PROJECTION_OFFSET|MAP_PROJECTION_TYPE|SAMPLE_TYPE|SAMPLE_BITS/i.test(l));
    console.log(`=== ${n}${ext}\n${keep.map((l) => '  ' + l.trim()).join('\n')}`);
  }
}
