#!/usr/bin/env node
// Vertical relief of the rings: ONE height field z0 (bending waves, the 1983 C-ring corrugation, B-ring-edge region A /
// S/2009 S1, moonlet edge waves; src/rings/relief.ts + streamlines.ts, GLSL sv_ringRelief / sv_ringReliefShade,
// docs/ring-physics.md section 10) that every renderer takes heights relative to.
//   model (Node, the TypeScript sources imported directly):
//     1. Mimas 5:3 peak height = 450 m (calibration) and maximum slope 7..11 deg (observed ~10 deg); Titan -1:0 maximum
//        slope 45 deg (calibration) with |h| 500..1500 m 10..30 km from the resonance; the wave tables' phase advance
//        between 4 W and 12 W from the resonance vs the WKB dispersion relation k = |D' x| / (2 pi G Sigma): +-1 %;
//     2. the corrugation's radial wavenumber = (t - t_impact) |d(Omega - nu)/dr| (analytic derivative vs a numerical
//        one): +-0.5 %;
//     3. region A at the PIA11668 frame time lies inside the frame's ring footprint (165.8..168.4 deg).
//   GPU vs CPU mirror (looking straight up at the sheet, near field and wakes off, render scale 1; ring-layer debug
//   views 23 = (r - r0, azimuth - phi0, z of the ray at the hit), 24 = (z0, relief sun visibility, mu0), 26 = (footprint,
//   slopes)) in six views -- Mimas 5:3 and Titan -1:0 bending waves, the C-ring corrugation, region A at the 2009
//   equinox, the Keeler gap (Daphnis' edge waves), the giant propeller Bleriot: per pixel the rendered mid-plane height
//   and slopes vs window.__sv.pipeline.ctx.structure.streamAt(dr, dth, fp, true) at the same point and footprint:
//     4. |z0_GPU - z0_CPU| <= 1 m + 1 % of the view's max |z0|; slopes within 0.002 + 2 % of the max slope;
//     5. ray / height-field intersection: the horizontal error |z0 - z_ray| tan(view zenith angle) at the hit <= 0.3
//        footprints + 2 m (the search is skipped exactly when the relief moves the hit by less) for >= 99.5 % of pixels;
//     Bleriot: the relief at the moonlet (CPU) = its Table S3 height (430 m) toward the Sun's side within 1 %, the
//     rendered max |z0| 80..105 % of it (prefiltered, pixel sampling);
//   6. equinox shadow: S/2009 S1 (150 m, Spitale & Porco 2010) at its NAC frame time (Sun 0.24 deg): the rendered shadow
//      (relief visibility < 0.5 along the anti-Sun axis) ends at h / tan B = 35.8 km within 3 %, fully dark halfway;
//   7. near field inside the Mimas 5:3 wave (30 m above the local mid-plane, which lies hundreds of m off the SEF
//      plane): drawn particles sit at the local mid-plane (99 % of |z - z0| <= 40 m, the layer's vertical scatter),
//      the relief varies across them (z0 spread >= 50 m), the HUD height is 30 m above the mid-plane; station keeping:
//      after 6,000 s of simulated time at warp 3000 (the mid-plane under the camera moves by >= 20 m) the camera is still
//      30 m above it; the same beside Bleriot (2 r_H outside its orbit, 0.3 dB downstream: the propellers' relief in
//      the near field; z0 spread >= 30 m, no warp);
//   8. no NaN / negative pixels in sceneRT / hdrRT (normal render), no console / GL errors, passes ok.
// usage: node scripts/test/relief.mjs [--base URL] [--out DIR] [--only model,gpu,shadow,near] [--views mimas53,titan,cring,region-a,keeler,propeller]
import { join } from 'node:path';
import { orbitalFrequencies } from '../../src/core/constants.ts';
import { BENDING_WAVES, CORRUGATION, REGION_A, RingRelief, buildWaveTable, sampleWave, tFromIso } from '../../src/rings/relief.ts';
import { fmt, openApp, problems, renderTargetScan, sleep, table, withHarness } from './lib.mjs';

const DEG = Math.PI / 180;
const G = 6.674e-11;
const T_WAVES = '2026-11-08T12:00:00Z';
const T_PIA11668 = '2009-07-26T09:57:40.704Z';
const T_S2009S1 = '2009-07-26T11:30:49.665Z';

// GPU views: cam=ring below the ring plane looking up (yaw 90: azimuth horizontal), z relative to the local mid-plane
const VIEWS = [
  { id: 'mimas53', t: T_WAVES, rKm: 131_860.2, phiDeg: 31, hKm: 30, what: 'Mimas 5:3 bending wave, 40 km inside r_V' },
  { id: 'titan', t: T_WAVES, rKm: 77_545.5, phiDeg: 31, hKm: 10, what: 'Titan -1:0 nodal bending wave, 20 km outside r_V' },
  { id: 'cring', t: T_WAVES, rKm: 80_000, phiDeg: 31, hKm: 20, what: 'C-ring corrugation (m = 1 spiral + m = 0 / 2 ripples)' },
  { id: 'region-a', t: T_PIA11668, rKm: 117_555, phiDeg: 168.22, hKm: 150, what: 'B-ring edge region A (PIA11668 epoch)' },
  { id: 'keeler', t: T_WAVES, moon: 635, hKm: 100, what: 'Keeler gap: Daphnis vertical edge waves' },
  // the propeller Bleriot at the Tiscareno et al. 2010 Fig. 1b epoch (its relief: 430 m toward the Sun, south then)
  { id: 'propeller', t: '2008-04-12T08:00:00Z', giant: 'Bleriot', hKm: 25, what: 'giant propeller Bleriot (propellers relief)' },
];

await withHarness('relief', { usage: 'node scripts/test/relief.mjs [--base URL] [--out DIR] [--only model,gpu,shadow,near] [--views id,..]' }, async ({ args, out, rep, base, browser }) => {
  const only = args.list('only', ['model', 'gpu', 'shadow', 'near']);
  const want = args.list('views', VIEWS.map((v) => v.id));
  const common = { paused: 1, hud: 0, labels: 0, astronaut: 0, nearField: 0, wakes: 0, scale: 1, fps: 0 };

  // ------------------------------------------------------------------------------------------- 1-3. the model
  if (only.includes('model')) {
    const rows = [];
    for (const d of BENDING_WAVES) {
      const T = buildWaveTable(d, orbitalFrequencies);
      const w = [0, 0, 0, 0];
      // phase advance of the wave train between 4 W and 12 W from the resonance vs the WKB dispersion relation
      // k = |D'| |x| / (2 pi G Sigma) (the exact linear profile's local wavenumber oscillates by a few % around it: the
      // non-propagating near-resonance response beats with the wave; the advance over ~10 cycles is what defines lambda)
      const x1 = T.side * 4 * T.W, x2 = T.side * 12 * T.W;
      sampleWave(T, x1, w);
      const p1 = w[1];
      sampleWave(T, x2, w);
      const p2 = w[1];
      const dPhiWKB = (Math.abs(T.dD) * (x2 * x2 - x1 * x1)) / (4 * Math.PI * G * d.sigma);
      const ratio = Math.abs(p2 - p1) / dPhiWKB;
      rep.range(`model: ${d.name} phase advance 4..12 W / WKB`, ratio, 0.99, 1.01);
      rows.push([d.name, fmt(T.rV / 1e3, 1), fmt(T.W / 1e3, 1), fmt(T.xD / 1e3, 1), fmt(T.AV, 0), fmt(T.peak, 0), fmt(T.peakX / 1e3, 1), fmt(T.maxSlope / DEG, 1), fmt((ratio - 1) * 100, 2)]);
      if (d.id === 'mimas53') {
        rep.range('model: Mimas 5:3 peak height (calibrated to the VIMS ~450 m)', T.peak, 445, 455, ' m');
        rep.range('model: Mimas 5:3 maximum slope (observed ~10 deg)', T.maxSlope / DEG, 7, 11, ' deg');
      }
      if (d.id === 'titan10') {
        rep.range('model: Titan -1:0 maximum slope (calibrated: ~45 deg, Sega & Stewart 2022)', T.maxSlope / DEG, 44, 46, ' deg');
        for (const xk of [10, 20, 30]) {
          sampleWave(T, T.side * xk * 1e3, w);
          rep.range(`model: Titan -1:0 |h| ${xk} km from r_V (500..1500 m)`, w[0], 500, 1500, ' m');
        }
      }
    }
    console.log(`\n${table(['wave', 'r_V km', 'W km', 'x_D km', 'A_V m', 'peak m', 'at km', 'max slope deg', 'phase/WKB-1 %'], rows)}\n`);
    // corrugation wavenumber: analytic d(Omega - nu)/dr (as the GLSL) vs numerical
    const rel = new RingRelief(orbitalFrequencies);
    const t09 = tFromIso('2009-08-11T00:00:00Z');
    let worstK = 0;
    const crow = [];
    for (const rKm of [75_000, 80_000, 86_000, 90_000]) {
      const r = rKm * 1e3, h = 5;
      const kNum = Math.abs((rel.nodalRate(r + h) - rel.nodalRate(r - h)) / (2 * h)) * (t09 - CORRUGATION.tImpact);
      const kAn = Math.abs(rel.nodalRateDeriv(r)) * (t09 - CORRUGATION.tImpact);
      worstK = Math.max(worstK, Math.abs(kAn / kNum - 1));
      crow.push(`${rKm / 1e3}k km ${fmt((2 * Math.PI) / kAn / 1e3, 1)} km`);
    }
    rep.range('model: corrugation wavenumber, analytic / numerical d(Omega - nu)/dr', 1 + worstK, 1, 1.005);
    console.log(`  corrugation (m = 1) wavelength on 2009-08-11: ${crow.join(', ')}`);
    const lonA = ((((REGION_A.lon0 + REGION_A.n * (tFromIso(T_PIA11668) - REGION_A.t0)) / DEG) % 360) + 360) % 360;
    rep.range('model: region A centre at the PIA11668 frame time (frame footprint 165.8..168.4 deg)', lonA, 165.8, 168.4, ' deg');
    rep.data.model = { rows, corrugation: crow, regionALon: lonA };
  }

  // ------------------------------------------------------------------------------------------- 4-5, 8. GPU vs CPU
  if (only.includes('gpu')) {
    let moons = null;
    const rows = [];
    for (const v of VIEWS.filter((x) => want.includes(x.id))) {
      let rC = v.rKm * 1e3, phi = v.phiDeg * DEG;
      if (v.moon) {
        if (!moons) {
          const probe = await openApp(browser, base, { ...common, t: v.t, preset: 'overview' }, { settle: 300 });
          moons = await probe.page.evaluate(() => Object.fromEntries(window.__sv.frame.moons.map((m) => [m.id, { r: Math.hypot(m.pos.x, m.pos.y), phi: Math.atan2(m.pos.y, m.pos.x) }])));
          await probe.page.close();
        }
        rC = moons[v.moon].r;
        phi = moons[v.moon].phi;
      }
      if (v.giant) {
        const probe = await openApp(browser, base, { ...common, t: v.t, preset: 'overview' }, { settle: 300 });
        const g = await probe.page.evaluate((n) => {
          const sv = window.__sv, st = sv.pipeline.ctx.structure, m = st.propellers.giant(n);
          return { r: m.a, phi: m.theta, Z: m.Z, zc: st.midPlaneAtSEF(m.a, m.theta), sun: Math.sign(sv.frame.sunDir.z) };
        }, v.giant);
        await probe.page.close();
        rC = g.r;
        phi = g.phi;
        v.g = g;
        // the relief at the moonlet (CPU, unfiltered) = its Table S3 height toward the Sun's side (the sunlit half of
        // the stirred region's thickening)
        rep.range(`${v.id}: relief at the moonlet (CPU) x sign(Sun's elevation) / Z (Table S3)`, (g.zc * g.sun) / g.Z, 0.99, 1.01);
      }
      const params = { ...common, t: v.t, cam: 'ring', r: rC.toFixed(1), phi: (phi / DEG).toFixed(7), z: (-v.hKm * 1e3).toFixed(0), yaw: 90, pitch: 89.5, fov: 50 };
      const { page, errs } = await openApp(browser, base, params, { settle: 2500 });
      try {
        const scan = await renderTargetScan(page);
        const res = await page.evaluate(gpuVsCpu);
        await page.screenshot({ path: join(out, `${v.id}.png`) });
        const pr = await problems(page, errs);
        rep.check(`${v.id}: clean (errors, GL, passes)`, pr.length === 0, pr.slice(0, 3).join(' | ') || 'none');
        const bad = scan.sceneRT.nan + scan.sceneRT.neg + scan.hdrRT.nan + scan.hdrRT.neg;
        rep.check(`${v.id}: no NaN / negative pixels`, bad === 0, `scene ${scan.sceneRT.nan}/${scan.sceneRT.neg}, hdr ${scan.hdrRT.nan}/${scan.hdrRT.neg} ${scan.hdrRT.examples.join(' ')}`);
        rep.range(`${v.id}: sheet pixels compared`, res.n, 1000, 1e9);
        rep.range(`${v.id}: max |z0 GPU - CPU|`, res.dzMax, 0, 1 + 0.01 * res.zAbsMax, ' m');
        rep.range(`${v.id}: max |slope GPU - CPU|`, res.dsMax, 0, 0.002 + 0.02 * res.sAbsMax);
        rep.range(`${v.id}: pixels whose hit is off by > 0.3 footprints + 2 m`, res.hitBadFrac, 0, 0.005);
        if (v.id === 'mimas53' || v.id === 'titan') rep.range(`${v.id}: relief in view (max |z0|)`, res.zAbsMax, 100, 2000, ' m');
        if (v.id === 'region-a') rep.range(`${v.id}: relief in view (max |z0|)`, res.zAbsMax, 300, 3600, ' m');
        // (the giant's Table S3 height, prefiltered and sampled by the pixels: >= 80 %)
        if (v.giant) rep.range(`${v.id}: relief in view (max |z0|) / Z (Tiscareno et al. 2010 Table S3)`, res.zAbsMax / v.g.Z, 0.8, 1.05);
        rows.push([v.id, res.n, fmt(res.fpMed, 1), fmt(res.zAbsMax, 1), fmt(res.dzMax, 3), fmt(res.dzRms, 3), fmt(res.sAbsMax, 4), fmt(res.dsMax, 5), fmt(res.hitErrMax, 2), fmt(res.hitBadFrac * 100, 3)]);
        if (res.worst) console.log(`  ${v.id}: largest height difference at pixel (${res.worst.x}, ${res.worst.y}): dr ${fmt(res.worst.dr, 1)} m, dth ${fmt(res.worst.dth, 7)}, z0 GPU ${fmt(res.worst.z0GPU, 2)} / CPU ${fmt(res.worst.z0CPU, 2)} m (CPU a' - r ${fmt(res.worst.da, 1)} m, J ${fmt(res.worst.J, 3)}, footprint ${fmt(res.worst.fp, 1)} m)`);
        rep.data[v.id] = { params, what: v.what, ...res };
      } finally {
        await page.close();
      }
      await sleep(200);
    }
    console.log(`\n${table(['view', 'pixels', 'fp m', 'max |z0| m', 'max dz m', 'rms dz m', 'max slope', 'max dslope', 'max hit err / fp', 'bad hits %'], rows)}\n`);
  }

  // ------------------------------------------------------------------------------------------- 6. equinox shadow
  if (only.includes('shadow')) {
    const params = { ...common, t: T_S2009S1, cam: 'ring', r: '116914000', phi: '144.4', z: '-60000', yaw: 90, pitch: 89.5, fov: 50 };
    const { page, errs } = await openApp(browser, base, params, { settle: 2500 });
    try {
      const res = await page.evaluate(shadowProfile);
      await page.screenshot({ path: join(out, 's2009s1.png') });
      const pr = await problems(page, errs);
      rep.check('s2009s1: clean (errors, GL, passes)', pr.length === 0, pr.slice(0, 3).join(' | ') || 'none');
      console.log(`  S/2009 S1: h ${fmt(res.h, 1)} m, Sun elevation ${fmt(res.Bdeg, 4)} deg, expected h / tan B = ${fmt(res.Lexp / 1e3, 2)} km; rendered ${fmt(res.L / 1e3, 2)} km (axis samples ${res.n}, footprint ${fmt(res.fp, 0)} m); visibility halfway ${fmt(res.visHalf, 3)}`);
      rep.range('s2009s1: shadow length / (h / tan B)', res.L / res.Lexp, 0.97, 1.03);
      rep.range('s2009s1: relief sun visibility halfway along the shadow', res.visHalf, 0, 0.1);
      rep.data.s2009s1 = res;
    } finally {
      await page.close();
    }
  }

  // ------------------------------------------------------------------------------------------- 7. near field
  if (only.includes('near')) {
    const params = { t: T_WAVES, paused: 1, hud: 0, labels: 0, astronaut: 0, scale: 1, fps: 0, cam: 'ring', r: '131850000', phi: '31', z: '30', yaw: 0, pitch: -10, fov: 60 };
    const { page, errs } = await openApp(browser, base, params, { settle: 3500 });
    try {
      const res = await page.evaluate(nearProfile);
      await page.screenshot({ path: join(out, 'near-mimas53.png') });
      const pr = await problems(page, errs);
      rep.check('near: clean (errors, GL, passes)', pr.length === 0, pr.slice(0, 3).join(' | ') || 'none');
      console.log(`  near (Mimas 5:3, 30 m above the local mid-plane at ${fmt(res.zMid, 1)} m): ${res.n} drawn particles sampled, z0 under them ${fmt(res.z0Lo, 1)} .. ${fmt(res.z0Hi, 1)} m, |z - z0| median ${fmt(res.dMed, 2)} m, 99 % ${fmt(res.d99, 2)} m (|z - zMid(camera)| 99 %: ${fmt(res.dFlat99, 1)} m); HUD z ${fmt(res.hudZ, 2)} m; after warp: mid-plane moved ${fmt(res.zMidMoved, 1)} m, HUD z ${fmt(res.hudZ2, 3)} m`);
      rep.range('near: drawn particles sampled', res.n, 1000, 1e9);
      rep.range('near: 99 % of |z_particle - z0(x, y)|', res.d99, 0, 40, ' m');
      rep.range('near: spread of z0 under the drawn particles', res.z0Hi - res.z0Lo, 50, 2000, ' m');
      rep.range('near: HUD height above the local mid-plane', res.hudZ, 29.5, 30.5, ' m');
      rep.range('near: station keeping -- local mid-plane moved under the camera (warp 3000)', Math.abs(res.zMidMoved), 20, 2000, ' m');
      rep.range('near: station keeping -- HUD height above the local mid-plane afterwards', res.hudZ2, 29.5, 30.5, ' m');
      rep.data.near = res;
    } finally {
      await page.close();
    }
    // beside Bleriot (the propellers' relief in the near field: hash-grid classes' mask, the presence / relief pass):
    // 30 m above the local mid-plane, 2 r_H outside the moonlet's orbit, 0.3 dB downstream (z0 there ~0.55 Z, falling
    // off radially by ~120 m per km)
    const tP = VIEWS.find((x) => x.id === 'propeller').t;
    const probe = await openApp(browser, base, { ...common, t: tP, preset: 'overview' }, { settle: 300 });
    const g = await probe.page.evaluate(() => { const m = window.__sv.pipeline.ctx.structure.propellers.giant('Bleriot'); return { a: m.a, theta: m.theta, h: m.h, dB: m.dB, Z: m.Z }; });
    await probe.page.close();
    const pP = { t: tP, paused: 1, hud: 0, labels: 0, astronaut: 0, scale: 1, fps: 0, cam: 'ring', r: (g.a + 2 * g.h).toFixed(1), phi: ((g.theta - (0.3 * g.dB) / g.a) / DEG).toFixed(7), z: '30', yaw: 0, pitch: -10, fov: 60 };
    const pg = await openApp(browser, base, pP, { settle: 3500 });
    try {
      const res = await pg.page.evaluate(nearProfile, false);
      await pg.page.screenshot({ path: join(out, 'near-bleriot.png') });
      const pr = await problems(pg.page, pg.errs);
      rep.check('near-propeller: clean (errors, GL, passes)', pr.length === 0, pr.slice(0, 3).join(' | ') || 'none');
      console.log(`  near (beside Bleriot, Z ${fmt(g.Z, 0)} m, 30 m above the local mid-plane at ${fmt(res.zMid, 1)} m): ${res.n} drawn particles sampled, z0 under them ${fmt(res.z0Lo, 1)} .. ${fmt(res.z0Hi, 1)} m, |z - z0| median ${fmt(res.dMed, 2)} m, 99 % ${fmt(res.d99, 2)} m (|z - zMid(camera)| 99 %: ${fmt(res.dFlat99, 1)} m); HUD z ${fmt(res.hudZ, 2)} m`);
      rep.range('near-propeller: drawn particles sampled', res.n, 1000, 1e9);
      rep.range('near-propeller: 99 % of |z_particle - z0(x, y)|', res.d99, 0, 40, ' m');
      rep.range('near-propeller: spread of z0 under the drawn particles', res.z0Hi - res.z0Lo, 30, 1000, ' m');
      rep.range('near-propeller: HUD height above the local mid-plane', res.hudZ, 29.5, 30.5, ' m');
      rep.data.nearPropeller = { params: pP, ...res };
    } finally {
      await pg.page.close();
    }
  }
});

// ---------------------------------------------------------------------------------------------- in-page functions
/** Debug views 23 / 24 / 26 vs the CPU mirror at every 3rd pixel. */
async function gpuVsCpu() {
  const sv = window.__sv;
  const frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const rt = sv.pipeline.ctx.hdrRT;
  const w = rt.width, h = rt.height;
  const read = async (d) => {
    sv.frame.settings.debugView = d;
    await frames(4);
    const b = new Float32Array(w * h * 4);
    sv.renderer.readRenderTargetPixels(rt, 0, 0, w, h, b);
    return b;
  };
  const b23 = await read(23), b24 = await read(24), b26 = await read(26);
  sv.frame.settings.debugView = 0;
  await frames(2);
  const st = sv.pipeline.ctx.structure;
  const cam = sv.frame.camPos;
  const r0 = st.r0, phi0 = st.phi0;
  const sp = { da: 0, J: 1, drda: 1, tauMod: 1, zeta: 0, slopeR: 0, slopeT: 0 };
  let n = 0, dzMax = 0, dz2 = 0, zAbsMax = 0, dsMax = 0, sAbsMax = 0, hitBad = 0, hitErrMax = 0, worst = null;
  const fps = [];
  for (let y = 1; y < h; y += 3) {
    for (let x = 1; x < w; x += 3) {
      const k = (y * w + x) * 4;
      const fp = b26[k];
      if (!(fp > 0) || !Number.isFinite(b24[k])) continue;
      const dr = b23[k], dth = b23[k + 1], zRay = b23[k + 2], z0 = b24[k];
      st.streamAt(dr, dth, fp, true, sp);
      const dz = Math.abs(z0 - sp.zeta);
      n++;
      if (dz > dzMax) worst = { x, y, dr, dth, z0GPU: z0, z0CPU: sp.zeta, fp, da: sp.da, J: sp.J };
      dzMax = Math.max(dzMax, dz);
      dz2 += dz * dz;
      zAbsMax = Math.max(zAbsMax, Math.abs(sp.zeta));
      dsMax = Math.max(dsMax, Math.hypot(b26[k + 1] - sp.slopeR, b26[k + 2] - sp.slopeT));
      sAbsMax = Math.max(sAbsMax, Math.hypot(sp.slopeR, sp.slopeT));
      // horizontal error of the hit: the ray is at z_ray there, the surface at z0
      const r = r0 + dr, th = phi0 + dth;
      const hx = r * Math.cos(th) - cam.x, hy = r * Math.sin(th) - cam.y;
      const tanZ = Math.hypot(hx, hy) / Math.max(Math.abs(cam.z - zRay), 1);
      const e = Math.abs(z0 - zRay) * tanZ;
      hitErrMax = Math.max(hitErrMax, e / fp);
      if (e > 0.3 * fp + 2) hitBad++;
      if (n % 50 === 0) fps.push(fp);
    }
  }
  fps.sort((a, b) => a - b);
  return { n, dzMax, dzRms: Math.sqrt(dz2 / Math.max(n, 1)), zAbsMax, dsMax, sAbsMax, hitBadFrac: hitBad / Math.max(n, 1), hitErrMax, fpMed: fps.length ? fps[fps.length >> 1] : NaN, worst };
}

/** S/2009 S1's shadow along the anti-Sun axis (debug views 23 / 24 / 26). */
async function shadowProfile() {
  const sv = window.__sv;
  const frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const st = sv.pipeline.ctx.structure;
  const pk = st.relief.peaks[0];
  // the peak's material: Lagrangian (a', theta) -> Eulerian radius
  const aP = st.r0 + pk.aL, thP = st.phi0 + pk.dth;
  const rP = aP + st.xiAtSEF(aP, thP);
  const s = sv.frame.sunDir;
  const shl = Math.hypot(s.x, s.y);
  const tanB = Math.abs(s.z) / shl;
  // anti-Sun direction in the peak's (radial, azimuthal) axes
  const cr = (s.x * Math.cos(thP) + s.y * Math.sin(thP)) / shl, ct = (-s.x * Math.sin(thP) + s.y * Math.cos(thP)) / shl;
  const rt = sv.pipeline.ctx.hdrRT;
  const w = rt.width, h = rt.height;
  const read = async (d) => {
    sv.frame.settings.debugView = d;
    await frames(4);
    const b = new Float32Array(w * h * 4);
    sv.renderer.readRenderTargetPixels(rt, 0, 0, w, h, b);
    return b;
  };
  const b23 = await read(23), b24 = await read(24), b26 = await read(26);
  sv.frame.settings.debugView = 0;
  const bin = 200, bins = new Map();
  let fpS = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const fp = b26[k];
      if (!(fp > 0)) continue;
      const r = st.r0 + b23[k], th = st.phi0 + b23[k + 1];
      let dTh = th - thP;
      dTh = Math.atan2(Math.sin(dTh), Math.cos(dTh));
      const dR = r - rP, dT = rP * dTh;
      const along = -(dR * cr + dT * ct), perp = -dR * ct + dT * cr;
      if (along < 0 || Math.abs(perp) > Math.max(2 * fp, 60)) continue;
      // the shadow of a Gaussian peak tapers to its tip: per bin the darkest pixel across the axis (the axis itself)
      const i = Math.floor(along / bin);
      bins.set(i, Math.min(bins.get(i) ?? 1, b24[k + 1]));
      fpS += fp;
      n++;
    }
  }
  const prof = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([i, v]) => [(i + 0.5) * bin, v]);
  // the shadow's end: last crossing of 0.5 going outward
  let L = NaN;
  for (let j = prof.length - 1; j > 0; j--) {
    if (prof[j - 1][1] < 0.5 && prof[j][1] >= 0.5) {
      L = prof[j - 1][0] + ((0.5 - prof[j - 1][1]) / (prof[j][1] - prof[j - 1][1])) * (prof[j][0] - prof[j - 1][0]);
      break;
    }
  }
  // (the peaks rise toward the lit face: h < 0 while the Sun is south of the ring plane)
  const Lexp = Math.abs(pk.h) / tanB;
  const half = prof.filter((p) => Math.abs(p[0] - 0.5 * Lexp) < 1000).map((p) => p[1]);
  return { h: pk.h, Bdeg: (Math.atan(tanB) * 180) / Math.PI, Lexp, L, n, fp: fpS / Math.max(n, 1), visHalf: half.length ? Math.max(...half) : NaN, profile: prof.filter((_, j) => j % 10 === 0) };
}

/** Near-field particle heights vs the local mid-plane; HUD height; (warp) station keeping under time warp. */
async function nearProfile(warp = true) {
  const sv = window.__sv;
  const frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const st = sv.pipeline.ctx.structure;
  const near = sv.pipeline.passes.near.inner;
  const rt = near.r0RT;
  const cam = sv.frame.camPos.clone();
  const rows = Math.min(rt.height, 256);
  const b = new Float32Array(rt.width * rows * 4);
  sv.renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rows, b);
  const d = [], dFlat = [];
  let z0Lo = Infinity, z0Hi = -Infinity, n = 0;
  const zMid = sv.frame.ring.zMid;
  for (let i = 0; i < rt.width * rows; i += 7) {
    const k = 4 * i;
    if (!(b[k + 3] > 0)) continue;
    const x = cam.x + b[k], y = cam.y + b[k + 1], z = cam.z + b[k + 2];
    const z0 = st.midPlaneAtSEF(Math.hypot(x, y), Math.atan2(y, x));
    d.push(Math.abs(z - z0));
    dFlat.push(Math.abs(z - zMid));
    z0Lo = Math.min(z0Lo, z0);
    z0Hi = Math.max(z0Hi, z0);
    n++;
  }
  d.sort((p, q) => p - q);
  dFlat.sort((p, q) => p - q);
  const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN);
  const hudZ = sv.info().z;
  if (!warp) return { n, zMid, z0Lo, z0Hi, dMed: q(d, 0.5), d99: q(d, 0.99), dFlat99: q(dFlat, 0.99), hudZ };
  // station keeping: let the material (and the wave pattern) move for 6,000 s of simulated time at warp 3000 (however
  // long that takes at the current frame rate, at most 20 s), pause, settle
  const t0 = sv.frame.t;
  sv.setWarp(3000);
  for (let k = 0; k < 200 && sv.frame.t - t0 < 6000; k++) await new Promise((r) => setTimeout(r, 100));
  sv.setWarp(0);
  await frames(6);
  const zMid2 = sv.frame.ring.zMid;
  return { n, zMid, z0Lo, z0Hi, dMed: q(d, 0.5), d99: q(d, 0.99), dFlat99: q(dFlat, 0.99), hudZ, zMidMoved: zMid2 - zMid, hudZ2: sv.info().z };
}
