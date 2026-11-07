#!/usr/bin/env node
// Headless screenshot + console capture harness (uses the system Google Chrome via puppeteer-core).
//
// Usage:
//   node scripts/shot.mjs <url> <out.png> [--w 1280] [--h 720] [--wait 4000] [--dpr 1]
//                         [--until "window.__svReady===true"] [--timeout 60000]
//                         [--eval "window.__sv.setTime(...)"] [--frames N]
//
// - Prints all browser console messages and page errors to stdout (prefixed), so shader
//   compile errors etc. are visible.
// - --until: JS expression polled until truthy before the screenshot (after page load).
// - --eval: JS expression evaluated after --until resolves (e.g. to set camera/time), then waits --wait ms.
// - Exit code 0 on success, 2 if any page error / uncaught exception occurred, 1 on harness failure.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [--w W] [--h H] [--wait ms] [--until expr] [--eval expr] [--dpr n]');
  process.exit(1);
}
const url = args[0];
const out = resolve(args[1]);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const W = parseInt(opt('w', '1280'), 10);
const H = parseInt(opt('h', '720'), 10);
const WAIT = parseInt(opt('wait', '3000'), 10);
const DPR = parseFloat(opt('dpr', '1'));
const UNTIL = opt('until', null);
const EVAL = opt('eval', null);
const TIMEOUT = parseInt(opt('timeout', '60000'), 10);

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let hadError = false;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--enable-unsafe-webgpu',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--window-size=${W},${H}`,
  ],
  defaultViewport: { width: W, height: H, deviceScaleFactor: DPR },
  protocolTimeout: TIMEOUT + 30000,
});
try {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const t = msg.type();
    console.log(`[console.${t}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    hadError = true;
    console.log(`[pageerror] ${err && err.stack ? err.stack : err}`);
  });
  page.on('requestfailed', (req) => {
    console.log(`[requestfailed] ${req.url()} ${req.failure()?.errorText ?? ''}`);
  });
  await page.goto(url, { waitUntil: 'load', timeout: TIMEOUT });
  if (UNTIL) {
    await page.waitForFunction(UNTIL, { timeout: TIMEOUT, polling: 200 });
  }
  if (EVAL) {
    const r = await page.evaluate(EVAL);
    if (r !== undefined) console.log('[eval-result]', typeof r === 'string' ? r : JSON.stringify(r));
  }
  await new Promise((r) => setTimeout(r, WAIT));
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out, type: 'png' });
  console.log(`[shot] saved ${out}`);
} catch (e) {
  console.log(`[harness-error] ${e && e.stack ? e.stack : e}`);
  await browser.close();
  process.exit(1);
}
await browser.close();
process.exit(hadError ? 2 : 0);
