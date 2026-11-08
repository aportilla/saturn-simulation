#!/usr/bin/env node
// Astronaut exposure invariance. The camera-pinned astronaut is left out of the auto-exposure meter
// (AstronautPass writes ctx.meterMask; PostPass meters the masked pixels as the scene they hide, mirrored across
// the astronaut's bounding box), so the exposure must be the same with the astronaut shown or hidden.
// For each preset: load with astronaut=1 and astronaut=0 (fresh pages, paused, fixed time), let the exposure
// settle, compare post.EV; require a live mask when shown and none when hidden; no errors.
// Expected: |EV(on) − EV(off)| ≤ --tol (default 0.1 EV; the meter's half-stop histogram is interpolated, so
// residual differences are ≲ 0.1). Measured 2026-11-07 (1920×1080): 0.00 at overview, a-ring-30m, enceladus,
// cloud-tops, a-ring-inside, b-ring-inside, a-ring-1km, shadow, rings-above; 0.10 at under-rings.
// usage: node scripts/test/exposure.mjs [--presets overview,a-ring-30m,enceladus,cloud-tops] [--t ISO]
//                                       [--settle 4000] [--tol 0.1] [--w 1920 --h 1080] [--base URL] [--out DIR]
import { fmt, openApp, problems, T_STD, table, withHarness } from './lib.mjs';

const USAGE = 'node scripts/test/exposure.mjs [--presets a,b,…] [--t ISO] [--settle ms] [--tol EV] [--w --h] [--base URL] [--out DIR]';

await withHarness('exposure', { usage: USAGE, w: 1920, h: 1080 }, async ({ args, rep, base, browser }) => {
  const presets = args.list('presets', ['overview', 'a-ring-30m', 'enceladus', 'cloud-tops']);
  const t = args.str('t', T_STD);
  const settle = args.num('settle', 4000);
  const tol = args.num('tol', 0.1);

  const measure = async (preset, on) => {
    const { page, errs } = await openApp(browser, base, { preset, t, paused: 1, hud: 0, labels: 0, astronaut: on ? 1 : 0 }, { settle });
    try {
      const r = await page.evaluate(() => {
        const sv = window.__sv;
        const st = sv.pipeline.stats();
        const mm = sv.pipeline.ctx.meterMask;
        return { ev: parseFloat(st['post.EV']), metered: st['post.metered'], mask: !!mm && mm.frame === sv.frame.frameIndex };
      });
      return { ...r, problems: await problems(page, errs) };
    } finally {
      await page.close();
    }
  };

  const rows = [];
  for (const p of presets) {
    const on = await measure(p, true);
    const off = await measure(p, false);
    const d = on.ev - off.ev;
    rep.check(`${p}: exposure unchanged by the astronaut`, Number.isFinite(d) && Math.abs(d) <= tol + 1e-9,
      `EV on ${fmt(on.ev, 2)} / off ${fmt(off.ev, 2)}, diff ${fmt(d, 2)} (tol ${tol})`, d);
    rep.check(`${p}: meter mask live only while shown`, on.mask && !off.mask,
      `shown: ${on.mask ? 'live' : 'none'}, hidden: ${off.mask ? 'live' : 'none'}`);
    const probs = [...on.problems, ...off.problems];
    rep.check(`${p}: no errors`, probs.length === 0, probs.slice(0, 3).join(' | '));
    rows.push([p, fmt(on.ev, 2), fmt(off.ev, 2), fmt(d, 2), on.metered, off.metered]);
  }
  console.log('\n' + table(['preset', 'EV on', 'EV off', 'diff', 'metered on', 'metered off'], rows));
  rep.data.rows = rows;
});
