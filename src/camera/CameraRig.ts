// The camera rig: owns the active controller (orbit / co-orbit / hover), fly-to transitions, and the ring
// anchor that defines frame.ring every frame. Produces frame.camPos, frame.camQuat, frame.fovY and
// RingAnchor.fill(frame.ring, t, camPos).
import { Quaternion, Vector3 } from 'three';
import type { FrameState } from '../core/FrameState';
import { RingAnchor } from '../core/RingAnchor';
import { findMoon } from './frames';
import { FreeController, SPEED_MAX, SPEED_MIN } from './FreeController';
import { emptyInput, type InputFrame } from './Input';
import { clamp, saturnAltitude, smoothstep } from './math';
import { OrbitController } from './OrbitController';
import { Transition, type Controller } from './Transition';

const REANCHOR_X = 5e3;
const REANCHOR_Y = 2e4;
const MIN_ANCHOR_R = 1e6;

export type RigMode = 'orbit' | 'co-orbit' | 'hover' | 'flying';

export interface RigStatus {
  mode: RigMode;
  /** what the camera is attached to / heading to */
  target: string;
  ballistic: boolean;
  speed: number | null;
  progress: number;
  destLabel: string | null;
}

const _p = new Vector3();
const _q = new Quaternion();
const _v = new Vector3();

export class CameraRig {
  active: Controller;
  transition: Transition | null = null;
  /** the single anchor used for frame.ring (anchorId strictly increases on every change) */
  readonly frameAnchor = new RingAnchor(130_000e3, 0, 0);
  readonly pos = new Vector3(0, -1.5e9, 0);
  readonly quat = new Quaternion();
  /** orientation settle after an abrupt controller switch */
  private settleFrom: Quaternion | null = null;
  private settleT = 0;
  private lookScale = 1e-3;
  /** optional callbacks: a transition completed / was cancelled by user input */
  onArrive: ((label: string) => void) | null = null;
  onCancel: ((label: string) => void) | null = null;

  constructor() {
    this.active = new OrbitController({ target: 'saturn', dist: 1.5e9, az: -Math.PI / 3, el: 0.3 });
  }

  /** Per-frame update: input -> controller/transition -> frame camera + ring frame. */
  update(f: FrameState, inp: InputFrame, dtReal: number): void {
    this.lookScale = inp.lookScale;
    if (this.transition && inp.interacted) this.cancelTransition(f);
    if (this.transition) {
      const tr = this.transition;
      // keep the destination controller co-moving (station-keeping drift etc.)
      tr.dest.update(f, null, dtReal);
      const done = tr.update(f, dtReal, this.pos, this.quat);
      if (done) {
        this.transition = null;
        this.active = tr.dest;
        this.active.pose(f, this.pos, this.quat);
        this.onArrive?.(tr.destLabel);
      }
    } else {
      this.active.update(f, inp, dtReal);
      this.active.pose(f, this.pos, this.quat);
    }
    if (this.settleFrom) {
      this.settleT += dtReal / 0.6;
      if (this.settleT >= 1) {
        this.settleFrom = null;
      } else {
        _q.copy(this.settleFrom).slerp(this.quat, smoothstep(0, 1, this.settleT));
        this.quat.copy(_q);
      }
    }
    if (!Number.isFinite(this.pos.x + this.pos.y + this.pos.z)) this.pos.set(0, -1.5e9, 0);
    f.camPos.copy(this.pos);
    f.camQuat.copy(this.quat).normalize();
    this.updateFrameAnchor(f);
  }

  // ---------------------------------------------------------------- ring frame
  private ringAnchorSource(f: FrameState): RingAnchor | null {
    if (this.transition) {
      const d = this.transition.dest;
      if (d instanceof FreeController && d.frameKind === 'ring') {
        d.anchor.sefToLocal(f.camPos, f.t, _v);
        if (Math.abs(_v.x) < REANCHOR_X && Math.abs(_v.y) < REANCHOR_Y) return d.anchor;
      }
      return null;
    }
    const a = this.active;
    return a instanceof FreeController && a.frameKind === 'ring' ? a.anchor : null;
  }

  private updateFrameAnchor(f: FrameState): void {
    const A = this.frameAnchor;
    const src = this.ringAnchorSource(f);
    if (src) {
      if (A.r0 !== src.r0 || A.phiRef !== src.phiRef || A.tRef !== src.tRef) {
        A.r0 = src.r0;
        A.phiRef = src.phiRef;
        A.tRef = src.tRef;
        A.omega = src.omega;
        A.kappa = src.kappa;
        A.nu = src.nu;
        A.qShear = src.qShear;
        A.anchorId++;
      }
      A.fill(f.ring, f.t, f.camPos);
      return;
    }
    A.fill(f.ring, f.t, f.camPos);
    const cl = f.ring.camLocal;
    if (Math.abs(cl.x) > REANCHOR_X || Math.abs(cl.y) > REANCHOR_Y || !Number.isFinite(cl.x + cl.y)) {
      const r = Math.hypot(f.camPos.x, f.camPos.y);
      const phi = Math.atan2(f.camPos.y, f.camPos.x);
      const rr = Math.max(r, MIN_ANCHOR_R);
      // avoid re-anchoring every frame when the camera is inside the clamp radius (e.g. over a pole)
      if (!(r < MIN_ANCHOR_R && Math.abs(A.r0 - rr) < 1 && Math.abs(cl.y) < REANCHOR_Y)) {
        A.reanchor(rr, phi, f.t);
        A.fill(f.ring, f.t, f.camPos);
      }
    }
  }

  // ---------------------------------------------------------------- mode changes
  /** Switch to a controller: instantly, or via a fly-to transition. */
  goto(f: FrameState, ctl: Controller, label: string, instant: boolean): void {
    this.settleFrom = null;
    if (instant) {
      this.transition = null;
      this.active = ctl;
      ctl.pose(f, this.pos, this.quat);
      f.camPos.copy(this.pos);
      f.camQuat.copy(this.quat);
      this.updateFrameAnchor(f);
      return;
    }
    const start = this.transition ?? this.active;
    this.transition = new Transition(f, this.pos, this.quat, start, ctl, label);
  }

  cancelTransition(f: FrameState): void {
    const tr = this.transition;
    if (!tr) return;
    this.transition = null;
    this.onCancel?.(tr.destLabel);
    const d = tr.dest;
    if (d instanceof OrbitController) {
      const c = OrbitController.fromPosition(f, d.target, this.pos, d.axes);
      this.switchTo(f, c);
    } else if (d.frameKind === 'ring') {
      const c = FreeController.ringAt(f, this.pos, this.quat, d.upLocal.z >= 0 ? 1 : -1, this.defaultSpeed(f));
      this.switchTo(f, c);
    } else {
      this.switchTo(f, FreeController.bodyAt(f, d.body, this.pos, this.quat, this.defaultSpeed(f)));
    }
  }

  /** Abrupt controller change with a short orientation settle (position is preserved by construction). */
  private switchTo(f: FrameState, c: Controller): void {
    this.settleFrom = this.quat.clone();
    this.settleT = 0;
    this.active = c;
    c.pose(f, _p, _q);
  }

  /** A sensible flight speed for the camera's current situation (m/s). */
  defaultSpeed(f: FrameState): number {
    const h = Math.abs(f.camPos.z);
    const alt = Math.max(1, saturnAltitude(f.camPos));
    const s = Math.min(Math.max(h, 2) * 0.1, alt * 0.05);
    return clamp(s, SPEED_MIN, SPEED_MAX);
  }

  /** C key: toggle between orbit (around Saturn / the current target) and co-orbiting at the current position. */
  toggleCoorbit(f: FrameState): string {
    if (this.transition) this.cancelTransition(f);
    const a = this.active;
    if (a instanceof OrbitController || (a instanceof FreeController && a.frameKind === 'body')) {
      const lit = f.sunDir.z >= 0 ? 1 : -1;
      const up = Math.abs(f.camPos.z) > 50 ? Math.sign(f.camPos.z) : lit;
      const c = FreeController.ringAt(f, this.pos, this.quat, up, this.defaultSpeed(f));
      this.active = c;
      return 'Co-orbiting here (station keeping)';
    }
    const target = 'saturn';
    this.switchTo(f, OrbitController.fromPosition(f, target, this.pos));
    return 'Orbit mode around Saturn';
  }

  toggleBallistic(): string | null {
    const a = this.active;
    if (this.transition || !(a instanceof FreeController) || a.frameKind !== 'ring') return null;
    a.setBallistic(!a.ballistic);
    return a.ballistic ? 'Ballistic: free test particle (Hill\'s equations)' : 'Station keeping: at rest in the local flow';
  }

  /** [ / ] keys: multiply the flight speed. */
  scaleSpeed(factor: number): number | null {
    const a = this.transition ? null : this.active;
    if (a instanceof FreeController) {
      a.setSpeed(a.speed * factor);
      return a.speed;
    }
    return null;
  }

  status(f: FrameState): RigStatus {
    if (this.transition) {
      return { mode: 'flying', target: this.transition.destLabel, ballistic: false, speed: null, progress: this.transition.progress, destLabel: this.transition.destLabel };
    }
    const a = this.active;
    if (a instanceof OrbitController) {
      return { mode: 'orbit', target: a.targetName(f), ballistic: false, speed: null, progress: 1, destLabel: null };
    }
    if (a.frameKind === 'ring') return { mode: 'co-orbit', target: 'ring', ballistic: a.ballistic, speed: a.speed, progress: 1, destLabel: null };
    const m = findMoon(f, a.body);
    const target = m ? m.name : a.body === 'sef' ? 'Saturn (inertial frame)' : 'Saturn';
    return { mode: 'hover', target, ballistic: false, speed: a.speed, progress: 1, destLabel: null };
  }

  /** Passive input frame for scripted updates. */
  emptyInput(): InputFrame {
    return emptyInput(this.lookScale);
  }
}
