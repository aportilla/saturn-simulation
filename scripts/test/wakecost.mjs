#!/usr/bin/env node
// GPU cost of the shared self-gravity-wake functions (sv_wakes: wakeDensity, wakeDisplacement): an in-page
// micro-benchmark on the real app state. A fullscreen pass evaluates the function K times per pixel at scattered points
// (spacing --step m) over a --size^2 float target around the camera, rendered --reps times and synchronised by a 1-pixel
// read-back; per variant the median of --trials wall times, minus that of the same pass with a trivial expression,
// / (size^2 K reps) = ns per call. The app's frame loop does not run during a trial (the timed loop is synchronous).
// The passes blend additively, so the tile-based GPU cannot skip the earlier of the repeated draws (hidden-surface
// removal of identical opaque full-screen draws made an opaque version scale with neither --reps nor --k).
// Informational (no thresholds): run it on two checkouts under the same conditions (e.g. before / after a wake-model
// change: `git archive <rev> | tar -x -C <dir>` + a node_modules symlink, then this script from each tree), interleaved;
// other GPU users skew the absolute numbers. The wake set under test is the one of the place (--preset).
// --scatter R: incoherent access like the near-field particles (each call at a hashed random point within +-R m of the
// camera instead of on a grid: texture-cache misses dominate; this is the cost that matters for nearUpdate /
// nearDraw.vert, ~2-5x the coherent one).
// usage: node scripts/test/wakecost.mjs [--base URL] [--out DIR] [--preset a-ring-1km] [--t ISO] [--size 512] [--k 8]
//        [--reps 8] [--trials 9] [--step 0.37] [--scatter R] [--async D]  (--async: override the asynchrony depth if the
//        tree has it)
import { openApp, table, withHarness } from './lib.mjs';

await withHarness('wakecost', {
  usage: 'node scripts/test/wakecost.mjs [--base URL] [--out DIR] [--preset id] [--t ISO] [--size N] [--k K] [--reps R] [--trials T] [--step m] [--async D]',
}, async ({ args, rep, base, browser }) => {
  const preset = args.str('preset', 'a-ring-1km');
  const size = args.num('size', 512), K = args.num('k', 8), reps = args.num('reps', 8), trials = args.num('trials', 9);
  const step = args.num('step', 0.37);
  const scatter = args.num('scatter', 0);
  const asyncD = args.has('async') ? args.num('async', 0) : null;
  const { page } = await openApp(browser, base, { preset, t: args.str('t', '2026-11-08T12:00:00Z'), paused: 1, hud: 0, labels: 0, astronaut: 0 }, { settle: 2500 });
  const res = await page.evaluate(async (size, K, reps, trials, step, asyncD, scatter) => {
    const { FullscreenPass } = await import(/* @vite-ignore */ '/src/render/fullscreen.ts');
    const { SV_HEADER_ALL } = await import(/* @vite-ignore */ '/src/render/shaders/chunks.ts');
    const sv = window.__sv;
    const p = sv.pipeline, r = sv.renderer;
    const wakes = p.ctx.wakes;
    if (asyncD !== null && wakes.shapeOverride !== undefined && 'asyncD' in wakes.shape) {
      wakes.shapeOverride = { ...(wakes.shapeOverride ?? {}), asyncD };
      // re-configure at the current anchor (the pipeline re-configures on anchor changes only)
      const f = sv.frame;
      const local = p.ctx.profile.local(f.ring.r0 + f.ring.camLocal.x);
      wakes.configure(local, f.ring);
      wakes.update(f.t);
    }
    const rt = p.ctx.hdrRT.clone();
    rt.setSize(size, size);
    const V4 = p.ctx.hdrRT.viewport.constructor; // three's Vector4 (no bare-module import in the page)
    const cam = sv.frame.ring.camLocal;
    const uP = new V4(cam.x - 0.5 * size * step, cam.y - 0.5 * size * step, step, scatter);
    const mk = (expr) => new FullscreenPass({
      fragmentShader: `${SV_HEADER_ALL}
uniform vec4 uP;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 xy = uP.xy + gl_FragCoord.xy * uP.z;
  float acc = 0.0;
  vec2 dacc = vec2(0.0);
  for (int i = 0; i < ${K}; i++) {
    vec2 q = xy + vec2(float(i) * 7.31, float(i) * -3.17);
    if (uP.w > 0.0) q = uP.xy + 0.5 * float(${size}) * uP.z + (vec2(hash13(vec3(gl_FragCoord.xy, float(i))), hash13(vec3(gl_FragCoord.yx, float(i) + 0.5))) - 0.5) * (2.0 * uP.w);
    ${expr}
  }
  outColor = vec4(acc, dacc, 1.0);
}`,
      uniforms: { ...p.ctx.shared.u, uP: { value: uP } },
      // additive blending: without it the tile-based GPU's hidden-surface removal shades only the last of the
      // identical opaque full-screen draws (the time would not scale with --reps)
      transparent: true,
      blending: 2, // THREE.AdditiveBlending
    });
    const passes = {
      baseline: mk('acc += sin(q.x * 0.01) + q.y * 1e-6;'),
      wakeDensity: mk('acc += wakeDensity(q);'),
      wakeDisplacement: mk('dacc += wakeDisplacement(q);'),
    };
    const buf = new Float32Array(4);
    const probe = {};
    const time = (pass, name) => {
      pass.render(r, rt);
      r.readRenderTargetPixels(rt, 0, 0, 1, 1, buf); // compile + warm up
      probe[name] = Array.from(buf);
      const ts = [];
      for (let t = 0; t < trials; t++) {
        const t0 = performance.now();
        for (let i = 0; i < reps; i++) pass.render(r, rt);
        r.readRenderTargetPixels(rt, 0, 0, 1, 1, buf);
        ts.push(performance.now() - t0);
      }
      ts.sort((a, b) => a - b);
      return ts[Math.floor(ts.length / 2)];
    };
    const out = {};
    // interleave: baseline, functions, baseline again
    out.baseline0 = time(passes.baseline, 'baseline');
    out.wakeDensity = time(passes.wakeDensity, 'wakeDensity');
    out.wakeDisplacement = time(passes.wakeDisplacement, 'wakeDisplacement');
    out.baseline1 = time(passes.baseline, 'baseline');
    // the per-frame skips (uWakeOpt: work the cycle phase makes redundant) must not change a result: both functions on a
    // grid with the flags as set and with every path forced on, compared bit for bit; and their cost with all paths on
    const opt = wakes.uniforms.uWakeOpt?.value;
    let exact = null;
    if (opt) {
      const flags = [opt.x, opt.y, opt.z, opt.w];
      const grid = new FullscreenPass({
        fragmentShader: `${SV_HEADER_ALL}
uniform vec4 uP;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 q = uP.xy + gl_FragCoord.xy * (uP.z * 3.1);
  outColor = vec4(wakeDensity(q), wakeDisplacement(q), 1.0);
}`,
        uniforms: { ...p.ctx.shared.u, uP: { value: uP } },
      });
      const read = () => { grid.render(r, rt); const b = new Float32Array(size * size * 4); r.readRenderTargetPixels(rt, 0, 0, size, size, b); return b; };
      const a = read();
      opt.set(1, 1, 1, 0);
      const b = read();
      out.wakeDensityAllOn = time(passes.wakeDensity, 'wakeDensityAllOn');
      out.wakeDisplacementAllOn = time(passes.wakeDisplacement, 'wakeDisplacementAllOn');
      opt.set(flags[0], flags[1], flags[2], flags[3]);
      let diff = 0, n = 0;
      for (let i = 0; i < a.length; i++) { if (i % 4 === 3) continue; diff = Math.max(diff, Math.abs(a[i] - b[i])); n++; }
      exact = { flags, maxDiff: diff, values: n };
      grid.dispose?.();
    }
    const glErr = r.getContext().getError();
    for (const k of Object.keys(passes)) passes[k].dispose?.();
    rt.dispose();
    const st = p.stats();
    return { ms: out, probe, glErr, exact, phase: wakes.uniforms.uWakeClock.value.x, wakeOn: wakes.uniforms.uWakeOn.value, strength: wakes.strength, shape: wakes.shape, stats: { mean: st['rings.wakeMean'] ?? st['rings.wakeMassK'] } };
  }, size, K, reps, trials, step, asyncD, scatter);
  const calls = size * size * K * reps;
  const b = 0.5 * (res.ms.baseline0 + res.ms.baseline1);
  const ns = (ms) => ((ms - b) * 1e6) / calls;
  const rows = [
    ['baseline (trivial)', res.ms.baseline0.toFixed(1) + ' / ' + res.ms.baseline1.toFixed(1), '-'],
    ['wakeDensity', res.ms.wakeDensity.toFixed(1), (1000 * ns(res.ms.wakeDensity)).toFixed(1)],
    ['wakeDisplacement', res.ms.wakeDisplacement.toFixed(1), (1000 * ns(res.ms.wakeDisplacement)).toFixed(1)],
  ];
  if (res.exact) {
    rows.push(['wakeDensity, every path on', res.ms.wakeDensityAllOn.toFixed(1), (1000 * ns(res.ms.wakeDensityAllOn)).toFixed(1)]);
    rows.push(['wakeDisplacement, every path on', res.ms.wakeDisplacementAllOn.toFixed(1), (1000 * ns(res.ms.wakeDisplacementAllOn)).toFixed(1)]);
  }
  console.log(`\n${preset}: wakes ${res.wakeOn ? 'on' : 'OFF'}, strength ${res.strength.toFixed(3)}, ${size}^2 px x ${K} calls x ${reps} reps, median of ${trials}` +
    (res.shape && 'asyncD' in res.shape ? `, asyncD ${res.shape.asyncD}` : '') + (scatter > 0 ? `, scattered within +-${scatter} m` : ', coherent grid'));
  console.log(table(['variant', 'median ms', 'ps / call (GPU throughput)'], rows));
  console.log(`read-back of pixel (0, 0) per variant (sanity: the draws ran): ${JSON.stringify(res.probe)}; gl error ${res.glErr}`);
  rep.check('the benchmark draws ran (finite, non-zero read-back, no GL error)', res.glErr === 0 &&
    ['wakeDensity', 'wakeDisplacement'].every((k) => res.probe[k] && res.probe[k].slice(0, 3).some((v) => Number.isFinite(v) && v !== 0)),
  JSON.stringify(res.probe));
  rep.data = { preset, size, K, reps, trials, scatter, ms: res.ms, nsPerCall: { wakeDensity: ns(res.ms.wakeDensity), wakeDisplacement: ns(res.ms.wakeDisplacement) }, shape: res.shape, strength: res.strength };
  rep.check('wakes are on at the benchmark place', res.wakeOn > 0.5, `strength ${res.strength.toFixed(3)}`);
  if (res.exact) {
    console.log(`cycle phase ${res.phase.toFixed(3)}, skip flags uWakeOpt = ${JSON.stringify(res.exact.flags)} (1 = needed)`);
    rep.check('the per-frame skips change no result (wakeDensity, wakeDisplacement on a grid: flags as set vs every path on)', res.exact.maxDiff === 0,
      `max |diff| ${res.exact.maxDiff} over ${res.exact.values} values`);
  }
  await page.close();
});
