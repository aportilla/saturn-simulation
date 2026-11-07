// Procedural self-gravity wakes for dense rings (A and B rings).
//
// Physics being imitated: in rings with a large surface density, collective self-gravity continuously
// forms transient, trailing, elongated particle aggregates ("wakes") with a radial spacing of order the
// Toomre critical wavelength  lambda_cr = 4 pi^2 G Sigma / kappa^2  (~50-100 m in the A/B rings) and a
// mean pitch angle of ~20-25 deg from the azimuthal direction (Salo 1992; Colwell et al. 2006; Hedman et
// al. 2007). Each wake is born at a steep angle, is sheared by Keplerian differential rotation into a
// more azimuthal orientation while being swing-amplified, and dissolves in ~half an orbit. Occultations
// show the A-ring wakes as nearly opaque elongated aggregates separated by gaps with tau ~ 0.1-0.2,
// i.e. a density contrast of ~10 between wakes and gaps (Colwell et al. 2006).
//
// Model (Lagrangian map, mirrored in src/render/shaders/wakes.glsl):
//  * Two overlapping "generations". A generation is born every T_LIFE/2 (in units of 1/Omega) with a fresh
//    random offset into a periodic tile of size L, lives T_LIFE with amplitude s = strength*sin^2(pi*age/T_LIFE)
//    (the two envelopes always sum to exactly `strength`), and is advected by the linear shear flow exactly
//    like the particles: u = (x, y + S x)/L + off with S = qShear*age.
//  * Each generation is a narrow-band random wave field Z(u) = W(u) exp(2 pi i m0.u): W is a smooth random
//    complex envelope (stored in the texture), m0 = (M0X, M0Y) the central mode. Local phase
//    Theta = 2 pi m0.u + arg W, local strength a = s * (1 - exp(-|W|^2/Rc^2)) (weak where |W| ~ 0: wakes
//    end, merge and split there, like the dislocations seen in N-body simulations).
//  * The generation maps a Lagrangian point q to x = q + n * (M(Theta) - Theta)/|k|, where n,k are the
//    local wave normal / vector and M is the circle map M(Theta) = 2 atan(gamma^a tan(Theta/2)): a smooth,
//    strictly monotone compression of each wavelength around Theta = 0 (density 1/gamma^a in the wake
//    core, gamma^a in the gap). It never shell-crosses, so the density is well defined everywhere and
//    bounded by gamma^(+-strength).
//  * The two generations are composed (older first): x = M_young(M_old(q)). The inverse of each map is
//    closed form (inverse circle map), so the Eulerian density factor wakeDensity(x) = 1/(J_young J_old)
//    is cheap and exactly consistent with where the particles are drawn.
// The particles evaluate the map at their epicyclic position (guiding center + epicycle), so random
// velocities move them through the pattern without smearing it: the drawn particle density is exactly
// the wake density factor that the medium uses.
import { DataTexture, FloatType, LinearFilter, RGBAFormat, RepeatWrapping, Vector3, Vector4 } from 'three';
import { G } from '../core/constants';
import type { RingFrame } from '../core/FrameState';
import type { RingLocal } from './RingProfile';

/** Lattice mode center (m_x, m_y) at birth: crests y_L = -(m_x/m_y) x_L, pitch at birth = atan(M0Y/M0X) = 63 deg */
export const WAKE_M0X = 3;
export const WAKE_M0Y = 6;
/** generation lifetime in units of 1/Omega (pitch sweeps from 63 deg to 11 deg, 20 deg at peak) */
export const WAKE_T_LIFE = 3.0;
/** perpendicular spacing at peak (pitch ~20 deg) equals lambda: L = lambda * M0Y / sin(20 deg) */
const TILE_PER_LAMBDA = WAKE_M0Y / Math.sin((20 * Math.PI) / 180);
/** envelope amplitude below which the wake fades (|W|^2 normalized to mean 1) */
const R_C = 0.45;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashFloat(n: number, salt: number): number {
  const r = mulberry32((n * 2654435761) ^ (salt * 40503));
  r();
  return r();
}
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export interface WakeShape {
  /** density contrast parameter: wake core density 1/gamma, gap density gamma (at full strength) */
  gamma: number;
  /** spread of the envelope modes along m0 (irregularity of the spacing) */
  spreadPar: number;
  /** spread across m0 (controls wake length / orientation scatter) */
  spreadPerp: number;
}

/** A ring: regular, high-contrast wakes. B ring: denser, more chaotic. */
export function wakeShapeFor(local: RingLocal): WakeShape {
  // gamma 0.16 (A ring): gap density factor 0.16 at the gap centre, ~0.3 averaged over the gaps (tau_gap ~0.1-0.2
  // as in the occultation granola-bar fits, Colwell et al. 2006), wake cores ~6x the mean
  const chaos = smooth(1.0, 2.5, local.tau);
  return {
    gamma: 0.16 + 0.08 * chaos,
    spreadPar: 1.6 + 0.8 * chaos,
    spreadPerp: 5.0 + 1.0 * chaos,
  };
}

export class WakeField {
  readonly N = 256;
  /** set to override the zone-derived wake shape (testing / tuning) */
  shapeOverride: Partial<WakeShape> | null = null;
  readonly texture: DataTexture;
  /** tile size (m) */
  tile = 1000;
  /** local Toomre wavelength (m) */
  lambda = 60;
  strength = 0;
  omega = 1e-4;
  qShear = 1.5;
  enabled = true;
  shape: WakeShape = { gamma: 0.16, spreadPar: 1.6, spreadPerp: 5.0 };
  private texShape: WakeShape | null = null;
  private readonly seed: number;
  private readonly data: Float32Array;

  readonly uniforms = {
    uWakeTex: { value: null as DataTexture | null },
    uWakeTile: { value: 1000 },
    // per generation (0 = older, 1 = younger): (amplitude s_g, shear S_g, offsetU, offsetV); [2] unused
    uWakeGen: { value: [new Vector4(), new Vector4(), new Vector4()] },
    uWakeSel: { value: new Vector3() },
    uWakeOn: { value: 0 },
    // (ln gamma, 1/Rc^2, minimum density factor of the current pattern, maximum density factor)
    uWakeShape: { value: new Vector4(Math.log(0.16), 1 / (R_C * R_C), 1, 1) },
  };

  constructor(seed = 12345) {
    this.seed = seed;
    this.data = new Float32Array(this.N * this.N * 4);
    const t = new DataTexture(this.data, this.N, this.N, RGBAFormat, FloatType);
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.generateMipmaps = false;
    this.texture = t;
    this.uniforms.uWakeTex.value = t;
    this.buildTexture(this.shape);
  }

  /** Fill the texture with two independent smooth complex envelopes W_A, W_B (mean |W|^2 = 1). */
  private buildTexture(shape: WakeShape): void {
    const N = this.N;
    const data = this.data;
    const m0n = Math.hypot(WAKE_M0X, WAKE_M0Y);
    const px = WAKE_M0X / m0n, py = WAKE_M0Y / m0n; // unit vector along m0 (texture u,v axes)
    const sp = shape.spreadPar, sq = shape.spreadPerp;
    const R = Math.ceil(3 * Math.max(sp, sq)) + 1;
    // separable phasors e^{2 pi i d n / N} for d in [-R, R], n in [0, N)
    const nd = 2 * R + 1;
    const cs = new Float64Array(nd * N), sn = new Float64Array(nd * N);
    for (let d = -R; d <= R; d++) {
      for (let n = 0; n < N; n++) {
        const ang = (2 * Math.PI * d * n) / N;
        cs[(d + R) * N + n] = Math.cos(ang);
        sn[(d + R) * N + n] = Math.sin(ang);
      }
    }
    for (let field = 0; field < 2; field++) {
      const rnd = mulberry32(this.seed + field * 977);
      const modes: { dx: number; dy: number; re: number; im: number }[] = [];
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const par = dx * px + dy * py;
          const perp = -dx * py + dy * px;
          const w = Math.exp(-0.5 * ((par * par) / (sp * sp) + (perp * perp) / (sq * sq)));
          if (w < 0.01) continue;
          // complex Gaussian amplitude (Rayleigh modulus, uniform phase)
          const ray = Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd())));
          const ph = rnd() * Math.PI * 2;
          modes.push({ dx, dy, re: w * ray * Math.cos(ph), im: w * ray * Math.sin(ph) });
        }
      }
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          let re = 0, im = 0;
          for (const m of modes) {
            const a = (m.dx + R) * N + i, b = (m.dy + R) * N + j;
            // e^{i(ax+by)} = (cx + i sx)(cy + i sy)
            const pr = cs[a] * cs[b] - sn[a] * sn[b];
            const pi = sn[a] * cs[b] + cs[a] * sn[b];
            re += m.re * pr - m.im * pi;
            im += m.re * pi + m.im * pr;
          }
          const k = (j * N + i) * 4 + field * 2;
          data[k] = re;
          data[k + 1] = im;
        }
      }
    }
    // renormalize each field to unit mean |W|^2 over the texture (finite mode sums are not exactly unit)
    for (let field = 0; field < 2; field++) {
      let s = 0;
      for (let p = 0; p < N * N; p++) {
        const k = p * 4 + field * 2;
        s += data[k] * data[k] + data[k + 1] * data[k + 1];
      }
      const f = 1 / Math.sqrt(s / (N * N));
      for (let p = 0; p < N * N; p++) {
        const k = p * 4 + field * 2;
        data[k] *= f;
        data[k + 1] *= f;
      }
    }
    this.texture.needsUpdate = true;
    this.texShape = { ...shape };
  }

  /** Configure for the local ring patch at the frame anchor. */
  configure(local: RingLocal, ring: RingFrame): void {
    this.omega = ring.omega;
    this.qShear = ring.qShear;
    const sigma = Math.max(local.sigma, 1e-3);
    this.lambda = (4 * Math.PI * Math.PI * G * sigma) / (ring.kappa * ring.kappa);
    this.tile = Math.max(this.lambda * TILE_PER_LAMBDA, 1);
    // wakes only exist when the Toomre wavelength comfortably exceeds the largest particles
    const sizeOk = Math.min(1, Math.max(0, (this.lambda / Math.max(local.aMax, 0.1) - 2) / 4));
    this.strength = local.macroscopic ? Math.min(1, local.wake * sizeOk) : 0;
    this.shape = { ...wakeShapeFor(local), ...(this.shapeOverride ?? {}) };
    const ts = this.texShape;
    if (!ts || Math.abs(ts.spreadPar - this.shape.spreadPar) > 0.05 || Math.abs(ts.spreadPerp - this.shape.spreadPerp) > 0.05) {
      this.buildTexture(this.shape);
    }
    this.uniforms.uWakeTile.value = this.tile;
    const lg = Math.log(this.shape.gamma);
    const sh = this.uniforms.uWakeShape.value;
    sh.set(lg, 1 / (R_C * R_C), Math.exp(lg * this.strength), Math.exp(-lg * this.strength));
  }

  /** Per-frame generation parameters. t = sim time (s since J2000). */
  update(t: number): void {
    const on = this.enabled && this.strength > 1e-3;
    this.uniforms.uWakeOn.value = on ? 1 : 0;
    const sh = this.uniforms.uWakeShape.value;
    if (!on) sh.z = sh.w = 1;
    else {
      sh.z = Math.exp(sh.x * this.strength);
      sh.w = Math.exp(-sh.x * this.strength);
    }
    const tau = this.omega * t; // dimensionless time (radians of orbital phase)
    const half = WAKE_T_LIFE / 2;
    const nYoung = Math.floor(tau / half);
    for (let g = 0; g < 2; g++) {
      const ng = nYoung - (1 - g); // g = 0 -> older generation, g = 1 -> younger
      const age = tau - ng * half; // [T/2, T) for the older one, [0, T/2) for the younger
      const env = Math.sin((Math.PI * age) / WAKE_T_LIFE) ** 2;
      const S = this.qShear * age;
      this.uniforms.uWakeGen.value[g].set(this.strength * env, S, hashFloat(ng, 1), hashFloat(ng, 2));
      this.uniforms.uWakeSel.value.setComponent(g, ((ng % 2) + 2) % 2);
    }
    this.uniforms.uWakeGen.value[2].set(0, 0, 0, 0);
    this.uniforms.uWakeSel.value.z = 0;
    this._tau = tau;
  }
  private _tau = 0;

  /** Current amplitude-weighted mean pitch angle (deg) of the wake pattern, for the HUD. */
  get pitchDeg(): number {
    if (this.strength <= 1e-3) return 0;
    let wsum = 0, psum = 0;
    for (let g = 0; g < 2; g++) {
      const v = this.uniforms.uWakeGen.value[g];
      const pitch = Math.atan2(WAKE_M0Y, WAKE_M0X + v.y * WAKE_M0Y) * (180 / Math.PI);
      wsum += v.x;
      psum += v.x * pitch;
    }
    return wsum > 0 ? psum / wsum : 0;
  }

  /** Orbital phase (rad) used for the generation clock (for debugging). */
  get clockPhase(): number {
    return this._tau;
  }
}
