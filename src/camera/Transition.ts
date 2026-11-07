// Fly-to transitions between any two camera states, across up to ~12 orders of magnitude of scale.
//
// Each end is described by a focus point c, an approach direction d (unit, focus -> camera) and a scale w
// (camera distance from the focus). The path follows van Wijk & Nuij's "smooth and efficient zooming and
// panning" (2003): log-distance interpolation of w(s) with a simultaneous pan of the focus u(s), which
// zooms out as needed to keep both ends in view. The camera looks at the moving focus along the path and
// blends its orientation from the start pose (first ~20%) to the destination pose (last ~28%).
//
// Both ends move: the start pose stays attached to the start frame (frozen in that frame), the destination
// is evaluated from the destination controller every frame. With zero velocity at both ends of the time
// profile the camera departs co-moving with the start frame and arrives co-moving with the destination
// frame — no jolt when arriving inside the rings at 17 km/s.
import { Quaternion, Vector3 } from 'three';
import type { FrameState } from '../core/FrameState';
import { evalFrame, type FrameRef } from './frames';
import type { FreeController } from './FreeController';
import type { OrbitController } from './OrbitController';
import { clamp, easeTrap, lookQuat, quatForward, quatUp, slerpUnit, smoothstep } from './math';

export type Controller = OrbitController | FreeController;

const RHO = 1.3;

const _o = new Vector3();
const _q = new Quaternion();
const _qi = new Quaternion();
const _c0 = new Vector3();
const _c1 = new Vector3();
const _d0 = new Vector3();
const _d1 = new Vector3();
const _p0 = new Vector3();
const _q0 = new Quaternion();
const _p1 = new Vector3();
const _q1 = new Quaternion();
const _u0 = new Vector3();
const _u1 = new Vector3();
const _dir = new Vector3();
const _up = new Vector3();
const _fw = new Vector3();
const _ql = new Quaternion();

export class Transition {
  readonly dest: Controller;
  readonly destLabel: string;
  /** seconds (real time) */
  readonly duration: number;
  /** current focus / approach direction / scale along the path (lets a new fly-to start seamlessly mid-flight) */
  readonly cur = { c: new Vector3(), dir: new Vector3(0, 0, 1), w: 1 };
  private tau = 0;
  private startRef: FrameRef;
  private startPosL = new Vector3();
  private startQuatL = new Quaternion();
  private startFocusL = new Vector3();
  private startDirL = new Vector3();
  private w0: number;
  private w1: number;
  private u1: number;
  private S: number;
  private r0 = 0;
  private pureZoom: boolean;
  private zoomSign = 1;

  constructor(f: FrameState, startPos: Vector3, startQuat: Quaternion, start: Controller | Transition | null, dest: Controller, destLabel: string) {
    this.dest = dest;
    this.destLabel = destLabel;
    // ---- start end, expressed in the start frame
    if (start instanceof Transition) {
      // interrupted fly-to: continue from its current focus/scale, attached to whichever end it co-moves with most
      this.startRef = start.progress < 0.5 ? start.startRef : start.dest.frameRef();
    } else {
      this.startRef = start ? start.frameRef() : { kind: 'saturn-inertial' };
    }
    evalFrame(this.startRef, f, _o, _q);
    _qi.copy(_q).invert();
    if (start instanceof Transition) {
      this.w0 = Math.max(start.cur.w, 1);
      _d0.copy(start.cur.dir).normalize();
      _c0.copy(startPos).addScaledVector(_d0, -this.w0);
    } else if (start) {
      this.w0 = start.focus(f, _c0, _d0);
      // the controller's focus is computed from its own pose; re-base on the actual current pose
      _c0.copy(startPos).addScaledVector(_d0, -this.w0);
    } else {
      // generic: focus ahead along the view direction
      quatForward(startQuat, _fw);
      this.w0 = Math.max(100, 0.25 * startPos.length());
      _d0.copy(_fw).negate();
      _c0.copy(startPos).addScaledVector(_fw, this.w0);
    }
    this.startPosL.copy(startPos).sub(_o).applyQuaternion(_qi);
    this.startQuatL.copy(_qi).multiply(startQuat);
    this.startFocusL.copy(_c0).sub(_o).applyQuaternion(_qi);
    this.startDirL.copy(_d0).applyQuaternion(_qi);
    this.cur.c.copy(_c0);
    this.cur.dir.copy(_d0);
    this.cur.w = this.w0;
    // ---- destination end (now)
    this.w1 = dest.focus(f, _c1, _d1);
    this.u1 = _c1.distanceTo(_c0);
    const w0 = this.w0, w1 = this.w1, u1 = this.u1;
    this.pureZoom = u1 < 1e-7 * Math.max(w0, w1);
    if (this.pureZoom) {
      this.S = Math.abs(Math.log(w1 / w0)) / RHO;
      this.zoomSign = w1 >= w0 ? 1 : -1;
    } else {
      const r2 = RHO * RHO, r4 = r2 * r2;
      const b0 = (w1 * w1 - w0 * w0 + r4 * u1 * u1) / (2 * w0 * r2 * u1);
      const b1 = (w1 * w1 - w0 * w0 - r4 * u1 * u1) / (2 * w1 * r2 * u1);
      this.r0 = -Math.asinh(b0);
      const r1 = -Math.asinh(b1);
      this.S = (r1 - this.r0) / RHO;
    }
    if (!Number.isFinite(this.S) || this.S < 0) this.S = 0;
    this.duration = clamp(3.5 + 0.22 * this.S, 4, 8);
  }

  get progress(): number {
    return clamp(this.tau, 0, 1);
  }

  /** (pan fraction 0..1, distance w) at path parameter s */
  private path(s: number, e: number): [number, number] {
    if (this.pureZoom) {
      const w = this.w0 * Math.exp(this.zoomSign * RHO * s);
      return [e, w];
    }
    const rs = RHO * s + this.r0;
    const ch = Math.cosh(rs);
    const u = ((this.w0 / (RHO * RHO)) * Math.sinh(RHO * s)) / ch;
    const w = (this.w0 * Math.cosh(this.r0)) / ch;
    return [clamp(u / this.u1, 0, 1), w];
  }

  /** Advance and write the camera pose. Returns true when finished. */
  update(f: FrameState, dtReal: number, outPos: Vector3, outQuat: Quaternion): boolean {
    this.tau = Math.min(1, this.tau + dtReal / this.duration);
    const tau = this.tau;
    const e = easeTrap(tau);
    // ---- start end (moving with the start frame)
    evalFrame(this.startRef, f, _o, _q);
    _p0.copy(this.startPosL).applyQuaternion(_q).add(_o);
    _q0.copy(_q).multiply(this.startQuatL);
    _c0.copy(this.startFocusL).applyQuaternion(_q).add(_o);
    _d0.copy(this.startDirL).applyQuaternion(_q);
    // ---- destination end (moving with the destination frame)
    this.dest.pose(f, _p1, _q1);
    this.dest.focus(f, _c1, _d1);
    if (tau >= 1) {
      outPos.copy(_p1);
      outQuat.copy(_q1);
      return true;
    }
    let [fr, w] = this.path(this.S * e, e);
    if (this.S === 0) {
      fr = e;
      w = this.w0 * Math.pow(this.w1 / this.w0, e);
    }
    const g = this.pureZoom || this.S === 0 ? e : fr;
    // focus and approach direction
    _dir.copy(_d0);
    slerpUnit(_d0, _d1, g, _dir);
    this.cur.c.copy(_c0).lerp(_c1, fr);
    this.cur.dir.copy(_dir);
    this.cur.w = w;
    outPos.copy(this.cur.c).addScaledVector(_dir, w);
    // orientation: look at the focus, with the up vector blended between the ends
    quatUp(_q0, _u0);
    quatUp(_q1, _u1);
    slerpUnit(_u0.normalize(), _u1.normalize(), g, _up);
    _fw.copy(_dir).negate();
    lookQuat(_fw, _up, _ql);
    const a = smoothstep(0, 0.22, tau);
    const b = smoothstep(0.72, 1, tau);
    outQuat.copy(_q0).slerp(_ql, a).slerp(_q1, b);
    // exact end-pose convergence: blend the position toward the true destination pose at the very end
    const pb = smoothstep(0.9, 1, tau);
    if (pb > 0) outPos.lerp(_p1, pb);
    const pa = 1 - smoothstep(0, 0.1, tau);
    if (pa > 0) outPos.lerp(_p0, pa);
    return false;
  }
}
