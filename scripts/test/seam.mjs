#!/usr/bin/env node
// Near field <-> medium consistency (seams): the particles plus the ring-layer medium carrying the remaining
// optical depth must look like the medium carrying all of it.
//
// usage: node scripts/test/seam.mjs [--base URL] [--out DIR] [--only seam,flux,handover,base] [--views id1,id2] [--realizations 6]
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
// 3. handover  the medium's own representations (near field off): the ray march with the explicit wake field
//          (clipmap) and the wake statistics (the march's statistical branch, the far-field sheet) against a
//          reference explicit field (the shared wakeDensity evaluated per step, no clipmap prefilter, 12 sun-path
//          nodes), in strips across the march -> sheet handover (wM from debug view 12) and in two column regions
//          (looking along / across the wakes): reflected radiance L (far-field pass off: nothing behind the rings)
//          and transmission T (debug view 2). Checks in the band strips (0.02 < wM < 0.98): statistics (sheet) /
//          reference within 1 +- 0.08 (L) and 0.06 (T); prefiltered explicit march / reference within 0.08 (L) and 0.06
//          (T); the march's statistical branch / sheet within
//          0.03; the largest step of production / reference between neighbouring strips across the band <= 0.04 (a
//          seam between the representations is a step the reference does not have). Per-view overrides (documented
//          in HANDOVER_VIEWS) for known residuals. Before Nov 2026 the explicit field was 15-26 % too bright (two
//          fixed sun-path samples) and the statistical T 30-40 % too low across the wakes.
//          --hviews id,... --hstrips 13 --hreal 3 (realizations: independent wake patterns, WakeField.realization;
//          the statistics are the ensemble mean, one pattern's strip means scatter by +-5 % along the wakes)
// 4. base  the base radiative transfer of the two representations with the wakes off (wakes=0): the march forced over
//          the frame vs the sheet, L and T in the handover views' strips: L within 1 +- 0.03 in every strip the layer
//          fills, T's slant optical depth -ln T within 3 % (the same plane-parallel transfer; measured L 0.994-1.027,
//          T 0.986-1.035 at T >= 0.04, i.e. <= 1.1 % in tau). Found in Nov 2026: the sheet's Saturnshine beams
//          took the point-source shadow-hiding surge (an opposition peak of a few degrees applied to Saturn's half-disk
//          of tens of degrees), up to 14 % too bright at high solar phase (yaw120), where Saturnshine dominates.
// The default render scale (0.5) is used unless --scale is given; astronaut=0 throughout.
import { join } from 'node:path';
import { canvasChroma, fmt, hdrMeans, openApp, retry, setPassEnabled, sleep, strips, table, waitFrames, withHarness } from './lib.mjs';

const T_ARC = '2026-11-08T01:02:55Z', T_STD = '2026-11-07T20:00:00Z';
export const VIEWS = [
  { id: 'arc-repro', note: 'user report: 2 km above the unlit A ring, grazing', params: { cam: 'ring', r: 133374e3, z: 1970, yaw: 60, pitch: -22, t: T_ARC }, rows: [0.42, 1.0] },
  { id: 'a-ring-1km', note: 'preset', params: { preset: 'a-ring-1km', t: T_STD }, rows: [0.25, 1.0] },
  // 30 m above the layer the strips hold relatively few, large particles: +-5 % realization noise per strip even
  // with 6 realizations -> 6 wider strips and a 0.08 step limit. (It was 0.11 for a ~9 % particle deficit in the grazing
  // far strip and the contact brightening; with the N-body size rules -- participation, the vertical laws, tau_dyn,
  // docs/ring-physics.md 10.12 -- the far strip is within 2 % and the contact brightening +1-3 % in the nearest strips:
  // step 0.041 in two runs.)
  { id: 'a-ring-30m', note: 'preset; rows within ~60 m of the camera excluded (single metre-sized boulders dominate); realization noise, step limit 0.08', params: { preset: 'a-ring-30m', t: T_STD }, rows: [0.35, 0.78], strips: 6, jump: 0.08 },
  { id: 'lit-500m', note: '500 m below the lit A ring, looking up', params: { cam: 'ring', r: 128000e3, z: -500, yaw: -120, pitch: 10, t: T_ARC }, rows: [0.0, 0.55] },
  // (the former +5-8 % particle excess on the unlit face, step limit 0.09, is gone since the sun-path fix: step <= 0.011)
  { id: 'under-rings', note: 'preset (unlit face from below)', params: { preset: 'under-rings', t: T_STD }, rows: [0.0, 0.45] },
];
const LIM = { lo: 0.85, hi: 1.15, jump: 0.06, chroma: 0.002, flux: 0.08, base: 0.03 };
const COMMON = { hud: 0, labels: 0, paused: 1, astronaut: 0 };

// handover views: rows of the frame spanning the explicit field, the handover band and the statistics (within the
// wake clipmap's coverage, where the reference exists), two column regions [x0, x1]. Limits (HLIM, per-view `lim`
// overrides with the reason) apply in the handover band, 0.02 < wM < 0.98:
//   L, T        statistics (sheet) / reference                       0.08 / 0.06
//   LE, TE      prefiltered explicit march / reference               0.08 / 0.06 (LE was 0.22 for the clipmap
//                                                                    prefilter's reflection excess; <= 2 % since the
//                                                                    size rules of 10.12)
//   statSheet   the march's statistical branch / sheet               0.03
//   step        production / reference between neighbouring strips  0.04 (a seam at the handover)
// Nov 2026 (docs/ring-physics.md 10.12): with the size rules, the sheet's multiple scattering in the medium's tau metric
// and no point-source shadow hiding for Saturnshine, all views pass the default limits except as noted (they had L 0.18,
// T 0.15, TE 0.15 / 0.12, statSheet 0.07, step 0.05 at yaw120, L 0.12 / T 0.08 on the unlit face, TE 0.12 at 1 km).
export const HANDOVER_VIEWS = [
  { id: 'a-ring-1km', note: 'preset at the Cassini-compare time: left half along the wakes, right half across (Saturn behind)', params: { preset: 'a-ring-1km', t: '2026-11-08T12:00:00Z' }, rows: [0.3, 0.95], regions: [[0.02, 0.48], [0.52, 0.98]] },
  // (below the ring plane, z < 0: pitch up to look at the layer). High phase (looking toward the Sun's azimuth): across
  // the wakes, where the paths start to decorrelate (rows 0.25-0.45: the smoothstep of chi in the two-column
  // reflection, uRlWakeHeff), the sheet's reflection is up to 4 % above the march's statistics (which match the
  // reference within 1.5 %) -> statSheet 0.05
  { id: 'a-1km-yaw120', note: 'the preset position (lit face, 1 km) looking the other way (yaw 120, high phase)', params: { cam: 'ring', r: 128000e3, phi: 96.2, z: -1000, yaw: 120, pitch: 24, t: '2026-11-08T12:00:00Z' }, rows: [0.05, 0.7], regions: [[0.02, 0.48], [0.52, 0.98]], lim: { statSheet: 0.05 } },
  { id: 'unlit-2km', note: '2 km above the unlit A ring (arc-repro camera)', params: { cam: 'ring', r: 133374e3, z: 1970, yaw: 60, pitch: -22, t: '2026-11-08T01:02:55Z' }, rows: [0.45, 0.95], regions: [[0.02, 0.48], [0.52, 0.98]] },
];
const HLIM = { L: 0.08, T: 0.06, LE: 0.08, TE: 0.06, statSheet: 0.03, step: 0.04, wBand: 0.02 };
const HANDOVER_MODES = ['default', 'sheet', 'stat', 'explicit', 'reference'];

// Strip means averaged over `nReal` realizations: bumping the frame anchor id re-seeds the particles, and the wake
// field's realization index draws an independent wake pattern (same sequence in the near-field and the medium-only
// runs); this beats the shot noise of the few large particles close to the camera, and the pattern noise of strips
// covering only a few wake tiles, far better than moving the time.
const nextRealization = (page, k) => page.evaluate((k) => {
  const sv = window.__sv;
  sv.anchor.anchorId += 7919;
  if (sv.pipeline.ctx.wakes) sv.pipeline.ctx.wakes.realization = k;
}, k);
async function stripMeans(browser, base, params, rects, nReal, { shot, chromaRect } = {}) {
  return retry(async () => {
    const { page } = await openApp(browser, base, params, { settle: 2000 });
    try {
      const acc = new Array(rects.length).fill(0);
      for (let k = 0; k < nReal; k++) {
        if (k > 0) {
          await nextRealization(page, k);
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

// Fraction of the pixels of each rectangle (fractions, y from the top) whose hdrRT channel ch lies in [lo, hi].
const hdrFraction = (page, rects, ch, lo, hi) => page.evaluate((rects, ch, lo, hi) => {
  const sv = window.__sv;
  const rt = sv.pipeline.ctx.hdrRT;
  const w = rt.width, h = rt.height;
  const buf = new Float32Array(w * h * 4);
  sv.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  return rects.map(([x0, y0, x1, y1]) => {
    let c = 0, n = 0;
    for (let yt = Math.floor(y0 * h); yt < Math.max(Math.floor(y0 * h) + 1, Math.floor(y1 * h)); yt++) {
      for (let x = Math.floor(x0 * w); x < Math.max(Math.floor(x0 * w) + 1, Math.floor(x1 * w)); x++) {
        const v = buf[((h - 1 - yt) * w + x) * 4 + ch];
        n++;
        if (v >= lo && v <= hi) c++;
      }
    }
    return c / n;
  });
}, rects, ch, lo, hi);

// One page per representation of the medium (near field and far field off): install the forcing hook on the ring-layer
// pass (applied after its own update every frame), then read L (debug view 0), T (debug view 2: hdr = 2 T), for the
// production image the march weight wM (debug view 12: hdr.r = wM) and for the reference the share of pixels whose
// wake field came from the clipmap's coverage (debug view 12: hdr.g = wake source 0-5; elsewhere there is no reference).
async function handoverMeans(browser, base, params, mode, rects, nReal) {
  return retry(async () => {
    const { page } = await openApp(browser, base, { ...COMMON, ...params, nearField: 0 }, { settle: 1500 });
    try {
      await page.evaluate((mode) => {
        const sv = window.__sv;
        sv.pipeline.passes.far.inner.enabled = false;
        const p = sv.pipeline.passes.rings.inner;
        const up = Object.getPrototypeOf(p).update;
        p.update = function (f, ctx) {
          up.call(this, f, ctx);
          const u = this.u;
          if (mode === 'sheet') u.uRlNearOn.value = 0;
          if (mode === 'stat' || mode === 'explicit' || mode === 'reference') u.uRlLodRange.value = 1e9;
          u.uRlForce.value.x = mode === 'stat' ? 2 : mode === 'explicit' || mode === 'reference' ? 1 : 0;
          u.uRlForce.value.y = mode === 'reference' ? 1 : 0;
        };
      }, mode);
      const setDebug = (v) => page.evaluate((v) => { window.__sv.app.settings.render.debugView = v; }, v);
      const acc = { L: rects.map(() => 0), T: rects.map(() => 0), wM: rects.map(() => 0), cover: rects.map(() => 0) };
      for (let k = 0; k < nReal; k++) {
        if (k > 0) await nextRealization(page, k);
        await setDebug(0);
        await waitFrames(page, 4);
        await sleep(k > 0 ? 1500 : 300);
        (await hdrMeans(page, rects)).forEach((v, i) => (acc.L[i] += v / nReal));
        await setDebug(2);
        await waitFrames(page, 3);
        (await hdrMeans(page, rects, 'r')).forEach((v, i) => (acc.T[i] += v / (2 * nReal)));
        if (mode === 'default' || mode === 'reference') {
          await setDebug(12);
          await waitFrames(page, 3);
          if (mode === 'default') (await hdrMeans(page, rects, 'r')).forEach((v, i) => (acc.wM[i] += v / nReal));
          else (await hdrFraction(page, rects, 1, -0.5, 5.5)).forEach((v, i) => (acc.cover[i] += v / nReal));
        }
      }
      await setDebug(0);
      return acc;
    } finally {
      await page.close();
    }
  }, { label: `handover ${mode}` });
}

await withHarness('seam', { usage: 'node scripts/test/seam.mjs [--base URL] [--out DIR] [--only seam,flux,handover,base] [--views a,b] [--hviews a,b] [--realizations 6] [--hreal 3] [--strips N] [--scale S]' }, async ({ args, out, rep, base, browser }) => {
  const only = new Set(args.list('only', ['seam', 'flux', 'handover', 'base']));
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

  if (only.has('handover')) {
    const want = new Set(args.list('hviews', HANDOVER_VIEWS.map((v) => v.id)));
    const nS = args.num('hstrips', 13), nR = args.num('hreal', 3);
    rep.data.handover = {};
    for (const v of HANDOVER_VIEWS.filter((x) => want.has(x.id))) {
      console.log(`\n[handover] ${v.id} — ${v.note}`);
      const rects = v.regions.flatMap(([x0, x1]) => strips(v.rows[0], v.rows[1], nS, x0, x1));
      const M = {};
      for (const mode of HANDOVER_MODES) M[mode] = await handoverMeans(browser, base, { ...scale, ...v.params }, mode, rects, nR);
      rep.data.handover[v.id] = { rects, means: M };
      v.regions.forEach(([x0, x1], ri) => {
        const idx = Array.from({ length: nS }, (_, i) => ri * nS + i);
        const r = (q, a, b) => idx.map((i) => M[a][q][i] / M[b][q][i]);
        const R = { L: { sheet: r('L', 'sheet', 'reference'), expl: r('L', 'explicit', 'reference'), stat: r('L', 'stat', 'sheet'), def: r('L', 'default', 'reference') },
          T: { sheet: r('T', 'sheet', 'reference'), expl: r('T', 'explicit', 'reference'), stat: r('T', 'stat', 'sheet'), def: r('T', 'default', 'reference') } };
        const wM = idx.map((i) => M.default.wM[i]);
        const cover = idx.map((i) => M.reference.cover[i]);
        const rows = idx.map((i, j) => [`${fmt(rects[i][1], 3)}-${fmt(rects[i][3], 3)}`, fmt(wM[j], 2), fmt(cover[j], 2),
          fmt(M.reference.L[i], 4), fmt(R.L.def[j], 3), fmt(R.L.sheet[j], 3), fmt(R.L.expl[j], 3), fmt(R.L.stat[j], 3),
          fmt(M.reference.T[i], 4), fmt(R.T.def[j], 3), fmt(R.T.sheet[j], 3), fmt(R.T.expl[j], 3), fmt(R.T.stat[j], 3)]);
        console.log(`  columns ${x0}-${x1}`);
        console.log(table(['rows', 'wM', 'ref cover', 'L ref', 'def/ref', 'sheet/ref', 'expl/ref', 'stat/sheet', 'T ref', 'def/ref', 'sheet/ref', 'expl/ref', 'stat/sheet'], rows));
        const tag = `${v.id} x ${x0}-${x1}`;
        rep.check(`handover ${tag}: the ring layer fills the strips (reference L > 0, T < 0.99)`, idx.every((i) => M.reference.L[i] > 0 && M.reference.T[i] < 0.99), `L ${fmt(Math.min(...idx.map((i) => M.reference.L[i])), 4)} .. , T .. ${fmt(Math.max(...idx.map((i) => M.reference.T[i])), 3)}`);
        // the handover band (and the reference exists only within the wake clipmap's coverage)
        const L = { ...HLIM, ...(v.lim ?? {}) };
        const band = wM.map((w, j) => (w > L.wBand && w < 1 - L.wBand && cover[j] >= 0.98 ? j : -1)).filter((j) => j >= 0);
        const span = (a, js) => (js.length ? [Math.min(...js.map((j) => a[j])), Math.max(...js.map((j) => a[j]))] : [1, 1]);
        const within = (a, lim) => { const [lo, hi] = span(a, band); return { ok: band.length > 0 && lo >= 1 - lim && hi <= 1 + lim, d: `${fmt(lo, 3)} .. ${fmt(hi, 3)} (${band.length} band strips)` }; };
        for (const q of ['L', 'T']) {
          let c = within(R[q].sheet, L[q]);
          rep.check(`handover ${tag}: ${q} statistics (sheet) / reference explicit field within 1 +- ${L[q]} in the band`, c.ok, c.d);
          c = within(R[q].expl, L[`${q}E`]);
          rep.check(`handover ${tag}: ${q} prefiltered explicit march / reference within 1 +- ${L[`${q}E`]} in the band`, c.ok, c.d);
          c = within(R[q].stat, L.statSheet);
          rep.check(`handover ${tag}: ${q} march statistics / sheet within 1 +- ${L.statSheet} in the band`, c.ok, c.d);
          // a seam between the representations: production / reference jumps between neighbouring band strips
          let step = 0, at = -1;
          for (let j = 0; j + 1 < nS; j++) {
            if (!band.includes(j) || !band.includes(j + 1)) continue;
            if (cover[j] < 0.98 || cover[j + 1] < 0.98) continue;
            const d = Math.abs(R[q].def[j + 1] - R[q].def[j]);
            if (d > step) { step = d; at = j; }
          }
          rep.check(`handover ${tag}: ${q} production / reference, largest step across the band <= ${L.step}`, step <= L.step, `${fmt(step, 3)} between strips ${at} and ${at + 1}`);
        }
        rep.data.handover[v.id][`x${x0}-${x1}`] = { rows, wM, ratios: R };
      });
    }
  }

  if (only.has('base')) {
    // the base radiative transfer of the medium's two representations without wakes: the same plane-parallel transfer
    rep.data.base = {};
    const nS = args.num('hstrips', 13);
    for (const v of HANDOVER_VIEWS.filter((x) => new Set(args.list('hviews', HANDOVER_VIEWS.map((h) => h.id))).has(x.id))) {
      console.log(`\n[base] ${v.id} — wakes off: march (forced over the frame) vs sheet`);
      const rects = v.regions.flatMap(([x0, x1]) => strips(v.rows[0], v.rows[1], nS, x0, x1));
      const M = {};
      for (const mode of ['explicit', 'sheet']) M[mode] = await handoverMeans(browser, base, { ...scale, ...v.params, wakes: 0 }, mode, rects, 1);
      const rows = rects.map((r, i) => [`${fmt(r[0], 2)}-${fmt(r[2], 2)} ${fmt(r[1], 3)}-${fmt(r[3], 3)}`, fmt(M.explicit.L[i], 4), fmt(M.sheet.L[i] / M.explicit.L[i], 3), fmt(M.explicit.T[i], 4), fmt(M.sheet.T[i] / M.explicit.T[i], 3)]);
      console.log(table(['columns rows', 'L march', 'L sheet/march', 'T march', 'T sheet/march'], rows));
      // strips the ring layer fills (some light reflected, some extinction)
      const idx = rects.map((_, i) => i).filter((i) => M.explicit.L[i] > 0 && M.explicit.T[i] < 0.99);
      const rr = idx.map((i) => M.sheet.L[i] / M.explicit.L[i]);
      const lo = Math.min(...rr), hi = Math.max(...rr);
      rep.check(`base ${v.id}: L sheet / march (wakes off) within 1 +- ${LIM.base} in every filled strip`, idx.length > 0 && lo >= 1 - LIM.base && hi <= 1 + LIM.base, `${fmt(lo, 3)} .. ${fmt(hi, 3)} (${idx.length} strips)`);
      // transmission as slant optical depth: -ln T within 3 % (the ratio of T within 3 % where T > 1/e; the grazing far
      // strips have T of a few % and the sheet's footprint-averaged prefilter differs there by ~1 % in tau)
      const dt = idx.map((i) => Math.abs(Math.log(M.sheet.T[i] / M.explicit.T[i])) / Math.max(1, -Math.log(M.explicit.T[i])));
      const tr = idx.map((i) => M.sheet.T[i] / M.explicit.T[i]);
      rep.check(`base ${v.id}: T sheet / march (wakes off): |ln ratio| / max(1, tau_slant) <= ${LIM.base} in every filled strip`, idx.length > 0 && Math.max(...dt) <= LIM.base,
        `worst ${fmt(Math.max(...dt), 4)}; ratio ${fmt(Math.min(...tr), 3)} .. ${fmt(Math.max(...tr), 3)} (${idx.length} strips)`);
      rep.data.base[v.id] = { rects, means: M };
    }
  }
});
