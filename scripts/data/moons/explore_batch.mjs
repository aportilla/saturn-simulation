// Compact exploration over several moons: global-fit residuals and residual spectra.
//   node explore_batch.mjs Name1 Name2 ...
import { moonConfig } from './catalog.mjs';
import { initOrbit, loadObs } from './fitcore.mjs';
import { fitGlobal, paramPaths, alongTrackDeg, periodogram } from './fitlib.mjs';
import { EPOCH_JD } from './model.mjs';

const stats = (a) => { let mx = 0, s2 = 0; for (const v of a) { mx = Math.max(mx, Math.abs(v)); s2 += v * v; } return `rms ${Math.sqrt(s2 / a.length).toFixed(3)} max ${mx.toFixed(3)}`; };
for (const name of process.argv.slice(2)) {
  const cfg = moonConfig(name);
  const gs = cfg.globalSpan ?? cfg.cover;
  const P = cfg.ssd[6];
  const longStep = cfg.cover[1] - cfg.cover[0] > 60000 ? 7.31 : 2.31;
  const obsL = await loadObs(cfg.id, gs[0] + 1, gs[1] - 1, longStep);
  const orbit = initOrbit(cfg, obsL);
  const r = fitGlobal(orbit, obsL, paramPaths(orbit, { frame: orbit.fitFrame, libNu: true }), { iters: 40 });
  const at = alongTrackDeg(orbit, obsL);
  const tl = Array.from(obsL.jd, (j) => j - EPOCH_JD);
  const per = []; for (let p = 60; p < (cfg.cover[1] - cfg.cover[0]) / 1.5; p *= 1.03) per.push(p);
  const pg = periodogram(tl, at, per).sort((a, b) => b.amp - a.amp).slice(0, 4);
  const d0 = Math.max(2458849.5, cfg.cover[0] + 1), d1 = Math.min(2462502.5, cfg.cover[1] - 1);
  const obsD = await loadObs(cfg.id, d0, d1, Math.min(P / 9.73, 3.7));
  const ad = alongTrackDeg(orbit, obsD);
  const td = Array.from(obsD.jd, (j) => j - EPOCH_JD);
  const det = new Float64Array(ad.length);
  let j0 = 0, j1 = 0, acc = 0;
  for (let i = 0; i < ad.length; i++) {
    while (j1 < ad.length && td[j1] < td[i] + 10) acc += ad[j1++];
    while (td[j0] < td[i] - 10) acc -= ad[j0++];
    det[i] = ad[i] - acc / (j1 - j0);
  }
  const sp = []; for (let p = 0.25; p < 40; p *= 1.01) sp.push(p);
  const ps = periodogram(td, det, sp).sort((a, b) => b.amp - a.amp).slice(0, 4);
  const lib = orbit.lib.map((L) => `${(6.283185307 / L.nu).toFixed(0)}d:${(Math.hypot(L.cl[0], L.sl[0]) * 57.29578).toFixed(2)}`).join(',');
  console.log(`${cfg.name.padEnd(10)} e=${Math.hypot(orbit.k0, orbit.h0).toExponential(2)} i=${(2 * Math.atan(Math.hypot(orbit.q0, orbit.p0)) * 57.29578).toFixed(3)} pidot=${(orbit.pidot * 57.29578).toFixed(5)} Omdot=${(orbit.Omdot * 57.29578).toFixed(5)} lib[${lib}] gRMS=${r.rms.toFixed(1)}km`);
  console.log(`   long(${obsL.jd.length}) ${stats(at)} | peaks ${pg.map((p) => `${p.P.toFixed(0)}:${p.amp.toFixed(3)}`).join(' ')}`);
  console.log(`   dense(${obsD.jd.length}) ${stats(ad)} | short ${ps.map((p) => `${p.P.toFixed(2)}:${p.amp.toFixed(4)}`).join(' ')} | detrended ${stats(det)}`);
}
