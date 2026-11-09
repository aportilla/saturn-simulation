// Shared helpers for the browser regression tests (scripts/test/*.mjs) and the screenshot tools
// (scripts/shot.mjs, scripts/shots.mjs). Documentation and conventions: scripts/test/README.md.
//
//   import { withHarness, openApp, hdrMeans, strips, ... } from './lib.mjs';
//
// - CLI:      parseArgs(argv, { bool: [...] }) -> { _, str, num, flag, list }
// - output:   outputDir(name, dir) (default <os tmp>/space-viz-test/<name>-<stamp>), writeJson, Report
// - server:   startServer({ base }) -> an existing dev server if reachable, else a private Vite server (no HMR,
//             no file watching, free port) so a test is self-contained and immune to other agents' edits
// - browser:  launchBrowser({ w, h, dpr, uncapped }) -> headless Chrome on the real GPU (ANGLE/Metal)
// - app:      openApp(browser, base, params) clears localStorage (cleanStorageOnLoad), waits for window.__svReady;
//             captureErrors collects console errors/warnings, page errors, failed requests, HTTP >= 400;
//             passStatus / glErrors / problems
// - in-page:  getStats, getInfo, setSetting, setPassEnabled, gotoPreset, setSimTime, simTime, waitFrames,
//             hdrMeans + strips (linear HDR radiance), renderTargetScan (NaN / negative pixels), canvasChroma
//             (unnatural hues), measureFps (fresh page per measurement)
// - images:   decodePng / encodePng / pngLumaMean (no dependencies)
// puppeteer-core and vite are imported lazily, so the PNG / CLI helpers work without them.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** Headless Chrome on the real GPU (ANGLE/Metal), no background throttling. */
export const CHROME_ARGS = [
  '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
];
/** No vsync / frame-rate limit (performance measurements; pair with the app's ?fps=0). */
export const UNCAPPED_ARGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];
/** Times that make the sun geometry reproducible (used by the standard views below). */
export const T_STD = '2026-11-07T20:00:00Z';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ CLI
/**
 * Minimal argument parser: positional args in `_`, `--key value`, `--key=value`, boolean `--flag` (names listed in
 * opts.bool never consume the next argument).
 */
export function parseArgs(argv = process.argv.slice(2), opts = {}) {
  const bools = new Set(opts.bool ?? []);
  const pos = [];
  const named = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 2) { named.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
    const k = a.slice(2);
    const nx = argv[i + 1];
    if (!bools.has(k) && nx !== undefined && !nx.startsWith('--')) { named.set(k, nx); i++; } else named.set(k, true);
  }
  const raw = (k) => named.get(k);
  return {
    _: pos,
    has: (k) => named.has(k),
    str: (k, d) => (typeof raw(k) === 'string' ? raw(k) : d),
    num: (k, d) => { const n = typeof raw(k) === 'string' ? Number(raw(k)) : NaN; return Number.isFinite(n) ? n : d; },
    flag: (k) => named.has(k) && raw(k) !== 'false' && raw(k) !== '0',
    list: (k, d) => (typeof raw(k) === 'string' ? raw(k).split(',').map((s) => s.trim()).filter(Boolean) : d),
  };
}

// --------------------------------------------------------------------------------------------- output
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
/** Create and return the output directory (default <os tmp>/space-viz-test/<name>-<yyyymmdd-hhmmss>). */
export function outputDir(name, dir) {
  const d = dir ? resolve(dir) : join(tmpdir(), 'space-viz-test', `${name}-${stamp()}`);
  mkdirSync(d, { recursive: true });
  return d;
}
export function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}
/** Fixed-width text table. */
export function table(headers, rows) {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c)));
  const wid = headers.map((_, j) => Math.max(...all.map((r) => (r[j] ?? '').length)));
  return all.map((r, i) => {
    const line = r.map((c, j) => c.padEnd(wid[j])).join('  ').trimEnd();
    return i === 0 ? `${line}\n${wid.map((n) => '-'.repeat(n)).join('  ')}` : line;
  }).join('\n');
}
/** Number formatting for tables: fixed with d decimals, exponential outside 1e-3 .. 1e7. */
export const fmt = (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? '-' : typeof x === 'number' ? (Math.abs(x) >= 1e7 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(d) : x.toFixed(d)) : String(x));

/** Pass/fail bookkeeping; finish() writes <out>/results.json and returns the process exit code. */
export class Report {
  constructor(name, dir) {
    this.name = name;
    this.dir = dir;
    this.checks = [];
    this.data = {};
    this.t0 = Date.now();
  }
  check(id, ok, detail = '', value = undefined) {
    this.checks.push({ id, ok: !!ok, detail, value });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? `  — ${detail}` : ''}`);
    return !!ok;
  }
  /** a check whose value must lie in [lo, hi] */
  range(id, value, lo, hi, unit = '') {
    const ok = Number.isFinite(value) && value >= lo && value <= hi;
    return this.check(id, ok, `${fmt(value, 4)}${unit} (expected ${fmt(lo, 4)} .. ${fmt(hi, 4)}${unit})`, value);
  }
  error(where, e) {
    const msg = e && e.stack ? e.stack : String(e);
    this.checks.push({ id: `harness: ${where}`, ok: false, detail: msg });
    console.log(`ERROR ${where}: ${msg}`);
  }
  get failed() { return this.checks.filter((c) => !c.ok).length; }
  finish(extra = {}) {
    const secs = (Date.now() - this.t0) / 1000;
    const res = { test: this.name, passed: this.failed === 0, failures: this.failed, checks: this.checks, seconds: secs, ...this.data, ...extra };
    writeJson(join(this.dir, 'results.json'), res);
    console.log(`\n${this.name}: ${this.failed === 0 ? 'PASS' : `FAIL (${this.failed} of ${this.checks.length} checks)`} in ${secs.toFixed(0)} s — ${join(this.dir, 'results.json')}`);
    return this.failed === 0 ? 0 : 1;
  }
}

/** Run fn up to `tries` times (transient page reloads, e.g. Vite HMR when --base points at a watched server). */
export async function retry(fn, { tries = 2, label = '', log = console.log } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      if (i + 1 < tries) log(`  retry ${label} (${e && e.message ? e.message.split('\n')[0] : e})`);
    }
  }
  throw last;
}

// --------------------------------------------------------------------------------------------- server
export async function isReachable(url, timeoutMs = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}
function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
/**
 * The app's base URL: `base` if it answers, otherwise a private Vite dev server for this repo on a free port
 * (no HMR, no file watching: the code is fixed for the run; deps cache in
 * <os tmp>/space-viz-test-vite-cache/<hash of this checkout's path>, one per checkout / git worktree, so runs
 * from parallel worktrees never share Vite's dependency optimizer state). Returns { base, own, close() }.
 * `root`: serve another checkout of the app instead of this one (e.g. an older revision extracted with
 * `git archive`, with a node_modules symlink; fps.mjs --compare).
 */
export async function startServer({ base, root = REPO, log = console.log } = {}) {
  if (base) {
    const b = base.endsWith('/') ? base : `${base}/`;
    if (await isReachable(b)) return { base: b, own: false, close: async () => {} };
    log(`[server] ${b} is not reachable — starting a private dev server instead`);
  }
  const { createServer } = await import('vite');
  const port = await freePort();
  const server = await createServer({
    configFile: join(root, 'vite.config.ts'),
    root,
    logLevel: 'warn',
    clearScreen: false,
    cacheDir: join(tmpdir(), 'space-viz-test-vite-cache', createHash('sha1').update(root).digest('hex').slice(0, 12)),
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } },
  });
  await server.listen();
  const url = `http://127.0.0.1:${port}/`;
  log(`[server] private Vite dev server at ${url} (no HMR / file watching)${root !== REPO ? ` for ${root}` : ''}`);
  return { base: url, own: true, close: () => server.close() };
}

// -------------------------------------------------------------------------------------------- browser
export async function launchBrowser({ w = 1280, h = 720, dpr = 1, uncapped = false, extraArgs = [], protocolTimeout = 300000 } = {}) {
  const { default: puppeteer } = await import('puppeteer-core');
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [...CHROME_ARGS, ...(uncapped ? UNCAPPED_ARGS : []), `--window-size=${w},${h}`, ...extraArgs],
    defaultViewport: { width: w, height: h, deviceScaleFactor: dpr },
    protocolTimeout,
  });
}

/** Messages that are never failures (missing favicon; Vite client chatter). */
export const DEFAULT_IGNORE = [/favicon\.ico/i, /^\[vite\]/];

/**
 * Collect problems on a page: console errors / warnings (WebGL errors, shader compile errors and GuardedPass
 * fallbacks are logged there), uncaught page errors, failed requests, HTTP status >= 400, renderer crashes.
 * `echo`: print each problem as it arrives; `echoAll`: print every console message (screenshot tools).
 */
export function captureErrors(page, { ignore = DEFAULT_IGNORE, echo = false, echoAll = false, prefix = '' } = {}) {
  const list = [];
  const add = (type, text) => {
    if (ignore.some((re) => re.test(text))) return;
    list.push({ type, text });
    if (echo && !echoAll) console.log(`  ${prefix}[${type}] ${text.slice(0, 3000)}`);
  };
  page.on('console', (m) => {
    const t = m.type();
    const loc = m.location()?.url ?? '';
    const text = m.text() + (t !== 'log' && t !== 'info' && t !== 'debug' && loc ? ` (${loc})` : '');
    if (echoAll) console.log(`${prefix}[console.${t}] ${m.text()}`);
    if (t === 'error' || t === 'warning' || t === 'warn' || t === 'assert') add(`console.${t}`, text);
  });
  page.on('pageerror', (e) => {
    if (echoAll) console.log(`${prefix}[pageerror] ${e && e.stack ? e.stack : e}`);
    add('pageerror', e && e.stack ? e.stack : String(e));
  });
  page.on('requestfailed', (r) => add('requestfailed', `${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => { if (r.status() >= 400) add('http', `${r.status()} ${r.url()}`); });
  page.on('error', (e) => add('crash', String(e)));
  return { list, clear: () => { list.length = 0; } };
}

/** URL of the app (or a sandbox page via `path`) with query parameters (undefined / null values are skipped). */
export function appUrl(base, params = {}, path = '') {
  const u = new URL(path, base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u.toString();
}

/**
 * Settings persist in localStorage (e.g. the V key toggles the astronaut and saves it), and pages of one browser
 * share it: clear it before every document so each load starts from the defaults + its URL parameters. Pin
 * everything a test depends on in the URL (astronaut=0, scale=, quality=, nearField=, ...).
 */
export async function cleanStorageOnLoad(page) {
  await page.evaluateOnNewDocument(() => {
    try { window.localStorage.clear(); } catch { /* storage unavailable */ }
  });
}

/**
 * New page -> URL -> wait for window.__svReady (true 8 frames after the first frame). Returns { page, errs, url }.
 * `settle` (ms) waits a little longer (allocation / exposure adaptation / clipmap refresh). The load is retried
 * once (first-run dependency optimization, a reload from a watched dev server).
 */
export async function openApp(browser, base, params = {}, { path = '', timeout = 120000, settle = 0, w, h, errors = {}, keepStorage = false } = {}) {
  const page = await browser.newPage();
  if (w && h) await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  if (!keepStorage) await cleanStorageOnLoad(page);
  const errs = captureErrors(page, errors);
  const url = appUrl(base, params, path);
  await retry(async (i) => {
    if (i > 0) errs.clear();
    await page.goto(url, { waitUntil: 'load', timeout });
    await page.waitForFunction('window.__svReady===true', { timeout, polling: 200 });
  }, { tries: 2, label: `load ${url}` });
  if (settle) await sleep(settle);
  return { page, errs, url };
}

// ------------------------------------------------------------------------------------- in-page helpers
/** pipeline.stats(): `<pass>.<key>` -> value (e.g. near.drawn, near.count, rings.mode, post.EV). */
export const getStats = (page) => page.evaluate(() => window.__sv.pipeline.stats());
/** __sv.info() subset: where the camera is. */
export const getInfo = (page) => page.evaluate(() => {
  const x = window.__sv.info();
  return { feature: x.feature, rKm: x.rCyl / 1e3, z: x.z, altKm: x.alt / 1e3, tau: x.local ? x.local.tau : null, sunVis: x.sunVis, phaseDeg: x.phase * 57.29578 };
});
/** Status of every GuardedPass: [{ name, source, state: ok | fallback | failed | missing, error }]. */
export const passStatus = (page) => page.evaluate(() => {
  const g = window.__sv.app?.loaded?.guards;
  return g ? g.map((x) => x.status()) : [];
});
/** Drain gl.getError() (WebGL errors not already reported on the console). */
export const glErrors = (page) => page.evaluate(() => {
  const gl = window.__sv.renderer.getContext();
  const out = [];
  for (let e = gl.getError(), n = 0; e !== gl.NO_ERROR && n < 8; e = gl.getError(), n++) out.push(`0x${e.toString(16)}`);
  return out;
});
/** Everything that makes a page "not clean": captured messages, GL errors, passes not in state ok. */
export async function problems(page, errs) {
  const out = errs.list.map((e) => `${e.type}: ${e.text.split('\n')[0].slice(0, 400)}`);
  try {
    for (const e of await glErrors(page)) out.push(`gl.getError: ${e}`);
    for (const s of await passStatus(page)) if (s.state !== 'ok') out.push(`pass ${s.name}: ${s.state} (${s.source})${s.error ? ` — ${s.error}` : ''}`);
  } catch (e) {
    out.push(`probe failed: ${e.message}`);
  }
  return out;
}
/** Resolve after n animation frames. */
export const waitFrames = (page, n = 3) => page.evaluate((n) => new Promise((res) => {
  let k = 0;
  const f = () => (++k >= n ? res() : requestAnimationFrame(f));
  requestAnimationFrame(f);
}), n);
/** Change a setting like the settings panel does (render.* keys, or fovDeg / hud / maxFps). */
export const setSetting = (page, key, value) => page.evaluate((key, value) => {
  const app = window.__sv.app;
  if (key === 'fovDeg' || key === 'hud' || key === 'maxFps') app.settings[key] = value;
  else app.settings.render[key] = value;
  app.applySetting(key);
}, key, value);
/** Enable / disable a render pass (far | near | overlay | rings | post) without tripping its GuardedPass. */
export const setPassEnabled = (page, name, on) => page.evaluate((name, on) => {
  const p = window.__sv.pipeline.passes[name];
  if (!p) return false;
  (p.inner ?? p).enabled = on;
  return true;
}, name, on);
/** Jump to a place (preset id) instantly; false if unknown. */
export const gotoPreset = (page, id) => page.evaluate((id) => window.__sv.goto(id, { instant: true }), id);
/** Pause and set the simulation time: TDB seconds since J2000 (number) or an ISO string. Returns the new t. */
export async function setSimTime(page, t, settleMs = 400) {
  const r = await page.evaluate((t) => {
    const sv = window.__sv;
    if (typeof t === 'string') sv.setTime(t);
    else sv.clock.t = t;
    sv.clock.paused = true;
    return sv.clock.t;
  }, t);
  await sleep(settleMs);
  return r;
}
/** Simulation time (TDB s since J2000). */
export const simTime = (page) => page.evaluate(() => window.__sv.clock.t);

/** Horizontal strips [x0, y0, x1, y1] (fractions, y from the top) covering rows y0..y1 in n bands. */
export const strips = (y0, y1, n, x0 = 0, x1 = 1) =>
  Array.from({ length: n }, (_, i) => [x0, y0 + (i * (y1 - y0)) / n, x1, y0 + ((i + 1) * (y1 - y0)) / n]);
/**
 * Mean HDR radiance (W m^-2 sr^-1) of the last frame in screen rectangles [x0, y0, x1, y1] (fractions of the frame,
 * y from the TOP), read from pipeline.ctx.hdrRT: after the ring layer, before glare / tone mapping, so it is
 * independent of exposure. channel: 'lum' (Rec. 709 luminance) | 'r' | 'g' | 'b'.
 */
export const hdrMeans = (page, rects, channel = 'lum') => page.evaluate((rects, channel) => {
  const sv = window.__sv;
  const rt = sv.pipeline.ctx.hdrRT;
  const w = rt.width, h = rt.height;
  const buf = new Float32Array(w * h * 4);
  sv.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  const ch = { r: 0, g: 1, b: 2 }[channel] ?? -1;
  return rects.map(([x0, y0, x1, y1]) => {
    const ya = Math.floor(y0 * h), yb = Math.max(ya + 1, Math.floor(y1 * h));
    const xa = Math.floor(x0 * w), xb = Math.max(xa + 1, Math.floor(x1 * w));
    let s = 0, n = 0;
    for (let yt = ya; yt < yb; yt++) {
      const row = h - 1 - yt;
      for (let x = xa; x < xb; x++) {
        const k = (row * w + x) * 4;
        s += ch >= 0 ? buf[k + ch] : 0.2126 * buf[k] + 0.7152 * buf[k + 1] + 0.0722 * buf[k + 2];
        n++;
      }
    }
    return s / n;
  });
}, rects, channel);

/**
 * Pixel sanity of the float render targets: NaN / negative / huge (> 1e3 W m^-2 sr^-1: only the Sun's disk and
 * glints are legitimately that bright) values in sceneRT (far field + near-field particles) and hdrRT (after the
 * ring layer). Returns { sceneRT: { w, h, nan, neg, huge, mean, examples }, hdrRT: {...} }.
 */
export const renderTargetScan = (page) => page.evaluate(() => {
  const sv = window.__sv;
  const out = {};
  for (const name of ['sceneRT', 'hdrRT']) {
    const rt = sv.pipeline.ctx[name];
    const w = rt.width, h = rt.height;
    const buf = new Float32Array(w * h * 4);
    sv.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    let nan = 0, neg = 0, huge = 0, sum = 0, n = 0;
    const examples = [];
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < 3; c++) {
        const v = buf[i * 4 + c];
        if (Number.isNaN(v)) { nan++; if (examples.length < 4) examples.push(`NaN @${i % w},${h - 1 - Math.floor(i / w)}`); }
        else if (v < 0) { neg++; if (examples.length < 4) examples.push(`${v.toExponential(2)} @${i % w},${h - 1 - Math.floor(i / w)}`); }
        else if (v > 1e3) huge++;
        else { sum += v; n++; }
      }
    }
    out[name] = { w, h, nan, neg, huge, mean: sum / Math.max(n, 1), examples };
  }
  return out;
});

/**
 * Unnatural hues in the displayed image (post-pass output, read from the canvas right after a frame): pixels
 * brighter than 20/255 whose green or blue clearly exceeds red (g > r + 12, b > g + 12 or b > r + 12). The rings
 * are reddish-brown to grey, so in ring views these flag colour bugs (NaN-adjacent fringes, channel mix-ups).
 * Stars, the E ring and parts of Saturn may legitimately be bluish — judge counts in context.
 * Returns { w, h, count, fraction, examples }.
 */
export const canvasChroma = (page, rect = [0, 0, 1, 1]) => page.evaluate((rect) => new Promise((resolve) => {
  const gl = window.__sv.renderer.getContext();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const [x0, y0, x1, y1] = rect;
    let count = 0, n = 0;
    const examples = [];
    for (let yt = Math.floor(y0 * h); yt < Math.floor(y1 * h); yt++) {
      const row = h - 1 - yt;
      for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x++) {
        const k = (row * w + x) * 4, r = px[k], g = px[k + 1], b = px[k + 2];
        n++;
        if (Math.max(r, g, b) > 20 && (g > r + 12 || b > g + 12 || b > r + 12)) {
          count++;
          if (examples.length < 5) examples.push(`(${x},${yt}) ${r},${g},${b}`);
        }
      }
    }
    resolve({ w, h, count, fraction: count / Math.max(n, 1), examples });
  }));
}), rect);

/**
 * Uncapped frame rate of one view: a FRESH page (several navigations in one tab leave old WebGL contexts alive
 * and roughly halve the fps), ?fps=0, warm-up, then rAF callbacks counted for `secs`. The browser should be
 * launched with { uncapped: true }. Returns { fps, frames, stats, problems, url }.
 */
export async function measureFps(browser, base, params, { secs = 4, warmup = 2500, timeout = 120000 } = {}) {
  const { page, errs, url } = await openApp(browser, base, { ...params, fps: 0 }, { timeout });
  try {
    await sleep(warmup);
    const r = await page.evaluate(async (secs) => {
      const t0 = performance.now();
      let n = 0;
      await new Promise((res) => {
        const tick = () => { n++; if (performance.now() - t0 < secs * 1000) requestAnimationFrame(tick); else res(); };
        requestAnimationFrame(tick);
      });
      return { fps: n / ((performance.now() - t0) / 1000), frames: n, stats: window.__sv.pipeline.stats() };
    }, secs);
    return { ...r, problems: await problems(page, errs), url };
  } finally {
    await page.close();
  }
}

// ----------------------------------------------------------------------------------------- harness
/**
 * Common test skeleton: parse args, output dir, server (--base or private), browser, Report; fn receives
 * { args, out, rep, base, browser } and the process exits with the report's code (0 pass, 1 fail).
 * opts: { bool: [...boolean flags], w, h, uncapped }
 */
export async function withHarness(name, opts, fn) {
  const args = parseArgs(process.argv.slice(2), { bool: ['uncapped', ...(opts.bool ?? [])] });
  if (args.flag('help')) {
    console.log(opts.usage ?? `see scripts/test/README.md (${name})`);
    process.exit(0);
  }
  const out = outputDir(name, args.str('out'));
  const rep = new Report(name, out);
  console.log(`[${name}] output: ${out}`);
  let srv = null, browser = null;
  try {
    srv = await startServer({ base: args.str('base') });
    browser = await launchBrowser({ w: args.num('w', opts.w ?? 1280), h: args.num('h', opts.h ?? 720), uncapped: opts.uncapped || args.flag('uncapped') });
    await fn({ args, out, rep, base: srv.base, browser });
  } catch (e) {
    rep.error(name, e);
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
    try { await srv?.close(); } catch { /* ignore */ }
  }
  process.exit(rep.finish());
}

// -------------------------------------------------------------------------------------------- images
/** Decode an 8-bit PNG (gray, gray+alpha, RGB, RGBA; non-interlaced) -> { w, h, data: RGBA Uint8Array }. */
export function decodePng(src) {
  const b = typeof src === 'string' ? readFileSync(src) : src;
  let p = 8, w = 0, h = 0, ct = 0, bd = 0, il = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    const d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; il = d[12]; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8 || il !== 0) throw new Error(`unsupported PNG (bit depth ${bd}, interlace ${il})`);
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (!bpp) throw new Error(`unsupported PNG color type ${ct}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src0 = y * (stride + 1) + 1, o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[o + x - bpp] : 0, up = y > 0 ? px[o - stride + x] : 0, c = x >= bpp && y > 0 ? px[o - stride + x - bpp] : 0;
      let v = raw[src0 + x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      px[o + x] = v & 255;
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * bpp;
    if (bpp >= 3) { data[i * 4] = px[s]; data[i * 4 + 1] = px[s + 1]; data[i * 4 + 2] = px[s + 2]; data[i * 4 + 3] = bpp === 4 ? px[s + 3] : 255; }
    else { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = px[s]; data[i * 4 + 3] = bpp === 2 ? px[s + 1] : 255; }
  }
  return { w, h, data };
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** Encode RGBA (Uint8Array, w*h*4) as an 8-bit RGBA PNG buffer. */
export function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const srgbToLinear = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
/** Mean luminance of a pixel rectangle [x0, y0, x1, y1) of a decoded PNG: display units 0..255, or linear 0..1. */
export function pngLumaMean(img, [x0, y0, x1, y1], { linear = false } = {}) {
  let s = 0, n = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
      const k = (y * img.w + x) * 4;
      const [r, g, b] = linear ? [srgbToLinear(img.data[k]), srgbToLinear(img.data[k + 1]), srgbToLinear(img.data[k + 2])] : [img.data[k], img.data[k + 1], img.data[k + 2]];
      s += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++;
    }
  }
  return n ? s / n : NaN;
}
