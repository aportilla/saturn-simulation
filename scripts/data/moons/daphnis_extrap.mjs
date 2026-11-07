// Daphnis extrapolation skill: fit the mean-element model on [2011, 2011+L] and measure the along-track
// error over the following years of Horizons data (Horizons ends 2018-01-17).
import { moonConfig } from './catalog.mjs';
import { initOrbit, loadObs } from './fitcore.mjs';
import { fitGlobal, paramPaths, alongTrackDeg } from './fitlib.mjs';

const cfg = moonConfig('Daphnis');
const all = await loadObs(cfg.id, cfg.cover[0] + 1, cfg.cover[1] - 1, 0.731);
const sub = (o, j0, j1) => {
  const idx = []; for (let i = 0; i < o.jd.length; i++) if (o.jd[i] >= j0 && o.jd[i] < j1) idx.push(i);
  return { jd: Float64Array.from(idx, (i) => o.jd[i]), pos: Float64Array.from(idx.flatMap((i) => [o.pos[3 * i], o.pos[3 * i + 1], o.pos[3 * i + 2]])) };
};
for (const [j0, j1] of [[2455562.5, 2456658.5], [2455562.5, 2457023.5], [2453005.5, 2455197.5], [2453005.5, 2456293.5]]) {
  const c = { ...cfg, maxAutoLib: 0 };
  const tr = sub(all, j0, j1);
  const orbit = initOrbit(c, tr);
  fitGlobal(orbit, tr, paramPaths(orbit, { frame: false, libNu: true }), { iters: 60 });
  const te = sub(all, j1, cfg.cover[1] - 1);
  const at = alongTrackDeg(orbit, te);
  const yrs = {};
  for (let i = 0; i < te.jd.length; i++) {
    const dy = Math.floor((te.jd[i] - j1) / 365.25);
    (yrs[dy] ??= []).push(Math.abs(at[i]));
  }
  console.log(`train ${(2000 + (j0 - 2451545) / 365.25).toFixed(1)}-${(2000 + (j1 - 2451545) / 365.25).toFixed(1)}: max |err| by years after: ` +
    Object.entries(yrs).map(([y, v]) => `+${+y + 1}y ${Math.max(...v).toFixed(3)}°`).join('  '));
}
