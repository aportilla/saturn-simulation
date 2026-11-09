#!/usr/bin/env node
// Whole-frame cost (ms) of configurations of the app in the same page: per view, the paused frame is rendered by
// pipeline.render `--reps` times between synchronous 1-pixel read-backs (Chrome's gl.finish does not wait), for every
// configuration in turn (rotating order per trial), min and 20th percentile over `--trials` per configuration. The app's
// own frame loop is held meanwhile. Robust against other GPU users (interleaved short trials; another agent's browser
// can triple the median, so compare minima / p20 and repeat runs) and far less noisy than fps counting; it measures
// CPU + GPU time of one frame (no presentation). Informational, no limits.
//
// A configuration is `name::<js>` (repeat --cfg): the JavaScript runs in the page before each of its measurements and
// must set everything it relies on (it is not undone; the next configuration sets its own state). Helpers in scope:
// sv = window.__sv, P = sv.pipeline, near / rings / far / post = the passes' inner objects, S = P.ctx.structure,
// f = sv.frame, ctx = P.ctx. `name::<setup js>::<timed js>` times the second snippet instead of a whole frame (an
// isolated stage, e.g. the near field's update pass alone:
// "upd::Object.assign(near.skip,{contact:true,compact:true,points:true,quads:true,shadow:true})::near.render(f,ctx)";
// shorter timed spans are hit less often by other GPU users). Whole frames are still rendered to settle.
// --settle-frames N: frames rendered after applying a configuration before timing (re-fits, clipmap refreshes).
// Default configurations: `full` (everything on) and the passes off one at a time (near, rings, far).
//
// usage: node scripts/test/framecost.mjs [--base URL] [--out DIR] [--views a-ring-1km,b-ring-inside] [--params "k=v&..."]
//                                        [--cfg "name::js"]... [--reps 1] [--trials 30] [--settle 2500]
//                                        [--settle-frames 3] [--w 1920 --h 1080]
// examples:
//   --cfg "on::S.texture.amp=1;S.propellers.scale=1" --cfg "off::S.texture.amp=0;S.propellers.scale=0"
//   --cfg "all::near.skip.update=false" --cfg "noupdate::near.skip.update=true"   (stale R0: the update pass's cost)
import { T_STD, openApp, problems, table, withHarness } from './lib.mjs';

const DEFAULT_CFGS = [
  'full::near.enabled=true;rings.enabled=true;far.enabled=true',
  'no-near::near.enabled=false;rings.enabled=true;far.enabled=true',
  'no-rings::near.enabled=true;rings.enabled=false;far.enabled=true',
  'no-far::near.enabled=true;rings.enabled=true;far.enabled=false',
];

export async function frameCostConfigs(cfgs, reps, trials, settleFrames) {
  const sv = window.__sv, P = sv.pipeline;
  const inner = (n) => P.passes[n]?.inner ?? P.passes[n];
  const env = { sv, P, near: inner('near'), rings: inner('rings'), far: inner('far'), post: inner('post'), S: P.ctx.structure, f: sv.frame, ctx: P.ctx };
  const run = (js) => new Function(...Object.keys(env), js)(...Object.values(env));
  const timedFns = cfgs.map((c) => (c.timed ? new Function(...Object.keys(env), c.timed) : null));
  const orig = P.render.bind(P), px = new Float32Array(4);
  let hold = true;
  P.render = (f) => (hold ? undefined : orig(f));
  // fence on every target a timed stage may write (a 1-pixel read-back waits only for the work on its own target)
  const fenceRTs = () => [P.ctx.hdrRT, P.ctx.sceneRT, env.near?.r0RT].filter(Boolean);
  const sync = () => { for (const rt of fenceRTs()) sv.renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, px); };
  const best = cfgs.map(() => Infinity), all = cfgs.map(() => []);
  try {
    for (let t = 0; t < trials; t++) {
      for (let j = 0; j < cfgs.length; j++) {
        const i = (j + t) % cfgs.length;
        run(cfgs[i].js);
        for (let k = 0; k < settleFrames; k++) { orig(sv.frame); sync(); }
        const tf = timedFns[i], ev = Object.values(env);
        const t0 = performance.now();
        for (let k = 0; k < reps; k++) { if (tf) tf(...ev); else orig(sv.frame); }
        sync();
        const ms = (performance.now() - t0) / reps;
        all[i].push(ms);
        best[i] = Math.min(best[i], ms);
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  } finally {
    run(cfgs[0].js);
    hold = false;
    P.render = orig;
  }
  const pct = (q) => all.map((v) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; });
  return { best, p20: pct(0.2), med: pct(0.5), stats: P.stats() };
}

if (process.argv[1] && process.argv[1].endsWith('framecost.mjs')) {
  await withHarness('framecost', { w: 1920, h: 1080, usage: 'node scripts/test/framecost.mjs [--base URL] [--out DIR] [--views a,b] [--params "k=v&..."] [--cfg "name::js"]... [--reps 1] [--trials 30] [--settle 2500] [--settle-frames 3]' }, async ({ args, rep, base, browser }) => {
    const views = args.list('views', ['a-ring-1km']);
    const extra = Object.fromEntries(new URLSearchParams(args.str('params', '')));
    // repeated --cfg options (parseArgs keeps the last): read them from argv directly
    const raw = [];
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--cfg' && argv[i + 1] !== undefined) raw.push(argv[++i]);
    const cfgs = (raw.length ? raw : DEFAULT_CFGS).map((s) => {
      const p = s.split('::');
      return p.length < 2 ? { name: s, js: s } : { name: p[0], js: p[1], timed: p.length > 2 ? p.slice(2).join('::') : null };
    });
    const reps = args.num("reps", 1), trials = args.num("trials", 30), settleFrames = args.num("settle-frames", 3);
    const rows = [];
    const out = [];
    for (const v of views) {
      const params = v.includes('=') ? Object.fromEntries(new URLSearchParams(v)) : { preset: v };
      const { page, errs } = await openApp(browser, base, { t: T_STD, paused: 1, hud: 0, labels: 0, ...params, ...extra }, { settle: args.num('settle', 2500) });
      try {
        const r = await page.evaluate(frameCostConfigs, cfgs, reps, trials, settleFrames);
        const pr = await problems(page, errs);
        if (pr.length) rep.check(`${v}: clean`, false, pr.join(' | '));
        out.push({ view: v, cfgs, ...r });
        const dl = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
        cfgs.forEach((c, i) => rows.push([v, c.name, r.best[i].toFixed(2), r.p20[i].toFixed(2), r.med[i].toFixed(2), i === 0 ? '-' : dl(r.best[i] - r.best[0]), i === 0 ? '-' : dl(r.p20[i] - r.p20[0])]));
        console.log(`  ${v}: ${cfgs.map((c, i) => `${c.name} ${r.best[i].toFixed(2)} ms`).join(', ')}  (near.drawn ${r.stats['near.drawn'] ?? '-'})`);
      } finally {
        await page.close();
      }
    }
    console.log(`\n${table(['view', 'config', 'min ms', 'p20 ms', 'median ms', 'min - first', 'p20 - first'], rows)}`);
    rep.data.views = out;
    rep.check('frame costs measured', out.length === views.length, `${out.length} views`);
  });
}
