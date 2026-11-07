// Hyperion's chaotic rotation: rigid-body Euler equations with Saturn's gravity-gradient torque, integrated
// (RK4) along Hyperion's fitted orbit. Produces checkpoints (quaternion body->SEF + body angular velocity)
// from which the runtime (src/moons/hyperionRotation.ts) re-integrates at most half a checkpoint interval.
//
// Body axes: x = long axis (a = 180.1 km), y = intermediate (133.0), z = short (102.7). Homogeneous ellipsoid
// moments: A = b^2+c^2, B = a^2+c^2, C = a^2+b^2 (x m/5). Units: days, rad/day, km.
//   dw_x/dt = (B-C)/A (w_y w_z - 3 GM/r^3 r_y r_z)   (and cyclic), r = unit vector moon->Saturn (body frame)
//   dq/dt   = 1/2 q (x) (w, 0)
// Initial state (illustrative; the real present-day orientation is unpredictable because the rotation is
// chaotic): 2005-09-26 0h TDB (Cassini close flyby), |w| = 72 deg/day (Thomas et al. 2007, Nature 448:50),
// spin axis 35 deg from the long axis in the long/short-axis plane, spin axis in space 40 deg from SEF +Z.
import { DEG } from './model.mjs';

export const HYP_RADII = [180.1, 133.0, 102.7];
const [ra, rb, rc] = HYP_RADII;
const A = rb * rb + rc * rc, B = ra * ra + rc * rc, C = ra * ra + rb * rb;
export const HYP_K = [(B - C) / A, (C - A) / B, (A - B) / C];
export const GM_SATURN_KM3_D2 = 37931206.2 * 86400 * 86400;
export const HYP_EPOCH_JD = 2453639.5;

/** rotate SEF vector v into the body frame of q (body->SEF): v_b = q* v q */
function toBody(q, v, out) {
  // conj(q) = (-x,-y,-z,w): v' = v + 2w(c x v) + 2 c x (c x v), c = -q_v
  const cx = -q[0], cy = -q[1], cz = -q[2], w = q[3];
  const tx = 2 * (cy * v[2] - cz * v[1]);
  const ty = 2 * (cz * v[0] - cx * v[2]);
  const tz = 2 * (cx * v[1] - cy * v[0]);
  out[0] = v[0] + w * tx + (cy * tz - cz * ty);
  out[1] = v[1] + w * ty + (cz * tx - cx * tz);
  out[2] = v[2] + w * tz + (cx * ty - cy * tx);
  return out;
}

const _rb = new Float64Array(3);
/** derivative of y = [qx,qy,qz,qw, wx,wy,wz]; s = Saturn direction (moon->Saturn, SEF unit), mu3 = 3GM/r^3 */
export function deriv(y, s, mu3, dy) {
  const q = y;
  toBody(q, s, _rb);
  const rx = _rb[0], ry = _rb[1], rz = _rb[2];
  const wx = y[4], wy = y[5], wz = y[6];
  dy[4] = HYP_K[0] * (wy * wz - mu3 * ry * rz);
  dy[5] = HYP_K[1] * (wz * wx - mu3 * rz * rx);
  dy[6] = HYP_K[2] * (wx * wy - mu3 * rx * ry);
  // dq = 1/2 q (x) (w,0)
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  dy[0] = 0.5 * (qw * wx + (qy * wz - qz * wy));
  dy[1] = 0.5 * (qw * wy + (qz * wx - qx * wz));
  dy[2] = 0.5 * (qw * wz + (qx * wy - qy * wx));
  dy[3] = -0.5 * (qx * wx + qy * wy + qz * wz);
}

/** One RK4 step of size h (days). sat(t, out) gives [sx,sy,sz,mu3] at time t. */
const k1 = new Float64Array(7), k2 = new Float64Array(7), k3 = new Float64Array(7), k4 = new Float64Array(7), yt = new Float64Array(7);
const sv = new Float64Array(4);
export function rk4(y, t, h, sat) {
  sat(t, sv); deriv(y, sv, sv[3], k1);
  for (let i = 0; i < 7; i++) yt[i] = y[i] + 0.5 * h * k1[i];
  sat(t + 0.5 * h, sv); deriv(yt, sv, sv[3], k2);
  for (let i = 0; i < 7; i++) yt[i] = y[i] + 0.5 * h * k2[i];
  deriv(yt, sv, sv[3], k3);
  for (let i = 0; i < 7; i++) yt[i] = y[i] + h * k3[i];
  sat(t + h, sv); deriv(yt, sv, sv[3], k4);
  for (let i = 0; i < 7; i++) y[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  const n = Math.hypot(y[0], y[1], y[2], y[3]);
  y[0] /= n; y[1] /= n; y[2] /= n; y[3] /= n;
}

/** Initial state at HYP_EPOCH_JD. */
export function initialState() {
  const rate = 72 * DEG; // rad/day
  const tilt = 35 * DEG;
  const wb = [Math.cos(tilt), 0, Math.sin(tilt)]; // spin direction in the body frame
  // spin axis in SEF: 40 deg from +Z toward azimuth 200 deg
  const th = 40 * DEG, az = 200 * DEG;
  const e1 = [Math.sin(th) * Math.cos(az), Math.sin(th) * Math.sin(az), Math.cos(th)];
  // body triad (wb, yb, wb x yb) -> SEF triad (e1, e2, e1 x e2)
  const yb = [0, 1, 0];
  const zb = [wb[1] * yb[2] - wb[2] * yb[1], wb[2] * yb[0] - wb[0] * yb[2], wb[0] * yb[1] - wb[1] * yb[0]];
  let e2 = [-e1[1], e1[0], 0];
  const l = Math.hypot(e2[0], e2[1]);
  e2 = [e2[0] / l, e2[1] / l, 0];
  const e3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  // M = [e1 e2 e3] * [wb yb zb]^T  (body -> SEF)
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[3 * i + j] = e1[i] * wb[j] + e2[i] * yb[j] + e3[i] * zb[j];
  const q = matToQuat(M);
  return Float64Array.from([q[0], q[1], q[2], q[3], rate * wb[0], rate * wb[1], rate * wb[2]]);
}

export function matToQuat(m) {
  const m11 = m[0], m12 = m[1], m13 = m[2], m21 = m[3], m22 = m[4], m23 = m[5], m31 = m[6], m32 = m[7], m33 = m[8];
  const tr = m11 + m22 + m33;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}
