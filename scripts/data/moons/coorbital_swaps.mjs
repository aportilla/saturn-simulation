// Janus/Epimetheus orbit swaps from the fitted models (data-raw/moons_fit): epochs where the separation of the
// MEAN longitudes is minimal (the moons approach and exchange semi-major axes), with the semi-major axes 200 d before/after.
import { loadFitOrbit } from './wobble.mjs';
import { orbitElements } from './model.mjs';

const J = loadFitOrbit('Janus').orbit, E = loadFitOrbit('Epimetheus').orbit;
const eJ = {}, eE = {};
const sep = (jd) => {
  orbitElements(J, jd, eJ); orbitElements(E, jd, eE);
  let d = (eE.lambda - eJ.lambda) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d) * 180 / Math.PI;
};
const iso = (jd) => new Date((jd - 2440587.5) * 86400000).toISOString().slice(0, 10);
const t0 = 2449720, t1 = 2471700, step = 1;
const s = [];
for (let jd = t0; jd <= t1; jd += step) s.push(sep(jd));
for (let i = 300; i < s.length - 300; i++) {
  let isMin = true;
  for (let k = i - 300; k <= i + 300 && isMin; k++) if (s[k] < s[i]) isMin = false;
  if (!isMin) continue;
  const t = t0 + i * step;
  orbitElements(J, t - 200, eJ); const aJ0 = eJ.a; orbitElements(J, t + 200, eJ);
  orbitElements(E, t - 200, eE); const aE0 = eE.a; orbitElements(E, t + 200, eE);
  console.log(`swap ${iso(t)}: closest mean-longitude separation ${s[i].toFixed(2)} deg; a(Janus) ${aJ0.toFixed(1)} -> ${eJ.a.toFixed(1)} km, a(Epimetheus) ${aE0.toFixed(1)} -> ${eE.a.toFixed(1)} km`);
}
