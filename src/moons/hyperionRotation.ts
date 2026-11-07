// Hyperion's chaotic rotation (runtime). The rigid-body Euler equations with Saturn's gravity-gradient
// torque were integrated offline (scripts/data/moons/hyperion_rot.mjs, RK4, h = 0.005 d) along Hyperion's
// fitted orbit and stored as checkpoints every `step` days: [qx,qy,qz,qw, wx,wy,wz] (float32; q = body->SEF,
// w = body-frame angular velocity, rad/day). Here we re-integrate from the NEAREST checkpoint (at most
// step/2 days, forward or backward), so the orientation is a deterministic function of t that is smooth and
// cheap at any time warp and in reversed time. Outside the checkpoint span the time is wrapped periodically
// into the span (the tumbling stays physical-looking; it jumps only at the wrap instants).
//
// Body axes: x = long axis (180.1 km), y = intermediate (133.0 km), z = short axis (102.7 km).
import type { Quaternion } from 'three';
import { EPOCH_JD, type OrbitModel } from './orbitModel';

export interface ChaoticRotationJson {
  type: 'chaotic';
  file: string;
  startJd: number;
  step: number;
  count: number;
  /** Euler coefficients [(B-C)/A, (C-A)/B, (A-B)/C] */
  k: number[];
  gmSaturnKm3PerDay2: number;
  epochJd: number;
  maxSubstepDays: number;
}

export class HyperionRotation {
  private readonly t0: number; // tau of the first checkpoint
  private readonly span: number;
  private readonly kx: number; private readonly ky: number; private readonly kz: number;
  private readonly gm3: number;
  private readonly y = new Float64Array(7);
  private readonly k1 = new Float64Array(7); private readonly k2 = new Float64Array(7);
  private readonly k3 = new Float64Array(7); private readonly k4 = new Float64Array(7);
  private readonly yt = new Float64Array(7);
  /** Saturn-direction interpolation: 5 orbit positions (km) over the integration interval */
  private readonly P = new Float64Array(15);
  private readonly sv = new Float64Array(4);
  private ta = 0; private dt = 0;

  constructor(private readonly spec: ChaoticRotationJson, private readonly data: Float32Array, private readonly orbit: OrbitModel) {
    this.t0 = spec.startJd - EPOCH_JD;
    this.span = (spec.count - 1) * spec.step;
    this.kx = spec.k[0]; this.ky = spec.k[1]; this.kz = spec.k[2];
    this.gm3 = 3 * spec.gmSaturnKm3PerDay2;
  }

  /** Saturn direction (unit, moon -> Saturn, SEF) and 3GM/r^3 at tau, from the 5-point interpolant. */
  private sat(tau: number): void {
    const s = this.dt === 0 ? 0 : ((tau - this.ta) / this.dt) * 4; // node coordinate 0..4
    // 5-point Lagrange weights at nodes 0..4
    const a0 = s, a1 = s - 1, a2 = s - 2, a3 = s - 3, a4 = s - 4;
    const w0 = (a1 * a2 * a3 * a4) / 24;
    const w1 = -(a0 * a2 * a3 * a4) / 6;
    const w2 = (a0 * a1 * a3 * a4) / 4;
    const w3 = -(a0 * a1 * a2 * a4) / 6;
    const w4 = (a0 * a1 * a2 * a3) / 24;
    const P = this.P;
    const x = w0 * P[0] + w1 * P[3] + w2 * P[6] + w3 * P[9] + w4 * P[12];
    const y = w0 * P[1] + w1 * P[4] + w2 * P[7] + w3 * P[10] + w4 * P[13];
    const z = w0 * P[2] + w1 * P[5] + w2 * P[8] + w3 * P[11] + w4 * P[14];
    const r = Math.sqrt(x * x + y * y + z * z);
    const sv = this.sv;
    sv[0] = -x / r; sv[1] = -y / r; sv[2] = -z / r;
    sv[3] = this.gm3 / (r * r * r);
  }

  private deriv(y: Float64Array, dy: Float64Array): void {
    const sv = this.sv;
    // Saturn direction in the body frame: v_b = conj(q) v q
    const cx = -y[0], cy = -y[1], cz = -y[2], w = y[3];
    const vx = sv[0], vy = sv[1], vz = sv[2];
    const tx = 2 * (cy * vz - cz * vy), ty = 2 * (cz * vx - cx * vz), tz = 2 * (cx * vy - cy * vx);
    const rx = vx + w * tx + (cy * tz - cz * ty);
    const ry = vy + w * ty + (cz * tx - cx * tz);
    const rz = vz + w * tz + (cx * ty - cy * tx);
    const mu3 = sv[3];
    const wx = y[4], wy = y[5], wz = y[6];
    dy[4] = this.kx * (wy * wz - mu3 * ry * rz);
    dy[5] = this.ky * (wz * wx - mu3 * rz * rx);
    dy[6] = this.kz * (wx * wy - mu3 * rx * ry);
    const qx = y[0], qy = y[1], qz = y[2], qw = y[3];
    dy[0] = 0.5 * (qw * wx + (qy * wz - qz * wy));
    dy[1] = 0.5 * (qw * wy + (qz * wx - qx * wz));
    dy[2] = 0.5 * (qw * wz + (qx * wy - qy * wx));
    dy[3] = -0.5 * (qx * wx + qy * wy + qz * wz);
  }

  /** Orientation (body -> SEF) at tau = days since EPOCH_JD. No allocations. */
  orientation(tau: number, out: Quaternion): Quaternion {
    let t = tau;
    if (t < this.t0 || t > this.t0 + this.span) {
      const u = (((t - this.t0) % this.span) + this.span) % this.span;
      t = this.t0 + u;
    }
    let k = Math.round((t - this.t0) / this.spec.step);
    if (k < 0) k = 0;
    if (k > this.spec.count - 1) k = this.spec.count - 1;
    const tk = this.t0 + k * this.spec.step;
    const y = this.y;
    const d = this.data;
    for (let i = 0; i < 7; i++) y[i] = d[7 * k + i];
    const dt = t - tk;
    if (dt !== 0) {
      this.ta = tk; this.dt = dt;
      for (let j = 0; j < 5; j++) this.orbit.positionAt(tk + (dt * j) / 4, this.P, 3 * j);
      const n = Math.max(1, Math.ceil(Math.abs(dt) / this.spec.maxSubstepDays));
      const h = dt / n;
      const { k1, k2, k3, k4, yt } = this;
      let tt = tk;
      for (let s = 0; s < n; s++) {
        this.sat(tt); this.deriv(y, k1);
        for (let i = 0; i < 7; i++) yt[i] = y[i] + 0.5 * h * k1[i];
        this.sat(tt + 0.5 * h); this.deriv(yt, k2);
        for (let i = 0; i < 7; i++) yt[i] = y[i] + 0.5 * h * k2[i];
        this.deriv(yt, k3);
        for (let i = 0; i < 7; i++) yt[i] = y[i] + h * k3[i];
        this.sat(tt + h); this.deriv(yt, k4);
        for (let i = 0; i < 7; i++) y[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
        const nq = Math.sqrt(y[0] * y[0] + y[1] * y[1] + y[2] * y[2] + y[3] * y[3]);
        y[0] /= nq; y[1] /= nq; y[2] /= nq; y[3] /= nq;
        tt += h;
      }
    }
    return out.set(y[0], y[1], y[2], y[3]);
  }

  /** Body-frame angular velocity magnitude at the nearest checkpoint (rad/day), for HUD/debug. */
  spinRate(tau: number): number {
    let k = Math.round((tau - this.t0) / this.spec.step);
    k = Math.max(0, Math.min(this.spec.count - 1, k));
    const d = this.data;
    return Math.hypot(d[7 * k + 4], d[7 * k + 5], d[7 * k + 6]);
  }
}
