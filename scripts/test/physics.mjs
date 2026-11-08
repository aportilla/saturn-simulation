#!/usr/bin/env node
// Physics regression: ephemeris (Sun over the ring plane), orbital frequencies, near-field particle kinematics.
//
// usage: node scripts/test/physics.mjs [--base URL] [--out DIR] [--only ephemeris,orbits,kinematics]
//                                      [--place a-ring-30m] [--class K] [--dts 30,600,-600,20000]
//
// 1. ephemeris  Sun elevation above the ring plane (asin of frame.sunDir.z, SEF) on known dates:
//               equinoxes 2009-08-11 and 2025-05-06 -> 0 (+-0.1 deg; the elevation changes ~0.016 deg/day there),
//               northern solstice 2017-05-24 -> +26.7 deg (+-0.3), 2026-11-07T12Z -> -8.205 deg (+-0.02, regression).
// 2. orbits     frame.ring omega / kappa / nu / qShear at the anchor vs an independent evaluation of the
//               oblate-Saturn frequencies (GM, R_ref, J2, J4, J6; rel. 1e-6), and the orbital period at the
//               orbits of Pan (133,584 km: 0.575050 d) and Daphnis (136,505 km: 0.594080 d) within 2e-4.
// 3. kinematics near-field particle positions (R0 read-back) of one size class at t0 and t0 + dt (both time
//               directions), self-gravity wakes off (wakes=0: their displacement field evolves and adds to dx, dy):
//               least-squares shear slope d(dy)/dx vs -q Omega dt (ratio 1 +- 0.002), rms of the radial /
//               vertical / non-shear azimuthal displacements vs the epicycle and vertical-oscillation predictions
//               2|sin(kappa dt/2)| sigX, 2|sin(nu dt/2)| sigZ and |q Omega dt cos(kappa dt/2) - 4 (Omega/kappa)
//               sin(kappa dt/2)| sigX (the shear is removed at the instantaneous x; it acts on the guiding centre)
//               (ratios 0.95 .. 1.05; measured 0.994 .. 1.002). Particles whose box copy switched are skipped; for |q Omega dt| > 0.25 the azimuthal
//               shear wraps the boxes, so only dx and dz are checked (default dts include 20000 s for that).
import { fmt, openApp, retry, setSimTime, sleep, table, withHarness } from './lib.mjs';

// ---- independent statement of the physics (Iess et al. 2019 gravity field; JPL small-body mean elements)
const GM = 3.79312062e16, R_REF = 60_330e3, J2 = 16_290.573e-6, J4 = -935.314e-6, J6 = 86.34e-6;
function frequencies(r) {
  const n2 = GM / r ** 3, x2 = (R_REF / r) ** 2, x4 = x2 * x2, x6 = x4 * x2;
  return {
    omega: Math.sqrt(n2 * (1 + 1.5 * J2 * x2 - (15 / 8) * J4 * x4 + (35 / 16) * J6 * x6)),
    kappa: Math.sqrt(n2 * (1 - 1.5 * J2 * x2 + (45 / 8) * J4 * x4 - (175 / 16) * J6 * x6)),
    nu: Math.sqrt(n2 * (1 + 4.5 * J2 * x2 - (75 / 8) * J4 * x4 + (245 / 16) * J6 * x6)),
  };
}
const qShear = (r) => { const h = r * 1e-4; return -(Math.log(frequencies(r + h).omega) - Math.log(frequencies(r - h).omega)) / (Math.log(r + h) - Math.log(r - h)); };
const DAY = 86400;
const MOONS = [
  { name: 'Pan', r: 133_584e3, periodDays: 0.575050 },
  { name: 'Daphnis', r: 136_505e3, periodDays: 0.594080 },
];
const SUN_DATES = [
  { t: '2009-08-11T12:00:00Z', deg: 0, tol: 0.1, what: 'equinox 2009' },
  { t: '2017-05-24T12:00:00Z', deg: 26.7, tol: 0.3, what: 'northern solstice 2017' },
  { t: '2025-05-06T12:00:00Z', deg: 0, tol: 0.1, what: 'equinox 2025' },
  { t: '2026-11-07T12:00:00Z', deg: -8.205, tol: 0.02, what: 'regression value' },
];
const BASE_PARAMS = { hud: 0, labels: 0, paused: 1, astronaut: 0 };

await withHarness('physics', { usage: 'node scripts/test/physics.mjs [--base URL] [--out DIR] [--only ephemeris,orbits,kinematics] [--place id] [--class K] [--dts 30,600,-600,20000]' }, async ({ args, rep, base, browser }) => {
  const only = new Set(args.list('only', ['ephemeris', 'orbits', 'kinematics']));

  // ------------------------------------------------------------------ 1. ephemeris
  if (only.has('ephemeris')) {
    console.log('\n[ephemeris] Sun elevation above the ring plane');
    const { page } = await openApp(browser, base, { ...BASE_PARAMS, preset: 'overview', t: SUN_DATES[0].t });
    const rows = [];
    for (const d of SUN_DATES) {
      await setSimTime(page, d.t, 300);
      const el = await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(Math.asin(window.__sv.frame.sunDir.z) * 57.29577951)))));
      rows.push([d.t, d.what, fmt(el, 3), `${d.deg} +- ${d.tol}`]);
      rep.range(`sun elevation ${d.t} (${d.what})`, el, d.deg - d.tol, d.deg + d.tol, ' deg');
    }
    console.log(table(['date', 'event', 'elevation deg', 'expected'], rows));
    rep.data.ephemeris = rows;
    await page.close();
  }

  // ------------------------------------------------------------------ 2. orbits
  if (only.has('orbits')) {
    console.log('\n[orbits] frequencies at the anchor vs independent formula; periods at Pan / Daphnis');
    const rows = [];
    for (const m of MOONS) {
      const { page } = await openApp(browser, base, { ...BASE_PARAMS, cam: 'ring', r: m.r, z: 200, yaw: 0, pitch: -10, t: '2026-11-07T20:00:00Z' }, { settle: 500 });
      const fr = await page.evaluate(() => { const r = window.__sv.frame.ring; return { r0: r.r0, omega: r.omega, kappa: r.kappa, nu: r.nu, q: r.qShear }; });
      await page.close();
      const ex = frequencies(fr.r0);
      const rel = (a, b) => Math.abs(a / b - 1);
      rep.check(`${m.name}: anchor radius`, Math.abs(fr.r0 - m.r) < 1e3, `${fmt(fr.r0 / 1e3, 3)} km (URL ${m.r / 1e3} km)`);
      for (const k of ['omega', 'kappa', 'nu']) rep.range(`${m.name}: ${k} vs formula (rel. error)`, rel(fr[k], ex[k]), 0, 1e-6);
      rep.range(`${m.name}: qShear vs formula (abs. error)`, Math.abs(fr.q - qShear(fr.r0)), 0, 1e-4);
      const period = (2 * Math.PI) / fr.omega;
      rep.range(`${m.name}: orbital period / observed`, period / (m.periodDays * DAY), 1 - 2e-4, 1 + 2e-4);
      rows.push([m.name, fmt(fr.r0 / 1e3, 1), fmt(period / 3600, 5), fmt(m.periodDays * 24, 5), fmt((fr.omega * fr.r0) / 1e3, 4),
        fmt((2 * Math.PI) / fr.kappa / 3600, 4), fmt((2 * Math.PI) / fr.nu / 3600, 4), fmt(fr.q, 5)]);
    }
    console.log(table(['moon orbit', 'r0 km', 'period h', 'observed h', 'v km/s', 'epicycle h', 'vertical h', 'q'], rows));
    rep.data.orbits = rows;
  }

  // ------------------------------------------------------------------ 3. kinematics
  if (only.has('kinematics')) {
    const place = args.str('place', 'a-ring-30m');
    const dts = args.list('dts', ['30', '600', '-600', '20000']).map(Number);
    console.log(`\n[kinematics] near-field particles at ${place}`);
    const { page } = await openApp(browser, base, { ...BASE_PARAMS, wakes: 0, preset: place, t: '2026-11-07T20:00:00Z' }, { settle: 1500 });
    const pick = await page.evaluate((K) => {
      const sv = window.__sv;
      const near = sv.pipeline.passes.near?.inner ?? sv.pipeline.passes.near;
      if (!near || !near.classes || !near.r0RT) return { error: 'near-field internals (classes / r0RT) not found — update physics.mjs' };
      const lod = sv.pipeline.ctx.lod;
      let k = K;
      if (!(k >= 0)) {
        // the class with the most slots among those whose box is at least 50 m (enough lever arm for the shear fit)
        let best = -1;
        for (const c of near.classes) if (c.slots > 0 && c.D >= 50 && (best < 0 || c.slots > near.classes[best].slots)) best = c.k;
        k = best;
      }
      const c = near.classes[k];
      if (!c || c.slots <= 0) return { error: `class ${k} has no slots here` };
      return { k, slots: c.slots, D: c.D, sigX: lod.sigX(k), sigZ: lod.sigZ(k), aLo: lod.aLo[k], aHi: lod.aHi[k] };
    }, args.num('class', -1));
    if (pick.error) { rep.check('kinematics setup', false, pick.error); await page.close(); return; }
    console.log(`  class ${pick.k} (${fmt(pick.aLo * 100, 2)}-${fmt(pick.aHi * 100, 2)} cm): ${pick.slots} slots, box ${fmt(pick.D, 0)} m, sigX ${fmt(pick.sigX, 3)} m, sigZ ${fmt(pick.sigZ, 3)} m`);
    // read class K's R0 rows at time t into window.__kin[slot] (local Hill-frame coordinates, relative to the camera)
    const snap = (t, store) => page.evaluate(async (t, K, store) => {
      const sv = window.__sv;
      sv.clock.paused = true;
      sv.clock.t = t;
      await new Promise((r) => setTimeout(r, 500));
      const near = sv.pipeline.passes.near?.inner ?? sv.pipeline.passes.near;
      const c = near.classes[K];
      const buf = new Float32Array(2048 * c.rows * 4);
      sv.renderer.readRenderTargetPixels(near.r0RT, 0, c.row0, 2048, c.rows, buf);
      const f = sv.frame, r = f.ring, eR = r.eR, eP = r.ePhi;
      const n = c.slots, out = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const k = i * 4, w = buf[k + 3];
        out[k + 3] = w;
        if (w === 0) continue;
        const px = buf[k], py = buf[k + 1], pz = buf[k + 2];
        out[k] = px * eR.x + py * eR.y + pz * eR.z;
        out[k + 1] = px * eP.x + py * eP.y + pz * eP.z;
        out[k + 2] = pz;
      }
      window.__kin = window.__kin || {};
      window.__kin[store] = { t: f.t, anchor: r.anchorId, cam: [r.camLocal.x, r.camLocal.y, r.camLocal.z], omega: r.omega, kappa: r.kappa, nu: r.nu, q: r.qShear, data: out };
      let present = 0;
      for (let i = 0; i < n; i++) if (out[i * 4 + 3] !== 0) present++;
      return { t: f.t, anchor: r.anchorId, present };
    }, t, pick.k, store);
    const compare = () => page.evaluate((D, sigX, sigZ) => {
      const A = window.__kin.A, B = window.__kin.B;
      const T = B.t - A.t, slope0 = -A.q * A.omega * T;
      let sxx = 0, sxy = 0, n = 0, sdx2 = 0, sdz2 = 0, sdy2 = 0, wraps = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        if (A.data[i + 3] === 0 || B.data[i + 3] === 0) continue;
        const dx = B.data[i] - A.data[i], dy = B.data[i + 1] - A.data[i + 1], dz = B.data[i + 2] - A.data[i + 2];
        if (Math.abs(dx) > 0.5 * D || Math.abs(dy) > 0.5 * D) { wraps++; continue; }
        const xm = 0.5 * (A.data[i] + B.data[i]) + A.cam[0];
        sxx += xm * xm; sxy += xm * dy; n++;
        sdx2 += dx * dx; sdz2 += dz * dz; sdy2 += (dy - slope0 * xm) ** 2;
      }
      const sk = 2 * Math.abs(Math.sin((A.kappa * T) / 2));
      // azimuthal residual after removing the shear of the INSTANTANEOUS mean x (the shear acts on the guiding
      // centre): A cos(th + kT/2) [q Omega T cos(kT/2) - 4 (Omega/kappa) sin(kT/2)] -> rms sigX |...|
      const ky = Math.abs(A.q * A.omega * T * Math.cos((A.kappa * T) / 2) - 4 * (A.omega / A.kappa) * Math.sin((A.kappa * T) / 2));
      return {
        T, n, wraps, slope: sxy / sxx, slope0,
        rmsX: Math.sqrt(sdx2 / n), expX: sk * sigX,
        rmsZ: Math.sqrt(sdz2 / n), expZ: 2 * Math.abs(Math.sin((A.nu * T) / 2)) * sigZ,
        rmsY: Math.sqrt(sdy2 / n), expY: ky * sigX,
      };
    }, pick.D, pick.sigX, pick.sigZ);
    const t0 = await page.evaluate(() => window.__sv.clock.t);
    const a = await snap(t0, 'A');
    const rows = [];
    for (const dt of dts) {
      const b = await retry(() => snap(t0 + dt, 'B'), { label: `snapshot dt=${dt}` });
      if (b.anchor !== a.anchor) { rep.check(`kinematics dt=${dt}`, false, 'the frame anchor changed between the snapshots'); continue; }
      const s = await compare();
      const short = Math.abs(s.slope0) <= 0.25;
      rows.push([fmt(s.T, 0), s.n, s.wraps, short ? fmt(s.slope / s.slope0, 5) : 'n/a', fmt(s.rmsX / s.expX, 3), fmt(s.rmsZ / s.expZ, 3), short ? fmt(s.rmsY / s.expY, 3) : 'n/a', `${fmt(s.rmsX, 4)} / ${fmt(s.expX, 4)}`, `${fmt(s.rmsZ, 4)} / ${fmt(s.expZ, 4)}`]);
      rep.check(`kinematics dt=${dt}: sample`, s.n >= 200, `${s.n} particles compared (${s.wraps} box-copy switches skipped)`);
      if (short) rep.range(`kinematics dt=${dt}: shear slope / (-q Omega dt)`, s.slope / s.slope0, 0.998, 1.002);
      rep.range(`kinematics dt=${dt}: rms radial / epicycle prediction`, s.rmsX / s.expX, 0.95, 1.05);
      rep.range(`kinematics dt=${dt}: rms vertical / oscillation prediction`, s.rmsZ / s.expZ, 0.95, 1.05);
      if (short) rep.range(`kinematics dt=${dt}: rms azimuthal (minus shear) / epicycle prediction`, s.rmsY / s.expY, 0.95, 1.05);
    }
    console.log(table(['dt s', 'n', 'wraps', 'slope ratio', 'dx ratio', 'dz ratio', 'dy ratio', 'rms dx / exp (m)', 'rms dz / exp (m)'], rows));
    rep.data.kinematics = { place, class: pick, rows };
    await sleep(100);
    await page.close();
  }
});
