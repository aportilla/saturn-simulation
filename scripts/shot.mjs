#!/usr/bin/env node
// Headless screenshot + console capture harness (system Google Chrome on the real GPU via puppeteer-core).
//
// Usage:
//   node scripts/shot.mjs <url> <out.png> [--w 1280] [--h 720] [--wait 3000] [--dpr 1]
//                         [--until "window.__svReady===true"] [--timeout 60000]
//                         [--eval "window.__sv.setTime(...)"] [--keep-storage]
//
// - Prints all browser console messages, page errors and failed requests (prefixed), so shader compile errors,
//   WebGL errors and pass fallbacks are visible.
// - --until: JS expression polled until truthy before the screenshot (after page load).
// - --eval: JS expression evaluated after --until resolves (e.g. to set camera/time), then waits --wait ms.
// - localStorage is cleared before the page loads (persisted settings, e.g. the V astronaut toggle, would
//   otherwise leak between runs); --keep-storage keeps it. Pin settings with URL parameters.
// - Exit code 0 on success, 2 if any page error / uncaught exception occurred, 1 on harness failure.
// Shared helpers: scripts/test/lib.mjs (see scripts/test/README.md).
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { captureErrors, cleanStorageOnLoad, launchBrowser, parseArgs, sleep } from './test/lib.mjs';

const args = parseArgs(process.argv.slice(2), { bool: ['keep-storage'] });
if (args._.length < 2) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [--w W] [--h H] [--wait ms] [--until expr] [--eval expr] [--dpr n] [--timeout ms] [--keep-storage]');
  process.exit(1);
}
const [url, outArg] = args._;
const out = resolve(outArg);
const W = args.num('w', 1280), H = args.num('h', 720), DPR = args.num('dpr', 1);
const WAIT = args.num('wait', 3000), TIMEOUT = args.num('timeout', 60000);
const UNTIL = args.str('until', null), EVAL = args.str('eval', null);

let hadError = false;
const browser = await launchBrowser({ w: W, h: H, dpr: DPR, protocolTimeout: TIMEOUT + 30000 });
try {
  const page = await browser.newPage();
  if (!args.flag('keep-storage')) await cleanStorageOnLoad(page);
  captureErrors(page, { echoAll: true, ignore: [] });
  page.on('pageerror', () => { hadError = true; });
  page.on('requestfailed', (req) => console.log(`[requestfailed] ${req.url()} ${req.failure()?.errorText ?? ''}`));
  await page.goto(url, { waitUntil: 'load', timeout: TIMEOUT });
  if (UNTIL) await page.waitForFunction(UNTIL, { timeout: TIMEOUT, polling: 200 });
  if (EVAL) {
    const r = await page.evaluate(EVAL);
    if (r !== undefined) console.log('[eval-result]', typeof r === 'string' ? r : JSON.stringify(r));
  }
  await sleep(WAIT);
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
