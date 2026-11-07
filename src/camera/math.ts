// Double-precision camera math (three.js Vector3/Quaternion hold JS doubles).
// Camera convention (three.js): the camera looks along its local -Z with +Y up; camQuat = camera -> SEF.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { SATURN } from '../core/constants';

const _m4 = new Matrix4();
const _f = new Vector3();
const _r = new Vector3();
const _u = new Vector3();
const _t = new Vector3();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _va = new Vector3();

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Wrap an angle to (-pi, pi]. */
export function wrapPi(a: number): number {
  const t = a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
  return t <= -Math.PI ? t + 2 * Math.PI : t;
}
/** Wrap an angle to [0, 2pi). */
export function wrap2Pi(a: number): number {
  return a - 2 * Math.PI * Math.floor(a / (2 * Math.PI));
}

/** Camera -> world quaternion for a camera looking along `forward` with roughly `upHint` up. */
export function lookQuat(forward: Vector3, upHint: Vector3, out: Quaternion): Quaternion {
  _f.copy(forward).normalize();
  _r.crossVectors(_f, upHint);
  if (_r.lengthSq() < 1e-14 * Math.max(upHint.lengthSq(), 1e-300)) {
    // degenerate: forward parallel to the up hint -> any perpendicular
    _t.set(0, 1, 0);
    if (Math.abs(_f.y) > 0.9) _t.set(1, 0, 0);
    _r.crossVectors(_f, _t);
  }
  _r.normalize();
  _u.crossVectors(_r, _f).normalize();
  _t.copy(_f).negate();
  _m4.makeBasis(_r, _u, _t);
  return out.setFromRotationMatrix(_m4);
}

/** Rotation about +Z by angle phi (local x -> (cos phi, sin phi, 0)). */
export function rotZQuat(phi: number, out: Quaternion): Quaternion {
  return out.set(0, 0, Math.sin(phi / 2), Math.cos(phi / 2));
}

/** Quaternion whose columns (as a rotation matrix) are the given orthonormal axes. */
export function basisQuat(x: Vector3, y: Vector3, z: Vector3, out: Quaternion): Quaternion {
  _m4.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m4);
}

/** Spherical interpolation between unit vectors (handles antiparallel inputs). `out` may alias a or b. */
export function slerpUnit(a: Vector3, b: Vector3, t: number, out: Vector3): Vector3 {
  _qa.setFromUnitVectors(a, b);
  _qb.identity().slerp(_qa, t);
  _va.copy(a).applyQuaternion(_qb);
  return out.copy(_va);
}

/** Camera forward (SEF) from a camera quaternion. */
export function quatForward(q: Quaternion, out: Vector3): Vector3 {
  return out.set(0, 0, -1).applyQuaternion(q);
}
export function quatUp(q: Quaternion, out: Vector3): Vector3 {
  return out.set(0, 1, 0).applyQuaternion(q);
}
export function quatRight(q: Quaternion, out: Vector3): Vector3 {
  return out.set(1, 0, 0).applyQuaternion(q);
}

/**
 * Position profile of a trapezoidal velocity curve with raised-cosine ramps of fraction `a` at both ends:
 * zero velocity at t = 0 and t = 1 (no jolt at departure or arrival), constant speed in the middle.
 */
export function easeTrap(t: number, a = 0.22): number {
  t = clamp(t, 0, 1);
  const vmax = 1 / (1 - a);
  if (t < a) return vmax * (t / 2 - (a / (2 * Math.PI)) * Math.sin((Math.PI * t) / a));
  if (t > 1 - a) return 1 - easeTrap(1 - t, a);
  return vmax * (a / 2 + (t - a));
}

// ------------------------------------------------------------------ Saturn's 1-bar ellipsoid
/** Radius (m) of the 1-bar ellipsoid along a direction with geocentric latitude given by (sin, cos). */
export function saturnRadiusAt(sinLat: number, cosLat: number): number {
  const a = SATURN.R_EQ, b = SATURN.R_POL;
  return (a * b) / Math.sqrt(b * b * cosLat * cosLat + a * a * sinLat * sinLat);
}
/** Radial altitude (m) above the 1-bar ellipsoid of an SEF point. */
export function saturnAltitude(p: Vector3): number {
  const rc = Math.hypot(p.x, p.y);
  const d = Math.hypot(rc, p.z);
  if (d === 0) return -SATURN.R_POL;
  return d - saturnRadiusAt(p.z / d, rc / d);
}
/** Outward unit normal of the ellipsoid through point p (body or SEF axes; axisymmetric). */
export function saturnNormal(p: Vector3, out: Vector3): Vector3 {
  const a2 = SATURN.R_EQ * SATURN.R_EQ, b2 = SATURN.R_POL * SATURN.R_POL;
  return out.set(p.x / a2, p.y / a2, p.z / b2).normalize();
}
/** Does the segment o + t*d, t in (0, tMax], intersect Saturn's ellipsoid? (d need not be unit) */
export function segmentHitsSaturn(o: Vector3, d: Vector3, tMax: number): boolean {
  const a = SATURN.R_EQ, k = SATURN.R_EQ / SATURN.R_POL;
  const ox = o.x / a, oy = o.y / a, oz = (o.z * k) / a;
  const dx = d.x / a, dy = d.y / a, dz = (d.z * k) / a;
  const A = dx * dx + dy * dy + dz * dz;
  const B = 2 * (ox * dx + oy * dy + oz * dz);
  const C = ox * ox + oy * oy + oz * oz - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || A === 0) return false;
  const sq = Math.sqrt(disc);
  const t0 = (-B - sq) / (2 * A), t1 = (-B + sq) / (2 * A);
  return t1 > 0 && t0 < tMax;
}
/** Radius of a triaxial ellipsoid (semi-axes r) along a unit body-frame direction d. */
export function ellipsoidRadiusAlong(d: Vector3, r: Vector3): number {
  const x = d.x / r.x, y = d.y / r.y, z = d.z / r.z;
  return 1 / Math.sqrt(x * x + y * y + z * z);
}
