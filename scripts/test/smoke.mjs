#!/usr/bin/env node
// Smoke test: every place (preset) loads and renders cleanly with the default settings.
//
// usage: node scripts/test/smoke.mjs [--base URL] [--out DIR] [--presets id1,id2] [--t ISO] [--settle ms]
//                                    [--w 1280 --h 720] [--params "k=v&k2=v2"]
//
// Per preset (fresh page each, localStorage cleared, ?preset=<id>&t=<t>&paused=1&hud=0&labels=0 + --params):
//   FAIL on: any console error / warning (incl. WebGL errors, shader compile errors, GuardedPass fallbacks),
//            uncaught page error, failed request / HTTP >= 400, gl.getError() != 0, a pass not in state "ok",
//            NaN or negative values in sceneRT / hdrRT.
//   report:  screenshot <out>/<id>.png, where the camera is, key pipeline stats, pixel sanity, unnatural-hue
//            pixel count of the displayed image (informational: stars / E ring / Saturn can be bluish).
// The default settings are tested on purpose (astronaut on, render scale 0.5, quality high, ...).
import { join } from 'node:path';
import {
  T_STD, canvasChroma, fmt, getInfo, getStats, openApp, problems, renderTargetScan, retry, sleep, table, withHarness,
} from './lib.mjs';

const KEY_STATS = ['rings.mode', 'near.drawn', 'near.count', 'post.EV'];

await withHarness('smoke', { usage: 'node scripts/test/smoke.mjs [--base URL] [--out DIR] [--presets a,b] [--t ISO] [--settle ms] [--params "k=v&..."]' }, async ({ args, out, rep, base, browser }) => {
  const t = args.str('t', T_STD);
  const settle = args.num('settle', 2500);
  const extra = Object.fromEntries(new URLSearchParams(args.str('params', '')));
  let presets = args.list('presets', null);
  if (!presets) {
    const { page } = await openApp(browser, base, { hud: 0, labels: 0, paused: 1 });
    presets = await page.evaluate(() => window.__sv.presets);
    await page.close();
  }
  console.log(`[smoke] ${presets.length} presets: ${presets.join(', ')}`);
  const rows = [];
  const results = [];
  for (const id of presets) {
    const t0 = Date.now();
    let res;
    try {
      res = await retry(async () => {
        const { page, errs } = await openApp(browser, base, { preset: id, t, paused: 1, hud: 0, labels: 0, ...extra }, { settle });
        try {
          const shot = join(out, `${id}.png`);
          await page.screenshot({ path: shot });
          const [info, stats, scan, chroma] = [await getInfo(page), await getStats(page), await renderTargetScan(page), await canvasChroma(page)];
          await sleep(200);
          const probs = await problems(page, errs);
          return { id, info, stats, scan, chroma, problems: probs, shot };
        } finally {
          await page.close();
        }
      }, { tries: 2, label: id });
    } catch (e) {
      rep.error(`preset ${id}`, e);
      continue;
    }
    res.seconds = (Date.now() - t0) / 1000;
    results.push(res);
    const pix = [];
    for (const [rt, s] of Object.entries(res.scan)) if (s.nan || s.neg) pix.push(`${rt}: ${s.nan} NaN, ${s.neg} negative (${s.examples.join('; ')})`);
    const all = [...res.problems, ...pix];
    rep.check(`preset ${id}`, all.length === 0, all.length ? all.join(' | ') : `clean (${res.seconds.toFixed(1)} s)`);
    rows.push([
      id, res.info.feature, String(Math.round(res.info.rKm)), fmt(res.info.z, 1),
      ...KEY_STATS.map((k) => String(res.stats[k] ?? '-').slice(0, 48)),
      `${res.chroma.count}`, `${res.scan.hdrRT.huge}`,
    ]);
  }
  console.log(`\n${table(['preset', 'where', 'r km', 'z m', ...KEY_STATS, 'blue/green px', 'hdr>1e3'], rows)}`);
  rep.data.presets = results;
});
