#!/usr/bin/env node
// Particle-count contract: "every particle >= 1 display pixel across is drawn, at true size and position".
//
// usage: node scripts/test/counts.mjs [--base URL] [--out DIR] [--places a-ring-30m,a-ring-1km,cassini-division]
//                                     [--classes N] [--mc 400000] [--heights 100,1000,5000] [--w 1280 --h 720]
//                                     [--cull-views b-ring-inside,a-ring-inside,a-ring-30m]
//
// 1. drawn vs expected  per place (astronaut=0, statistical occlusion culling switched off for the comparison):
//    measured = particles of class k in the near-field R0 read-back that are drawn (in view) and >= 0.5 display
//    px in radius; expected = Monte Carlo of n_k(a) tau_macro(r) M(r, theta) over the class box (M = the 2-D tau
//    modulation of sv_ringStructure: sub-km texture, propellers; CPU mirror), the Gaussian layer height,
//    the class's power-law radii and the view frustum, with the same >= 1 px condition. Ratio within
//    1 +- max(4/sqrt(expected), 0.04) for the classes with the most expected particles (>= 300).
// 2. HUD count line     pipeline.stats()['near.count'] starts with "complete" at every place checked, and at the
//    B ring seen from above (heights --heights m) it is either "complete..." or an explicit "DEFICIT: ~x% ...".
// 3. radius sampler     the per-class radius / box sampler (RingLod pieceP / pieceB, mirrored from nearRadiusBox)
//    reproduces the target number density tauMax a^-q / (pi I2) in every radius bin (ratio 1 +- 0.02) when
//    the slot cap does not bind.
// 4. occlusion cull     (--cull-views; render scale 1, astronaut off) the statistical-occlusion cull (nearOcclusion.glsl
//    nearLosTau: line-of-sight tau > 5) may only remove particles the layer hides: the same frame (same particles) with
//    the cull on and off, after the draw lists settled -- mean HDR radiance ratio within 1 +- 0.005, pixels whose
//    radiance changes by > 5 % <= 0.5 % (a culled particle that was visible leaves a hole: at the cull's tau >= 5 / 0.8
//    it is seen with probability <= e^-6.25 = 0.2 %); drawn >= 1 px with the cull off / on reported.
import { fmt, openApp, retry, sleep, table, withHarness } from './lib.mjs';

const BASE_PARAMS = { hud: 0, labels: 0, paused: 1, astronaut: 0, t: '2026-11-07T20:00:00Z' };

// --- in-page: measured vs Monte-Carlo expected counts per class (runs with culling off)
async function countClasses(page, nClasses, nMc) {
  return page.evaluate(async (nClasses, nMc) => {
    const sv = window.__sv;
    const near = sv.pipeline.passes.near?.inner ?? sv.pipeline.passes.near;
    if (!near || !near.classes || !near.r0RT) return { error: 'near-field internals (classes / r0RT) not found — update counts.mjs' };
    const lod = sv.pipeline.ctx.lod, prof = sv.pipeline.ctx.profile;
    if (!lod.active) return { error: 'near field not active here' };
    near.cullEnabled = false;
    await new Promise((r) => setTimeout(r, 1200));
    const f = sv.frame, pa = f.canvasPixelAngle;
    const W2C = f.worldToCam.elements, tanH = Math.tan(f.fovY / 2), asp = f.aspect;
    const inFrustum = (x, y, z, rb) => {
      const vx = W2C[0] * x + W2C[3] * y + W2C[6] * z, vy = W2C[1] * x + W2C[4] * y + W2C[7] * z, vz = W2C[2] * x + W2C[5] * y + W2C[8] * z;
      const w = -vz, tx = tanH * asp, ty = tanH;
      return !(w < -rb || Math.abs(vx) > w * tx + rb * Math.sqrt(1 + tx * tx) || Math.abs(vy) > w * ty + rb * Math.sqrt(1 + ty * ty));
    };
    const eR = f.ring.eR, eP = f.ring.ePhi, cam = f.ring.camLocal;
    const r0 = f.ring.r0 + cam.x;
    const tauMacro = (rm) => { const l = prof.local(rm); return l.tau * (1 - l.dust); };
    // the 2-D modulation of sv_ringStructure (sub-km texture, propellers) at a local-frame offset (lx, ly) from the
    // camera: the particles' presence follows tau0 M (CPU mirror, window.__sv.pipeline.ctx.structure)
    const st = sv.pipeline.ctx.structure, mo = [1, 0, 1];
    const tauMod = (lx, ly) => (st.tauModAt ? st.tauModAt(cam.x + lx, Math.atan2(cam.y + ly, f.ring.r0 + cam.x + lx), 0, mo)[0] : 1);
    // expected counts for every active class, then measure the largest
    const exp = [];
    for (const c of near.classes) {
      const k = c.k;
      if (!(c.slots > 0)) continue;
      const D = lod.box[k], lo = lod.aLo[k], hi = lod.aHi[k], q = lod.q, sig = lod.sigZ(k), p1 = 1 - q;
      let acc = 0;
      for (let n = 0; n < nMc; n++) {
        const lx = (2 * Math.random() - 1) * D, ly = (2 * Math.random() - 1) * D;
        const zz = sig * Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
        const a = Math.abs(p1) < 1e-9 ? lo * Math.pow(hi / lo, Math.random()) : Math.pow(lo ** p1 + (hi ** p1 - lo ** p1) * Math.random(), 1 / p1);
        const x = lx * eR.x + ly * eP.x, y = lx * eR.y + ly * eP.y, z = zz - cam.z;
        const s = Math.hypot(lx, ly, z);
        if (a / (s * pa) < 0.5 || !inFrustum(x, y, z, 1.2 * a)) continue;
        acc += tauMacro(r0 + lx) * tauMod(lx, ly);
      }
      exp.push({ k, D, lo, hi, slots: c.slots, row0: c.row0, rows: c.rows, expected: (lod.nPerTau[k] * (2 * D) ** 2 * acc) / nMc });
    }
    exp.sort((A, B) => B.expected - A.expected);
    const out = [];
    for (const e of exp.slice(0, nClasses)) {
      const buf = new Float32Array(2048 * e.rows * 4);
      sv.renderer.readRenderTargetPixels(near.r0RT, 0, e.row0, 2048, e.rows, buf);
      let meas = 0;
      for (let i = 0; i < e.slots; i++) {
        const w = buf[i * 4 + 3];
        if (!(w > 0)) continue;
        const s = Math.hypot(buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]);
        if (w / (s * pa) >= 0.5) meas++;
      }
      out.push({ ...e, measured: meas });
    }
    near.cullEnabled = true;
    return { classes: out, deficit: lod.deficit, capRadius: lod.capRadius, count: sv.pipeline.stats()['near.count'] };
  }, nClasses, nMc);
}

// --- in-page: the same frame with the occlusion cull off and on (HDR radiance per pixel, drawn counts)
async function cullCompare(page) {
  return page.evaluate(async () => {
    const sv = window.__sv, near = sv.pipeline.passes.near?.inner ?? sv.pipeline.passes.near;
    if (!near || !near.r0RT) return { error: 'near-field internals (r0RT) not found — update counts.mjs' };
    const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    // the draw-list cap follows the read-back list size: let it settle after every switch
    const settle = async () => { await frames(10); await new Promise((r) => setTimeout(r, 1500)); await frames(5); };
    const grab = () => {
      const rt = sv.pipeline.ctx.hdrRT, b = new Float32Array(rt.width * rt.height * 4);
      sv.renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, b);
      let drawn = 0;
      const pa = sv.frame.canvasPixelAngle;
      for (const c of near.classes) {
        if (!(c.slots > 0) || !c.active) continue;
        const r0 = new Float32Array(2048 * c.rows * 4);
        sv.renderer.readRenderTargetPixels(near.r0RT, 0, c.row0, 2048, c.rows, r0);
        for (let i = 0; i < c.slots; i++) {
          const w = r0[i * 4 + 3];
          if (w > 0 && w / (Math.hypot(r0[i * 4], r0[i * 4 + 1], r0[i * 4 + 2]) * pa) >= 0.5) drawn++;
        }
      }
      return { b, drawn };
    };
    const was = near.cullEnabled;
    try {
      near.cullEnabled = false; await settle();
      const A = grab();
      near.cullEnabled = true; await settle();
      const B = grab();
      let sa = 0, sb = 0, n5 = 0, n = 0;
      for (let i = 0; i < A.b.length; i += 4) {
        const la = 0.2126 * A.b[i] + 0.7152 * A.b[i + 1] + 0.0722 * A.b[i + 2], lb = 0.2126 * B.b[i] + 0.7152 * B.b[i + 1] + 0.0722 * B.b[i + 2];
        sa += la; sb += lb; n++;
        if (Math.abs(lb - la) > 0.05 * Math.max(la, 1e-12)) n5++;
      }
      return { ratio: sb / sa, changed: n5 / n, drawnOff: A.drawn, drawnOn: B.drawn };
    } finally {
      near.cullEnabled = was;
    }
  });
}

// --- in-page: radius / box sampler density check (mirror of nearRadiusBox in nearCommon.glsl)
function samplerCheck(page) {
  return page.evaluate(() => {
    const lod = window.__sv.pipeline.ctx.lod;
    const NP = lod.pieceP.length / (lod.box.length * 4), q = lod.q;
    const powInt = (lo, hi, p) => (hi <= lo ? 0 : Math.abs(p + 1) < 1e-9 ? Math.log(hi / lo) : (hi ** (p + 1) - lo ** (p + 1)) / (p + 1));
    const I2all = powInt(lod.aMin, lod.aMax, 2 - q);
    const res = [];
    for (let k = 0; k < lod.box.length; k++) {
      if (lod.slots[k] <= 0) continue;
      const P = lod.pieceP.subarray(k * NP * 4, (k + 1) * NP * 4), B = lod.pieceB.subarray(k * NP * 4, (k + 1) * NP * 4);
      const sample = (u) => {
        let i = 0, u0 = 0;
        for (let j = 0; j < NP - 1; j++) { if (u < P[j * 4 + 3]) break; u0 = P[j * 4 + 3]; i = j + 1; }
        const t = Math.min(1, Math.max(0, (u - u0) / Math.max(P[i * 4 + 3] - u0, 1e-30)));
        const s = P[i * 4 + 1] !== 0 ? Math.pow(P[i * 4 + 2] + (1 - P[i * 4 + 2]) * t, P[i * 4 + 1]) : Math.exp((1 - t) * P[i * 4 + 2]);
        return [P[i * 4] * s, Math.max(B[i * 4] * Math.pow(s, B[i * 4 + 1]), 0.05)];
      };
      const N = 400000, NB = 8, lo = lod.aLo[k], hi = lod.aHi[k];
      const cnt = new Float64Array(NB), dsum = new Float64Array(NB);
      for (let n = 0; n < N; n++) {
        const [a, D] = sample((n + 0.5) / N);
        const b = Math.min(NB - 1, Math.max(0, Math.floor((Math.log(a / lo) / Math.log(hi / lo)) * NB)));
        cnt[b]++;
        dsum[b] += 1 / (4 * D * D);
      }
      const ratios = [];
      for (let b = 0; b < NB; b++) {
        const a0 = lo * (hi / lo) ** (b / NB), a1 = lo * (hi / lo) ** ((b + 1) / NB);
        const have = (lod.count[k] / N) * dsum[b];
        const want = (lod.tauMax[k] * powInt(a0, a1, -q)) / (Math.PI * I2all);
        ratios.push(cnt[b] > 0 && want > 0 ? have / want : null);
      }
      res.push({ k, lo, hi, box: lod.box[k], ratios });
    }
    return { capped: Number.isFinite(lod.capRadius), capRadius: lod.capRadius, classes: res };
  });
}

await withHarness('counts', { usage: 'node scripts/test/counts.mjs [--base URL] [--out DIR] [--places a,b] [--classes N] [--mc N] [--heights 100,1000,5000] [--cull-views a,b]' }, async ({ args, rep, base, browser }) => {
  const places = args.list('places', ['a-ring-30m', 'a-ring-1km', 'cassini-division']);
  const nClasses = args.num('classes', 4), nMc = args.num('mc', 400000);
  const rows = [];
  let samplerDone = false;
  for (const place of places) {
    console.log(`\n[counts] ${place}`);
    const res = await retry(async () => {
      const { page } = await openApp(browser, base, { ...BASE_PARAMS, preset: place }, { settle: 2000 });
      try {
        const r = await countClasses(page, nClasses, nMc);
        if (!samplerDone && !r.error) { r.sampler = await samplerCheck(page); samplerDone = true; }
        return r;
      } finally {
        await page.close();
      }
    }, { label: place });
    if (res.error) { rep.check(`${place}: setup`, false, res.error); continue; }
    rep.check(`${place}: HUD count line`, String(res.count).startsWith('complete'), String(res.count));
    for (const c of res.classes) {
      const ratio = c.measured / c.expected;
      const tol = Math.max(4 / Math.sqrt(Math.max(c.expected, 1)), 0.04);
      rows.push([place, c.k, `${fmt(c.lo * 100, 2)}-${fmt(c.hi * 100, 2)} cm`, fmt(c.D, 0), c.measured, fmt(c.expected, 0), fmt(ratio, 3), `+-${fmt(tol, 3)}`]);
      if (c.expected < 300) { console.log(`  class ${c.k}: ${c.measured} drawn vs ${fmt(c.expected, 0)} expected (too few to test)`); continue; }
      rep.range(`${place}: class ${c.k} drawn >= 1 px / expected`, ratio, 1 - tol, 1 + tol);
    }
    if (res.sampler) {
      const s = res.sampler;
      const all = s.classes.flatMap((c) => c.ratios.filter((x) => x !== null));
      const worst = all.reduce((m, x) => Math.max(m, Math.abs(x - 1)), 0);
      console.log(`  radius sampler (${s.classes.length} classes, ${all.length} radius bins): max |ratio - 1| = ${fmt(worst, 4)}${s.capped ? ` (slot cap binds at ${fmt(s.capRadius, 0)} m)` : ''}`);
      if (!s.capped) rep.range(`${place}: radius sampler density (max |ratio - 1| over bins)`, worst, 0, 0.02);
      rep.data.sampler = s;
    }
  }
  console.log(`\n${table(['place', 'class', 'radii', 'box m', 'drawn', 'expected', 'ratio', 'tolerance'], rows)}`);
  rep.data.counts = rows;

  // ---- the HUD must state the count status honestly at every height above the dense B ring
  const heights = args.list('heights', ['100', '1000', '5000']).map(Number);
  const hrows = [];
  for (const z of heights) {
    const r = await retry(async () => {
      const { page } = await openApp(browser, base, { ...BASE_PARAMS, cam: 'ring', r: 105000e3, z, yaw: 0, pitch: -35 }, { settle: 2500 });
      try {
        return await page.evaluate(() => {
          const sv = window.__sv, st = sv.pipeline.stats(), lod = sv.pipeline.ctx.lod;
          return { count: String(st['near.count']), drawn: String(st['near.drawn']), alloc: String(st['near.allocated']), deficit: lod.deficit, active: lod.active };
        });
      } finally {
        await page.close();
      }
    }, { label: `B ring z=${z}` });
    hrows.push([z, r.drawn, r.alloc.slice(0, 60), r.count.slice(0, 90)]);
    const ok = r.count.startsWith('complete') || /^DEFICIT: ~\d/.test(r.count);
    rep.check(`B ring ${z} m above: HUD count line states the count status`, ok, r.count);
    await sleep(100);
  }
  console.log(`\n${table(['B ring z m', 'drawn', 'allocated', 'count'], hrows)}`);
  rep.data.heights = hrows;

  // ---- the statistical-occlusion cull removes only what the layer hides
  const crows = [];
  for (const v of args.list('cull-views', ['b-ring-inside', 'a-ring-inside', 'a-ring-30m'])) {
    const r = await retry(async () => {
      const { page } = await openApp(browser, base, { ...BASE_PARAMS, preset: v, scale: 1 }, { settle: 2500 });
      try { return await cullCompare(page); } finally { await page.close(); }
    }, { label: `cull ${v}` });
    if (r.error) { rep.check(`cull ${v}: setup`, false, r.error); continue; }
    crows.push([v, r.drawnOff, r.drawnOn, fmt(r.ratio, 5), `${fmt(100 * r.changed, 3)} %`]);
    rep.range(`cull ${v}: mean radiance cull on / off (same particles)`, r.ratio, 0.995, 1.005);
    rep.range(`cull ${v}: share of pixels changed by > 5 %`, r.changed, 0, 0.005);
    rep.data[`cull-${v}`] = r;
  }
  console.log(`\n${table(['cull view', 'drawn >= 1 px, cull off', 'cull on', 'radiance on / off', 'pixels changed > 5 %'], crows)}`);
});
