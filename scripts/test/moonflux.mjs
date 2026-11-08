#!/usr/bin/env node
// Unresolved-moon flux vs the resolved rendering, for the measured small-moon shapes (src/moons/shapes.ts) and an
// ellipsoid control. A moon below ~1-2.5 px radius is drawn as a point source whose irradiance the far pass's flux
// step (src/render/far/MoonPoints.ts) integrates by tracing sunflower-sampled rays over the moon's bounding disk
// through the same shading as the resolved renderer; with measured shapes that disk must be r_max (Pan's and Atlas's
// ridges reach far beyond their IAU ellipsoids) and enough rays must hit the irregular silhouette.
// Per moon: a resolved view (~120 px radius, 10 deg fov, camera 70 deg below the ring plane so Saturn and the rings
// stay out of the frame; ring layer, near field and stars off), the moon's resolved/point cross-fade weight forced
// to 0.5 so the flux step runs; E_res = sceneRT radiance (far pass) integrated over the moon's bounding circle and
// divided by 0.5, E_flux = sum of the moon's flux-target row. Check |E_flux / E_res - 1| <= --tol for measured shapes
// (default 0.08: 256 rays over a silhouette filling ~40-90 % of its bounding disk, ~2-5 % rms) and <= --tol-ellipsoid
// for the ellipsoid control (default 0.10: the pre-existing 64-ray sampling, ~3-7 %); resolved limb AA adds < 1 %.
// Measured 2026-11-08 (t = 2026-11-08T12:00:00Z): Pan 0.9995, Daphnis 0.970, Atlas 1.026, Prometheus 0.972,
// Pandora 0.973, Epimetheus 0.967 (in Saturn's shadow: Saturnshine only), Janus 0.986; Mimas (ellipsoid) 1.070.
// usage: node scripts/test/moonflux.mjs [--moons Pan,Daphnis,...] [--t ISO] [--tol 0.08] [--tol-ellipsoid 0.10]
//                                       [--px 120] [--w 1280 --h 720] [--base URL] [--out DIR]
import { fmt, openApp, problems, table, withHarness } from './lib.mjs';

const USAGE = 'node scripts/test/moonflux.mjs [--moons a,b,…] [--t ISO] [--tol frac] [--tol-ellipsoid frac] [--px radius] [--w --h] [--base URL] [--out DIR]';
const DEFAULT_MOONS = ['Pan', 'Daphnis', 'Atlas', 'Prometheus', 'Pandora', 'Epimetheus', 'Janus', 'Mimas'];

await withHarness('moonflux', { usage: USAGE, w: 1280, h: 720 }, async ({ args, rep, base, browser }) => {
  const moons = args.list('moons', DEFAULT_MOONS);
  const t = args.str('t', '2026-11-08T12:00:00Z');
  const tol = args.num('tol', 0.08);
  const tolE = args.num('tol-ellipsoid', 0.1);
  const px = args.num('px', 120);
  const { page, errs } = await openApp(browser, base, {
    cam: 'orbit', target: moons[0].toLowerCase(), dist: 1e6, az: 0, el: -70, t, paused: 1, hud: 0, labels: 0,
    astronaut: 0, stars: 0, nearField: 0, scale: 1,
  }, { settle: 1500 });
  const rows = [];
  try {
    for (const name of moons) {
      const r = await page.evaluate(async (name, px) => {
        const sv = window.__sv, D = Math.PI / 180;
        const far = sv.pipeline.passes.far.inner;
        const frames = (n) => new Promise((res) => { let k = 0; const st = () => (++k >= n ? res() : requestAnimationFrame(st)); requestAnimationFrame(st); });
        const idx = sv.frame.moons.findIndex((m) => m.name === name);
        if (idx < 0) return { error: `no moon ${name}` };
        const m = sv.frame.moons[idx];
        const shaped = !!m.shape;
        const rB = shaped ? m.shape.rMax : Math.max(m.radii.x, m.radii.y, m.radii.z);
        // force the resolved/point cross-fade to 0.5 so the flux step integrates this moon
        if (!far.__mfOrig) far.__mfOrig = far.updateMoons;
        far.updateMoons = function (f) { far.__mfOrig.call(far, f); far.u.uMoonRing.value[idx].w = 0.5; };
        sv.pipeline.passes.rings.inner.enabled = false;
        sv.app.settings.fovDeg = 10;
        await frames(2);
        // camera: 70 deg below the moon's equator, 20 deg in azimuth from the Sun (moon-up frame)
        const V = m.pos.constructor;
        const z = new V(0, 0, 1).applyQuaternion(m.orient).normalize();
        const x = new V(1, 0, 0).addScaledVector(z, -z.x).normalize();
        const y = new V().crossVectors(z, x);
        const s = sv.frame.sunDir;
        const c = sv.camera.active;
        c.target = name.toLowerCase();
        c.az = Math.atan2(s.dot(y), s.dot(x)) - 20 * D;
        c.el = -70 * D;
        const pa0 = (2 * Math.tan(5 * D)) / sv.pipeline.ctx.height;
        c.dist = rB / (px * pa0);
        await frames(6);
        const ctx = sv.pipeline.ctx, W = ctx.width, H = ctx.height, pa = sv.frame.pixelAngle;
        const buf = new Float32Array(W * H * 4);
        sv.renderer.readRenderTargetPixels(ctx.sceneRT, 0, 0, W, H, buf);
        const d = m.pos.distanceTo(sv.frame.camPos);
        const rpx = rB / d / pa + 3;
        let E = 0;
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
          const u = i + 0.5 - W / 2, v = j + 0.5 - H / 2;
          if (u * u + v * v > rpx * rpx) continue;
          const k = 4 * (j * W + i), tx = u * pa, ty = v * pa;
          E += (0.2126 * buf[k] + 0.7152 * buf[k + 1] + 0.0722 * buf[k + 2]) * (pa * pa) / Math.pow(1 + tx * tx + ty * ty, 1.5);
        }
        E /= 0.5;
        const NSW = far.moonPts.fluxRT.width;
        const fb = new Float32Array(NSW * 4);
        sv.renderer.readRenderTargetPixels(far.moonPts.fluxRT, 0, idx, NSW, 1, fb);
        let F = 0, used = 0;
        for (let k = 0; k < NSW; k++) {
          const l = 0.2126 * fb[4 * k] + 0.7152 * fb[4 * k + 1] + 0.0722 * fb[4 * k + 2];
          F += l;
          if (fb[4 * k + 3] > 0) used++;
        }
        far.updateMoons = far.__mfOrig;
        sv.pipeline.passes.rings.inner.enabled = true;
        return { shaped, rB, d, rpx, E, F, used, ratio: F / E };
      }, name, px);
      if (r.error) { rep.error(name, r.error); continue; }
      const tl = r.shaped ? tol : tolE;
      rep.range(`${name} (${r.shaped ? 'measured shape' : 'ellipsoid'}): point-source flux / resolved flux`, r.ratio, 1 - tl, 1 + tl);
      rows.push([name, r.shaped ? 'measured' : 'ellipsoid', fmt(r.rB / 1e3, 2), fmt(r.d / 1e3, 0), fmt(r.rpx, 0), r.used, fmt(r.E, 4), fmt(r.F, 4), fmt(r.ratio, 4)]);
    }
    const probs = await problems(page, errs);
    rep.check('no errors', probs.length === 0, probs.slice(0, 3).join(' | '));
  } finally {
    await page.close();
  }
  console.log('\n' + table(['moon', 'shape', 'r_bound km', 'dist km', 'circle px', 'rays', 'E_res W/m2', 'E_flux W/m2', 'ratio'], rows));
  rep.data.rows = rows;
});
