// Fetch the Horizons object-data header (physical properties block) for each moon and save to
// data-raw/ssd/horizons_objdata.txt (reference only).
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../ephemeris/horizons.mjs';
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const ids = [618, 635, 615, 616, 617, 611, 610, 653, 601, 632, 649, 633, 602, 603, 613, 614, 604, 612, 634, 605, 606, 607, 608, 609, 629, 626, 620, 619, 624, 621, 622];
let out = '';
for (const id of ids) {
  const qs = `format=text&COMMAND='${id}'&OBJ_DATA='YES'&MAKE_EPHEM='NO'`;
  const txt = await (await fetch(`${API}?${qs}`)).text();
  out += `===== ${id}\n${txt}\n`;
}
writeFileSync(resolve(ROOT, 'data-raw/ssd/horizons_objdata.txt'), out);
console.log('ok', out.length);
