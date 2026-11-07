// Reflex motion of Saturn's centre about the Saturn-system barycentre, from the fitted major-moon models:
//   r_Saturn/bary = -sum_i m_i r_i / (M_S + sum_j m_j)       (r_i Saturn-centric)
// so a moon modelled in barycentric coordinates (Phoebe, irregulars) has Saturn-centric position
//   r = r_bary + W,  W = sum_i mu_i r_i / (1 + sum_j mu_j),  mu_i = GM_i / GM_Saturn.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../ephemeris/horizons.mjs';
import { MOONS } from './catalog.mjs';
import { orbitPosSef } from './model.mjs';

export const GM_SATURN = 37931206.2; // km^3/s^2 (Saturn alone; Jacobson SAT441-era)
export const WOBBLE_MOONS = ['Mimas', 'Enceladus', 'Tethys', 'Dione', 'Rhea', 'Titan', 'Hyperion', 'Iapetus'];

export function loadFitOrbit(name) {
  const r = JSON.parse(readFileSync(resolve(ROOT, 'data-raw/moons_fit', `${name.toLowerCase()}.json`), 'utf8'));
  const o = r.orbit;
  o.Rfix = o.R;
  delete o.R;
  if (o.table) o.table.data = Float64Array.from(o.table.data);
  return { orbit: o, result: r };
}

export function makeWobble() {
  const terms = WOBBLE_MOONS.map((n) => {
    const cfg = MOONS.find((m) => m.name === n);
    return { mu: cfg.gm / GM_SATURN, orbit: loadFitOrbit(n).orbit };
  });
  const musum = terms.reduce((s, t) => s + t.mu, 0);
  const p = new Float64Array(3);
  return (jd, out = new Float64Array(3)) => {
    out[0] = out[1] = out[2] = 0;
    for (const t of terms) {
      orbitPosSef(t.orbit, jd, p);
      out[0] += t.mu * p[0]; out[1] += t.mu * p[1]; out[2] += t.mu * p[2];
    }
    out[0] /= 1 + musum; out[1] /= 1 + musum; out[2] /= 1 + musum;
    return out;
  };
}
