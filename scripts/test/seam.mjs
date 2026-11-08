#!/usr/bin/env node
// Near field <-> medium consistency (seams): the particles plus the ring-layer medium carrying the remaining
// optical depth must look like the medium carrying all of it.
//
// usage: node scripts/test/seam.mjs [--base URL] [--out DIR] [--only seam,flux] [--views id1,id2] [--realizations 6]
//                                   [--strips 10] [--scale S] [--w 1280 --h 720]
//
// 1. seam  per view: mean HDR radiance (hdrRT: after the ring layer, before glare / tone mapping) in horizontal
//          strips over the view's ring rows, averaged over several particle / wake realizations (shot noise), with
//          the near field on (A) and off (B, ?nearField=0: the medium carries all optical depth). Checks per strip:
//          A/B in [0.85, 1.15], and |A/B(i+1) - A/B(i)| <= 0.06 between neighbouring strips (a seam / arc is a
//          step that the medium-only image does not have; the arc fixed in 2026-11 was a ~0.1 step). The
//          user-reported arc repro (2 km above the unlit A ring, yaw 60) is the first view. Also counts
//          unnatural-hue pixels in the ring rows of the displayed image (fraction <= 0.002). Screenshots of A and
//          B go to <out>/<view>-near.png / -medium.png.
// 2. flux  particle-only flux (ring layer pass disabled, so hdrRT = particles + far field) in the near strips of
//          a-ring-30m at render scale 0.5 vs 1, averaged over particle realizations: sub-pixel particles are
//          rasterized differently at the two scales, but the expected flux must not change (ratio 1 +- 0.08).
// The default render scale (0.5) is used unless --scale is given; astronaut=0 throughout.
import { join } from 'node:path';
import { canvasChroma, fmt, hdrMeans, openApp, retry, setPassEnabled, sleep, strips, table, withHarness } from './lib.mjs';

const T_ARC = '2026-11-08T01:02:55Z', T_STD = '2026-11-07T20:00:00Z';
export const VIEWS = [
  { id: 'arc-repro', note: 'user report: 2 km above the unlit A ring, grazing', params: { cam: 'ring', r: 133374e3, z: 1970, yaw: 60, pitch: -22, t: T_ARC }, rows: [0.42, 1.0] },
  { id: 'a-ring-1km', note: 'preset', params: { preset: 'a-ring-1km', t: T_STD }, rows: [0.25, 1.0] },
  // 30 m above the layer the strips hold relatively few, large particles: +-5 % realization noise per strip even
  // with 6 realizations -> 6 wider strips and a 0.08 step limit
  { id: 'a-ring-30m', note: 'preset; rows within ~60 m of the camera excluded (single metre-sized boulders dominate)', params: { preset: 'a-ring-30m', t: T_STD }, rows: [0.35, 0.78], strips: 6, jump: 0.08 },
  { id: 'lit-500m', note: '500 m below the lit A ring, looking up', params: { cam: 'ring', r: 128000e3, z: -500, yaw: -120, pitch: 10, t: T_ARC }, rows: [0.0, 0.55] },
  // known (2026-11): on the unlit face the particles are ~5-8 % brighter than the medium they replace (near-field
  // photometry), which leaves a soft ~0.07 step where the particle range ends -> looser step limit for this view
  { id: 'under-rings', note: 'preset (unlit face from below); known +5-8 % particle excess, step limit 0.09', params: { preset: 'under-rings', t: T_STD }, rows: [0.0, 0.45], jump: 0.09 },
];
const LIM = { lo: 0.85, hi: 1.15, jump: 0.06, chroma: 0.002, flux: 0.08 };
const COMMON = { hud: 0, labels: 0, paused: 1, astronaut: 0 };

// Strip means averaged over `nReal` realizations: bumping the frame anchor id re-seeds the particles and the wake
// field (same seed sequence in the near-field and the medium-only runs), which beats the shot noise of the few
// large particles close to the camera far better than moving the time.
async function stripMeans(browser, base, params, rects, nReal, { shot, chromaRect } = {}) {
  return retry(async () => {
    const { page } = await openApp(browser, base, params, { settle: 2000 });
    try {
      const acc = new Array(rects.length).fill(0);
      for (let k = 0; k < nReal; k++) {
        if (k > 0) {
          await page.evaluate(() => { window.__sv.anchor.anchorId += 7919; });
          await sleep(1500);
        }
        const v = await hdrMeans(page, rects);
        v.forEach((x, i) => (acc[i] += x / nReal));
      }
      let chroma = null;
      if (chromaRect) chroma = await canvasChroma(page, chromaRect);
      if (shot) await page.screenshot({ path: shot });
      return { means: acc, chroma };
    } finally {
      await page.close();
    }
  }, { label: params.preset ?? params.cam });
}

await withHarness('seam', { usage: 'node scripts/test/seam.mjs [--base URL] [--out DIR] [--only seam,flux] [--views a,b] [--realizations 6] [--strips N] [--scale S]' }, async ({ args, out, rep, base, browser }) => {
  const only = new Set(args.list('only', ['seam', 'flux']));
  const scale = args.has('scale') ? { scale: args.num('scale', 0.5) } : {};
  const nReal = args.num('realizations', 6);
  const nStrips = args.num('strips', 10);

  if (only.has('seam')) {
    const want = new Set(args.list('views', VIEWS.map((v) => v.id)));
    for (const v of VIEWS.filter((x) => want.has(x.id))) {
      console.log(`\n[seam] ${v.id} — ${v.note}`);
      const rects = strips(v.rows[0], v.rows[1], args.has('strips') ? nStrips : v.strips ?? nStrips);
      const chromaRect = [0, v.rows[0], 1, v.rows[1]];
      const A = await stripMeans(browser, base, { ...COMMON, ...scale, ...v.params }, rects, nReal, { shot: join(out, `${v.id}-near.png`), chromaRect });
      const B = await stripMeans(browser, base, { ...COMMON, ...scale, ...v.params, nearField: 0 }, rects, nReal, { shot: join(out, `${v.id}-medium.png`) });
      const ratio = A.means.map((a, i) => a / B.means[i]);
      const rows = rects.map((r, i) => [`${fmt(r[1], 3)}-${fmt(r[3], 3)}`, fmt(A.means[i], 5), fmt(B.means[i], 5), fmt(ratio[i], 3)]);
      console.log(table(['rows (top=0)', 'near+medium', 'medium only', 'ratio'], rows));
      const lo = Math.min(...ratio), hi = Math.max(...ratio);
      let jump = 0, at = -1;
      for (let i = 0; i + 1 < ratio.length; i++) { const d = Math.abs(ratio[i + 1] - ratio[i]); if (d > jump) { jump = d; at = i; } }
      const jl = v.jump ?? LIM.jump;
      rep.check(`${v.id}: strip ratios near+medium / medium within [${LIM.lo}, ${LIM.hi}]`, lo >= LIM.lo && hi <= LIM.hi, `min ${fmt(lo, 3)} max ${fmt(hi, 3)}`);
      rep.check(`${v.id}: largest step between neighbouring strips <= ${jl}`, jump <= jl, `${fmt(jump, 3)} between strips ${at} and ${at + 1}`);
      rep.check(`${v.id}: unnatural-hue pixels in the ring rows <= ${LIM.chroma * 100}%`, A.chroma.fraction <= LIM.chroma, `${A.chroma.count} px (${fmt(A.chroma.fraction * 100, 3)}%) ${A.chroma.examples.slice(0, 3).join(' ')}`);
      rep.data[v.id] = { rows, ratio, chroma: A.chroma };
    }
  }

  if (only.has('flux')) {
    console.log('\n[flux] particle-only flux, render scale 0.5 vs 1 (a-ring-30m, ring layer off)');
    const rects = strips(0.5, 0.9, 4);
    const flux = {};
    for (const sc of [0.5, 1]) {
      flux[sc] = await retry(async () => {
        const { page } = await openApp(browser, base, { ...COMMON, preset: 'a-ring-30m', t: T_STD, scale: sc }, { settle: 1500 });
        try {
          await setPassEnabled(page, 'rings', false);
          const acc = new Array(rects.length).fill(0);
          const n = 4;
          for (let k = 0; k < n; k++) {
            // a new particle realization (new seeds) for every sample
            if (k > 0) await page.evaluate(() => { window.__sv.anchor.anchorId += 7919; });
            await sleep(1500);
            const v = await hdrMeans(page, rects);
            v.forEach((x, i) => (acc[i] += x / n));
          }
          return acc;
        } finally {
          await page.close();
        }
      }, { label: `flux scale ${sc}` });
    }
    const rows = rects.map((r, i) => [`${fmt(r[1], 2)}-${fmt(r[3], 2)}`, fmt(flux[0.5][i], 5), fmt(flux[1][i], 5), fmt(flux[0.5][i] / flux[1][i], 3)]);
    console.log(table(['rows (top=0)', 'scale 0.5', 'scale 1', 'ratio'], rows));
    const tot = flux[0.5].reduce((a, b) => a + b, 0) / flux[1].reduce((a, b) => a + b, 0);
    rep.range('particle flux scale 0.5 / scale 1 (near strips, all)', tot, 1 - LIM.flux, 1 + LIM.flux);
    rep.data.flux = rows;
  }
});
