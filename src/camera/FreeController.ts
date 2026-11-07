// Free-look camera attached to a moving frame.
//
//  * frame 'ring' — the local Hill frame of a RingAnchor (co-orbiting with the ring particles).
//      Station keeping (default): when not thrusting, the camera is at rest relative to the local particle
//      flow: it drifts with the Keplerian shear at its own radial offset (dy = -q Omega x dt, sim time) and
//      holds its height. Ballistic: the camera is a free test particle obeying Hill's equations, using the
//      exact linear solution (guiding center + epicycle + vertical oscillation), so any time warp is exact.
//      The frame is re-anchored under the camera when |x| > 5 km or |y| > 20 km (SEF pose preserved).
//  * frame 'body' — fixed to a rotating body (Saturn System III, or a moon's body frame): hovering.
//
// Thrust (WASD horizontal, R/F or Space/Ctrl vertical) is a velocity relative to the local flow, applied
// in REAL time (so flying feels the same at any warp); orbital motion uses SIM time.
import { Quaternion, Vector3 } from 'three';
import type { FrameState } from '../core/FrameState';
import { RingAnchor } from '../core/RingAnchor';
import { evalFrame, findMoon, type FrameRef } from './frames';
import { axis, type InputFrame } from './Input';
import { clamp, ellipsoidRadiusAlong, lookQuat, rotZQuat, saturnAltitude, saturnNormal, wrapPi } from './math';

export const SPEED_MIN = 1e-3;
export const SPEED_MAX = 1e5;
const REANCHOR_X = 5e3;
const REANCHOR_Y = 2e4;
const MIN_ANCHOR_R = 1e6;
const SATURN_MIN_ALT = 1e3;

const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);
const _p = new Vector3();
const _prev = new Vector3();
const _cmd = new Vector3();
const _f = new Vector3();
const _u = new Vector3();
const _fh = new Vector3();
const _rh = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _o = new Vector3();
const _v = new Vector3();
const _n = new Vector3();

/**
 * Exact solution of the linearized Hill equations (Keplerian shear q, epicyclic kappa, vertical nu) over dt,
 * in the same kinematic form used for the near-field ring particles:
 *   x = x_g + A cos(theta), y = y_g0 - q Omega x_g t - 2 A (Omega/kappa) sin(theta), z = B cos(nu t + psi).
 */
export function propagateHill(p: Vector3, v: Vector3, dt: number, Om: number, ka: number, nu: number, q: number): void {
  if (dt === 0) return;
  const xg = (v.y + 2 * Om * p.x) / ((2 - q) * Om);
  const Ac = p.x - xg;
  const As = -v.x / ka;
  const yg = p.y + 2 * (Om / ka) * As;
  const c = Math.cos(ka * dt), s = Math.sin(ka * dt);
  const Ac1 = Ac * c - As * s;
  const As1 = As * c + Ac * s;
  p.x = xg + Ac1;
  v.x = -ka * As1;
  p.y = yg - q * Om * xg * dt - 2 * (Om / ka) * As1;
  v.y = -q * Om * xg - 2 * Om * Ac1;
  const cn = Math.cos(nu * dt), sn = Math.sin(nu * dt);
  const z = p.z, vz = v.z;
  p.z = z * cn + (vz / nu) * sn;
  v.z = -z * nu * sn + vz * cn;
}

export interface FreeInit {
  frame: 'ring' | 'body';
  anchor?: RingAnchor;
  body?: string;
  local: Vector3;
  qLocal: Quaternion;
  upLocal: Vector3;
  speed?: number;
}

/** Local-frame orientation from yaw/pitch/roll (degrees) relative to an up side (+1 north, -1 south).
 *  yaw 0 = prograde, +90 = radially outward, -90 = toward Saturn, 180 = retrograde; pitch + = toward `up`. */
export function ringOrientation(yawDeg: number, pitchDeg: number, rollDeg: number, upSign: number, out: Quaternion): Quaternion {
  const y = (yawDeg * Math.PI) / 180, p = (pitchDeg * Math.PI) / 180;
  _f.set(Math.cos(p) * Math.sin(y), Math.cos(p) * Math.cos(y), upSign * Math.sin(p));
  _u.set(0, 0, upSign);
  lookQuat(_f, _u, out);
  if (rollDeg) out.multiply(_q2.setFromAxisAngle(Z, (-rollDeg * Math.PI) / 180));
  return out;
}

export class FreeController {
  readonly type = 'free' as const;
  readonly frameKind: 'ring' | 'body';
  /** ring frame (co-orbit). Owned by this controller. */
  readonly anchor: RingAnchor;
  /** body frame: 'saturn' or a moon name (lower-case) */
  body: string;
  /** camera position in the frame (m) */
  readonly local = new Vector3();
  /** camera -> frame-local rotation */
  readonly qLocal = new Quaternion();
  /** the camera's notion of "up" in frame-local axes (yaw axis, horizontal flight plane) */
  readonly upLocal = new Vector3(0, 0, 1);
  /** flight speed scale (m/s) */
  speed = 1;
  /** current (smoothed) thrust velocity relative to the local flow, frame-local, m/s */
  readonly thrust = new Vector3();
  /** ballistic: free test particle on Hill's equations */
  ballistic = false;
  /** ballistic velocity relative to the Hill frame (m/s) */
  readonly vel = new Vector3();
  reanchors = 0;
  private pinchMove = 0;

  constructor(o: FreeInit) {
    this.frameKind = o.frame;
    this.anchor = o.anchor ?? new RingAnchor();
    this.body = (o.body ?? 'saturn').toLowerCase();
    this.local.copy(o.local);
    this.qLocal.copy(o.qLocal).normalize();
    this.upLocal.copy(o.upLocal).normalize();
    this.speed = clamp(o.speed ?? 1, SPEED_MIN, SPEED_MAX);
  }

  frameRef(): FrameRef {
    if (this.frameKind === 'ring') {
      const A = this.anchor;
      return { kind: 'ring', r0: A.r0, phiRef: A.phiRef, tRef: A.tRef, omega: A.omega };
    }
    return bodyFrameRef(this.body);
  }

  /** Frame origin + orientation now. */
  frameNow(f: FrameState, outO: Vector3, outQ: Quaternion): void {
    if (this.frameKind === 'ring') {
      const phi = this.anchor.phiAt(f.t);
      outO.set(this.anchor.r0 * Math.cos(phi), this.anchor.r0 * Math.sin(phi), 0);
      rotZQuat(phi, outQ);
    } else {
      evalFrame(this.frameRef(), f, outO, outQ);
    }
  }

  setSpeed(v: number): void {
    this.speed = clamp(v, SPEED_MIN, SPEED_MAX);
  }

  update(f: FrameState, inp: InputFrame | null, dtReal: number): void {
    if (inp) this.applyLook(inp, dtReal);
    if (inp && inp.wheel) this.setSpeed(this.speed * Math.pow(2, -inp.wheel / 120));
    if (inp && inp.pinch !== 1 && inp.pinch > 0) this.pinchMove += Math.log(inp.pinch) * this.speed * 2.5;
    if (inp) this.commandVelocity(inp, _cmd);
    else _cmd.set(0, 0, 0);
    const a = 1 - Math.exp(-dtReal / 0.15);
    this.thrust.lerp(_cmd, a);
    if (_cmd.lengthSq() === 0 && this.thrust.lengthSq() < 1e-6 * this.speed * this.speed) this.thrust.set(0, 0, 0);
    if (this.frameKind === 'ring') this.updateRing(f, dtReal);
    else this.updateBody(f, dtReal);
  }

  private applyLook(inp: InputFrame, dtReal: number): void {
    const k = inp.lookScale;
    const keyYaw = axis(inp.keys, ['ArrowLeft'], ['ArrowRight']) * 0.9 * dtReal;
    const keyPitch = axis(inp.keys, ['ArrowUp'], ['ArrowDown']) * 0.9 * dtReal;
    const yaw = inp.dragX * k + keyYaw;
    const pitch = inp.dragY * k + keyPitch;
    if (yaw) this.qLocal.premultiply(_q.setFromAxisAngle(this.upLocal, yaw));
    if (pitch) {
      _q2.copy(this.qLocal).multiply(_q.setFromAxisAngle(X, pitch));
      const sNew = _f.set(0, 0, -1).applyQuaternion(_q2).dot(this.upLocal);
      const sOld = _f.set(0, 0, -1).applyQuaternion(this.qLocal).dot(this.upLocal);
      if (Math.abs(sNew) < 0.9995 || Math.abs(sNew) < Math.abs(sOld)) this.qLocal.copy(_q2);
    }
    const roll = axis(inp.keys, ['KeyE'], ['KeyQ']);
    if (roll) this.qLocal.multiply(_q.setFromAxisAngle(Z, -roll * 1.2 * dtReal));
    this.qLocal.normalize();
  }

  /** Commanded thrust velocity (frame-local, m/s) from the keys. */
  private commandVelocity(inp: InputFrame, out: Vector3): Vector3 {
    const keys = inp.keys;
    const fw = axis(keys, ['KeyW'], ['KeyS']);
    const st = axis(keys, ['KeyD'], ['KeyA']);
    const vt = axis(keys, ['KeyR', 'Space', 'PageUp'], ['KeyF', 'ControlLeft', 'ControlRight', 'PageDown']);
    out.set(0, 0, 0);
    if (!fw && !st && !vt) return out;
    const U = this.upLocal;
    _f.set(0, 0, -1).applyQuaternion(this.qLocal);
    _fh.copy(_f).addScaledVector(U, -_f.dot(U));
    if (_fh.lengthSq() < 1e-8) {
      // looking straight up/down: "forward" = toward the top of the screen
      _fh.set(0, 1, 0).applyQuaternion(this.qLocal);
      _fh.addScaledVector(U, -_fh.dot(U));
    }
    _fh.normalize();
    _rh.crossVectors(_fh, U);
    const s = this.speed * (inp.shift ? 10 : 1) * (inp.alt ? 0.1 : 1);
    return out.addScaledVector(_fh, fw * s).addScaledVector(_rh, st * s).addScaledVector(U, vt * s);
  }

  private updateRing(f: FrameState, dtReal: number): void {
    const A = this.anchor;
    const dt = f.dt;
    _prev.copy(this.local);
    if (this.ballistic) {
      propagateHill(this.local, this.vel, dt, A.omega, A.kappa, A.nu, A.qShear);
      this.local.addScaledVector(this.thrust, dtReal);
    } else {
      const x0 = this.local.x;
      this.local.x += this.thrust.x * dtReal;
      this.local.z += this.thrust.z * dtReal;
      this.local.y += this.thrust.y * dtReal - A.qShear * A.omega * 0.5 * (x0 + this.local.x) * dt;
    }
    if (this.pinchMove) {
      _f.set(0, 0, -1).applyQuaternion(this.qLocal);
      this.local.addScaledVector(_f, this.pinchMove);
      this.pinchMove = 0;
    }
    // never fly into Saturn
    A.localToSef(this.local, f.t, _p);
    if (saturnAltitude(_p) < SATURN_MIN_ALT) {
      A.localToSef(_prev, f.t, _o);
      if (saturnAltitude(_p) < saturnAltitude(_o)) {
        this.local.copy(_prev);
        this.thrust.set(0, 0, 0);
        this.vel.set(0, 0, 0);
      }
    }
    if (!Number.isFinite(this.local.x + this.local.y + this.local.z)) this.local.copy(_prev);
    if (Math.abs(this.local.x) > REANCHOR_X || Math.abs(this.local.y) > REANCHOR_Y) this.reanchor(f);
  }

  /** Move the Hill frame origin under the camera, preserving the camera's SEF position, orientation and velocity. */
  reanchor(f: FrameState): void {
    const A = this.anchor;
    const t = f.t;
    A.localToSef(this.local, t, _p);
    const phiOld = A.phiAt(t);
    if (this.ballistic) {
      // inertial velocity = V_origin + Omega z x rho + R * v_local
      const c = Math.cos(phiOld), s = Math.sin(phiOld);
      const rx = _p.x - A.r0 * c, ry = _p.y - A.r0 * s;
      _v.set(
        -A.omega * A.r0 * s - A.omega * ry + (this.vel.x * c - this.vel.y * s),
        A.omega * A.r0 * c + A.omega * rx + (this.vel.x * s + this.vel.y * c),
        this.vel.z,
      );
    }
    const r = Math.max(Math.hypot(_p.x, _p.y), MIN_ANCHOR_R);
    const phi = Math.atan2(_p.y, _p.x);
    A.reanchor(r, phi, t);
    const phiNew = A.phiAt(t);
    const dphi = wrapPi(phiNew - phiOld);
    rotZQuat(-dphi, _q);
    this.qLocal.premultiply(_q).normalize();
    this.upLocal.applyQuaternion(_q).normalize();
    this.thrust.applyQuaternion(_q);
    A.sefToLocal(_p, t, this.local);
    if (this.ballistic) {
      const c = Math.cos(phiNew), s = Math.sin(phiNew);
      const vo = A.omega * A.r0;
      const dvx = _v.x + vo * s, dvy = _v.y - vo * c;
      this.vel.set(dvx * c + dvy * s, -dvx * s + dvy * c, _v.z);
    }
    this.reanchors++;
  }

  private updateBody(f: FrameState, dtReal: number): void {
    this.local.addScaledVector(this.thrust, dtReal);
    if (this.pinchMove) {
      _f.set(0, 0, -1).applyQuaternion(this.qLocal);
      this.local.addScaledVector(_f, this.pinchMove);
      this.pinchMove = 0;
    }
    const m = findMoon(f, this.body);
    if (!m) {
      // Saturn: body axes share the polar axis, so the SEF ellipsoid formulas apply directly
      const alt = saturnAltitude(this.local);
      if (alt < SATURN_MIN_ALT) {
        saturnNormal(this.local, _n);
        this.local.addScaledVector(_n, SATURN_MIN_ALT - alt);
      }
      saturnNormal(this.local, _n);
    } else {
      const d = this.local.length();
      _n.copy(this.local).divideScalar(Math.max(d, 1e-9));
      const R = ellipsoidRadiusAlong(_n, m.radii);
      const minD = R + Math.max(5, 2e-4 * m.meanRadius);
      if (d < minD) this.local.copy(_n).multiplyScalar(minD);
    }
    // keep "up" = the local vertical, parallel-transporting the view so the horizon stays level
    if (_n.lengthSq() > 0.5 && _n.dot(this.upLocal) < 0.9999999) {
      _q.setFromUnitVectors(this.upLocal, _n);
      this.qLocal.premultiply(_q).normalize();
      this.upLocal.copy(_n);
    }
  }

  pose(f: FrameState, outPos: Vector3, outQuat: Quaternion): void {
    this.frameNow(f, _o, _q);
    if (this.frameKind === 'ring') this.anchor.localToSef(this.local, f.t, outPos);
    else outPos.copy(this.local).applyQuaternion(_q).add(_o);
    outQuat.copy(_q).multiply(this.qLocal);
  }

  /** Height scale used for transitions (m): distance to the ring plane or altitude above the body. */
  heightScale(f: FrameState): number {
    if (this.frameKind === 'ring') return Math.abs(this.local.z);
    const m = findMoon(f, this.body);
    if (!m) return Math.max(0, saturnAltitude(this.local));
    return Math.max(0, this.local.length() - m.meanRadius);
  }

  /**
   * Focus point, approach direction (unit SEF vector from the focus toward the camera) and scale for
   * fly-to transitions: the camera arrives/leaves from "above and behind" its view direction.
   */
  focus(f: FrameState, outC: Vector3, outDir: Vector3): number {
    this.pose(f, outC, _q2);
    this.frameNow(f, _o, _q);
    _u.copy(this.upLocal).applyQuaternion(_q);
    _f.set(0, 0, -1).applyQuaternion(_q2);
    _fh.copy(_f).addScaledVector(_u, -_f.dot(_u));
    if (_fh.lengthSq() < 1e-8) _fh.set(0, 1, 0).applyQuaternion(_q2).addScaledVector(_u, -_fh.dot(_u));
    _fh.normalize();
    outDir.copy(_u).multiplyScalar(0.8).addScaledVector(_fh, -0.6).normalize();
    const h = this.heightScale(f);
    const w = this.frameKind === 'ring' ? Math.max(40, 1.25 * h) : Math.max(500, 0.6 * h);
    outC.addScaledVector(outDir, -w);
    return w;
  }

  /** Station-keeping velocity of the camera relative to the frame (m/s), or the ballistic velocity. */
  velocityLocal(out: Vector3): Vector3 {
    if (this.frameKind !== 'ring') return out.copy(this.thrust);
    if (this.ballistic) return out.copy(this.vel).add(this.thrust);
    return out.set(this.thrust.x, this.thrust.y - this.anchor.qShear * this.anchor.omega * this.local.x, this.thrust.z);
  }

  setBallistic(on: boolean): boolean {
    if (this.frameKind !== 'ring') return false;
    if (on && !this.ballistic) {
      this.vel.set(this.thrust.x, this.thrust.y - this.anchor.qShear * this.anchor.omega * this.local.x, this.thrust.z);
      this.thrust.set(0, 0, 0);
    } else if (!on && this.ballistic) {
      this.vel.set(0, 0, 0);
    }
    this.ballistic = on;
    return true;
  }

  // ---------------------------------------------------------------- factories
  /** Co-orbit at the camera's current SEF pose (orientation preserved exactly). */
  static ringAt(f: FrameState, pos: Vector3, quat: Quaternion, upSign: number, speed: number): FreeController {
    const r = Math.max(Math.hypot(pos.x, pos.y), MIN_ANCHOR_R);
    const phi = Math.atan2(pos.y, pos.x);
    const anchor = new RingAnchor(r, phi, f.t);
    const local = anchor.sefToLocal(pos, f.t, new Vector3());
    const q = rotZQuat(-anchor.phiAt(f.t), new Quaternion()).multiply(quat);
    return new FreeController({ frame: 'ring', anchor, local, qLocal: q, upLocal: new Vector3(0, 0, upSign >= 0 ? 1 : -1), speed });
  }

  /** Hover in a body-fixed frame at the camera's current SEF pose ('sef' = non-rotating, Saturn-centered). */
  static bodyAt(f: FrameState, body: string, pos: Vector3, quat: Quaternion, speed: number): FreeController {
    const key = body.toLowerCase();
    evalFrame(bodyFrameRef(key), f, _o, _q);
    _q2.copy(_q).invert();
    const local = new Vector3().copy(pos).sub(_o).applyQuaternion(_q2);
    const qLocal = new Quaternion().copy(_q2).multiply(quat);
    const up = key === 'saturn' || key === 'sef' ? saturnNormal(local, new Vector3()) : local.clone().normalize();
    return new FreeController({ frame: 'body', body: key, local, qLocal, upLocal: up, speed });
  }
}

/** 'saturn' = System III (rotating), 'sef' = inertial Saturn-centered axes, else a moon's body frame. */
function bodyFrameRef(body: string): FrameRef {
  if (body === 'saturn') return { kind: 'saturn-body' };
  if (body === 'sef') return { kind: 'saturn-inertial' };
  return { kind: 'moon-body', body };
}
