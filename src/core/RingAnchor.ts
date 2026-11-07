// Manages the local co-orbiting (Hill) frame used for near-field ring physics.
//
// The frame origin moves on a circular equatorial orbit of radius r0 at the local (J2-corrected) mean
// motion. Local Cartesian coordinates: x = radial (outward), y = azimuthal (prograde), z = north.
// A ring particle with guiding center x_g drifts at v_y = -qShear * omega * x_g relative to the frame
// (Keplerian shear) while executing epicycles (freq. kappa, 2:1 azimuthal:radial) and vertical
// oscillations (freq. nu).
import { Vector3 } from 'three';
import { orbitalFrequencies, shearParameter } from './constants';
import type { RingFrame } from './FrameState';

/** Smallest anchor radius (m); well inside Saturn, only reached by degenerate camera positions. */
export const MIN_ANCHOR_R = 1e6;

export class RingAnchor {
  r0: number;
  phiRef: number;
  tRef: number;
  omega: number;
  kappa: number;
  nu: number;
  qShear: number;
  anchorId = 0;

  constructor(r0 = 130_000e3, phi = 0, t = 0) {
    this.r0 = r0;
    this.phiRef = phi;
    this.tRef = t;
    const f = orbitalFrequencies(r0);
    this.omega = f.omega;
    this.kappa = f.kappa;
    this.nu = f.nu;
    this.qShear = shearParameter(r0);
  }

  /**
   * Re-anchor so that the frame origin passes through the in-plane projection of `posSEF` at time t.
   * The radius is clamped to >= MIN_ANCHOR_R (orbitalFrequencies diverges at r -> 0).
   */
  reanchorAt(posSEF: Vector3, t: number): void {
    const r = Math.max(MIN_ANCHOR_R, Math.hypot(posSEF.x, posSEF.y));
    const phi = Math.atan2(posSEF.y, posSEF.x);
    this.r0 = r;
    this.phiRef = phi;
    this.tRef = t;
    const f = orbitalFrequencies(r);
    this.omega = f.omega;
    this.kappa = f.kappa;
    this.nu = f.nu;
    this.qShear = shearParameter(r);
    this.anchorId++;
  }

  /** Re-anchor to an explicit radius / azimuth. */
  reanchor(r0: number, phi: number, t: number): void {
    this.reanchorAt(new Vector3(r0 * Math.cos(phi), r0 * Math.sin(phi), 0), t);
  }

  /** Take over another anchor's orbit (counts as a re-anchor: consumers re-initialize local state). */
  copyFrom(a: RingAnchor): void {
    this.r0 = a.r0;
    this.phiRef = a.phiRef;
    this.tRef = a.tRef;
    this.omega = a.omega;
    this.kappa = a.kappa;
    this.nu = a.nu;
    this.qShear = a.qShear;
    this.anchorId++;
  }

  phiAt(t: number): number {
    // keep precision: reduce the accumulated angle modulo 2pi in double precision
    const a = this.phiRef + this.omega * (t - this.tRef);
    return a - Math.floor(a / (2 * Math.PI)) * 2 * Math.PI;
  }

  /** Fill a RingFrame for time t; camLocal is computed from camPosSEF. */
  fill(frame: RingFrame, t: number, camPosSEF: Vector3): RingFrame {
    const phi = this.phiAt(t);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    frame.anchorId = this.anchorId;
    frame.r0 = this.r0;
    frame.phi0 = phi;
    frame.omega = this.omega;
    frame.kappa = this.kappa;
    frame.nu = this.nu;
    frame.qShear = this.qShear;
    frame.tAnchor = this.tRef;
    frame.originSEF.set(this.r0 * c, this.r0 * s, 0);
    frame.eR.set(c, s, 0);
    frame.ePhi.set(-s, c, 0);
    frame.eZ.set(0, 0, 1);
    const dx = camPosSEF.x - frame.originSEF.x;
    const dy = camPosSEF.y - frame.originSEF.y;
    frame.camLocal.set(dx * c + dy * s, -dx * s + dy * c, camPosSEF.z);
    return frame;
  }

  /** Local (x,y,z) -> SEF position at time t. */
  localToSef(local: Vector3, t: number, out = new Vector3()): Vector3 {
    const phi = this.phiAt(t);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    return out.set(
      (this.r0 + local.x) * c - local.y * s,
      (this.r0 + local.x) * s + local.y * c,
      local.z,
    );
  }

  /** SEF position -> local (x,y,z) at time t. */
  sefToLocal(p: Vector3, t: number, out = new Vector3()): Vector3 {
    const phi = this.phiAt(t);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const dx = p.x - this.r0 * c;
    const dy = p.y - this.r0 * s;
    return out.set(dx * c + dy * s, -dx * s + dy * c, p.z);
  }

  /** Circular orbital velocity of the frame origin (m/s), SEF. */
  originVelocity(t: number, out = new Vector3()): Vector3 {
    const phi = this.phiAt(t);
    const v = this.omega * this.r0;
    return out.set(-v * Math.sin(phi), v * Math.cos(phi), 0);
  }
}
