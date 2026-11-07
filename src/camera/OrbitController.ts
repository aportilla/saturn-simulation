// Orbit / inspect mode: the camera circles a target (Saturn or a moon), following it, always looking at its
// center. Up = the target's north (SEF +Z for Saturn, the body's pole for moons). Zoom is exponential in
// altitude, from just above the surface to 1e11 m.
import { Quaternion, Vector3 } from 'three';
import type { FrameState } from '../core/FrameState';
import { evalFrame, findMoon, type FrameRef } from './frames';
import { axis, type InputFrame } from './Input';
import { clamp, ellipsoidRadiusAlong, lookQuat, saturnRadiusAt } from './math';

export const MAX_DISTANCE = 1e11;
const EL_LIMIT = (89.5 * Math.PI) / 180;

const _o = new Vector3();
const _q = new Quaternion();
const _qi = new Quaternion();
const _off = new Vector3();
const _fwd = new Vector3();
const _up = new Vector3();
const _ql = new Quaternion();
const _d = new Vector3();

export interface OrbitInit {
  target: string;
  dist: number;
  /** radians, in the target's up-frame */
  az: number;
  el: number;
  /** for moons: 'up' = non-rotating axes, 'orbital' = co-rotating with the moon's orbit */
  axes?: 'up' | 'orbital';
}

export class OrbitController {
  readonly type = 'orbit' as const;
  target: string;
  axes: 'up' | 'orbital';
  dist: number;
  az: number;
  el: number;
  private altGoal: number | null = null;

  constructor(o: OrbitInit) {
    this.target = o.target.toLowerCase();
    this.axes = o.axes ?? 'up';
    this.dist = o.dist;
    this.az = o.az;
    this.el = clamp(o.el, -EL_LIMIT, EL_LIMIT);
  }

  frameRef(): FrameRef {
    if (this.target === 'saturn') return { kind: 'saturn-inertial' };
    return this.axes === 'orbital' ? { kind: 'moon-orbital', body: this.target } : { kind: 'moon-up', body: this.target };
  }

  /** Display name of the target (falls back to Saturn if the moon is unknown). */
  targetName(f: FrameState): string {
    const m = findMoon(f, this.target);
    return m ? m.name : 'Saturn';
  }

  /** Local offset direction (unit) in the target frame. */
  private offsetDir(out: Vector3): Vector3 {
    const ce = Math.cos(this.el);
    return out.set(ce * Math.cos(this.az), ce * Math.sin(this.az), Math.sin(this.el));
  }

  /** Surface radius of the target in the camera's direction (m). */
  surfaceRadius(f: FrameState): number {
    const m = findMoon(f, this.target);
    if (!m) {
      // Saturn's up-frame is SEF, so el is the geocentric latitude
      return saturnRadiusAt(Math.sin(this.el), Math.cos(this.el));
    }
    evalFrame(this.frameRef(), f, _o, _q);
    this.offsetDir(_d).applyQuaternion(_q); // SEF
    _qi.copy(m.orient).invert();
    _d.applyQuaternion(_qi); // body frame
    return ellipsoidRadiusAlong(_d, m.radii);
  }

  minAltitude(f: FrameState): number {
    const m = findMoon(f, this.target);
    if (!m) return 20e3;
    return Math.max(20, 1e-3 * m.meanRadius);
  }

  altitude(f: FrameState): number {
    return this.dist - this.surfaceRadius(f);
  }

  update(f: FrameState, inp: InputFrame | null, dtReal: number): void {
    const R = this.surfaceRadius(f);
    let alt = Math.max(this.dist - R, this.minAltitude(f));
    if (inp) {
      // rotation rate scaled so that dragging feels like grabbing the surface when close
      const k = inp.lookScale * clamp(alt / R, 0.002, 3);
      this.az -= inp.dragX * k;
      this.el = clamp(this.el + inp.dragY * k, -EL_LIMIT, EL_LIMIT);
      const keys = inp.keys;
      const kr = 0.9 * clamp(alt / R, 0.003, 1.5) * dtReal * (inp.shift ? 4 : 1);
      this.az += kr * axis(keys, ['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
      this.el = clamp(this.el + kr * axis(keys, ['KeyR', 'ArrowUp', 'PageUp'], ['KeyF', 'ArrowDown', 'PageDown']), -EL_LIMIT, EL_LIMIT);
      const zoomKeys = axis(keys, ['KeyS'], ['KeyW']);
      let zoom = inp.wheel * 0.0015 * (inp.shift ? 4 : 1) + zoomKeys * 1.6 * dtReal * (inp.shift ? 3 : 1);
      if (inp.pinch !== 1 && inp.pinch > 0) zoom -= Math.log(inp.pinch) * 1.5;
      if (zoom !== 0) this.altGoal = (this.altGoal ?? alt) * Math.exp(zoom);
    }
    if (this.altGoal !== null) {
      this.altGoal = clamp(this.altGoal, this.minAltitude(f), MAX_DISTANCE - R);
      const a = 1 - Math.exp(-dtReal / 0.1);
      alt = alt * Math.pow(this.altGoal / alt, a);
      if (Math.abs(Math.log(this.altGoal / alt)) < 1e-4) {
        alt = this.altGoal;
        this.altGoal = null;
      }
    }
    alt = clamp(alt, this.minAltitude(f), MAX_DISTANCE - R);
    this.dist = this.surfaceRadius(f) + alt;
  }

  pose(f: FrameState, outPos: Vector3, outQuat: Quaternion): void {
    evalFrame(this.frameRef(), f, _o, _q);
    this.offsetDir(_off);
    const se = Math.sin(this.el), ce = Math.cos(this.el);
    _fwd.copy(_off).negate();
    _up.set(-se * Math.cos(this.az), -se * Math.sin(this.az), ce);
    lookQuat(_fwd, _up, _ql);
    outQuat.copy(_q).multiply(_ql);
    outPos.copy(_off).multiplyScalar(this.dist).applyQuaternion(_q).add(_o);
  }

  /** Focus point (target center), approach direction (unit, SEF, from the focus toward the camera) and scale. */
  focus(f: FrameState, outC: Vector3, outDir: Vector3): number {
    evalFrame(this.frameRef(), f, _o, _q);
    outC.copy(_o);
    this.offsetDir(outDir).applyQuaternion(_q);
    return this.dist;
  }

  /** Orbit controller around `target` reproducing the camera position `pos` (orientation looks at the target). */
  static fromPosition(f: FrameState, target: string, pos: Vector3, axes: 'up' | 'orbital' = 'up'): OrbitController {
    const c = new OrbitController({ target, dist: 1, az: 0, el: 0, axes });
    evalFrame(c.frameRef(), f, _o, _q);
    _qi.copy(_q).invert();
    _d.copy(pos).sub(_o).applyQuaternion(_qi);
    const d = Math.max(_d.length(), 1);
    c.dist = d;
    c.el = clamp(Math.asin(clamp(_d.z / d, -1, 1)), -EL_LIMIT, EL_LIMIT);
    c.az = Math.atan2(_d.y, _d.x);
    const R = c.surfaceRadius(f);
    if (c.dist < R + c.minAltitude(f)) c.dist = R + c.minAltitude(f);
    return c;
  }
}
