// Extract the Saturn rows of the JPL SSD satellite mean-element and physical-parameter HTML tables
// (downloaded into data-raw/ssd/) as plain text / JSON, for reference.
//   node ssd_tables.mjs <file.html> [--json] Name1 Name2 ...
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const file = args[0];
const json = args.includes('--json');
const names = args.slice(1).filter((a) => a !== '--json');
const html = readFileSync(file, 'utf8');
const clean = (s) => s.replace(/<[^>]+>/g, '').replace(/&plusmn;/g, '±').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const headers = [];
for (const m of html.matchAll(/<thead[^>]*>([\s\S]*?)<\/thead>/gi)) {
  headers.push([...m[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((x) => clean(x[1])));
}
console.log('HEADERS:', JSON.stringify(headers));
const out = {};
for (const tr of html.split(/<tr[^>]*>/i).slice(1)) {
  const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => clean(x[1]));
  if (cells.length < 4) continue;
  const name = names.find((n) => cells.includes(n));
  if (!name) continue;
  if (json) (out[name] ??= []).push(cells);
  else console.log(cells.join(' | '));
}
if (json) console.log(JSON.stringify(out, null, 1));
