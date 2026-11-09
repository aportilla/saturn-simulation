#!/usr/bin/env node
// Uncapped frame-rate table: places x particle render qualities, one fresh page per measurement; or an A/B cost
// measurement of a feature toggle in the same page.
//
// usage: node scripts/test/fps.mjs [--base URL] [--out DIR] [--presets a,b] [--qualities high,medium,low]
//                                  [--secs 4] [--warmup 2500] [--w 1920 --h 1080] [--params "k=v&..."] [--min-fps N]
//                                  [--ab-off "<js>" --ab-on "<js>" [--rounds 6] [--ab-settle 400]]
//                                  [--compare DIR|URL [--rounds 3] [--label-a this] [--label-b other]]
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
//
// Compare mode (--compare DIR|URL): this checkout (A) against another one (B): a directory holding another revision
// of the app (e.g. `git archive <rev> -o x.tar`, untar, symlink node_modules; a private Vite server is started for it)
// or the URL of a running server. Per cell --rounds rounds of one FRESH page per tree in ABBA order (both trees are
// measured under the same, slowly drifting GPU load); reports the mean ms per frame of A and B, B - A with its standard
// error over the rounds and the fps ratio. Presets missing in B (older revisions) are reported as such.
import { resolve } from 'node:path';
import { T_STD, measureFps, openApp, problems, sleep, startServer, table, withHarness } from './lib.mjs';

await withHarness('fps', { w: 1920, h: 1080, uncapped: true, usage: 'node scripts/test/fps.mjs [--base URL] [--out DIR] [--presets a,b] [--qualities high,medium,low] [--secs 4] [--min-fps N] [--ab-off JS --ab-on JS --rounds 6 --ab-settle 400] [--compare DIR|URL --rounds 3 --label-a A --label-b B]' }, async ({ args, rep, base, browser }) => {
  const presets = args.list('presets', ['overview', 'a-ring-1km', 'a-ring-30m', 'a-ring-inside', 'b-ring-inside', 'c-ring-inside']);
  const quals = args.list('qualities', ['high', 'medium', 'low']);
  const secs = args.num('secs', 4), warmup = args.num('warmup', 2500), minFps = args.num('min-fps', 0);
  const extra = Object.fromEntries(new URLSearchParams(args.str('params', '')));
  const abOff = args.str('ab-off', ''), abOn = args.str('ab-on', '');
  const rows = [];
  const cells = [];
  const compare = args.str('compare', '');
  if (compare) {
    const rounds = args.num('rounds', 3);
    const la = args.str('label-a', 'A (this checkout)'), lb = args.str('label-b', `B (${compare})`);
    const srvB = /^https?:\/\//.test(compare) ? await startServer({ base: compare }) : await startServer({ root: resolve(compare) });
    try {
      // presets the other tree knows (an older revision may lack some)
      const known = async (b) => {
        const { page } = await openApp(browser, b, { preset: 'overview', paused: 1, hud: 0, labels: 0 });
        try { return await page.evaluate(() => window.__sv.presets.map((p) => (typeof p === 'string' ? p : p.id))); } finally { await page.close(); }
      };
      const idsB = new Set(await known(srvB.base));
      const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
      for (const p of presets) {
        for (const q of quals) {
          const params = { preset: p, quality: q, t: T_STD, paused: 1, hud: 0, labels: 0, ...extra };
          const msA = [], msB = [];
          let stA = null, stB = null;
          for (let i = 0; i < rounds; i++) {
            const order = i % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
            for (const which of order) {
              if (which === 'B' && !idsB.has(p)) continue;
              const r = await measureFps(browser, which === 'A' ? base : srvB.base, params, { secs, warmup });
              if (r.problems.length) rep.check(`${p} / ${q} (${which}): clean`, false, r.problems.join(' | '));
              (which === 'A' ? msA : msB).push(1000 / r.fps);
              if (which === 'A') stA = r.stats; else stB = r.stats;
            }
          }
          const mA = mean(msA), mB = msB.length ? mean(msB) : NaN;
          let dm = NaN, se = NaN;
          if (msB.length === msA.length) {
            const d = msB.map((b, i) => b - msA[i]);
            dm = mean(d);
            se = Math.sqrt(d.reduce((s, x) => s + (x - dm) ** 2, 0) / Math.max(d.length - 1, 1) / d.length);
          }
          cells.push({ preset: p, quality: q, msA, msB, diffMs: dm, seMs: se, statsA: stA, statsB: stB });
          const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
          rows.push([p, q, f(mA), f(1000 / mA, 1), f(mB), f(1000 / mB, 1), Number.isFinite(dm) ? `${dm >= 0 ? '+' : ''}${dm.toFixed(2)} ± ${se.toFixed(2)}` : 'n/a', f(mB / mA, 2), `${stA?.['near.drawn'] ?? '-'}`.split(' ')[0], `${stB?.['near.drawn'] ?? '-'}`.split(' ')[0]]);
          console.log(`  ${p} / ${q}: A ${f(mA)} ms, B ${f(mB)} ms, B - A ${f(dm)} +- ${f(se)} ms`);
        }
      }
    } finally {
      await srvB.close();
    }
    console.log(`\nA = ${la}, B = ${lb}\n${table(['preset', 'quality', 'A ms', 'A fps', 'B ms', 'B fps', 'B - A ms', 'B / A ms', 'A drawn', 'B drawn'], rows)}`);
    rep.data.compare = { a: la, b: lb, target: compare, rounds, secs, cells };
    rep.data.size = `${args.num('w', 1920)}x${args.num('h', 1080)}`;
    rep.check('compare table measured', cells.length === presets.length * quals.length, `${cells.length} cells`);
    return;
  }
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
