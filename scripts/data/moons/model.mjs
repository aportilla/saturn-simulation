// Moon orbit model shared by the build scripts. This is the reference implementation of the runtime model
// in src/moons/orbitModel.ts — keep the two numerically identical.
//
// Model (per moon), time tau = JD(TDB) - EPOCH_JD in days, angles rad, lengths km:
//   reference frame: R_ref = Rz(phi) * Rx(theta) maps reference-frame vectors to SEF (for most moons the
//     Laplace plane; X_ref = ascending node of the reference plane on the SEF equator)
//   lambda(tau) = lambda0 + n*tau + sum_j sum_m [Cl_jm cos(m*nu_j*tau) + Sl_jm sin(m*nu_j*tau)] + dLambda(tau)
//   a(tau)      = a0                + sum_j sum_m [Ca_jm cos(...)       + Sa_jm sin(...)]       + dA(tau)
//   (k, h)      = rot(k0, h0;  pidot*tau) + (dK, dH)(tau)       k + i h = e exp(i varpi)
//   (q, p)      = rot(q0, p0; Omdot*tau) + (dQ, dP)(tau)       q + i p = tan(i/2) exp(i Omega)
//   d*(tau): optional residual table, 4-point Lagrange interpolation on a uniform grid, multiplied by a
//     smoothstep taper near the table ends (so the model reverts smoothly to the mean elements outside).
//   Position: equinoctial Kepler ellipse (Broucke & Cefola 1972) from (a, k, h, q, p, lambda).
export const DEG = Math.PI / 180;
export const TWO_PI = 2 * Math.PI;
export const DAY = 86400;
export const J2000_JD = 2451545.0;
/** Model epoch: 2025-01-01T00:00 TDB */
export const EPOCH_JD = 2460676.5;

// ---------------------------------------------------------------- frames (mirror of src/core/ephemeris.ts)
const RA0 = 40.589 * DEG;
const DEC0 = 83.537 * DEG;
const SZ = [Math.cos(DEC0) * Math.cos(RA0), Math.cos(DEC0) * Math.sin(RA0), Math.sin(DEC0)];
const SX = [-Math.sin(RA0), Math.cos(RA0), 0];
const SY = [SZ[1] * SX[2] - SZ[2] * SX[1], SZ[2] * SX[0] - SZ[0] * SX[2], SZ[0] * SX[1] - SZ[1] * SX[0]];
export const SEF_AXES_ICRF = { x: SX, y: SY, z: SZ };
export function icrfToSef(v) {
  return [
    SX[0] * v[0] + SX[1] * v[1] + SX[2] * v[2],
    SY[0] * v[0] + SY[1] * v[1] + SY[2] * v[2],
    SZ[0] * v[0] + SZ[1] * v[1] + SZ[2] * v[2],
  ];
}
export function sefToIcrf(v) {
  return [
    SX[0] * v[0] + SY[0] * v[1] + SZ[0] * v[2],
    SX[1] * v[0] + SY[1] * v[1] + SZ[1] * v[2],
    SX[2] * v[0] + SY[2] * v[1] + SZ[2] * v[2],
  ];
}
/** RA/Dec (rad, ICRF) -> SEF unit vector */
export function raDecToSef(ra, dec) {
  return icrfToSef([Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)]);
}
/** Reference frame matrix (row-major 3x3, ref -> SEF) for tilt theta and node phi. */
export function refMatrix(theta, phi) {
  const cf = Math.cos(phi), sf = Math.sin(phi), ct = Math.cos(theta), st = Math.sin(theta);
  return [cf, -sf * ct, sf * st, sf, cf * ct, -cf * st, 0, st, ct];
}
/** Minimal rotation taking +Z to the unit vector (u, v, sqrt(1-u^2-v^2)) (row-major). */
export function tiltMatrix(u, v) {
  const w = Math.sqrt(Math.max(0, 1 - u * u - v * v));
  const d = 1 + w;
  return [w + (v * v) / d, (-u * v) / d, u, (-u * v) / d, w + (u * u) / d, v, -u, -v, w];
}
export function mat3mul(A, B) {
  const C = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return C;
}
/** Frame matrix of an orbit: base (fixed) x tilt(tu, tv) (fit parameters), or an explicit orbit.Rfix. */
export function frameMatrix(orbit) {
  if (orbit.Rfix) return orbit.Rfix;
  const T = tiltMatrix(orbit.tu ?? 0, orbit.tv ?? 0);
  return orbit.base ? mat3mul(orbit.base, T) : T;
}
/** SEF unit pole -> (theta, phi) such that refMatrix(theta, phi) has that pole as its Z column. */
export function poleToThetaPhi(P) {
  const theta = Math.acos(Math.max(-1, Math.min(1, P[2])));
  const phi = Math.atan2(P[0], -P[1]);
  return { theta, phi: Number.isFinite(phi) ? phi : 0 };
}

// ---------------------------------------------------------------- Lagrange interpolation
export function lagrangeWeights(u, w) {
  w[0] = (-u * (u - 1) * (u - 2)) / 6;
  w[1] = ((u + 1) * (u - 1) * (u - 2)) / 2;
  w[2] = (-(u + 1) * u * (u - 2)) / 2;
  w[3] = ((u + 1) * u * (u - 1)) / 6;
  return w;
}
export function lagrangeDWeights(u, w) {
  w[0] = -(3 * u * u - 6 * u + 2) / 6;
  w[1] = (3 * u * u - 4 * u - 1) / 2;
  w[2] = -(3 * u * u - 2 * u - 2) / 2;
  w[3] = (3 * u * u - 1) / 6;
  return w;
}
function smoothstep(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

// ---------------------------------------------------------------- Kepler (equinoctial)
/** Solve lambda = F + h cos F - k sin F for the eccentric longitude F. */
export function solveKeplerEq(lambda, k, h) {
  let F = lambda + k * Math.sin(lambda) - h * Math.cos(lambda);
  for (let it = 0; it < 40; it++) {
    const s = Math.sin(F), c = Math.cos(F);
    const f = F + h * c - k * s - lambda;
    const fp = 1 - h * s - k * c;
    const d = f / fp;
    F -= d;
    if (Math.abs(d) < 1e-15) break;
  }
  return F;
}

/**
 * Elements (a, lambda, k, h, q, p, lambdaDot[rad/day]) -> position (km) & velocity (km/s) in the reference
 * frame. out: Float64Array(6). Also returns the orbit-frame unit vectors f, g, w (each 3) in out2 if given.
 */
export function elementsToState(a, lambda, k, h, q, p, ldot, out, fgw) {
  let L = lambda % TWO_PI;
  if (L < 0) L += TWO_PI;
  const F = solveKeplerEq(L, k, h);
  const sF = Math.sin(F), cF = Math.cos(F);
  const e2 = k * k + h * h;
  const beta = 1 / (1 + Math.sqrt(1 - e2));
  const X1 = a * ((1 - beta * h * h) * cF + h * k * beta * sF - k);
  const Y1 = a * ((1 - beta * k * k) * sF + h * k * beta * cF - h);
  const r = a * (1 - k * cF - h * sF);
  const na = (ldot / DAY) * a * a / r;
  const X1d = na * (h * k * beta * cF - (1 - beta * h * h) * sF);
  const Y1d = na * ((1 - beta * k * k) * cF - h * k * beta * sF);
  const s = 1 + p * p + q * q;
  const fx = (1 - p * p + q * q) / s, fy = (2 * p * q) / s, fz = (-2 * p) / s;
  const gx = (2 * p * q) / s, gy = (1 + p * p - q * q) / s, gz = (2 * q) / s;
  out[0] = X1 * fx + Y1 * gx;
  out[1] = X1 * fy + Y1 * gy;
  out[2] = X1 * fz + Y1 * gz;
  out[3] = X1d * fx + Y1d * gx;
  out[4] = X1d * fy + Y1d * gy;
  out[5] = X1d * fz + Y1d * gz;
  if (fgw) {
    fgw[0] = fx; fgw[1] = fy; fgw[2] = fz;
    fgw[3] = gx; fgw[4] = gy; fgw[5] = gz;
    fgw[6] = (2 * p) / s; fgw[7] = (-2 * q) / s; fgw[8] = (1 - p * p - q * q) / s;
  }
  return out;
}

// ---------------------------------------------------------------- orbit model
/**
 * orbit = {
 *   theta, phi,                      reference frame
 *   a, n, lambda0, k0, h0, pidot, q0, p0, Omdot,
 *   lib: [{ nu, cl:[...], sl:[...], ca?:[...], sa?:[...], ck?, sk?, ch?, sh? }]   harmonic m = index+1
 *        (ck.. = eccentricity-vector terms added to (k0, h0) before the apsidal rotation)
 *   table: { startJd, step, count, taper, data: Float32Array|Float64Array (count*6, fields dl,da,dk,dh,dq,dp) } | null
 * }
 */
const _w = new Float64Array(4);
const _dw = new Float64Array(4);
/** Table weights at tau (days since EPOCH_JD): returns base index or -1; fills _w and the taper weight. */
function tableLookup(tb, tau, w) {
  const f = (tau - (tb.startJd - EPOCH_JD)) / tb.step;
  const i1 = Math.floor(f);
  if (i1 < 1 || i1 > tb.count - 3) return -1;
  lagrangeWeights(f - i1, w);
  const tLo = tb.startJd - EPOCH_JD + tb.step;
  const tHi = tb.startJd - EPOCH_JD + (tb.count - 2) * tb.step;
  tb._wt = tb.taper > 0 ? smoothstep((tau - tLo) / tb.taper) * smoothstep((tHi - tau) / tb.taper) : 1;
  return i1 - 1;
}

/** Mean + tabulated elements at tau (days since EPOCH_JD). Element tables only (kind 'elements'). */
export function orbitElementsTau(orbit, tau, el) {
  let lam = orbit.lambda0 + orbit.n * tau;
  let ldot = orbit.n;
  let a = orbit.a;
  let k0 = orbit.k0, h0 = orbit.h0;
  if (orbit.lib) {
    for (const L of orbit.lib) {
      const M = L.cl.length;
      const c1 = Math.cos(L.nu * tau), s1 = Math.sin(L.nu * tau);
      let c = c1, s = s1;
      for (let m = 0; m < M; m++) {
        const w = (m + 1) * L.nu;
        lam += L.cl[m] * c + L.sl[m] * s;
        ldot += w * (L.sl[m] * c - L.cl[m] * s);
        if (L.ca) a += L.ca[m] * c + L.sa[m] * s;
        // eccentricity-vector libration, in the frame co-rotating with the mean apse
        if (L.ck) { k0 += L.ck[m] * c + L.sk[m] * s; h0 += L.ch[m] * c + L.sh[m] * s; }
        const cn = c * c1 - s * s1;
        s = s * c1 + c * s1;
        c = cn;
      }
    }
  }
  const cp = Math.cos(orbit.pidot * tau), sp = Math.sin(orbit.pidot * tau);
  let k = k0 * cp - h0 * sp;
  let h = k0 * sp + h0 * cp;
  const co = Math.cos(orbit.Omdot * tau), so = Math.sin(orbit.Omdot * tau);
  let q = orbit.q0 * co - orbit.p0 * so;
  let p = orbit.q0 * so + orbit.p0 * co;
  const tb = orbit.table;
  if (tb && (tb.kind ?? 'elements') === 'elements') {
    const b0 = tableLookup(tb, tau, _w);
    if (b0 >= 0) {
      const u = (tau - (tb.startJd - EPOCH_JD)) / tb.step - (b0 + 1);
      lagrangeDWeights(u, _dw);
      const wt = tb._wt;
      const d = tb.data;
      const b = b0 * 6;
      let dl = 0, da = 0, dk = 0, dh = 0, dq = 0, dp = 0, dld = 0;
      for (let m = 0; m < 4; m++) {
        const o = b + m * 6;
        const wm = _w[m];
        dl += wm * d[o]; da += wm * d[o + 1]; dk += wm * d[o + 2];
        dh += wm * d[o + 3]; dq += wm * d[o + 4]; dp += wm * d[o + 5];
        dld += _dw[m] * d[o];
      }
      lam += wt * dl; a += wt * da; k += wt * dk; h += wt * dh; q += wt * dq; p += wt * dp;
      ldot += (wt * dld) / tb.step;
    }
  }
  el.a = a; el.lambda = lam; el.k = k; el.h = h; el.q = q; el.p = p; el.ldot = ldot;
  return el;
}
/** jd-based convenience wrapper (fitting code). */
export function orbitElements(orbit, jd, el) {
  return orbitElementsTau(orbit, jd - EPOCH_JD, el);
}

const _st = new Float64Array(6);
const _el = {};
/** SEF position (km) at tau, including a Cartesian residual table if present. */
export function orbitPosTau(orbit, tau, out) {
  orbitElementsTau(orbit, tau, _el);
  elementsToState(_el.a, _el.lambda, _el.k, _el.h, _el.q, _el.p, _el.ldot, _st);
  const R = orbit.R ?? (orbit.R = frameMatrix(orbit));
  let x = R[0] * _st[0] + R[1] * _st[1] + R[2] * _st[2];
  let y = R[3] * _st[0] + R[4] * _st[1] + R[5] * _st[2];
  let z = R[6] * _st[0] + R[7] * _st[1] + R[8] * _st[2];
  const tb = orbit.table;
  if (tb && tb.kind === 'cartesian') {
    const b0 = tableLookup(tb, tau, _w);
    if (b0 >= 0) {
      const d = tb.data, wt = tb._wt, b = b0 * 3;
      x += wt * (_w[0] * d[b] + _w[1] * d[b + 3] + _w[2] * d[b + 6] + _w[3] * d[b + 9]);
      y += wt * (_w[0] * d[b + 1] + _w[1] * d[b + 4] + _w[2] * d[b + 7] + _w[3] * d[b + 10]);
      z += wt * (_w[0] * d[b + 2] + _w[1] * d[b + 5] + _w[2] * d[b + 8] + _w[3] * d[b + 11]);
    }
  }
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/** Velocity by central difference of the full model (exactly consistent with the positions). */
export const VEL_DT_DAYS = 2 / DAY;
const _pa = new Float64Array(3), _pb = new Float64Array(3);
/** SEF position (km) and velocity (km/s) at jd (TDB). */
export function orbitStateSef(orbit, jd, out = new Float64Array(6)) {
  const tau = jd - EPOCH_JD;
  orbitPosTau(orbit, tau + VEL_DT_DAYS, _pa);
  orbitPosTau(orbit, tau - VEL_DT_DAYS, _pb);
  orbitPosTau(orbit, tau, out);
  const inv = 1 / (2 * VEL_DT_DAYS * DAY);
  out[3] = (_pa[0] - _pb[0]) * inv;
  out[4] = (_pa[1] - _pb[1]) * inv;
  out[5] = (_pa[2] - _pb[2]) * inv;
  return out;
}
/** Position only (fast path for fitting). */
export function orbitPosSef(orbit, jd, out) {
  return orbitPosTau(orbit, jd - EPOCH_JD, out);
}

/** Decompose an error vector (model - truth) into radial / along-track / normal components w.r.t. truth. */
export function ricError(truthPos, truthVel, modelPos) {
  const r = Math.hypot(truthPos[0], truthPos[1], truthPos[2]);
  const R = [truthPos[0] / r, truthPos[1] / r, truthPos[2] / r];
  const hx = truthPos[1] * truthVel[2] - truthPos[2] * truthVel[1];
  const hy = truthPos[2] * truthVel[0] - truthPos[0] * truthVel[2];
  const hz = truthPos[0] * truthVel[1] - truthPos[1] * truthVel[0];
  const hn = Math.hypot(hx, hy, hz);
  const N = [hx / hn, hy / hn, hz / hn];
  const T = [N[1] * R[2] - N[2] * R[1], N[2] * R[0] - N[0] * R[2], N[0] * R[1] - N[1] * R[0]];
  const d = [modelPos[0] - truthPos[0], modelPos[1] - truthPos[1], modelPos[2] - truthPos[2]];
  const dr = d[0] * R[0] + d[1] * R[1] + d[2] * R[2];
  const dt = d[0] * T[0] + d[1] * T[1] + d[2] * T[2];
  const dn = d[0] * N[0] + d[1] * N[1] + d[2] * N[2];
  // angular separation seen from Saturn (deg) and along-track angle (deg)
  const mr = Math.hypot(modelPos[0], modelPos[1], modelPos[2]);
  const cosang = (modelPos[0] * truthPos[0] + modelPos[1] * truthPos[1] + modelPos[2] * truthPos[2]) / (mr * r);
  const ang = Math.acos(Math.max(-1, Math.min(1, cosang))) / DEG;
  return { dr, dt, dn, dist: Math.hypot(d[0], d[1], d[2]), alongDeg: Math.atan2(dt, r) / DEG, angDeg: ang };
}
