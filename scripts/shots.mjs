#!/usr/bin/env node
// Batch screenshots in one browser session.
//
// Usage: node scripts/shots.mjs <spec.json> <outDir> [--w 1280] [--h 720] [--uncapped] [--base URL] [--keep-storage]
// spec.json: { "base": "http://127.0.0.1:5173/", "until": "window.__svReady===true",
//              "shots": [ { "name": "a-ring", "url": "?preset=...", "eval": "js expr (may return a promise)",
//                           "wait": 3000, "reload": false } ] }
// - "url" is resolved against "base"; a shot with the same url as the previous one (and reload=false)
//   reuses the page (only "eval" + "wait" run), which is much faster than reloading.
// - --base overrides spec.base; if neither is given (or it does not answer) a private Vite dev server is started
//   for the run (no HMR), so specs with relative URLs work anywhere (e.g. scripts/test/specs/*.json).
// - Console errors / warnings and page errors are printed with the shot name.
// - localStorage is cleared before every page load, so settings changed by one shot's eval (e.g. the V key's
//   astronaut toggle) do not leak into later page loads; --keep-storage keeps it. Pin settings in the URLs.
// Shared helpers: scripts/test/lib.mjs (see scripts/test/README.md).
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanStorageOnLoad, launchBrowser, parseArgs, sleep, startServer } from './test/lib.mjs';

const args = parseArgs(process.argv.slice(2), { bool: ['uncapped', 'keep-storage'] });
if (args._.length < 2) {
  console.error('usage: node scripts/shots.mjs <spec.json> <outDir> [--w W] [--h H] [--uncapped] [--base URL] [--keep-storage]');
  process.exit(1);
}
const spec = JSON.parse(readFileSync(resolve(args._[0]), 'utf8'));
const outDir = resolve(args._[1]);
mkdirSync(outDir, { recursive: true });
const srv = await startServer({ base: args.str('base', spec.base) });
const browser = await launchBrowser({ w: args.num('w', 1280), h: args.num('h', 720), uncapped: args.flag('uncapped') });
const page = await browser.newPage();
if (!args.flag('keep-storage')) await cleanStorageOnLoad(page);
let current = '';
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning' || t === 'warn') console.log(`  [${current}] console.${t}: ${m.text()}`);
});
page.on('pageerror', (e) => console.log(`  [${current}] PAGEERROR: ${e && e.stack ? e.stack : e}`));

let lastUrl = null;
for (const s of spec.shots) {
  current = s.name;
  const url = new URL(s.url ?? '', srv.base).toString();
  try {
    if (url !== lastUrl || s.reload) {
      await page.goto(url, { waitUntil: 'load', timeout: 120000 });
      if (spec.until) await page.waitForFunction(spec.until, { timeout: 120000, polling: 200 });
      lastUrl = url;
    }
    if (s.eval) {
      const r = await page.evaluate(s.eval);
      if (r !== undefined) console.log(`  [${s.name}] eval: ${typeof r === 'string' ? r : JSON.stringify(r)}`);
    }
    await sleep(s.wait ?? 2500);
    const file = join(outDir, `${s.name}.png`);
    await page.screenshot({ path: file });
    console.log(`[shot] ${file}`);
  } catch (e) {
    console.log(`  [${s.name}] FAILED: ${e && e.message ? e.message : e}`);
  }
}
await browser.close();
await srv.close();
