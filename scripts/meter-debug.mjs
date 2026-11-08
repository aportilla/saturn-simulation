#!/usr/bin/env node
// Dump the auto-exposure meter's intermediates (src/render/PostPass.ts) for one view: the scene meter's
// 90th-percentile luminance and lit coverage (geoRT), the highlight meter's max region / extended / peak
// luminance (lum16RT), the final metered luminance (maxRT), the share of the frame covered by the astronaut's
// meter mask (AstronautPass maskRT), and the resulting EV. Use it when tuning or debugging exposure.
// usage: node scripts/meter-debug.mjs "<url or ?query>" [--base URL] [--settle 4000] [--w 1920 --h 1080]
//   e.g. node scripts/meter-debug.mjs "?preset=cloud-tops&t=2026-11-07T20:00:00Z&paused=1&hud=0"
// A relative "?query" is resolved against --base, or a private dev server is started (scripts/test/lib.mjs).
import { launchBrowser, openApp, parseArgs, startServer } from './test/lib.mjs';

const args = parseArgs(process.argv.slice(2));
const target = args._[0];
if (!target) {
  console.error('usage: node scripts/meter-debug.mjs "<url or ?query>" [--base URL] [--settle ms] [--w W --h H]');
  process.exit(1);
}
const srv = await startServer({ base: /^https?:/.test(target) ? new URL(target).origin + '/' : args.str('base') });
const browser = await launchBrowser({ w: args.num('w', 1920), h: args.num('h', 1080) });
try {
  const u = new URL(target, srv.base);
  const params = Object.fromEntries(u.searchParams.entries());
  const { page } = await openApp(browser, srv.base, params, { path: u.pathname.replace(/^\//, ''), settle: args.num('settle', 4000) });
  const res = await page.evaluate(() => {
    const sv = window.__sv;
    const post = sv.pipeline.passes.post.inner;
    const rd = (rt, w, h) => { const b = new Float32Array(w * h * 4); sv.renderer.readRenderTargetPixels(rt, 0, 0, w, h, b); return b; };
    const geo = rd(post.geoRT, 1, 1);
    const a16 = rd(post.lum16RT, 16, 16);
    let mr = 0, mg = 0, mb = 0;
    for (let i = 0; i < 256; i++) { mr = Math.max(mr, a16[i * 4]); mg = Math.max(mg, a16[i * 4 + 1]); mb = Math.max(mb, a16[i * 4 + 2]); }
    // astronaut meter mask (AstronautPass -> ctx.meterMask, R8 at the render resolution; live if stamped this frame)
    const mm = sv.pipeline.ctx.meterMask;
    let maskShare = null;
    const maskRT = sv.pipeline.passes.overlay?.inner?.maskRT;
    if (mm && mm.frame === sv.frame.frameIndex && maskRT) {
      const w = maskRT.width, h = maskRT.height;
      const b = new Uint8Array(w * h * 4);
      sv.renderer.readRenderTargetPixels(maskRT, 0, 0, w, h, b);
      let n = 0;
      for (let i = 0; i < w * h; i++) if (b[i * 4] > 127) n++;
      maskShare = n / (w * h);
    }
    const mx = rd(post.maxRT, 1, 1);
    return {
      percentile: geo[0], coverage: geo[1], region: mr, extended: mg, peak: mb, metered: mx[0],
      maskShare, EV: sv.pipeline.stats()['post.EV'],
    };
  });
  console.log(`scene meter p90 ${res.percentile.toExponential(3)} W/m2/sr, lit coverage ${res.coverage.toFixed(3)}`);
  console.log(`highlight meter: region ${res.region.toExponential(3)}, extended ${res.extended.toExponential(3)}, peak ${res.peak.toExponential(3)}`);
  console.log(`metered ${res.metered.toExponential(3)} W/m2/sr -> EV ${res.EV}; astronaut meter mask: ${res.maskShare === null ? 'not live' : `${(100 * res.maskShare).toFixed(1)}% of the frame (metered as the scene it hides)`}`);
} finally {
  await browser.close();
  await srv.close();
}
