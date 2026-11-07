// Download raw global maps into data-raw/textures/ (streams to disk; skips files that already exist).
//   node download.mjs <dir> <url> [<url> ...]
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [dir, ...urls] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
for (const url of urls) {
  const out = resolve(dir, basename(new URL(url).pathname));
  if (existsSync(out)) { console.log(`exists ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`); continue; }
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (space-viz data build)' } });
  if (!res.ok) { console.log(`FAILED ${res.status} ${url}`); continue; }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(out + '.part'));
  renameSync(out + '.part', out);
  console.log(`got ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
