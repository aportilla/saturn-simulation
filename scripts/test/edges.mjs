#!/usr/bin/env node
// Gap edges perturbed by moonlets (Keeler gap: Daphnis, Encke gap: Pan) and the B-ring edge's normal modes, through
// the shared streamline map (sv_ringStructure / src/rings/streamlines.ts, ringModes.ts). Looks straight down with the
// far-field sheet, reads back the rendered optical depth per pixel (ring-layer debug view 7 = (r 1e-6, I/F, tau),
// view 9 = (.., theta)) and compares it with the CPU mirror of the model (window.__sv.pipeline.ctx.structure):
//   1. gap empty: pixels whose Lagrangian radius a'(r, theta) lies inside the unperturbed gap, > max(1.5 km, 3
//      footprints) from its edges, have tau <= 0.05 and at most 0.01 above the profile's own tau0(a') J there (gap
//      floor <= 0.015, dusty Encke-gap ringlets <= 0.025; the old Eulerian lookup put tau ~ 0.5 A-ring slivers along
//      the moonlet's orbit);
//   2. ring material: tau_rendered / (tau0(a') J) away from the edges, median 1 +- 0.05 (+- 0.15 for km footprints,
//      which prefilter the structured B ring);
//   3. edge displacement: per azimuth bin the rendered edge (half-level crossing) minus the unperturbed edge radius
//      vs the model xi(a'_edge, theta): RMS <= max(0.25 km, 1.5 footprints), max <= 0.75 km + 2 footprints, and the
//      range (peak-to-peak) of the rendered displacement within 0.85..1.15 of the model's where that is >=
//      max(1 km, 5 footprints);
//   4. the peak displacement of the outer Keeler edge in the first ~80 km behind Daphnis within 2.5 .. 4.0 km (the Hill
//      response at b = 3.5: asymptotic epicycle 3.53 km, first excursion ~3.1-3.2 km; linear theory 2.76 km);
//   5. B-ring outer edge (views b-edge-90 / b-edge-180 at 3,000 km): the de-projected profile has its edge at the mean
//      radius 117,568 km and |rendered displacement| / model is 0.9 .. 1.1 (checks 1-3 apply as well);
//   6. no NaN / negative pixels in sceneRT / hdrRT (normal render), no console / GL errors, passes ok;
//   7. near-crest: 30 m above material the map has moved ~2.8 km into the unperturbed gap: near-field particles are
//      drawn (>= 1000 >= 1 px; the boxes are Lagrangian) and vanish with straight edges (edgeWaveScale 0: the camera
//      is then over the gap), and near field + medium / medium alone in the lower half is 0.8 .. 1.25 -- checked
//      once nearDraw.vert.glsl lights particles through sv_ringStructure (ringSampleLocal), informational before.
// The sub-km texture and the propellers (the 2-D tau modulation of sv_ringStructure: structure.texture.amp = 0,
// structure.propellers.scale = 0) are switched off for checks 1-5, the near field too (sheet only).
// usage: node scripts/test/edges.mjs [--base URL] [--out DIR] [--t ISO] [--w 1280 --h 720]
//        [--views keeler-0,keeler-out,keeler-in,encke-out,encke-in,b-edge-90,b-edge-180,near-crest]
import { join } from 'node:path';
import { fmt, openApp, problems, renderTargetScan, sleep, table, waitFrames, withHarness } from './lib.mjs';

const T_DEFAULT = '2026-11-08T12:00:00Z';
// gap edges of the rendered profile (km): docs/ring-physics.md section 5 (measure_features.mjs)
const GAPS = {
  635: { name: 'Daphnis', gap: 'Keeler', edgesKm: [136_483, 136_523] },
  618: { name: 'Pan', gap: 'Encke', edgesKm: [133_424, 133_745] },
};
// Moonlet views: moon, centre radius ('moon' | 'inner' | 'outer' edge), downstream arc of the view centre (km; side by
// `side`). B-ring edge views (normal modes, src/rings/ringModes.ts): centre radius / longitude. Camera height (km);
// yaw 90: azimuth runs horizontally (the wide axis), radius vertically. `gapKm`: the gap's catalogued boundaries
// (refined to the profile's half-level crossings), `measure`: which of them carry modelled displacements.
const VIEWS = [
  { id: 'keeler-0', moon: 635, at: 'moon', side: 0, sDownKm: 0, hKm: 100, gapKm: GAPS[635].edgesKm, measure: ['inner', 'outer'] },
  { id: 'keeler-out', moon: 635, at: 'moon', side: 1, sDownKm: 160, hKm: 100, gapKm: GAPS[635].edgesKm, measure: ['inner', 'outer'] },
  { id: 'keeler-in', moon: 635, at: 'moon', side: -1, sDownKm: 160, hKm: 100, gapKm: GAPS[635].edgesKm, measure: ['inner', 'outer'] },
  { id: 'encke-out', moon: 618, at: 'outer', side: 1, sDownKm: 375, hKm: 300, gapKm: GAPS[618].edgesKm, measure: ['outer'] },
  { id: 'encke-in', moon: 618, at: 'inner', side: -1, sDownKm: 375, hKm: 300, gapKm: GAPS[618].edgesKm, measure: ['inner'] },
  // the B-ring outer edge (Huygens gap: B-ring edge at the mean radius 117,568 km .. the Huygens ringlet, 117,822 km
  // in the profile) where the 2026-11-08 modes move it out by ~72 km (90 deg) and in by ~77 km (180 deg)
  { id: 'b-edge-90', rKm: 117_568, lonDeg: 90, hKm: 3000, gapKm: [117_568, 117_822], measure: ['inner'] },
  { id: 'b-edge-180', rKm: 117_568, lonDeg: 180, hKm: 3000, gapKm: [117_568, 117_822], measure: ['inner'] },
];

await withHarness('edges', { usage: 'node scripts/test/edges.mjs [--base URL] [--out DIR] [--views id,..] [--t ISO]' }, async ({ args, out, rep, base, browser }) => {
  const t = args.str('t', T_DEFAULT);
  const want = args.list('views', [...VIEWS.map((v) => v.id), 'near-crest']);
  const common = { t, paused: 1, hud: 0, labels: 0, astronaut: 0, nearField: 0, wakes: 0, scale: 1, fps: 0 };

  // ---- the moons' positions at t
  const probe = await openApp(browser, base, { ...common, preset: 'overview' }, { settle: 500 });
  const moons = await probe.page.evaluate(() => {
    const o = {};
    for (const m of window.__sv.frame.moons) if (m.id === 618 || m.id === 635) o[m.id] = { r: Math.hypot(m.pos.x, m.pos.y), phi: Math.atan2(m.pos.y, m.pos.x) };
    return o;
  });
  await probe.page.close();

  const rows = [];
  for (const v of VIEWS.filter((x) => want.includes(x.id))) {
    let rC, phi, rRef;
    if (v.moon) {
      const m = moons[v.moon];
      rC = v.at === 'moon' ? m.r : v.at === 'inner' ? v.gapKm[0] * 1e3 : v.gapKm[1] * 1e3;
      phi = m.phi - (v.side * v.sDownKm * 1e3) / m.r;
      rRef = m.r;
    } else {
      rC = v.rKm * 1e3;
      phi = (v.lonDeg * Math.PI) / 180;
      rRef = rC;
    }
    const params = { ...common, cam: 'ring', r: rC.toFixed(1), phi: ((phi * 180) / Math.PI).toFixed(7), z: (-v.hKm * 1e3).toFixed(0), yaw: 90, pitch: 89.5, fov: 50 };
    const { page, errs } = await openApp(browser, base, params, { settle: 2500 });
    try {
      const scan = await renderTargetScan(page);
      const res = await page.evaluate(async (edgesKm, measure, rm) => {
        const sv = window.__sv;
        const frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
        const stc = sv.pipeline.ctx.structure;
        stc.texture.amp = 0;
        stc.propellers.scale = 0;
        const rt = sv.pipeline.ctx.hdrRT;
        const w = rt.width, h = rt.height;
        const read = async (dbg) => {
          sv.frame.settings.debugView = dbg;
          await frames(4);
          const b = new Float32Array(w * h * 4);
          sv.renderer.readRenderTargetPixels(rt, 0, 0, w, h, b);
          return b;
        };
        const b7 = await read(7), b9 = await read(9);
        sv.frame.settings.debugView = 0;
        stc.texture.amp = 1;
        stc.propellers.scale = 1;
        const st = sv.pipeline.ctx.structure, prof = sv.pipeline.ctx.profile;
        // unperturbed (Lagrangian) edge radii: half-level crossings of the profile next to the catalogued edges
        const tauKm = (rKm) => prof.tauAtKm(rKm);
        const meanTau = (a, b) => { let s = 0, n = 0; for (let x = a; x <= b; x += 0.25) { s += tauKm(x); n++; } return s / n; };
        const edgeAt = (rKm, dir) => {
          // dir = +1: ring outward of the edge (outer gap edge); -1: ring inward
          const ring = meanTau(rKm + dir * 2, rKm + dir * 5), gapF = meanTau(rKm - dir * 5, rKm - dir * 2);
          const half = 0.5 * (ring + gapF);
          for (let x = rKm - dir * 3; dir * (rKm + dir * 3 - x) > 0; x += dir * 0.05) {
            const a = tauKm(x), b = tauKm(x + dir * 0.05);
            if ((a - half) * (b - half) <= 0 && a !== b) return x + (dir * 0.05 * (half - a)) / (b - a);
          }
          return rKm;
        };
        const eIn = edgeAt(edgesKm[0], -1) * 1e3, eOut = edgeAt(edgesKm[1], 1) * 1e3;
        // radial footprint of the readback: the radial extent of the frame over its rows ~ the pixel size on the ring
        let r0 = Infinity, r1 = -Infinity;
        for (let i = 0; i < w * h; i++) { const r = b7[i * 4] * 1e6; if (r > 1e8) { r0 = Math.min(r0, r); r1 = Math.max(r1, r); } }
        const fpM = (r1 - r0) / h;
        const dEdgeMin = Math.max(1500, 3 * fpM);
        // per-pixel comparison
        let nGap = 0, gapMax = 0, gapExcess = 0, gap99 = [], ratios = [], nan = 0;
        const sp = { da: 0, J: 1, drda: 1, tauMod: 1, zeta: 0, slopeR: 0, slopeT: 0 };
        const samples = [];
        for (let y = 0; y < h; y += 2) {
          for (let x = 0; x < w; x += 2) {
            const k = (y * w + x) * 4;
            const r = b7[k] * 1e6, tau = b7[k + 2], th = b9[k + 2];
            if (!(r > 1e8)) continue;
            if (!Number.isFinite(tau) || !Number.isFinite(th)) { nan++; continue; }
            st.streamAtSEF(r, th, 0, false, sp);
            const aL = r + sp.da;
            const dEdge = Math.min(Math.abs(aL - eIn), Math.abs(aL - eOut));
            const inGap = aL > eIn && aL < eOut;
            if (inGap && dEdge > dEdgeMin) {
              nGap++;
              gapMax = Math.max(gapMax, tau);
              gap99.push(tau);
              // material beyond what the profile itself has at this Lagrangian radius (dusty gap ringlets are real)
              gapExcess = Math.max(gapExcess, tau - tauKm(aL / 1e3) * sp.J);
            }
            if (!inGap && dEdge > dEdgeMin) {
              const exp = tauKm(aL / 1e3) * sp.J;
              if (exp > 0.1) ratios.push(tau / exp);
            }
            samples.push([r, th, tau]);
          }
        }
        gap99.sort((a, b) => a - b);
        ratios.sort((a, b) => a - b);
        const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN);
        // edge displacement per azimuth bin: rendered half-level crossing vs model xi at the edge streamline
        let th0 = Infinity, th1 = -Infinity;
        for (const s of samples) { th0 = Math.min(th0, s[1]); th1 = Math.max(th1, s[1]); }
        const nb = Math.max(8, Math.min(160, Math.round(((th1 - th0) * rm) / 2000)));
        const bins = Array.from({ length: nb }, () => []);
        for (const s of samples) {
          const i = Math.min(nb - 1, Math.floor(((s[1] - th0) / (th1 - th0)) * nb));
          bins[i].push(s);
        }
        const fpKm = fpM / 1e3;
        const win = Math.max(8000, 30 * fpM), ringA = Math.max(2000, 3 * fpM), ringB = Math.max(5000, 8 * fpM), gapA = Math.max(1500, 3 * fpM);
        const edges = [];
        for (const [eL, dir, name] of [[eIn, -1, 'inner'], [eOut, 1, 'outer']]) {
          if (!measure.includes(name)) continue;
          const diffs = [], xr = [], xm = [];
          for (let i = 0; i < nb; i++) {
            const thB = th0 + ((i + 0.5) / nb) * (th1 - th0);
            const xiM = st.xiAtSEF(eL, thB);
            const eM = eL + xiM;
            const pts = bins[i].filter((s) => Math.abs(s[0] - eM) < win).sort((a, b) => a[0] - b[0]);
            if (pts.length < 20) continue;
            // ring level beyond the model edge, gap level before it
            const ringPts = pts.filter((s) => dir * (s[0] - eM) > ringA && dir * (s[0] - eM) < ringB).map((s) => s[2]);
            const gapPts = pts.filter((s) => dir * (eM - s[0]) > gapA && dir * (eM - s[0]) < ringB).map((s) => s[2]);
            if (ringPts.length < 3 || gapPts.length < 3) continue;
            const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
            const half = 0.5 * (med(ringPts) + med(gapPts));
            // crossing nearest to the model edge (walking from the gap side)
            let best = null;
            for (let j = 0; j + 1 < pts.length; j++) {
              const a = pts[j], b = pts[j + 1];
              if ((a[2] - half) * (b[2] - half) <= 0 && a[2] !== b[2] && dir * (b[2] - a[2]) * (b[0] - a[0]) > 0) {
                const rc = a[0] + ((half - a[2]) / (b[2] - a[2])) * (b[0] - a[0]);
                if (!best || Math.abs(rc - eM) < Math.abs(best - eM)) best = rc;
              }
            }
            if (best === null) continue;
            diffs.push(best - eM);
            xr.push(best - eL);
            xm.push(xiM);
          }
          const rms = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / Math.max(diffs.length, 1));
          const maxD = Math.max(0, ...diffs.map(Math.abs));
          const range = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
          const peak = (a) => (a.length ? Math.max(...a.map(Math.abs)) : 0);
          edges.push({ name, bins: diffs.length, rmsKm: rms / 1e3, maxKm: maxD / 1e3, rangeModelKm: range(xm) / 1e3, rangeRenderedKm: range(xr) / 1e3, peakModelKm: peak(xm) / 1e3, peakRenderedKm: peak(xr) / 1e3 });
        }
        return { w, h, nan, nGap, gapMax, gapExcess, gap99: q(gap99, 0.99), nRing: ratios.length, ratioMed: q(ratios, 0.5), ratio05: q(ratios, 0.05), ratio95: q(ratios, 0.95), fpKm, eInKm: eIn / 1e3, eOutKm: eOut / 1e3, edges };
      }, v.gapKm, v.measure, rRef);
      await page.screenshot({ path: join(out, `${v.id}.png`) });
      const pr = await problems(page, errs);
      rep.check(`${v.id}: clean (errors, GL, passes)`, pr.length === 0, pr.slice(0, 3).join(' | ') || 'none');
      const bad = scan.sceneRT.nan + scan.sceneRT.neg + scan.hdrRT.nan + scan.hdrRT.neg;
      rep.check(`${v.id}: no NaN / negative pixels`, bad === 0, `scene ${scan.sceneRT.nan}/${scan.sceneRT.neg}, hdr ${scan.hdrRT.nan}/${scan.hdrRT.neg} ${scan.hdrRT.examples.join(' ')}`);
      if (res.nGap > 50) {
        rep.range(`${v.id}: max tau inside the gap (> 1.5 km from the streamline edges)`, res.gapMax, 0, 0.05);
        rep.range(`${v.id}: max tau inside the gap above the profile's own tau0(a') J there`, res.gapExcess, -1, 0.01);
      }
      // (km footprints prefilter the structured B ring: the transmission-preserving tau_eff of a mix is below the mean)
      const rtol = res.fpKm < 1 ? 0.05 : 0.15;
      if (res.nRing > 50) rep.range(`${v.id}: median tau_rendered / (tau0(a') J) in the ring`, res.ratioMed, 1 - rtol, 1 + rtol);
      const fp = Math.max(res.fpKm, 0.05);
      for (const e of res.edges) {
        if (e.bins < 6) continue;
        rep.range(`${v.id}: ${e.name} edge RMS(rendered - model)`, e.rmsKm, 0, Math.max(0.25, 1.5 * fp), ' km');
        rep.range(`${v.id}: ${e.name} edge max |rendered - model|`, e.maxKm, 0, 0.75 + 2 * fp, ' km');
        // (only where the model's range is well above the measurement noise of ~1 footprint)
        if (e.rangeModelKm >= Math.max(1, 5 * fp)) rep.range(`${v.id}: ${e.name} edge displacement range rendered / model`, e.rangeRenderedKm / e.rangeModelKm, 0.85, 1.15);
        if (v.id.startsWith('b-edge')) rep.range(`${v.id}: |edge displacement| from the mean radius, rendered / model`, e.peakRenderedKm / Math.max(e.peakModelKm, 1e-3), 0.9, 1.1);
        if (v.id === 'keeler-0' && e.name === 'outer') rep.range('keeler-0: peak outer-edge displacement (first ~80 km behind Daphnis)', e.peakRenderedKm, 2.5, 4.0, ' km');
        rows.push([v.id, e.name, e.bins, fmt(e.peakModelKm, 2), fmt(e.peakRenderedKm, 2), fmt(e.rangeModelKm, 2), fmt(e.rangeRenderedKm, 2), fmt(e.rmsKm, 3), fmt(e.maxKm, 3)]);
      }
      rep.data[v.id] = { params, ...res, scan: { scene: scan.sceneRT, hdr: scan.hdrRT } };
      console.log(`  ${v.id}: footprint ${fmt(res.fpKm, 3)} km, unperturbed edges ${fmt(res.eInKm, 2)} / ${fmt(res.eOutKm, 2)} km, gap pixels ${res.nGap} (max tau ${fmt(res.gapMax, 4)}, 99% ${fmt(res.gap99, 4)}, max above the profile ${fmt(res.gapExcess, 4)}), ring pixels ${res.nRing} (ratio ${fmt(res.ratio05, 3)} / ${fmt(res.ratioMed, 3)} / ${fmt(res.ratio95, 3)})`);
    } finally {
      await page.close();
    }
    await sleep(200);
  }
  console.log(`\n${table(['view', 'edge', 'bins', 'peak model km', 'peak rendered km', 'range model km', 'range rendered km', 'rms km', 'max km'], rows)}`);

  // ---- near field at a displaced edge: 30 m above material that the streamline map has moved into the unperturbed
  // Keeler gap (the outer edge's first inward excursion behind Daphnis). The near-field boxes are Lagrangian, so
  // particles must be there with the map and absent with straight edges (edgeWaveScale 0); near field + medium must
  // match the medium alone (LOD contract at the edge; one realization, so a loose band).
  if (want.includes('near-crest')) {
    const m = moons[635];
    const pre = await openApp(browser, base, { ...common, preset: 'overview' }, { settle: 300 });
    // the most inward displacement of the outer edge streamline within 20..100 km behind Daphnis (CPU mirror)
    const crest = await pre.page.evaluate((rm, phim) => {
      const st = window.__sv.pipeline.ctx.structure;
      const eOut = 136_522.9e3;
      let best = { xi: 0, s: 0 };
      for (let s = 20e3; s <= 100e3; s += 1e3) {
        const xi = st.xiAtSEF(eOut, phim - s / rm);
        if (xi < best.xi) best = { xi, s };
      }
      return { ...best, r: eOut + 0.5 * best.xi, phi: phim - best.s / rm };
    }, m.r, m.phi);
    await pre.page.close();
    const p = { ...common, nearField: 1, cam: 'ring', r: crest.r.toFixed(1), phi: ((crest.phi * 180) / Math.PI).toFixed(7), z: -30, yaw: -60, pitch: 35, roll: 180, fov: 60 };
    // particles >= 1 px drawn (the stats line is only refreshed while the near field renders: 0 when it is inactive)
    const drawnOf = (page) => page.evaluate(() => {
      const sv = window.__sv;
      if (!sv.pipeline.ctx.lod.active) return 0;
      const x = String(sv.pipeline.stats()['near.drawn'] ?? '0').match(/^([\d.]+)(k|M)?/);
      return x ? Number(x[1]) * (x[2] === 'M' ? 1e6 : x[2] === 'k' ? 1e3 : 1) : 0;
    });
    // does the particle draw shader light particles with the material of their streamline? (nearDraw.vert.glsl is
    // owned by the particle-appearance work package: ringSampleIdx(ringIdxFromLocal(lp)) -> ringSampleLocal(lp))
    const drawUsesStructure = (page) => page.evaluate(() => {
      const near = window.__sv.pipeline.passes.near?.inner;
      const src = near?.ptMat?.vertexShader ?? '';
      return /ringSampleLocal\(\s*lp/.test(src);
    });
    const strip = [[0, 0.55, 1, 1]];
    const lum = (page) => page.evaluate((rects) => {
      const sv = window.__sv, rt = sv.pipeline.ctx.hdrRT, w = rt.width, h = rt.height, b = new Float32Array(w * h * 4);
      sv.renderer.readRenderTargetPixels(rt, 0, 0, w, h, b);
      const [x0, y0, x1, y1] = rects[0];
      let s = 0, n = 0;
      for (let yt = Math.floor(y0 * h); yt < Math.floor(y1 * h); yt++) for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x++) { const k = ((h - 1 - yt) * w + x) * 4; s += 0.2126 * b[k] + 0.7152 * b[k + 1] + 0.0722 * b[k + 2]; n++; }
      return s / n;
    }, strip);
    const a = await openApp(browser, base, p, { settle: 3000 });
    let withMap = 0, straight = 0, lNear = 0, lMed = 0, drawStruct = false;
    try {
      withMap = await drawnOf(a.page);
      drawStruct = await drawUsesStructure(a.page);
      lNear = await lum(a.page);
      await a.page.screenshot({ path: join(out, 'near-crest.png') });
      const pr = await problems(a.page, a.errs);
      rep.check('near-crest: clean (errors, GL, passes)', pr.length === 0, pr.slice(0, 3).join(' | ') || 'none');
      await a.page.evaluate(() => { window.__sv.pipeline.passes.rings.inner.edgeWaveScale = 0; });
      await sleep(2500);
      straight = await drawnOf(a.page);
      await a.page.screenshot({ path: join(out, 'near-crest-straight-edges.png') });
    } finally {
      await a.page.close();
    }
    const b = await openApp(browser, base, { ...p, nearField: 0 }, { settle: 3000 });
    try { lMed = await lum(b.page); } finally { await b.page.close(); }
    console.log(`  near-crest: camera r = ${fmt(crest.r / 1e3, 3)} km, ${fmt(crest.s / 1e3, 0)} km behind Daphnis (edge displaced ${fmt(crest.xi / 1e3, 2)} km); drawn >= 1 px: ${withMap} with the map, ${straight} with straight edges; lower-half radiance near+medium ${fmt(lNear, 4)} vs medium ${fmt(lMed, 4)}`);
    rep.range('near-crest: particles >= 1 px drawn over displaced material', withMap, 1000, 1e9);
    rep.range('near-crest: drawn with straight edges / with the map (the camera is then over the gap)', straight / Math.max(withMap, 1), 0, 0.05);
    const ratio = lNear / lMed;
    if (drawStruct) rep.range('near-crest: radiance near field + medium / medium alone (lower half)', ratio, 0.8, 1.25);
    else {
      // informational until nearDraw.vert.glsl samples the profile through sv_ringStructure: it lights particles
      // with the unperturbed profile at their DISPLACED position (here: the empty gap -> unshadowed, ~2.4x too bright;
      // 1.11 with the one-line change)
      console.log(`  INFO near-crest: radiance near+medium / medium = ${fmt(ratio, 3)} -- not checked: nearDraw.vert.glsl still uses ringSampleIdx(ringIdxFromLocal(lp)); with ringSampleLocal(lp) this becomes a check in 0.8 .. 1.25`);
    }
    rep.data.nearCrest = { crest, withMap, straight, lNear, lMed, ratio, drawUsesStructure: drawStruct };
  }
});
