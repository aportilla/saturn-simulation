#!/usr/bin/env node
// Bibliography sync check (no GPU, ~1 s): src/app/references.ts against the docs, the code and src/app/placeSources.ts.
//
// usage: node scripts/check-refs.mjs [--online] [--only id,id] [--out DIR] [--verbose]
//        npm run check:refs                 (also part of `npm test`)
//        npm run check:refs -- --online     (re-verify the metadata against Crossref / DataCite / arXiv)
//
// Checks (exit 1 if any FAIL):
//  1. references.ts is well formed: unique ids, known type and topics, authors, year, title, venue, usedFor, DOI and
//     arXiv syntax, a verification source on every entry, a note on every unverified one, a licence on data
//     products and software.
//  2. Every author–year citation in README.md, docs/ring-physics.md and docs/data-sources.md resolves to an entry:
//     inline forms "Surname 2010", "Surname & Other (2010)", "A, B & C 2009", "P. C. Thomas, J. Joseph & T. Ansty
//     (2018)", "Surname et al. 2007, 2013", "H&N 2016", and the reference list of ring-physics.md ("Surname, I.,
//     Other, I. 2010, …"). Ambiguous citations ("Hedman et al. 2007" with 2007a/b/c) and loose ones ("Verbiscer
//     2007" for Verbiscer et al. 2007) are listed as notes; they don't fail.
//  3. Every DOI, arXiv id, PDS volume id (CORSS_8001 …) and Photojournal id (PIA…) in those docs belongs to an entry
//     (IGNORE_IDS lists the deliberate exceptions, with the reason).
//  4. Every entry is cited somewhere: in those docs, in src/ (references.ts and placeSources.ts excluded; author–year
//     forms, DOIs and the entry's `cite` strings) or in a placeSources.ts list.
//  5. placeSources.ts: every id exists. Every preset in src/app/presets.ts should have a list of 3–8 ids: a missing
//     or odd-sized list is a warning (the explainer then falls back to context defaults), not a failure.
// Informational: author–year citations in src/ that are not in the bibliography (rendering techniques, standards).
//
// --online (network, ~2 min) re-checks every entry against the registries: DOIs via Crossref (DataCite for data
// DOIs): first author, year (±1: print vs online edition), title (every word of the registry title in ours, or
// ≥ 70 % overlap — registries often hold only the main title), volume, first page / article number; arXiv ids via
// the arXiv API (title); landing pages (url) must answer HTTP 2xx. --only restricts it to some ids.
//
// Writes <out>/results.json (default <os tmp>/space-viz-test/refs-<stamp>/). Documented in scripts/test/README.md.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO, Report, outputDir, parseArgs, table } from './test/lib.mjs';

const args = parseArgs(process.argv.slice(2), { bool: ['online', 'verbose'] });
if (args.has('help')) {
  console.log('usage: node scripts/check-refs.mjs [--online] [--only id,id] [--out DIR] [--verbose]');
  process.exit(0);
}
const out = outputDir('refs', args.str('out'));
const rep = new Report('check-refs', out);
const verbose = args.flag('verbose');

const DOCS = ['README.md', 'docs/ring-physics.md', 'docs/data-sources.md'];
const REF_FILE = 'src/app/references.ts';
const PLACE_FILE = 'src/app/placeSources.ts';
const PRESET_FILE = 'src/app/presets.ts';
const TYPES = new Set(['paper', 'book', 'thesis', 'conference abstract', 'dataset', 'catalog', 'software']);
const NEEDS_LICENCE = new Set(['dataset', 'catalog', 'software']);
/** identifiers named in the docs that are deliberately not in the bibliography */
const IGNORE_IDS = {
  PIA06193: 'data-sources.md §5 names this Saturn tile mosaic only to say why there is no Saturn map (not used)',
};
/** author–year look-alikes in the docs that are not citations (add with a reason) */
const IGNORE_CITES = {};
/** capitalised words that precede a year without being an author */
const STOP = new Set(('January February March April May June July August September October November December Jan Feb Mar Apr ' +
  'Jun Jul Aug Sep Sept Oct Nov Dec Rev Table Figure Fig Section Version Since Until From In On At By Before After During ' +
  'Saturn Titan Mimas Enceladus Tethys Dione Rhea Iapetus Hyperion Phoebe Pan Daphnis Atlas Prometheus Pandora Janus ' +
  'Epimetheus Aegaeon Methone Anthe Pallene Calypso Telesto Polydeuces Helene Cassini Voyager Huygens Hubble Horizons ' +
  'Earth Sun Equinox Solstice Python Node Chrome Mission Release Edition Outside Inside Between Over Under Through ' +
  'Around Near Above Below Within Beyond Prior Every Each Year Years Epoch Data').split(/\s+/));

// ------------------------------------------------------------------------------------------------ load
const read = (p) => readFileSync(join(REPO, p), 'utf8');
let REFERENCES, TOPICS, PS;
try {
  ({ REFERENCES, TOPICS } = await import(pathToFileURL(join(REPO, REF_FILE)).href));
  PS = await import(pathToFileURL(join(REPO, PLACE_FILE)).href);
} catch (e) {
  rep.error(`importing ${REF_FILE} / ${PLACE_FILE} (Node type stripping: erasable TypeScript only, no imports)`, e);
  process.exit(rep.finish());
}
const TOPIC_KEYS = new Set(TOPICS.map(([k]) => k));
const byId = new Map(REFERENCES.map((r) => [r.id, r]));

// ------------------------------------------------------------------------------------------------ helpers
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[’`]/g, "'").toLowerCase().trim();
const surnameOf = (a) => (a.includes(',') ? a.slice(0, a.indexOf(',')) : a).trim();
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const ENTRY = REFERENCES.map((r) => ({ r, s: r.authors.map((a) => norm(surnameOf(a))), n: r.etAl ? Infinity : r.authors.length }));

const UP = '\\p{Lu}';
const SUR = `(?:(?:El|De|de|Van|van|Von|von|Le|La|Di|Da)\\s)?${UP}[\\p{L}'’]+(?:-[\\p{L}'’]+)*`;
const INI = `(?:${UP}\\.(?:-${UP}\\.)?\\s?)+`;
const AUTH = `(?:${INI})?${SUR}`;
const YEAR = '(?:19|20)\\d\\d[a-c]?(?![\\d\\-])';
const YEARS = `${YEAR}(?:\\s*[,/]\\s*${YEAR})*`;
const RX = {
  etal: new RegExp(`(${AUTH})\\s+et\\s+al\\.?,?\\s*\\(?(${YEARS})`, 'gu'),
  list: new RegExp(`(${AUTH}(?:,\\s*${AUTH})*),?\\s*(?:&|\\band\\b)\\s*(${AUTH}),?\\s*\\(?(${YEARS})`, 'gu'),
  abbr: new RegExp(`(?<!\\p{L})(${UP})&(${UP})\\s*\\(?(${YEAR})`, 'gu'),
  single: new RegExp(`(?<![\\p{L}.])(${AUTH})\\s*\\(?(${YEARS})`, 'gu'),
};
const stripInitials = (a) => a.replace(new RegExp(`^${INI}`, 'u'), '').trim();
const splitYears = (s) => s.split(/\s*[,/]\s*/).map((y) => ({ y: Number(y.slice(0, 4)), s: y.slice(4) || undefined }));

/**
 * Author–year citations in a text: [{ surnames, etAl, abbr?, years: [{y, s}], text, idx }]. Excludes [lo, hi) spans
 * (the parsed reference list).
 */
function extractCitations(text, skip = []) {
  let t = text.replace(/[*_`]/g, ' ');
  for (const [lo, hi] of skip) t = t.slice(0, lo) + ' '.repeat(hi - lo) + t.slice(hi);
  const found = [];
  const mask = (m) => {
    t = t.slice(0, m.index) + ' '.repeat(m[0].length) + t.slice(m.index + m[0].length);
  };
  for (const m of [...t.matchAll(RX.etal)]) {
    found.push({ surnames: [norm(stripInitials(m[1]))], etAl: true, years: splitYears(m[2]), text: m[0], idx: m.index });
    mask(m);
  }
  for (const m of [...t.matchAll(RX.list)]) {
    const raw = [...m[1].split(/,\s*/), m[2]].map(stripInitials);
    while (raw.length > 2 && raw[0] === raw[0].toUpperCase()) raw.shift(); // "(TSI, Kopp & Lean 2011)": drop acronyms
    if (raw.some((x) => STOP.has(x) || x === x.toUpperCase())) continue;
    const names = raw.map(norm);
    found.push({ surnames: names, etAl: false, years: splitYears(m[3]), text: m[0], idx: m.index });
    mask(m);
  }
  for (const m of [...t.matchAll(RX.abbr)]) {
    found.push({ surnames: [], abbr: [m[1], m[2]], etAl: false, years: splitYears(m[3]), text: m[0], idx: m.index });
    mask(m);
  }
  for (const m of [...t.matchAll(RX.single)]) {
    const name = stripInitials(m[1]);
    if (STOP.has(name) || name === name.toUpperCase()) continue; // months, moons, … and acronyms (IAU 2015, CIE 1931)
    found.push({ surnames: [norm(name)], etAl: false, years: splitYears(m[2]), text: m[0], idx: m.index });
  }
  return found.filter((c) => !(c.text.trim() in IGNORE_CITES));
}

/** The reference list of ring-physics.md: paragraphs of " · "-separated items "Surname, I., Other, I. 2010, …". */
function extractReferenceList(text) {
  const h = text.search(/^## References\s*$/m);
  if (h < 0) return { items: [], span: null };
  const end = text.slice(h + 1).search(/^## /m);
  const sec = text.slice(h, end < 0 ? text.length : h + 1 + end);
  const items = [];
  let pos = h;
  for (const para of sec.split(/\n\s*\n/)) {
    const at = text.indexOf(para, pos);
    pos = at + para.length;
    if (!para.includes(' · ')) continue;
    let k = at;
    for (const raw of para.replace(/\n/g, ' ').split(' · ')) {
      const item = raw.trim();
      const ym = new RegExp(`(?:^|\\s)(${YEAR})(?=[,\\s(]|$)`, 'u').exec(item);
      const idx = text.indexOf(item.slice(0, 20).split(' ')[0], k);
      k = Math.max(k, idx);
      if (!ym) {
        items.push({ noYear: true, text: item, idx });
        continue;
      }
      const toks = item.slice(0, ym.index).split(/,\s*/).map((s) => s.trim()).filter(Boolean);
      const surnames = [];
      let etAl = false;
      for (const tk of toks) {
        if (/^et al\.?$/.test(tk)) etAl = true;
        else if (!new RegExp(`^${INI}$`, 'u').test(tk)) surnames.push(norm(tk));
      }
      items.push({ surnames, etAl, years: splitYears(ym[1]), text: item.slice(0, 90), idx, list: true });
    }
  }
  return { items, span: [h, end < 0 ? text.length : h + 1 + end] };
}

/** Candidate entries for one author–year: strict (author form matches), else loose (first author + year). */
function resolve(c, y) {
  const pool = ENTRY.filter((e) => e.r.year === y.y && (y.s ? e.r.suffix === y.s : true));
  let byAuthor;
  if (c.abbr) {
    byAuthor = pool.filter((e) => e.n === 2 && e.s[0].startsWith(c.abbr[0].toLowerCase()) && e.s[1].startsWith(c.abbr[1].toLowerCase()));
    return { strict: byAuthor.map((e) => e.r), loose: [] };
  }
  byAuthor = pool.filter((e) => e.s[0] === c.surnames[0]);
  const strict = byAuthor.filter((e) => {
    if (c.etAl) return e.n >= 3;
    if (c.surnames.length === 1) return e.n === 1;
    const k = Math.min(c.surnames.length, e.s.length);
    for (let i = 0; i < k; i++) if (e.s[i] !== c.surnames[i]) return false;
    return e.r.etAl ? c.surnames.length >= e.s.length : c.surnames.length === e.s.length;
  });
  // an unlettered citation of a lettered pair (Hedman et al. 2007 → 2007a / 2007b) is ambiguous, not loose
  return { strict: strict.map((e) => e.r), loose: strict.length ? [] : byAuthor.map((e) => e.r) };
}

function citeLabel(c, y) {
  const who = c.abbr ? `${c.abbr[0]}&${c.abbr[1]}` : c.etAl ? `${c.surnames[0]} et al.` : c.surnames.join(' & ');
  return `${who} ${y.y}${y.s ?? ''}`;
}

function walk(dir, exts, acc = []) {
  for (const f of readdirSync(join(REPO, dir))) {
    const p = join(dir, f);
    if (statSync(join(REPO, p)).isDirectory()) walk(p, exts, acc);
    else if (exts.some((x) => f.endsWith(x))) acc.push(p);
  }
  return acc;
}

// ------------------------------------------------------------------------------------------------ 1. well-formed
{
  const problems = [];
  const seen = new Set();
  for (const r of REFERENCES) {
    const P = (m) => problems.push(`${r.id}: ${m}`);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(r.id ?? '')) P('id must be alphanumeric');
    if (seen.has(r.id)) P('duplicate id');
    seen.add(r.id);
    if (!TYPES.has(r.type)) P(`unknown type "${r.type}"`);
    if (!Array.isArray(r.authors) || !r.authors.length || r.authors.some((a) => !a || typeof a !== 'string')) P('authors missing');
    if (r.etAl && r.authors.length !== 3) P('etAl entries list exactly the first three authors');
    if (!Number.isInteger(r.year) || r.year < 1800 || r.year > 2100) P(`bad year ${r.year}`);
    if (r.suffix && !/^[a-c]$/.test(r.suffix)) P(`bad suffix ${r.suffix}`);
    for (const k of ['title', 'venue', 'usedFor', 'verifiedBy']) if (!r[k] || typeof r[k] !== 'string') P(`${k} missing`);
    if (!Array.isArray(r.topics) || !r.topics.length) P('no topics');
    else for (const t of r.topics) if (!TOPIC_KEYS.has(t)) P(`unknown topic "${t}"`);
    if (r.doi && !/^10\.\d{4,9}\/\S+$/.test(r.doi)) P(`malformed DOI ${r.doi}`);
    if (r.doi && r.doi !== r.doi.toLowerCase()) P('write DOIs in lower case (they are case-insensitive)');
    if (r.arxiv && !/^(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})$/.test(r.arxiv)) P(`malformed arXiv id ${r.arxiv}`);
    if (r.url && !/^https?:\/\/\S+$/.test(r.url)) P(`malformed url ${r.url}`);
    if (!r.doi && !r.url && !r.arxiv && !r.ads && r.verified) P('verified entry without DOI / URL / arXiv / ADS');
    if (typeof r.verified !== 'boolean') P('verified must be true or false');
    if (r.verified === false && !r.note) P('unverified entries need a note saying why');
    if (NEEDS_LICENCE.has(r.type) && !r.licence) P(`${r.type} without a licence`);
  }
  rep.check('references.ts is well formed', problems.length === 0, problems.length ? problems.join('; ') : `${REFERENCES.length} entries`);
}

// ------------------------------------------------------------------------------------------------ 2. docs citations
const cited = new Map(); // id -> Set of where
const markCited = (id, where) => {
  if (!cited.has(id)) cited.set(id, new Set());
  cited.get(id).add(where);
};
const unresolved = [];
const ambiguous = [];
const loose = [];
let nDocCites = 0;
const docText = {};
for (const f of DOCS) {
  const text = read(f);
  docText[f] = text;
  const { items, span } = extractReferenceList(text);
  const cites = [...items.filter((i) => !i.noYear), ...extractCitations(text, span ? [span] : [])];
  for (const c of cites) {
    for (const y of c.years) {
      nDocCites++;
      const { strict, loose: lo } = resolve(c, y);
      const where = `${f}:${lineOf(text, c.idx)}`;
      const label = citeLabel(c, y);
      if (strict.length === 1) markCited(strict[0].id, f);
      else if (strict.length > 1) ambiguous.push({ where, label, ids: strict.map((r) => r.id) });
      else if (lo.length) {
        loose.push({ where, label, ids: lo.map((r) => r.id) });
        if (lo.length === 1) markCited(lo[0].id, f);
      } else unresolved.push({ where, label, text: c.text.trim().slice(0, 80) });
    }
  }
}
rep.check('docs: every author–year citation resolves to references.ts', unresolved.length === 0,
  `${nDocCites} citations in ${DOCS.length} files, ${unresolved.length} unresolved, ${ambiguous.length} ambiguous, ${loose.length} loose`
  + (unresolved.length ? `: ${unresolved.map((u) => `${u.label} (${u.where})`).join('; ')}` : ''));

// ------------------------------------------------------------------------------------------------ 3. identifiers
const missingIds = [];
let nIds = 0;
const entryHas = (tok) => {
  const t = tok.toLowerCase();
  return REFERENCES.filter((r) => [r.doi, r.arxiv, r.url, r.title, ...(r.cite ?? [])].some((v) => v && v.toLowerCase().includes(t)));
};
for (const f of DOCS) {
  const text = docText[f];
  const toks = [
    ...[...text.matchAll(/\b10\.\d{4,9}\/[^\s;,)*`<>"]+/g)].map((m) => [m[0].replace(/[.)]+$/, ''), m.index]),
    ...[...text.matchAll(/arXiv:\s?(\d{4}\.\d{4,5})/g)].map((m) => [m[1], m.index]),
    ...[...text.matchAll(/\b(CO[A-Z]{2,6}_\d{4})\b/g)].map((m) => [m[1], m.index]),
    ...[...text.matchAll(/\bPIA\d{5}\b/g)].map((m) => [m[0], m.index]),
  ];
  for (const [tok, idx] of toks) {
    nIds++;
    if (tok in IGNORE_IDS) continue;
    const hits = entryHas(tok);
    if (!hits.length) missingIds.push(`${tok} (${f}:${lineOf(text, idx)})`);
    for (const r of hits) markCited(r.id, f);
  }
}
rep.check('docs: every DOI / arXiv / PDS volume / PIA id belongs to an entry', missingIds.length === 0,
  `${nIds} identifiers (${Object.keys(IGNORE_IDS).length} ignored on purpose)${missingIds.length ? `: missing ${missingIds.join(', ')}` : ''}`);

// docs mentions of an entry's own cite strings (data products, software)
for (const r of REFERENCES) {
  for (const f of DOCS) {
    const text = docText[f];
    if ((r.cite ?? []).some((s) => text.includes(s)) || (r.doi && text.toLowerCase().includes(r.doi))) markCited(r.id, f);
  }
}

// ------------------------------------------------------------------------------------------------ 4. cited somewhere
const srcFiles = walk('src', ['.ts', '.glsl']).filter((p) => p !== REF_FILE && p !== PLACE_FILE);
const srcUnknown = new Map(); // label -> [where]
for (const p of srcFiles) {
  const text = read(p);
  // join comment lines (a citation may wrap: "J. Joseph &\n// T. Ansty (2018)"), keeping offsets for line numbers
  const joined = text.replace(/\n[ \t]*(?:\/\/+|\*+(?!\/)|#)?[ \t]?/g, (m) => ' '.repeat(m.length));
  for (const c of extractCitations(joined)) {
    for (const y of c.years) {
      const { strict, loose: lo } = resolve(c, y);
      const hits = strict.length ? strict : lo;
      if (hits.length) for (const r of hits) markCited(r.id, 'src');
      else {
        const label = citeLabel(c, y);
        if (!srcUnknown.has(label)) srcUnknown.set(label, []);
        srcUnknown.get(label).push(`${p}:${lineOf(text, c.idx)}`);
      }
    }
  }
  for (const r of REFERENCES) {
    if ((r.cite ?? []).some((s) => text.includes(s)) || (r.doi && text.toLowerCase().includes(r.doi))) markCited(r.id, 'src');
  }
}
const lists = {
  ...Object.fromEntries(Object.entries(PS.PLACE_SOURCES).map(([k, v]) => [`place ${k}`, v])),
  ...Object.fromEntries(Object.entries(PS.MOON_SOURCES).map(([k, v]) => [`moon ${k}`, v])),
  ...Object.fromEntries(Object.entries(PS.DUSTY_RING_SOURCES).map(([k, v]) => [`${k} ring`, v])),
  'moon default': PS.MOON_DEFAULT,
  ...Object.fromEntries(Object.entries(PS.PLANNED_SOURCES).map(([k, v]) => [`planned ${k}`, v])),
};
const badIds = [];
for (const [name, ids] of Object.entries(lists)) {
  for (const id of ids) {
    if (!byId.has(id)) badIds.push(`${id} (${name})`);
    else markCited(id, 'placeSources');
  }
}
const uncited = REFERENCES.filter((r) => !cited.has(r.id)).map((r) => r.id);
const whereCount = (w) => REFERENCES.filter((r) => cited.get(r.id)?.has(w)).length;
rep.check('every entry is cited (docs, src/ or placeSources.ts)', uncited.length === 0,
  `docs ${REFERENCES.filter((r) => [...(cited.get(r.id) ?? [])].some((w) => DOCS.includes(w))).length}, src ${whereCount('src')}, placeSources ${whereCount('placeSources')} of ${REFERENCES.length}`
  + (uncited.length ? `; uncited: ${uncited.join(', ')}` : ''));

// ------------------------------------------------------------------------------------------------ 5. placeSources
rep.check('placeSources.ts: every id exists in references.ts', badIds.length === 0,
  `${Object.keys(lists).length} lists${badIds.length ? `; unknown: ${badIds.join(', ')}` : ''}`);
const presetIds = [...read(PRESET_FILE).matchAll(/\bid:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
const warnings = [];
for (const id of presetIds) {
  const l = PS.PLACE_SOURCES[id];
  if (!l) warnings.push(`place "${id}" has no list in placeSources.ts (the explainer falls back to context defaults)`);
  else if (l.length < 3 || l.length > 8) warnings.push(`place "${id}" lists ${l.length} references (aim for 3–8)`);
  else if (new Set(l).size !== l.length) warnings.push(`place "${id}" lists a reference twice`);
}
for (const id of Object.keys(PS.PLACE_SOURCES)) if (!presetIds.includes(id)) warnings.push(`placeSources.ts lists "${id}", which is not a preset (move it to PLANNED_SOURCES?)`);

// ------------------------------------------------------------------------------------------------ report
const nVer = REFERENCES.filter((r) => r.verified).length;
const types = new Map();
for (const r of REFERENCES) types.set(r.type, (types.get(r.type) ?? 0) + 1);
console.log(`\n${table(['type', 'entries'], [...types].map(([k, v]) => [k, v]))}\n`);
console.log(`${table(['topic', 'entries'], TOPICS.map(([k, label]) => [`${label} (${k})`, REFERENCES.filter((r) => r.topics.includes(k)).length]))}\n`);
console.log(`verified ${nVer} of ${REFERENCES.length}; unverified: ${REFERENCES.filter((r) => !r.verified).map((r) => r.id).join(', ') || 'none'}`);
if (ambiguous.length) console.log(`\nnote — ambiguous citations (resolve to several entries; add the letter in the doc to pin one):\n${ambiguous.map((a) => `  ${a.label} → ${a.ids.join(' / ')}  (${a.where})`).join('\n')}`);
if (loose.length) console.log(`\nnote — loose citations (author form differs from the entry; resolved by first author + year):\n${loose.map((a) => `  ${a.label} → ${a.ids.join(' / ')}  (${a.where})`).join('\n')}`);
if (warnings.length) console.log(`\nwarning —\n${warnings.map((w) => `  ${w}`).join('\n')}`);
if (srcUnknown.size) {
  console.log(`\ninfo — author–year citations in src/ that are not in the bibliography (fine for techniques and standards; add an entry if a physical number comes from one):`);
  for (const [label, w] of srcUnknown) console.log(`  ${label}  (${w.slice(0, 2).join(', ')}${w.length > 2 ? ', …' : ''})`);
}
if (verbose) {
  console.log('\ncitation sites per entry:');
  for (const r of REFERENCES) console.log(`  ${r.id.padEnd(22)} ${[...(cited.get(r.id) ?? [])].join(', ')}`);
}
rep.data = {
  entries: REFERENCES.length, verified: nVer, unverified: REFERENCES.filter((r) => !r.verified).map((r) => ({ id: r.id, note: r.note })),
  types: Object.fromEntries(types), topics: Object.fromEntries(TOPICS.map(([k]) => [k, REFERENCES.filter((r) => r.topics.includes(k)).length])),
  docCitations: nDocCites, ambiguous, loose, unresolved, warnings, srcUnknown: Object.fromEntries(srcUnknown),
  citedBy: Object.fromEntries(REFERENCES.map((r) => [r.id, [...(cited.get(r.id) ?? [])]])),
};

// ------------------------------------------------------------------------------------------------ --online
if (args.flag('online')) await online(args.list('only', null));
process.exit(rep.finish());

async function online(only) {
  const UA = { 'User-Agent': 'space-viz check-refs (bibliography verification; https://github.com/)', Accept: 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = async (url, opts = {}) => {
    for (let i = 0; i < 6; i++) {
      try {
        const r = await fetch(url, { headers: opts.headers ?? UA, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
        if (r.status !== 429 && r.status < 500) return r;
        await sleep(Math.max(Number(r.headers.get('retry-after')) * 1000 || 0, 1500 * 2 ** i));
      } catch (e) {
        if (i === 5) return { ok: false, status: `network: ${e.message}` };
        await sleep(1500 * 2 ** i);
      }
    }
    return { ok: false, status: 429 };
  };
  const words = (s) => norm(String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')).replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length > 1);
  const titleOk = (theirs, ours) => {
    const a = words(theirs);
    const b = new Set(words(ours));
    if (!a.length) return true;
    const hit = a.filter((w) => b.has(w)).length;
    return hit === a.length || hit / Math.max(a.length, b.size) >= 0.7;
  };
  const sameName = (theirs, ours) => {
    const t = norm(theirs ?? '');
    const o = norm(ours);
    if (t.includes('�')) return new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/�/g, '.')}$`).test(o);
    return t === o || t.endsWith(` ${o}`) || o.endsWith(` ${t}`);
  };
  const firstPage = (p) => String(p ?? '').split(/[–-]/)[0].trim().toLowerCase();
  const refs = REFERENCES.filter((r) => !only || only.includes(r.id));
  const rows = [];
  let bad = 0;
  for (const r of refs) {
    const issues = [];
    const notes = [];
    if (r.doi) {
      const cr = await get(`https://api.crossref.org/works/${encodeURIComponent(r.doi)}`);
      if (cr.ok) {
        const m = (await cr.json()).message;
        const years = ['issued', 'published-print', 'published-online', 'published'].map((k) => m[k]?.['date-parts']?.[0]?.[0]).filter(Boolean);
        if (!years.some((y) => Math.abs(y - r.year) <= 1)) issues.push(`year ${r.year} vs registry ${[...new Set(years)].join('/')}`);
        else if (!years.includes(r.year)) notes.push(`year ±1 (${[...new Set(years)].join('/')})`);
        const fam = m.author?.[0]?.family ?? m.author?.[0]?.name;
        if (fam && !sameName(fam, surnameOf(r.authors[0]))) issues.push(`first author ${surnameOf(r.authors[0])} vs ${fam}`);
        const title = [m.title?.[0], m.subtitle?.[0]].filter(Boolean).join(' ');
        if (!titleOk(title, r.title)) issues.push(`title differs: "${title}"`);
        if (m.volume && r.volume && m.volume !== r.volume) issues.push(`volume ${r.volume} vs ${m.volume}`);
        const page = m.page ?? m['article-number'];
        if (page && r.pages) {
          const a = firstPage(page);
          const b = firstPage(r.pages);
          if (a !== b) (/^\d{4}[a-z]{2}\d{6}$/.test(a) || a === 'n/a' ? notes : issues).push(`first page ${b} vs registry ${a}`);
        }
      } else if (cr.status === 404) {
        const dc = await get(`https://api.datacite.org/dois/${encodeURIComponent(r.doi)}`, { headers: { 'User-Agent': UA['User-Agent'] } });
        if (dc.ok) {
          const a = (await dc.json()).data.attributes;
          if (Math.abs(a.publicationYear - r.year) > 1) issues.push(`year ${r.year} vs DataCite ${a.publicationYear}`);
          const c0 = (a.creators?.[0]?.familyName ?? a.creators?.[0]?.name ?? '').split(',')[0];
          if (c0 && !sameName(c0, surnameOf(r.authors[0]))) issues.push(`first author vs DataCite ${c0}`);
          if (!titleOk(a.titles?.[0]?.title, r.title)) issues.push(`title differs: "${a.titles?.[0]?.title}"`);
          notes.push('DataCite');
        } else issues.push(`DOI not found (Crossref 404, DataCite ${dc.status})`);
      } else issues.push(`Crossref HTTP ${cr.status}`);
      await sleep(250);
    }
    if (r.arxiv) {
      const ax = await get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(r.arxiv)}`, { headers: { 'User-Agent': UA['User-Agent'] } });
      if (ax.ok) {
        const xml = await ax.text();
        const t = /<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/.exec(xml)?.[1];
        if (!t) issues.push('arXiv id not found');
        else if (!titleOk(t, r.title)) issues.push(`arXiv title differs: "${t.replace(/\s+/g, ' ').trim()}"`);
      } else issues.push(`arXiv HTTP ${ax.status}`);
      await sleep(400);
    }
    if (r.url) {
      const u = await get(r.url, { headers: { 'User-Agent': 'Mozilla/5.0 (space-viz check-refs)' } });
      if (!u.ok) issues.push(`url HTTP ${u.status}`);
      else await u.arrayBuffer?.().catch(() => {});
      await sleep(150);
    }
    if (!r.doi && !r.arxiv && !r.url) notes.push('nothing to check online');
    if (issues.length) bad++;
    rows.push([r.id, issues.length ? 'MISMATCH' : 'ok', [...issues, ...notes].join('; ')]);
    if (issues.length || verbose) console.log(`${issues.length ? 'MISMATCH' : 'ok      '}  ${r.id}  ${[...issues, ...notes].join('; ')}`);
  }
  console.log(`\n${table(['id', 'online', 'details'], rows.filter((x) => x[1] !== 'ok' || x[2]))}\n`);
  rep.data.online = rows.map(([id, result, details]) => ({ id, result, details }));
  rep.check('online: metadata agree with Crossref / DataCite / arXiv; landing pages answer', bad === 0,
    `${refs.length} entries checked, ${bad} with mismatches`);
}
