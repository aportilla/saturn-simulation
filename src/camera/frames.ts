// Moving reference frames the camera can be attached to. Every frame is evaluated at the current frame
// time: origin (SEF, m) and orientation (local -> SEF quaternion). All doubles.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { FrameState, MoonState } from '../core/FrameState';
import { rotZQuat, wrap2Pi } from './math';

export type FrameRef =
  /** Saturn-centered, SEF axes (inertial) */
  | { kind: 'saturn-inertial' }
  /** Saturn-centered, rotating with System III (body-fixed) */
  | { kind: 'saturn-body' }
  /** Moon-centered; Z = the moon's north pole, X = SEF +X projected perpendicular to it (non-rotating) */
  | { kind: 'moon-up'; body: string }
  /** Moon-centered; X = radial (away from Saturn), Z = orbit normal, Y = along-track (co-rotating with the orbit) */
  | { kind: 'moon-orbital'; body: string }
  /** Moon body frame (MoonState.orient) */
  | { kind: 'moon-body'; body: string }
  /** Snapshot of a ring (Hill) frame: origin on a circular orbit, axes radial / prograde / north */
  | { kind: 'ring'; r0: number; phiRef: number; tRef: number; omega: number };

/** Moon lookup by lower-case name. Returns null for 'saturn' or unknown names. */
export function findMoon(f: FrameState, key: string): MoonState | null {
  if (key === 'saturn') return null;
  for (const m of f.moons) if (m.name.toLowerCase() === key) return m;
  return null;
}

const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _m = new Matrix4();

/** Evaluate a frame at the current frame time. */
export function evalFrame(ref: FrameRef, f: FrameState, outOrigin: Vector3, outQuat: Quaternion): void {
  switch (ref.kind) {
    case 'saturn-inertial':
      outOrigin.set(0, 0, 0);
      outQuat.identity();
      return;
    case 'saturn-body':
      outOrigin.set(0, 0, 0);
      rotZQuat(f.saturnRotation, outQuat);
      return;
    case 'ring': {
      const phi = wrap2Pi(ref.phiRef + ref.omega * (f.t - ref.tRef));
      outOrigin.set(ref.r0 * Math.cos(phi), ref.r0 * Math.sin(phi), 0);
      rotZQuat(phi, outQuat);
      return;
    }
    default: {
      const m = findMoon(f, ref.body);
      if (!m) {
        outOrigin.set(0, 0, 0);
        outQuat.identity();
        return;
      }
      outOrigin.copy(m.pos);
      if (ref.kind === 'moon-body') {
        outQuat.copy(m.orient);
      } else if (ref.kind === 'moon-up') {
        moonUpAxes(m, _x, _y, _z);
        _m.makeBasis(_x, _y, _z);
        outQuat.setFromRotationMatrix(_m);
      } else {
        moonOrbitalAxes(m, _x, _y, _z);
        _m.makeBasis(_x, _y, _z);
        outQuat.setFromRotationMatrix(_m);
      }
    }
  }
}

/** Non-rotating axes with Z = the moon's north pole. */
export function moonUpAxes(m: MoonState, x: Vector3, y: Vector3, z: Vector3): void {
  z.set(0, 0, 1).applyQuaternion(m.orient).normalize();
  x.set(1, 0, 0).addScaledVector(z, -z.x);
  if (x.lengthSq() < 1e-12) x.set(0, 1, 0).addScaledVector(z, -z.y);
  x.normalize();
  y.crossVectors(z, x);
}

/** Orbit-following axes: X radial (away from Saturn), Z orbit normal, Y = Z x X (along-track). */
export function moonOrbitalAxes(m: MoonState, x: Vector3, y: Vector3, z: Vector3): void {
  x.copy(m.pos).normalize();
  z.crossVectors(m.pos, m.vel);
  if (z.lengthSq() < 1e-12) z.set(0, 0, 1);
  z.normalize();
  y.crossVectors(z, x).normalize();
  x.crossVectors(y, z);
}

/** Approximate angular rate (rad/s) of a moon about Saturn's polar axis. */
export function moonAngularRateZ(m: MoonState): number {
  const r2 = m.pos.x * m.pos.x + m.pos.y * m.pos.y;
  if (r2 <= 0) return 0;
  return (m.pos.x * m.vel.y - m.pos.y * m.vel.x) / r2;
}
