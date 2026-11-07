// Observation loading and orbit initialisation for the moon fits.
import { horizonsSpan, horizonsVectors } from '../ephemeris/horizons.mjs';
import { DEG, EPOCH_JD, TWO_PI, icrfToSef, mat3mul, frameMatrix, solveKeplerEq } from './model.mjs';
import { linLSQ, toRef, unwrap, periodogram } from './fitlib.mjs';
import { EPOCH_SSD_JD } from './catalog.mjs';

const OBL = (84381.406 / 3600) * DEG;
function eclToIcrf(v) {
  const c = Math.cos(OBL), s = Math.sin(OBL);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Load Horizons positions (SEF km) for a span with a given step (days). */
export async function loadObs(id, jd0, jd1, step, opts = {}) {
  const { rows, source } = await horizonsSpan(String(id), jd0, jd1, step, opts);
  const n = rows.length;
  const jd = new Float64Array(n);
  const pos = new Float64Array(3 * n);
  const vel = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    jd[i] = r.jd;
    const p = icrfToSef([r.x, r.y, r.z]);
    pos[3 * i] = p[0]; pos[3 * i + 1] = p[1]; pos[3 * i + 2] = p[2];
    if (r.vx !== undefined) {
      const v = icrfToSef([r.vx, r.vy, r.vz]);
      vel[3 * i] = v[0]; vel[3 * i + 1] = v[1]; vel[3 * i + 2] = v[2];
    }
  }
  return { jd, pos, vel, source };
}

/** Discrete-epoch state vectors (pos + vel, SEF). */
export async function loadEpochs(id, jds) {
  const rows = [];
  for (let i = 0; i < jds.length; i += 50) {
    const part = await horizonsVectors({ target: String(id), tlist: jds.slice(i, i + 50), vecTable: '2' });
    rows.push(...part);
  }
  const n = rows.length;
  const out = { jd: new Float64Array(n), pos: new Float64Array(3 * n), vel: new Float64Array(3 * n) };
  rows.forEach((r, i) => {
    out.jd[i] = r.jd;
    const p = icrfToSef([r.x, r.y, r.z]);
    const v = icrfToSef([r.vx, r.vy, r.vz]);
    out.pos.set(p, 3 * i);
    out.vel.set(v, 3 * i);
  });
  return out;
}

/** Columns-as-axes matrix (row-major) from three column vectors. */
function cols(x, y, z) {
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

/** Saturn's heliocentric orbit pole (J2000 ecliptic, Standish) -> SEF. */
function saturnOrbitPoleSef() {
  const I = 2.48599187 * DEG, Om = 113.66242448 * DEG;
  return icrfToSef(eclToIcrf([Math.sin(I) * Math.sin(Om), -Math.sin(I) * Math.cos(Om), Math.cos(I)]));
}

/**
 * Base frame (ref -> SEF, row-major) for a catalog entry and the frame in which its SSD elements are given
 * (as a function mapping SSD-frame vectors to SEF).
 */
export function frames(cfg) {
  const retro = cfg.ssd[4] > 90;
  let ssdToSef;
  let pole;
  if (cfg.lap === 'ecliptic') {
    ssdToSef = (v) => icrfToSef(eclToIcrf(v));
    pole = saturnOrbitPoleSef();
  } else {
    const [ra, dec] = cfg.lap ? [cfg.lap[0] * DEG, cfg.lap[1] * DEG] : [40.589 * DEG, 83.537 * DEG];
    const Z = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
    const X = norm([-Math.sin(ra), Math.cos(ra), 0]);
    const Y = cross(Z, X);
    ssdToSef = (v) => icrfToSef([X[0] * v[0] + Y[0] * v[1] + Z[0] * v[2], X[1] * v[0] + Y[1] * v[1] + Z[1] * v[2], X[2] * v[0] + Y[2] * v[1] + Z[2] * v[2]]);
    pole = icrfToSef(Z);
  }
  if (retro) pole = [-pole[0], -pole[1], -pole[2]];
  // minimal rotation from SEF +Z to the pole (keeps X close to SEF X for small tilts)
  pole = norm(pole);
  const d = 1 + pole[2];
  let base;
  if (Math.abs(d) < 1e-9) base = [1, 0, 0, 0, -1, 0, 0, 0, -1];
  else {
    const u = pole[0], v = pole[1], w = pole[2];
    base = [w + (v * v) / d, (-u * v) / d, u, (-u * v) / d, w + (u * u) / d, v, -u, -v, w];
  }
  const tiny = cfg.lap === null || (Array.isArray(cfg.lap) && cfg.lap[2] < 0.05 && !retro);
  return { base: tiny ? null : base, ssdToSef, retro };
}

/** Classical elements in frame F -> pericentre & pole unit vectors in F. */
function elemVectors(i, Om, w) {
  const P = [
    Math.cos(Om) * Math.cos(w) - Math.sin(Om) * Math.sin(w) * Math.cos(i),
    Math.sin(Om) * Math.cos(w) + Math.cos(Om) * Math.sin(w) * Math.cos(i),
    Math.sin(w) * Math.sin(i),
  ];
  const W = [Math.sin(i) * Math.sin(Om), -Math.sin(i) * Math.cos(Om), Math.cos(i)];
  return { P, W };
}

/**
 * Initial orbit for a catalog entry from its SSD mean elements, refined with the observations:
 * lambda0/n from the unwrapped observed longitudes, a from the mean radius.
 */
export function initOrbit(cfg, obs, { fitFrame } = {}) {
  const fr = frames(cfg);
  const orbit = { base: fr.base, tu: 0, tv: 0, lib: [], table: null };
  const R = frameMatrix(orbit);
  const RT = (v) => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
  const [a, e, wDeg, MDeg, iDeg, OmDeg, P, Paps, Pnod] = cfg.ssd;
  const { P: peri, W: pole } = elemVectors(iDeg * DEG, OmDeg * DEG, wDeg * DEG);
  let Pr = RT(fr.ssdToSef(peri));
  let Wr = RT(fr.ssdToSef(pole));
  // inclination & node in the reference frame
  const ir = Math.acos(Math.max(-1, Math.min(1, Wr[2])));
  let Omr = Math.atan2(Wr[0], -Wr[1]);
  if (!Number.isFinite(Omr) || ir < 1e-9) Omr = 0;
  const N = [Math.cos(Omr), Math.sin(Omr), 0];
  const wr = Math.atan2(dot(cross(N, Pr), Wr), dot(N, Pr));
  const varpi = Omr + wr;
  const n0 = TWO_PI / P; // rad/day
  const lamSsd = varpi + MDeg * DEG + n0 * (EPOCH_JD - EPOCH_SSD_JD);
  // rates
  const yr = 365.25;
  const theoryRates = () => {
    // J2/J4/J6 apsidal & nodal rates for an equatorial circular orbit
    const GM = 37931206.2, Rref = 60330, J2 = 16290.573e-6, J4 = -935.314e-6, J6 = 86.34e-6;
    const r = a;
    const n2 = GM / r ** 3;
    const x2 = (Rref / r) ** 2, x4 = x2 * x2, x6 = x4 * x2;
    const om = Math.sqrt(n2 * (1 + 1.5 * J2 * x2 - (15 / 8) * J4 * x4 + (35 / 16) * J6 * x6));
    const ka = Math.sqrt(n2 * (1 - 1.5 * J2 * x2 + (45 / 8) * J4 * x4 - (175 / 16) * J6 * x6));
    const nu = Math.sqrt(n2 * (1 + 4.5 * J2 * x2 - (75 / 8) * J4 * x4 + (245 / 16) * J6 * x6));
    return { pidot: (om - ka) * 86400, Omdot: -(nu - om) * 86400 };
  };
  const thr = theoryRates();
  // inner moons: oblateness theory (the SSD apsidal periods mix varpi and omega conventions);
  // outer moons: SSD periods (sign: apsides advance unless negative, nodes regress)
  const inner = a < 600000;
  let pidot = inner || Math.abs(Paps) < 0.1 ? thr.pidot : (Math.sign(Paps) * TWO_PI) / (Math.abs(Paps) * yr);
  let Omdot = inner || Math.abs(Pnod) < 0.1 ? thr.Omdot : -TWO_PI / (Pnod * yr);
  if (cfg.pidot !== undefined) pidot = cfg.pidot;
  if (cfg.Omdot !== undefined) Omdot = cfg.Omdot;
  // rotate SSD-epoch angles to the model epoch
  const dtE = EPOCH_JD - EPOCH_SSD_JD;
  const varpiE = varpi + pidot * dtE;
  const OmE = Omr + Omdot * dtE;
  orbit.a = a;
  orbit.n = n0;
  orbit.lambda0 = lamSsd;
  orbit.k0 = e * Math.cos(varpiE);
  orbit.h0 = e * Math.sin(varpiE);
  orbit.q0 = Math.tan(ir / 2) * Math.cos(OmE);
  orbit.p0 = Math.tan(ir / 2) * Math.sin(OmE);
  orbit.pidot = pidot;
  orbit.Omdot = Omdot;
  orbit.lambda0 = ((lamSsd % TWO_PI) + TWO_PI) % TWO_PI;
  // ---- 1. mean longitude: unwrap observed longitudes (equation of centre removed with SSD e, varpi),
  //         fit [1, tau] + libration sinusoids (configured periods + auto-detected periodogram peaks)
  const ref = toRef(R, obs.pos);
  const m = obs.jd.length;
  const tau = new Float64Array(m);
  const th = new Float64Array(m);
  const rr = new Float64Array(m);
  const res = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    tau[i] = obs.jd[i] - EPOCH_JD;
    const x = ref[3 * i], y = ref[3 * i + 1], z = ref[3 * i + 2];
    th[i] = Math.atan2(y, x);
    rr[i] = Math.hypot(x, y, z);
    const vp = varpiE + pidot * tau[i];
    const f = th[i] - vp;
    const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(f / 2));
    const M = E - e * Math.sin(E);
    res[i] = vp + M - (orbit.lambda0 + orbit.n * tau[i]);
  }
  const ru = unwrap(res);
  const span = tau[m - 1] - tau[0];
  const step = span / (m - 1);
  // libration terms: configured ({P, harm, a, ecc, fitNu}) + auto-detected fundamentals
  const terms = (cfg.lib ?? []).map((L) => ({ P: L.P, harm: L.harm ?? 1, a: !!L.a, ecc: !!L.ecc, fixNu: L.fitNu === false }));
  const fitLam = () => {
    const rows = Array.from(tau, (t) => {
      const row = [1, t];
      for (const T of terms) {
        const w = TWO_PI / T.P;
        for (let mm = 1; mm <= T.harm; mm++) row.push(Math.cos(mm * w * t), Math.sin(mm * w * t));
      }
      return row;
    });
    const sol = linLSQ(rows, Array.from(ru));
    const resid = Array.from(tau, (t, i) => ru[i] - rows[i].reduce((s, v, j) => s + v * sol[j], 0));
    return { sol, resid };
  };
  let fl = fitLam();
  if (cfg.autoLib !== false) {
    for (let iter = 0; iter < (cfg.maxAutoLib ?? 3); iter++) {
      const periods = [];
      for (let P = Math.max(30 * step, 60); P < span / 1.3; P *= 1.01) periods.push(P);
      if (!periods.length) break;
      const pg = periodogram(tau, fl.resid, periods).sort((a2, b2) => b2.amp - a2.amp);
      if (!pg.length || pg[0].amp < (cfg.autoLibMin ?? 0.5) * DEG) break;
      terms.push({ P: pg[0].P, harm: 1, a: false, ecc: false, fixNu: false });
      fl = fitLam();
    }
  }
  orbit.lambda0 += fl.sol[0];
  orbit.n += fl.sol[1];
  let col = 2;
  orbit.lib = terms.map((T) => {
    const L = { nu: TWO_PI / T.P, cl: [], sl: [] };
    if (T.fixNu) L.fixNu = true;
    for (let mm = 0; mm < T.harm; mm++) { L.cl.push(fl.sol[col++]); L.sl.push(fl.sol[col++]); }
    const z = () => new Array(T.harm).fill(0);
    if (T.a) { L.ca = z(); L.sa = z(); }
    if (T.ecc) { L.ck = z(); L.sk = z(); L.ch = z(); L.sh = z(); }
    return L;
  });
  const lamOf = (t) => {
    let l = orbit.lambda0 + orbit.n * t;
    for (const L of orbit.lib) for (let mm = 0; mm < L.cl.length; mm++) l += L.cl[mm] * Math.cos((mm + 1) * L.nu * t) + L.sl[mm] * Math.sin((mm + 1) * L.nu * t);
    return l;
  };
  // ---- 2. apsidal rate (scan for the strongest radial term) and (a, k0, h0)
  const lam = Float64Array.from(tau, lamOf);
  const scan = (rate0, sig, colsFn) => {
    let best = { amp: -1, rate: rate0 };
    const span2 = Math.max(Math.abs(rate0) * 2.5, 2e-4);
    const dr = Math.min(TWO_PI / span / 4, span2 / 400);
    const tryRate = (rate) => {
      const rows = [], y = [];
      for (let i = 0; i < m; i += Math.max(1, Math.floor(m / 6000))) { rows.push(colsFn(i, rate)); y.push(sig[i]); }
      const s = linLSQ(rows, y);
      const amp = Math.hypot(s[s.length - 2], s[s.length - 1]);
      if (amp > best.amp) best = { amp, rate, s };
    };
    if (cfg.scanRates === false) { tryRate(rate0); return best; }
    for (let rate = rate0 - span2; rate <= rate0 + span2; rate += dr) tryRate(rate);
    const r1 = best.rate;
    for (let rate = r1 - 2 * dr; rate <= r1 + 2 * dr; rate += dr / 20) tryRate(rate);
    return best;
  };
  const doRad = e > 0 || cfg.ssd[1] > 0 || true;
  if (doRad) {
    const bestR = scan(pidot, rr, (i, rate) => [1, -Math.cos(lam[i] - rate * tau[i]), -Math.sin(lam[i] - rate * tau[i])]);
    const A = bestR.s[0];
    const ka = bestR.s[1], ha = bestR.s[2];
    const aa = A / (1 + (ka * ka + ha * ha) / (2 * A * A));
    orbit.a = aa;
    orbit.k0 = ka / aa;
    orbit.h0 = ha / aa;
    orbit.pidot = bestR.rate;
  }
  // ---- 3. nodal rate (scan for the strongest vertical term) and (q0, p0)
  const zz = Float64Array.from({ length: m }, (_, i) => ref[3 * i + 2]);
  const bestZ = scan(Omdot, zz, (i, rate) => [1, 2 * rr[i] * Math.sin(th[i] - rate * tau[i]), -2 * rr[i] * Math.cos(th[i] - rate * tau[i])]);
  orbit.q0 = bestZ.s[1];
  orbit.p0 = bestZ.s[2];
  orbit.Omdot = bestZ.rate;
  orbit.fitFrame = fitFrame ?? cfg.fitFrame ?? !!fr.base;
  return orbit;
}

export { solveKeplerEq };
