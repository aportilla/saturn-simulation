#!/usr/bin/env node
// Uncapped frame-rate table: places x particle render qualities, one fresh page per measurement; or an A/B cost
// measurement of a feature toggle in the same page.
//
// usage: node scripts/test/fps.mjs [--base URL] [--out DIR] [--presets a,b] [--qualities high,medium,low]
//                                  [--secs 4] [--warmup 2500] [--w 1920 --h 1080] [--params "k=v&..."] [--min-fps N]
//                                  [--ab-off "<js>" --ab-on "<js>" [--rounds 6] [--ab-settle 400]]
//
// Each cell: new page with ?preset=<id>&quality=<q>&fps=0&t=...&paused=1&hud=0&labels=0 in a browser without vsync /
// frame-rate limit, warm-up, then requestAnimationFrame callbacks counted for --secs (several navigations in one
// tab leave old WebGL contexts alive and roughly halve the fps, hence a fresh page each). The default render scale
// and astronaut setting are kept (that is what users get). Another browser on the same GPU (other agents' tests)
// lowers the numbers: compare runs made under the same conditions. Informational unless --min-fps is given
// (then every cell must reach it). Results: <out>/fps.json and a table.
//
// A/B mode (--ab-off / --ab-on: JavaScript run in the page, e.g. to switch a feature off and on): one page per
// cell, --rounds rounds of (off, on) in alternating order (ABBA, cancels slow drifts), each measured for --secs after
// --ab-settle ms; reports the mean ms per frame with the feature off and on and the difference with its standard
// error over the rounds. Robust against a busy GPU only to the extent the load is steady over the measurement.
// Example (the sub-km texture + propellers, shader cost only):
//   --ab-off "s=__sv.pipeline.ctx.structure;s.texture.amp=0;s.propellers.scale=0"
//   --ab-on "s=__sv.pipeline.ctx.structure;s.texture.amp=1;s.propellers.scale=1"
// append ";__sv.pipeline.lastModKey='force'" to both and use --ab-settle 3000 to include the near-field allocation
// bound (the local LOD re-fits within 60 frames).
import { T_STD, measureFps, openApp, problems, sleep, table, withHarness } from './lib.mjs';

await withHarness('fps', { w: 1920, h: 1080, uncapped: true, usage: 'node scripts/test/fps.mjs [--base URL] [--out DIR] [--presets a,b] [--qualities high,medium,low] [--secs 4] [--min-fps N] [--ab-off JS --ab-on JS --rounds 6 --ab-settle 400]' }, async ({ args, rep, base, browser }) => {
  const presets = args.list('presets', ['overview', 'a-ring-1km', 'a-ring-30m', 'a-ring-inside', 'b-ring-inside', 'c-ring-inside']);
  const quals = args.list('qualities', ['high', 'medium', 'low']);
  const secs = args.num('secs', 4), warmup = args.num('warmup', 2500), minFps = args.num('min-fps', 0);
  const extra = Object.fromEntries(new URLSearchParams(args.str('params', '')));
  const abOff = args.str('ab-off', ''), abOn = args.str('ab-on', '');
  const rows = [];
  const cells = [];
  if (abOff || abOn) {
    const rounds = args.num('rounds', 6), settle = args.num('ab-settle', 400);
    for (const p of presets) {
      for (const q of quals) {
        const { page, errs } = await openApp(browser, base, { preset: p, quality: q, t: T_STD, paused: 1, hud: 0, labels: 0, fps: 0, ...extra });
        try {
          await sleep(warmup);
          const r = await page.evaluate(async (abOff, abOn, rounds, secs, settle) => {
            const wait = (ms) => new Promise((res) => setTimeout(res, ms));
            const measure = () => new Promise((res) => {
              const t0 = performance.now();
              let n = 0;
              const tick = () => { n++; if (performance.now() - t0 < secs * 1000) requestAnimationFrame(tick); else res((performance.now() - t0) / n); };
              requestAnimationFrame(tick);
            });
            const run = async (code) => { (0, eval)(code); await wait(settle); return measure(); };
            const A = [], B = [];
            for (let i = 0; i < rounds; i++) {
              if (i % 2 === 0) { A.push(await run(abOff)); B.push(await run(abOn)); } else { B.push(await run(abOn)); A.push(await run(abOff)); }
            }
            return { A, B, stats: window.__sv.pipeline.stats() };
          }, abOff, abOn, rounds, secs, settle);
          const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
          const d = r.B.map((b, i) => b - r.A[i]);
          const dm = mean(d), se = Math.sqrt(d.reduce((s, x) => s + (x - dm) ** 2, 0) / Math.max(d.length - 1, 1) / d.length);
          const pr = await problems(page, errs);
          if (pr.length) rep.check(`${p} / ${q}: clean`, false, pr.join(' | '));
          cells.push({ preset: p, quality: q, off: r.A, on: r.B, diffMs: dm, seMs: se, stats: r.stats });
          rows.push([p, q, mean(r.A).toFixed(2), mean(r.B).toFixed(2), `${dm >= 0 ? '+' : ''}${dm.toFixed(2)} ± ${se.toFixed(2)}`, `${((100 * dm) / mean(r.A)).toFixed(1)} %`, `${r.stats['near.drawn'] ?? '-'}`]);
          console.log(`  ${p} / ${q}: off ${mean(r.A).toFixed(2)} ms, on ${mean(r.B).toFixed(2)} ms, diff ${dm.toFixed(2)} +- ${se.toFixed(2)} ms`);
        } finally {
          await page.close();
        }
      }
    }
    console.log(`\n${table(['preset', 'quality', 'off ms/frame', 'on ms/frame', 'on - off ms', 'relative', 'near.drawn'], rows)}`);
    rep.data.ab = { off: abOff, on: abOn, rounds, secs, cells };
    rep.data.size = `${args.num('w', 1920)}x${args.num('h', 1080)}`;
    rep.check('A/B table measured', cells.length === presets.length * quals.length, `${cells.length} cells`);
    return;
  }
  for (const p of presets) {
    const row = [p];
    let info = '';
    for (const q of quals) {
      const r = await measureFps(browser, base, { preset: p, quality: q, t: T_STD, paused: 1, hud: 0, labels: 0, ...extra }, { secs, warmup });
      row.push(r.fps.toFixed(1));
      if (q === quals[0]) info = `${r.stats['near.drawn'] ?? '-'}`;
      cells.push({ preset: p, quality: q, fps: r.fps, frames: r.frames, problems: r.problems, stats: r.stats });
      if (r.problems.length) rep.check(`${p} / ${q}: clean`, false, r.problems.join(' | '));
      if (minFps > 0) rep.range(`${p} / ${q}: fps`, r.fps, minFps, Infinity);
      console.log(`  ${p} / ${q}: ${r.fps.toFixed(1)} fps`);
    }
    row.push(info);
    rows.push(row);
  }
  console.log(`\n${table(['preset', ...quals.map((q) => `${q} fps`), `near.drawn (${quals[0]})`], rows)}`);
  rep.data.cells = cells;
  rep.data.size = `${args.num('w', 1920)}x${args.num('h', 1080)}`;
  if (!minFps) rep.check('fps table measured', cells.length === presets.length * quals.length, `${cells.length} cells`);
});
