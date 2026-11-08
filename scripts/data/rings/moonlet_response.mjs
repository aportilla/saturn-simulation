#!/usr/bin/env node
// Moonlet streamline-response table for the perturbed gap edges (Encke gap: Pan, Keeler gap: Daphnis), used by
// src/rings/RingStructure.ts (CPU mirror, uniforms) and src/render/shaders/ringStructure.glsl (sv_ringStructure).
//
// Physics. A ring particle on a circular orbit at distance b from a moonlet's orbit drifts past the moonlet at
// the Keplerian shear rate, is deflected during the encounter and leaves on a forced epicycle: downstream (behind
// the moonlet for the outer edge, ahead of it for the inner one) each streamline oscillates radially with
// azimuthal wavelength 3 pi b (Cuzzi & Scargle 1985). In Hill units -- lengths in the Hill radius
// r_H = a (m / 3M)^(1/3), time in 1/Omega -- the problem has no free parameter (Henon & Petit 1986), so ONE table
// serves every moonlet. Rotating frame centred on the moonlet, x radial out, y prograde, Omega = 1:
//     x'' =  2 y' + 3 x - 3 x / r^3          y'' = -2 x' - 3 y / r^3           (r = planar distance)
//     z'' = -z + 3 (z_m(t) - z) / r^3        (linear response to the moonlet's vertical oscillation; integrated
//                                             for z_m = cos t and z_m = sin t, t = 0 at conjunction)
// The particle starts far upstream (t = -200, y = 1.5 b 200) on the unperturbed circular orbit, with its guiding
// centre already shifted by the analytic upstream tail -(8/3)/(b^2 |t|) (from b_g' = 2 F_y). RK4, adaptive
// step per output interval; accuracy checked by step halving and by the Jacobi constant.
//
// Stored quantities, on a grid of NB log-spaced b in [B_LO, B_HI] x NT times t in [T0, T1] (step DT):
//   K  = b^2 xi / r_H                          (xi = radial displacement from the unperturbed streamline)
//   Wc = b^3 z_c,  Ws = b^3 z_s                (vertical response per unit moonlet vertical amplitude)
// each with d/dt, d/db and d2/dbdt (bicubic Hermite interpolation in the shader: smooth density factor J).
// The normalisation makes the table nearly independent of b: the linear theory has K -> const(t), W -> const(t)
// (the radial kick ~ 1/b^2, the vertical one ~ 1/b^3).
//
// Envelope (baked into the table, documented in docs/ring-physics.md "Moonlet edge waves"):
//   * collisional damping exp(-t / (2 pi N_DAMP)): the forced epicycle decays by 1/e over N_DAMP wavelengths
//     (N_DAMP = 4, the e^(-x / 4 lambda) of the previous implementation; an assumption, see the doc);
//   * streamline-crossing limiter: downstream the phase difference of neighbouring streamlines grows (their
//     wavelengths differ), so dr/da' = 1 + dxi/db develops a secular term of amplitude Q = e(b) t / b. Real rings
//     cannot cross streamlines (collisions dissipate the forced motion where they would), so the amplitude is
//     limited smoothly: x (1 + (Q / Q_C)^2)^(-1/2), which caps the secular term at Q_C; the shader additionally
//     clamps J = 1 / max(dr/da', J_FLOOR) (moonlet eccentricity, inspection scale > 1);
//   * smooth tapers: upstream tail below T0 + 8, end of the table T1 - 12 .. T1, outer b 0.8 B_HI .. B_HI.
//
// Outputs public/data/rings/moonlet_response.{json,f32} and prints the checks (linear limit A -> 6.72 / b^2
// r_H = 2.24 mu a (a/da)^2, amplitudes at the Keeler / Encke edges, vertical amplitude for Daphnis, Jacobi
// constant, min dr/da').
//
// usage: node scripts/data/rings/moonlet_response.mjs [--out DIR] [--qc 1.0] [--ndamp 4] [--check-only]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const OUT = resolve(opt('out', resolve(ROOT, 'public/data/rings')));
const CHECK_ONLY = argv.includes('--check-only');

// ---------------------------------------------------------------- grid / envelope parameters
const B_LO = 2.5, B_HI = 30, NB = 36;
const T0 = -30, T1 = 72, DT = 0.3;
const NT = Math.round((T1 - T0) / DT) + 1;
const T_START = -200;
const N_DAMP = Number(opt('ndamp', 4));        // e-folding of the forced epicycle, in wavelengths (2 pi in t)
const Q_C = Number(opt('qc', 1.0));           // cap of the secular streamline-crossing term
const J_FLOOR = 0.2;                          // shader: J = 1 / max(dr/da', J_FLOOR)  (J <= 5)
const bNode = (i) => B_LO * Math.exp((i * Math.log(B_HI / B_LO)) / (NB - 1));

// ---------------------------------------------------------------- moons (moons.json) and Saturn
const GM_SATURN_KM = 37_931_206.2; // km^3/s^2 (src/core/constants.ts SATURN.GM)
const moonsJson = JSON.parse(readFileSync(resolve(ROOT, 'public/data/moons/moons.json'), 'utf8'));
const MOONLETS = [
  // gap edges: inner/outer edge radii (km) of the rendered profile (tau_main, docs/ring-physics.md section 5) and of
  // the PDS Rings Node catalogue
  { id: 618, name: 'Pan', edgesProfileKm: [133_424, 133_745], edgesCatalogKm: [133_423, 133_745] },
  { id: 635, name: 'Daphnis', edgesProfileKm: [136_483, 136_523], edgesCatalogKm: [136_487, 136_522] },
].map((m) => {
  const j = moonsJson.moons.find((x) => x.id === m.id);
  if (!j) throw new Error(`moon ${m.id} not in moons.json`);
  const mu = j.gmKm3s2 / GM_SATURN_KM;
  const aKm = j.orbit.a;
  return { ...m, gmKm3s2: j.gmKm3s2, massKg: (j.gmKm3s2 * 1e9) / 6.6743e-11, mu, aKm, rHillKm: aKm * Math.cbrt(mu / 3), radiusKm: j.meanRadiusKm };
});

// ---------------------------------------------------------------- integrator
// state: x, y, vx, vy, zc, vzc, zs, vzs
function deriv(t, s, o) {
  const x = s[0], y = s[1];
  const r2 = x * x + y * y;
  const ir3 = 1 / (r2 * Math.sqrt(r2));
  o[0] = s[2];
  o[1] = s[3];
  o[2] = 2 * s[3] + 3 * x - 3 * x * ir3;
  o[3] = -2 * s[2] - 3 * y * ir3;
  o[4] = s[5];
  o[5] = -s[4] + 3 * (Math.cos(t) - s[4]) * ir3;
  o[6] = s[7];
  o[7] = -s[6] + 3 * (Math.sin(t) - s[6]) * ir3;
}
const N_S = 8;
const k1 = new Float64Array(N_S), k2 = new Float64Array(N_S), k3 = new Float64Array(N_S), k4 = new Float64Array(N_S), tmp = new Float64Array(N_S);
function rk4(t, s, h) {
  deriv(t, s, k1);
  for (let i = 0; i < N_S; i++) tmp[i] = s[i] + 0.5 * h * k1[i];
  deriv(t + 0.5 * h, tmp, k2);
  for (let i = 0; i < N_S; i++) tmp[i] = s[i] + 0.5 * h * k2[i];
  deriv(t + 0.5 * h, tmp, k3);
  for (let i = 0; i < N_S; i++) tmp[i] = s[i] + h * k3[i];
  deriv(t + h, tmp, k4);
  for (let i = 0; i < N_S; i++) s[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
}
const jacobi = (s) => 0.5 * (s[2] * s[2] + s[3] * s[3]) - 1.5 * s[0] * s[0] - 3 / Math.hypot(s[0], s[1]);

/**
 * Trajectory of a particle starting at impact parameter b (Hill radii). Returns per output time t_j = T0 + j DT the
 * state (x, vx, zc, vzc, zs, vzs), plus diagnostics.
 */
function trajectory(b, refine = 1) {
  const s = new Float64Array(N_S);
  const dUp = -(8 / 3) / (b * b * Math.abs(T_START));
  s[0] = b + dUp;
  s[1] = 1.5 * b * Math.abs(T_START);
  s[2] = 0;
  s[3] = -1.5 * (b + dUp);
  let t = T_START;
  const ej0 = jacobi(s);
  // far upstream: fixed small steps (not recorded)
  const hUp = 0.05 / refine;
  const nUp = Math.round((T0 - T_START) / hUp);
  let rMin = Infinity;
  for (let i = 0; i < nUp; i++) { rk4(t, s, hUp); t = T_START + (i + 1) * hUp; }
  const out = new Float64Array(NT * 6);
  const rec = (j) => {
    out[j * 6] = s[0]; out[j * 6 + 1] = s[2]; out[j * 6 + 2] = s[4]; out[j * 6 + 3] = s[5]; out[j * 6 + 4] = s[6]; out[j * 6 + 5] = s[7];
  };
  rec(0);
  for (let j = 1; j < NT; j++) {
    const ta = T0 + (j - 1) * DT;
    const at = Math.abs(ta + 0.5 * DT);
    const nSub = (at < 8 ? 60 : at < 30 ? 15 : 6) * refine;
    const h = DT / nSub;
    for (let k = 0; k < nSub; k++) {
      rk4(ta + k * h, s, h);
      rMin = Math.min(rMin, Math.hypot(s[0], s[1]));
    }
    t = T0 + j * DT;
    rec(j);
  }
  // asymptotic epicycle at T1: guiding centre b_g = 4 x + 2 y', x - b_g = c1 cos t + c2 sin t
  const bg = 4 * s[0] + 2 * s[3];
  const xr = s[0] - bg, vx = s[2];
  const c1 = xr * Math.cos(t) - vx * Math.sin(t), c2 = xr * Math.sin(t) + vx * Math.cos(t);
  const e = Math.hypot(c1, c2);
  // vertical: z = a cos t + b sin t asymptotically
  const zAmp = (z, vz) => Math.hypot(z * Math.cos(t) - vz * Math.sin(t), z * Math.sin(t) + vz * Math.cos(t));
  return { out, e, phase: Math.atan2(c2, c1), bg, dB: bg - b, jacobiErr: jacobi(s) - ej0, rMin, zcAmp: zAmp(s[4], s[5]), zsAmp: zAmp(s[6], s[7]) };
}

// ---------------------------------------------------------------- envelope
const smooth = (e0, e1, x) => { const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };
const softplus = (t) => (t > 30 ? t : Math.log1p(Math.exp(t)));
/** envelope at (b, t) for the asymptotic amplitude e(b) (Hill units) */
function envelope(b, t, e) {
  const sp = softplus(t);
  const damp = Math.exp(-sp / (2 * Math.PI * N_DAMP));
  const Q = (e * sp) / b;
  const sat = 1 / Math.sqrt(1 + (Q / Q_C) * (Q / Q_C));
  const taper = smooth(T0, T0 + 8, t) * (1 - smooth(T1 - 12, T1, t)) * (1 - smooth(0.8 * B_HI, B_HI, b));
  return damp * sat * taper;
}

// ---------------------------------------------------------------- build
console.log(`[moonlet] Hill-problem response: ${NB} b in [${B_LO}, ${B_HI}] x ${NT} t in [${T0}, ${T1}] (dt ${DT}); damping ${N_DAMP} wavelengths, crossing cap Q_c = ${Q_C}`);
const data = new Float32Array(3 * NB * NT * 4);
const nodes = [];
const t0 = performance.now();
for (let i = 0; i < NB; i++) {
  const b = bNode(i);
  const db = 1e-4 * b;
  const T = trajectory(b), Tp = trajectory(b + db), Tm = trajectory(b - db);
  nodes.push({ b, e: T.e, E: T.e * b * b, dB: T.dB, phase: T.phase, jacobiErr: T.jacobiErr, rMin: T.rMin, zc: T.zcAmp * b ** 3, zs: T.zsAmp * b ** 3 });
  for (let j = 0; j < NT; j++) {
    const t = T0 + j * DT;
    const o = T.out, op = Tp.out, om = Tm.out, k = j * 6;
    // raw fields and derivatives (FD in b at fixed t; d/dt from the state)
    const x = o[k], vx = o[k + 1];
    const xb = (op[k] - om[k]) / (2 * db), vxb = (op[k + 1] - om[k + 1]) / (2 * db);
    const K = b * b * (x - b), Kt = b * b * vx, Kb = 2 * b * (x - b) + b * b * (xb - 1), Kbt = 2 * b * vx + b * b * vxb;
    const vert = (q) => {
      const z = o[k + q], vz = o[k + q + 1];
      const zb = (op[k + q] - om[k + q]) / (2 * db), vzb = (op[k + q + 1] - om[k + q + 1]) / (2 * db);
      return [b ** 3 * z, b ** 3 * vz, 3 * b * b * z + b ** 3 * zb, 3 * b * b * vz + b ** 3 * vzb];
    };
    // envelope and its derivatives (central differences; e(b) from the neighbouring trajectories)
    const ht = 1e-4;
    const en = envelope(b, t, T.e);
    const ent = (envelope(b, t + ht, T.e) - envelope(b, t - ht, T.e)) / (2 * ht);
    const enb = (envelope(b + db, t, Tp.e) - envelope(b - db, t, Tm.e)) / (2 * db);
    const enbt = (envelope(b + db, t + ht, Tp.e) - envelope(b + db, t - ht, Tp.e) - envelope(b - db, t + ht, Tm.e) + envelope(b - db, t - ht, Tm.e)) / (4 * db * ht);
    const put = (g, [F, Ft, Fb, Fbt]) => {
      const p = ((g * NB + i) * NT + j) * 4;
      data[p] = en * F;
      data[p + 1] = ent * F + en * Ft;
      data[p + 2] = enb * F + en * Fb;
      data[p + 3] = enbt * F + enb * Ft + ent * Fb + en * Fbt;
    };
    put(0, [K, Kt, Kb, Kbt]);
    put(1, vert(2));
    put(2, vert(4));
  }
}
console.log(`[moonlet] integrated ${3 * NB} trajectories in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// ---------------------------------------------------------------- checks
const hermite = (p0, m0, p1, m1, u, h) => {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * h * m1;
};
// asymptotic amplitude e(b) by interpolation of the node values in ln b (checks only)
function eAt(b) {
  const x = (Math.log(b / B_LO) / Math.log(B_HI / B_LO)) * (NB - 1);
  const i = Math.min(NB - 2, Math.max(0, Math.floor(x)));
  const f = x - i;
  return (nodes[i].E * (1 - f) + nodes[i + 1].E * f) / (b * b);
}
// accuracy: step halving at the smallest and an edge-like b
const acc = [B_LO, 3.5, 9].map((b) => {
  const a = trajectory(b), c = trajectory(b, 2);
  let dmax = 0;
  for (let j = 0; j < NT; j++) dmax = Math.max(dmax, Math.abs(a.out[j * 6] - c.out[j * 6]));
  return { b, maxDiffXi: dmax, jacobiErr: a.jacobiErr };
});
// (the guiding centre still approaches its final value as b_g(t) = b_g(inf) - (8/3) / (b^2 t): corrected for the
// Jacobi-constant check b_g(inf)^2 = b^2 + (4/3) e^2, i.e. db ~ (2/3) e^2 / b)
const lin = [3.5, 5, 8, 12, 16, 20, 25, 30].map((b) => {
  const T = trajectory(b);
  const dBinf = T.dB + 8 / 3 / (b * b * T1);
  return { b, 'e b^2 / 6.72': +((T.e * b * b) / 6.72).toFixed(4), 'db_inf / (2/3 e^2 / b)': +(dBinf / ((2 / 3) * (T.e * T.e) / b)).toFixed(3) };
});
console.log('[moonlet] linear limit (Julian & Toomre 1966 / Goldreich & Tremaine 1980: A = 2.24 mu a (a/da)^2 = 6.72 / b^2 r_H):');
console.table(lin);
console.log('[moonlet] integration accuracy (max |xi| change on step halving, Jacobi-constant drift, Hill units):');
console.table(acc.map((a) => ({ b: a.b, 'max dxi': a.maxDiffXi.toExponential(1), 'Jacobi drift': a.jacobiErr.toExponential(1) })));
console.log(`[moonlet] closest approach at b = ${B_LO}: ${nodes[0].rMin.toFixed(2)} r_H (Daphnis radius 0.77 r_H, Pan 0.78 r_H: no collisions)`);

// downstream map diagnostics from the stored (enveloped) table at a given b: peak |xi| in the first wavelength,
// min dr/da' at fixed s along the streamline (secular term included)
function streamlineDiag(b) {
  // locate the cell, interpolate K and its derivatives (bicubic Hermite, as the shader)
  const lx = (Math.log(b / B_LO) / Math.log(B_HI / B_LO)) * (NB - 1);
  const i = Math.min(NB - 2, Math.max(0, Math.floor(lx)));
  const b0 = bNode(i), b1 = bNode(i + 1), hb = b1 - b0, u = (b - b0) / hb;
  let peak1 = 0, minDrda = Infinity, tMin = 0;
  for (let t = 0; t < T1 - 12; t += 0.02) {
    const v = (t - T0) / DT;
    const j = Math.min(NT - 2, Math.floor(v));
    const w = v - j;
    const at = (ii, jj, c) => data[((0 * NB + ii) * NT + jj) * 4 + c];
    // bicubic Hermite: value and derivatives
    const f = (ii) => [
      hermite(at(ii, j, 0), at(ii, j, 1), at(ii, j + 1, 0), at(ii, j + 1, 1), w, DT),
      hermite(at(ii, j, 2), at(ii, j, 3), at(ii, j + 1, 2), at(ii, j + 1, 3), w, DT),
    ];
    const [K0, Kb0] = f(i), [K1, Kb1] = f(i + 1);
    const K = hermite(K0, Kb0, K1, Kb1, u, hb);
    // d/db at fixed t and d/dt by finite differences of the interpolant (diagnostic only)
    const Kat = (bb, tt) => {
      const uu = (bb - b0) / hb, vv = (tt - T0) / DT, jj = Math.min(NT - 2, Math.floor(vv)), ww = vv - jj;
      const g = (ii) => [hermite(at(ii, jj, 0), at(ii, jj, 1), at(ii, jj + 1, 0), at(ii, jj + 1, 1), ww, DT), hermite(at(ii, jj, 2), at(ii, jj, 3), at(ii, jj + 1, 2), at(ii, jj + 1, 3), ww, DT)];
      const [A0, B0] = g(i), [A1, B1] = g(i + 1);
      return hermite(A0, B0, A1, B1, uu, hb);
    };
    const xi = (bb, s) => Kat(bb, s / (1.5 * bb)) / (bb * bb);
    const s = 1.5 * b * t;
    const d = 1e-3;
    const drda = 1 + (xi(b + d, s) - xi(b - d, s)) / (2 * d);
    if (t < 2 * Math.PI + 2) peak1 = Math.max(peak1, Math.abs(K / (b * b)));
    if (drda < minDrda) { minDrda = drda; tMin = t; }
  }
  return { peak1, minDrda, tMin };
}

const report = { linearLimit: lin, accuracy: acc, moonlets: [] };
for (const m of MOONLETS) {
  const rows = [];
  const edges = [['inner (catalogue)', m.edgesCatalogKm[0]], ['outer (catalogue)', m.edgesCatalogKm[1]], ['inner (profile)', m.edgesProfileKm[0]], ['outer (profile)', m.edgesProfileKm[1]]];
  const mr = { id: m.id, name: m.name, gmKm3s2: m.gmKm3s2, massKg: m.massKg, aKm: m.aKm, rHillKm: m.rHillKm, edges: [] };
  for (const [label, rKm] of edges) {
    const da = rKm - m.aKm;
    const b = Math.abs(da) / m.rHillKm;
    const e = eAt(b);
    const linA = 2.24 * m.mu * m.aKm * (m.aKm / da) ** 2;
    const dg = streamlineDiag(b);
    rows.push({ edge: label, 'r (km)': rKm, 'da (km)': +da.toFixed(1), b: +b.toFixed(2), 'A linear (km)': +linA.toFixed(2), 'A Hill (km)': +(e * m.rHillKm).toFixed(2), 'peak 1st wavelength (km)': +(dg.peak1 * m.rHillKm).toFixed(2), 'min dr/da\'': +dg.minDrda.toFixed(2), 'lambda (km)': +(3 * Math.PI * Math.abs(da)).toFixed(0) });
    mr.edges.push({ label, rKm, daKm: da, b, aLinearKm: linA, aHillKm: e * m.rHillKm, peakFirstWavelengthKm: dg.peak1 * m.rHillKm, minDrDa: dg.minDrda, lambdaKm: 3 * Math.PI * Math.abs(da) });
  }
  console.log(`[moonlet] ${m.name}: GM ${m.gmKm3s2} km^3/s^2 (m = ${m.massKg.toExponential(2)} kg), a = ${m.aKm.toFixed(1)} km, r_H = ${m.rHillKm.toFixed(3)} km`);
  console.table(rows);
  report.moonlets.push(mr);
}
// vertical response per unit moonlet vertical amplitude at the Daphnis edges: downstream amplitude envelope over the
// moonlet's vertical phase psi at conjunction, z = Z [cos psi zc(t) - sin psi zs(t)], maximised over t in the first
// two wavelengths and over psi
{
  const D = MOONLETS.find((m) => m.id === 635);
  const vrows = [];
  for (const [label, rKm] of [['inner (catalogue)', D.edgesCatalogKm[0]], ['outer (catalogue)', D.edgesCatalogKm[1]], ['inner (profile)', D.edgesProfileKm[0]], ['outer (profile)', D.edgesProfileKm[1]]]) {
    const b = Math.abs(rKm - D.aKm) / D.rHillKm;
    const T = trajectory(b);
    let zmax = 0;
    for (let j = 0; j < NT; j++) {
      const t = T0 + j * DT;
      if (t < 0 || t > 4 * Math.PI) continue;
      const en = envelope(b, t, T.e);
      // max over psi of |cos psi zc - sin psi zs| = hypot(zc, zs)
      zmax = Math.max(zmax, en * Math.hypot(T.out[j * 6 + 2], T.out[j * 6 + 4]));
    }
    vrows.push({ edge: label, b: +b.toFixed(2), 'zeta_max / Z': +zmax.toFixed(3), 'zeta_max for Z = 6.0 km (km)': +(zmax * 6.0).toFixed(2), 'free inclination amp / Z (no envelope)': +Math.hypot(T.zcAmp, T.zsAmp).toFixed(3) });
  }
  console.log('[moonlet] Daphnis vertical response (moonlet vertical amplitude Z = a sin i; ~6.0 km in Nov 2026 from the live ephemeris):');
  console.table(vrows);
  report.daphnisVertical = vrows;
}

if (!CHECK_ONLY) {
  mkdirSync(OUT, { recursive: true });
  const meta = {
    source: 'scripts/data/rings/moonlet_response.mjs: Hill-problem integrations (Henon & Petit 1986 scaling)',
    format: 'f32 little-endian [3 groups][NB b][NT t][4]; texture width NT, height 3 NB (row = group NB + i)',
    groups: ['K = b^2 xi / r_H: (K, dK/dt, dK/db, d2K/dbdt)', 'Wc = b^3 z_c (moonlet z_m = Z cos t): same layout', 'Ws = b^3 z_s (z_m = Z sin t): same layout'],
    units: 'Hill units: length r_H = a (m/3M)^(1/3), time 1/Omega; t = 0 at conjunction, t > 0 downstream; b = |a\' - a_moon| / r_H',
    bLo: B_LO, bHi: B_HI, nb: NB, bSpacing: 'log: b_i = bLo (bHi/bLo)^(i/(nb-1))',
    t0: T0, t1: T1, dt: DT, nt: NT,
    envelope: { dampingWavelengths: N_DAMP, crossingCap: Q_C, jFloor: J_FLOOR, tapers: `upstream ${T0}..${T0 + 8}, end ${T1 - 12}..${T1}, b ${0.8 * B_HI}..${B_HI}` },
    moonlets: MOONLETS.map((m) => ({ id: m.id, name: m.name, gmKm3s2: m.gmKm3s2, aKm: m.aKm, rHillKm: m.rHillKm })),
    asymptotic: nodes.map((n) => ({ b: +n.b.toFixed(4), E: +n.E.toFixed(5), dB: +n.dB.toExponential(4), phase: +n.phase.toFixed(4), zc: +n.zc.toFixed(4), zs: +n.zs.toFixed(4) })),
    checks: report,
  };
  writeFileSync(resolve(OUT, 'moonlet_response.json'), JSON.stringify(meta, null, 1));
  writeFileSync(resolve(OUT, 'moonlet_response.f32'), Buffer.from(data.buffer));
  console.log(`[moonlet] wrote ${resolve(OUT, 'moonlet_response.json')} and .f32 (${(data.byteLength / 1024).toFixed(0)} KB)`);
}
