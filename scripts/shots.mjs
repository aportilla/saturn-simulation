#!/usr/bin/env node
// Batch screenshots in one browser session.
//
// Usage: node scripts/shots.mjs <spec.json> <outDir> [--w 1280] [--h 720] [--uncapped]
// spec.json: { "base": "http://127.0.0.1:5173/", "until": "window.__svReady===true",
//              "shots": [ { "name": "a-ring", "url": "?preset=...", "eval": "js expr (may return a promise)",
//                           "wait": 3000, "reload": false } ] }
// - "url" is resolved against "base"; a shot with the same url as the previous one (and reload=false)
//   reuses the page (only "eval" + "wait" run), which is much faster than reloading.
// - Console errors / page errors are printed with the shot name.
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: node scripts/shots.mjs <spec.json> <outDir> [--w W] [--h H]');
  process.exit(1);
}
const spec = JSON.parse(readFileSync(resolve(args[0]), 'utf8'));
const outDir = resolve(args[1]);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const W = parseInt(opt('w', '1280'), 10);
const H = parseInt(opt('h', '720'), 10);
// --uncapped: disable vsync / the 60 fps frame-rate limit (for performance measurements)
const uncapped = args.includes('--uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`, ...uncapped],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
let current = '';
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning' || t === 'warn') console.log(`  [${current}] console.${t}: ${m.text()}`);
});
page.on('pageerror', (e) => console.log(`  [${current}] PAGEERROR: ${e && e.stack ? e.stack : e}`));

let lastUrl = null;
for (const s of spec.shots) {
  current = s.name;
  const url = new URL(s.url ?? '', spec.base).toString();
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
    await new Promise((r) => setTimeout(r, s.wait ?? 2500));
    const file = join(outDir, `${s.name}.png`);
    await page.screenshot({ path: file });
    console.log(`[shot] ${file}`);
  } catch (e) {
    console.log(`  [${s.name}] FAILED: ${e && e.message ? e.message : e}`);
  }
}
await browser.close();
