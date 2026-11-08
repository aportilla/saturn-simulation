#!/usr/bin/env node
// Uncapped frame-rate table: places x particle render qualities, one fresh page per measurement.
//
// usage: node scripts/test/fps.mjs [--base URL] [--out DIR] [--presets a,b] [--qualities high,medium,low]
//                                  [--secs 4] [--warmup 2500] [--w 1920 --h 1080] [--params "k=v&..."] [--min-fps N]
//
// Each cell: new page with ?preset=<id>&quality=<q>&fps=0&t=...&paused=1&hud=0&labels=0 in a browser without vsync /
// frame-rate limit, warm-up, then requestAnimationFrame callbacks counted for --secs (several navigations in one
// tab leave old WebGL contexts alive and roughly halve the fps, hence a fresh page each). The default render scale
// and astronaut setting are kept (that is what users get). Another browser on the same GPU (other agents' tests)
// lowers the numbers: compare runs made under the same conditions. Informational unless --min-fps is given
// (then every cell must reach it). Results: <out>/fps.json and a table.
import { T_STD, measureFps, table, withHarness } from './lib.mjs';

await withHarness('fps', { w: 1920, h: 1080, uncapped: true, usage: 'node scripts/test/fps.mjs [--base URL] [--out DIR] [--presets a,b] [--qualities high,medium,low] [--secs 4] [--min-fps N]' }, async ({ args, rep, base, browser }) => {
  const presets = args.list('presets', ['overview', 'a-ring-1km', 'a-ring-30m', 'a-ring-inside', 'b-ring-inside', 'c-ring-inside']);
  const quals = args.list('qualities', ['high', 'medium', 'low']);
  const secs = args.num('secs', 4), warmup = args.num('warmup', 2500), minFps = args.num('min-fps', 0);
  const extra = Object.fromEntries(new URLSearchParams(args.str('params', '')));
  const rows = [];
  const cells = [];
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
