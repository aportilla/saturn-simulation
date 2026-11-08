// Sub-km optical-depth texture of the main rings: a 2-D, Keplerian-sheared, evolving random field. CPU mirror and
// uniforms of src/render/shaders/ringTexture.glsl (chunk sv_ringTexture: rsTauModTexture, one of the tauMod hooks of
// sv_ringStructure). RingStructure owns an instance (uniforms spread with the structure's, CPU mirror for tests and
// the near-field allocation). Model, parameters and sources: docs/ring-physics.md section 10.
//
//   M(a', theta, t) = 1 + A F,   F = clamp( sum_j wv_j(fp) w_j [s_0 n_j0 + s_1 n_j1], -3 sigma_F, +3 sigma_F )
//
// * Statistics (unchanged from the former radial-only rlFineFactor): six octaves of radial correlation length
//   lambda_j = 500, 250, ... 15.6 m with amplitudes ~ sqrt(lambda_j) (power ~ k^-2), each with the former octave's
//   variance; amplitude per region A = 0.22 + 0.35 smoothstep(1, 3, tau) + 0.1 wake (tau, wake of the 1 km-prefiltered
//   profile at a'): rms 7.5 % in the A ring, 14.5 % in the B-ring core, 5 % in the C ring.
// * Shear and evolution: each octave is variance-normalized 2-D value noise on a lattice that was ISOTROPIC (cells
//   lambda_b x lambda_b) at the structure's birth and is advected with the Keplerian(+J2) flow since: material at a'
//   carries the lattice azimuth phi = theta - Omega(a') age. A structure of age t is a trailing streak of aspect
//   ~ 1 + q Omega t and pitch atan(1 / (q Omega t)). Two generations (slots) overlap; a generation is visible for one
//   coherence time T (amplitude sin(pi a / T), a = visible age; the two slots' squares sum to 1, so the variance is
//   stationary) and is already T/2 old (sheared) when it appears: shear ages T/2 .. 3T/2, q Omega T = 3 pi = 9.4 at
//   mid-life (pitch ~6 deg, 4..12 deg over the life). T = one orbital period at 128,000 km (12.9 h).
// * lambda_b = C_BIRTH lambda_j: the cell size at birth that gives the octave the former radial correlation at fixed
//   azimuth (measured with this mirror, scripts/test/propellers.mjs texture checks), i.e. azimuthal coherence
//   ~C_BIRTH x the radial one (4.7 km for the 500 m octave, 150 m for the 15.6 m one).
// * Prefiltering: octave j fades with the radial pixel footprint as before (wv_j = clamp((lambda_j / fp - 1) / 2, 0,
//   1)); the faded part is returned as the sub-footprint variance v = A^2 sum_j (1 - wv_j^2) w_j^2 / 3, which the
//   ring-layer sheet folds into its transmission-preserving tau pyramid (second-order cumulant model of the
//   unresolved factor with the 3-sigma floor, rlApplyTauMod in rlOptics.glsl), so the mean transmission is the same
//   whether the texture is resolved or not.
// * Precision / anchoring: the lattice coordinates are absolute (a' and the Lagrangian azimuth), the CPU passes their
//   values at the ring-frame origin in double precision (mod the 256-cell tile), the GPU adds the offsets (aL, dth):
//   precise near the camera, independent of the anchor. The azimuthal lattice has N_j = multiple of 256 cells around
//   the ring (no seam).
import { DataTexture, DataUtils, HalfFloatType, LinearFilter, RedFormat, RepeatWrapping, Vector4 } from 'three';
import { SATURN } from '../core/constants';

export const RT_OCTAVES = 6;
/** radial correlation lengths (m) of the octaves: 250 m x 2^-j, j = -1 .. 4 (the former rlFineNoise) */
export const RT_LAMBDA = [500, 250, 125, 62.5, 31.25, 15.625];
/** tile size (cells) of the noise texture */
export const RT_TILE = 256;
/** lattice cell size at birth / radial correlation length (calibrated: propellers.mjs texture checks) */
export const RT_C_BIRTH = 9.5;
/** radius (m) at which the azimuthal lattice has its nominal cell length */
export const RT_R_NOMINAL = 128_000e3;
/** clamp of F in units of its standard deviation (bounds M for the near-field allocation) */
export const RT_CLAMP_SIGMA = 3;
/** amplitude law (the former rlFineFactor): A = A0 + A_TAU smoothstep(1, 3, tau) + A_WAKE wake */
export const RT_A0 = 0.22, RT_A_TAU = 0.35, RT_A_WAKE = 0.1;

const AMP = RT_LAMBDA.map((l) => Math.sqrt(l / 250));
const NORM = AMP.reduce((s, a) => s + a, 0);
// Variance match: the former octaves were 1-D value noise of uniform [-1, 1] node values with smoothstep weights,
// mean variance (1/3) int_0^1 [(1 - s)^2 + s^2] du = 0.7429 / 3; the new noise is variance-normalized (1/3 everywhere)
const VAR_MATCH = Math.sqrt(0.742857);
/** per-octave weight in F */
export const RT_W = AMP.map((a) => (a / NORM) * VAR_MATCH);
/** standard deviation of F with every octave resolved (= the former noise's) */
export const RT_SIGMA_F = Math.sqrt(RT_W.reduce((s, w) => s + (w * w) / 3, 0));
export const RT_F_CLAMP = RT_CLAMP_SIGMA * RT_SIGMA_F;

// Flow model: the angular velocity of circular orbits with J2, J4, J6 (as orbitalFrequencies, constants.ts) written as
//   Omega(a) = Omega_K(a) (1 + c1 u + c2 u^2 + c3 u^3),  u = (R/a)^2      (sqrt of the J series, error < 1e-10)
// so that Omega(r0 (1 + x)) / Omega_K(r0) = sum_k C_k (1 + x)^-(1.5 + 2k), C_0 = 1, C_k = c_k (R/r0)^2k: the GPU gets
// the difference to the frame origin without cancellation (rtDeltaOmega).
const FLOW_C1 = 0.75 * SATURN.J2;
const FLOW_C2 = -0.9375 * SATURN.J4 - 0.28125 * SATURN.J2 * SATURN.J2;
const FLOW_C3 = 1.09375 * SATURN.J6 + 0.703125 * SATURN.J2 * SATURN.J4 + 0.2109375 * SATURN.J2 ** 3;
/** (C1, C2, C3) of the flow model at the frame radius r0 */
export function flowCoefficients(r0: number): [number, number, number] {
  const u = (SATURN.R_GRAV_REF / r0) ** 2;
  return [FLOW_C1 * u, FLOW_C2 * u * u, FLOW_C3 * u * u * u];
}
/** Angular velocity (rad/s) of a circular orbit of radius r: the texture's and the propellers' flow model. */
export function omegaModel(r: number): number {
  const u = (SATURN.R_GRAV_REF / r) ** 2;
  return Math.sqrt(SATURN.GM / (r * r * r)) * (1 + FLOW_C1 * u + FLOW_C2 * u * u + FLOW_C3 * u * u * u);
}
/** coherence time (s): one orbital period at RT_R_NOMINAL (12.9 h) */
export const RT_T_COHERENCE = (2 * Math.PI) / omegaModel(RT_R_NOMINAL);
/** |dOmega/da| (rad/s/m) of the flow model at r0 (1 + x), from the frame-origin values (as the GLSL rtOmegaSlope) */
export function omegaSlope(x: number, omegaK0: number, C: readonly number[], invR0: number): number {
  const y = 1 + x;
  return omegaK0 * invR0 * (1.5 * y ** -2.5 + 3.5 * C[0] * y ** -4.5 + 5.5 * C[1] * y ** -6.5 + 7.5 * C[2] * y ** -8.5);
}
/** (1 + x)^-p - 1 without cancellation (identical to rtPowM1 in the GLSL: series for |x| < 0.05) */
export function powM1(x: number, p: number): number {
  if (Math.abs(x) < 0.05) {
    let t = 1, s = 0;
    for (let k = 1; k <= 7; k++) {
      t *= (-(p + k - 1) / k) * x;
      s += t;
    }
    return s;
  }
  return Math.pow(1 + x, -p) - 1;
}
/** omegaModel(r0 + aL) - omegaModel(r0) from the frame-origin values Omega_K(r0) and flowCoefficients(r0). */
export function deltaOmega(aL: number, omegaK0: number, C: readonly number[], invR0: number): number {
  const x = aL * invR0;
  return omegaK0 * (powM1(x, 1.5) + C[0] * powM1(x, 3.5) + C[1] * powM1(x, 5.5) + C[2] * powM1(x, 7.5));
}
export function texAmplitude(tau: number, wake: number): number {
  const t = Math.min(1, Math.max(0, (tau - 1) / 2));
  return RT_A0 + RT_A_TAU * t * t * (3 - 2 * t) + RT_A_WAKE * wake;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** deterministic [0, 1) from integers (generation offsets) */
function hash01(a: number, b: number): number {
  const r = mulberry32((Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x632be5ab, 0x85ebca77)) | 0);
  r();
  return r();
}
const mod = (x: number, m: number) => x - m * Math.floor(x / m);

export class RingTexture {
  /** amplitude multiplier: 1 = physical, 0 = off (tests) */
  amp = 1;
  /** the noise tile (exactly the half-float values on the GPU): RT_TILE^2 uniform values in [-1, 1] */
  readonly tile: Float32Array;
  readonly texture: DataTexture;
  /** azimuthal lattice cells around the ring per octave (multiples of RT_TILE) */
  readonly nAz: number[];
  /** lattice cell size at birth per octave (m) */
  readonly lambdaB: number[];
  readonly uniforms: {
    uRtNoise: { value: DataTexture };
    uRtOct: { value: Vector4[] };
    uRtGen: { value: Vector4 };
    uRtFlow: { value: Vector4 };
    uRtFlow2: { value: Vector4 };
    uRtOctW: { value: Vector4[] };
  };
  // frame state of the last update (CPU mirror; the propellers share the flow model)
  r0 = 1.3e8;
  omegaK0 = 1e-4;
  readonly flowC: [number, number, number] = [0, 0, 0];
  private readonly oct = Array.from({ length: 2 * RT_OCTAVES }, () => [0, 0, 0, 0]);
  private readonly gen = [0, 0, 0, 0];

  constructor(seed = 0x5a7e) {
    const n = RT_TILE * RT_TILE;
    this.tile = new Float32Array(n);
    const half = new Uint16Array(n);
    const rnd = mulberry32(seed);
    for (let i = 0; i < n; i++) {
      // k / 1024: exactly representable in half precision, so the GPU texels equal the mirror's values
      const v = Math.round((rnd() * 2 - 1) * 1024) / 1024;
      this.tile[i] = v;
      half[i] = DataUtils.toHalfFloat(v);
    }
    const tx = new DataTexture(half, RT_TILE, RT_TILE, RedFormat, HalfFloatType);
    tx.wrapS = RepeatWrapping;
    tx.wrapT = RepeatWrapping;
    tx.magFilter = LinearFilter;
    tx.minFilter = LinearFilter;
    tx.generateMipmaps = false;
    tx.needsUpdate = true;
    this.texture = tx;
    this.lambdaB = RT_LAMBDA.map((l) => RT_C_BIRTH * l);
    this.nAz = this.lambdaB.map((lb) => RT_TILE * Math.max(1, Math.round((2 * Math.PI * RT_R_NOMINAL) / lb / RT_TILE)));
    this.uniforms = {
      uRtNoise: { value: tx },
      uRtOct: { value: Array.from({ length: 2 * RT_OCTAVES }, () => new Vector4()) },
      uRtGen: { value: new Vector4() },
      uRtFlow: { value: new Vector4(1e-4, 0, 0, 0) },
      uRtFlow2: { value: new Vector4(1 / 1.3e8, 1, 0, 0) },
      uRtOctW: { value: RT_LAMBDA.map((l, j) => new Vector4(l, RT_W[j], (RT_W[j] * RT_W[j]) / 3, j === 0 ? RT_F_CLAMP : 0)) },
    };
  }

  /** Per frame: generation slots at time t (s TDB), lattice bases at the ring-frame origin (r0, phi0). */
  update(t: number, r0: number, phi0: number): void {
    const T = RT_T_COHERENCE, half = T / 2;
    this.r0 = r0;
    this.omegaK0 = Math.sqrt(SATURN.GM / (r0 * r0 * r0));
    const C = flowCoefficients(r0);
    this.flowC[0] = C[0]; this.flowC[1] = C[1]; this.flowC[2] = C[2];
    const om0 = omegaModel(r0);
    const nYoung = Math.floor(t / half);
    for (let g = 0; g < 2; g++) {
      const ng = nYoung - 1 + g; // slot 0: the older generation (visible age T/2 .. T), slot 1: the younger
      const ageVis = t - ng * half;
      this.gen[g] = Math.sin((Math.PI * ageVis) / T);
      const ageShear = ageVis + half; // already sheared for T/2 when it appears
      this.gen[g + 2] = ageShear;
      for (let j = 0; j < RT_OCTAVES; j++) {
        const lb = this.lambdaB[j], nAz = this.nAz[j];
        const uOff = RT_TILE * hash01(ng, 2 * j), vOff = RT_TILE * hash01(ng, 2 * j + 1);
        const u0 = mod(r0 / lb + uOff, RT_TILE);
        const v0 = mod(((phi0 - om0 * ageShear) * nAz) / (2 * Math.PI) + vOff, RT_TILE);
        const o = this.oct[g * RT_OCTAVES + j];
        o[0] = u0; o[1] = v0; o[2] = 1 / lb; o[3] = nAz / (2 * Math.PI);
        this.uniforms.uRtOct.value[g * RT_OCTAVES + j].set(u0, v0, 1 / lb, nAz / (2 * Math.PI));
      }
    }
    this.uniforms.uRtGen.value.set(this.gen[0], this.gen[1], this.gen[2], this.gen[3]);
    this.uniforms.uRtFlow.value.set(this.omegaK0, C[0], C[1], C[2]);
    this.uniforms.uRtFlow2.value.set(1 / r0, this.amp, 0, 0);
  }

  /** omegaModel(r0 + aL) - omegaModel(r0) at the last update's frame (rad/s) */
  deltaOmega(aL: number): number {
    return deltaOmega(aL, this.omegaK0, this.flowC, 1 / this.r0);
  }

  /** variance-normalized value noise of the tile at lattice point (u, v) (exact bilinear smoothstep weights) */
  noise(u: number, v: number): number {
    const iu = Math.floor(u), iv = Math.floor(v);
    const fu = u - iu, fv = v - iv;
    const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
    const N = RT_TILE;
    const x0 = mod(iu, N), x1 = mod(iu + 1, N), y0 = mod(iv, N), y1 = mod(iv + 1, N);
    const T = this.tile;
    const a = T[y0 * N + x0] * (1 - su) + T[y0 * N + x1] * su;
    const b = T[y1 * N + x0] * (1 - su) + T[y1 * N + x1] * su;
    const val = a * (1 - sv) + b * sv;
    const qu = (1 - su) * (1 - su) + su * su, qv = (1 - sv) * (1 - sv) + sv * sv;
    return val / Math.sqrt(qu * qv);
  }

  /**
   * The texture at Lagrangian offset aL = a' - r0 (m), azimuth offset dth (rad) from the frame origin, radial footprint
   * fp (m), with amplitude A (texAmplitude of the 1 km-prefiltered profile at a'): [mean factor, sub-footprint variance].
   * Same math as rsTauModTexture (GLSL), in double precision.
   */
  evalAt(aL: number, dth: number, fp: number, A: number, out: number[] = [1, 0]): number[] {
    out[0] = 1;
    out[1] = 0;
    if (!(this.amp > 0) || !(A > 0)) return out;
    const a = A * this.amp;
    let F = 0, vU = 0;
    let dW = NaN;
    for (let j = 0; j < RT_OCTAVES; j++) {
      const wv = Math.min(1, Math.max(0, (RT_LAMBDA[j] / Math.max(fp, 1e-3) - 1) * 0.5));
      vU += (1 - wv * wv) * (RT_W[j] * RT_W[j]) / 3;
      if (wv <= 0) continue;
      if (Number.isNaN(dW)) dW = this.deltaOmega(aL);
      let nj = 0;
      for (let g = 0; g < 2; g++) {
        if (this.gen[g] <= 0) continue;
        const o = this.oct[g * RT_OCTAVES + j];
        nj += this.gen[g] * this.noise(o[0] + aL * o[2], o[1] + (dth - dW * this.gen[g + 2]) * o[3]);
      }
      F += wv * RT_W[j] * nj;
    }
    F = Math.min(RT_F_CLAMP, Math.max(-RT_F_CLAMP, F));
    out[0] = 1 + a * F;
    out[1] = a * a * vU;
    return out;
  }

  /** Upper bound of the factor for amplitude A (near-field allocation: presence is thinned by tau0 M / tauMax). */
  maxFactor(A: number): number {
    return this.amp > 0 ? 1 + A * this.amp * RT_F_CLAMP : 1;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
