// Procedural self-gravity wakes for dense rings (A and B rings).
//
// Physics being imitated: in rings with a large surface density, collective self-gravity continuously
// forms transient, trailing, elongated particle aggregates ("wakes") with a radial spacing of order the
// Toomre critical wavelength  lambda_cr = 4 pi^2 G Sigma / kappa^2  (~40-60 m in the A/B rings) and a
// mean pitch angle of ~20-25 deg from the azimuthal direction (Salo 1992; Colwell et al. 2006; Hedman et
// al. 2007). Each wake is born at a steep angle, is sheared by Keplerian differential rotation into a
// more azimuthal orientation while being swing-amplified, and dissolves in ~half an orbit. Occultations
// show the A-ring wakes as nearly opaque elongated aggregates separated by gaps with tau ~ 0.1-0.2.
// Parameters calibrated against local N-body simulations (scripts/data/nbody, docs/ring-physics.md 10).
//
// Model (Lagrangian map, mirrored in src/render/shaders/wakes.glsl and scripts/data/nbody/procedural.py):
//  * Two overlapping "generations", half a lifetime T_LIFE/Omega apart. A generation is born with a fresh random
//    offset into a periodic tile of size L and is advected by the linear shear flow exactly like the particles:
//    u = (x, y + S x)/L + off with S = qShear * age.
//  * Each generation is a narrow-band random wave field Z(u) = W(u) exp(2 pi i m0.u): W is a smooth random
//    complex envelope (texture layer: Re W, Im W and the regularised phase gradient G = grad arg W), m0 = (m0x, 6)
//    the central mode. Local phase Theta = 2 pi m0.u + arg W; local strength a = s * e * (1 - exp(-|W|^2/Rc^2))
//    (weak where |W| ~ 0: wakes end, merge and split there, like the dislocations seen in N-body simulations).
//  * Envelope ("plateau", calibrated): within each half-life cycle (phase phi in [0, 1)) the younger generation
//    takes over from the older one by a smoothstep over 2 envW of the cycle; e_young + e_old = 1. With local
//    asynchrony the handover happens at the local phase phi - asyncD * delta(x): delta in [0, 1) is a smooth random
//    field (correlation length asyncEll Toomre wavelengths) advected with the shear flow and re-drawn every cycle,
//    so neighbouring regions show their wakes at different life stages (N-body: 12.7 deg within-snapshot pitch IQR).
//  * The generation maps a Lagrangian point p to x = p + n * (C(Theta) - Theta) / K along its mean wave normal n:
//    K is the LOCAL wave number along n (from G, >= 0.65 of the mean, smooth clamp) and C the composite circle
//    map C = G_g o M_gamma (M_gamma(Theta) = 2 atan(gamma tan(Theta/2)), G_g(phi) = atan(g tan phi)): density
//    1/gammaCore in the wake core and gammaGap in the gap at full local strength (independent: deeper gaps than
//    the plain circle map allows). Compressing each LOCAL wavelength into its own core keeps the map from folding
//    (the old map used the mean wave number and folded where the local one exceeded it).
//  * The two generations are composed (older first): x = M_young(M_old(q)); the particles evaluate the map at their
//    epicyclic position (guiding center + epicycle), so random velocities move them through the pattern without
//    smearing it. wakeDensity(x) = 1/(J_young J_old) inverts each map along its normal (closed-form guess exact for
//    a locally linear phase + 2 Newton steps): the medium's density factor is that of the drawn particles (within
//    20 % for 99.4 % (A set) / 97.4 % (B set) of the particles, area mean 0.998 / 0.997; procedural.py check-inverse,
//    docs/ring-physics.md 10.8, 10.11).
import { DataArrayTexture, DataTexture, FloatType, LinearFilter, RGBAFormat, RepeatWrapping, Vector2, Vector4 } from 'three';
import { G } from '../core/constants';
import type { RingFrame } from '../core/FrameState';
import type { RingLocal } from './RingProfile';
import { zoneParamsAtKm } from './ringRegions';

/** central mode m0y (the tile scale and the pitch at the envelope peak depend on it; m0x is per wake set) */
export const WAKE_M0Y = 6;
/** perpendicular spacing at peak (pitch ~20 deg) equals lambda: L = lambda * M0Y / sin(20 deg) */
export const WAKE_TILE_PER_LAMBDA = WAKE_M0Y / Math.sin((20 * Math.PI) / 180);
/** regularisation of the stored phase gradient Im(W* grad W) / max(|W|^2, G_EPS2) (|W|^2 normalised to mean 1) */
const G_EPS2 = 0.02;
/** asynchrony field: spectral width (modes per delta tile) and the tanh map of the unit Gaussian field to [0, 1) */
const DELTA_SIGMA = 2.5;
const DELTA_KAPPA = 0.8;
/** lower clamp of the local wave number (fraction of the mean): bounds the displacement by ~lambda_w/2 per generation */
export const WAKE_K_MIN = 0.65;
/** wakeDensity clamp: [CLAMP_LO gammaGap^s, CLAMP_HI gammaCore^-s]. The particles' density reaches 0.82 / 0.98 gammaGap^s
 * at its minimum (A / B sets; procedural.py), so the floor (= wakeMinDensity, the culling bound) is a true lower bound. */
const CLAMP_LO = 0.8;
const CLAMP_HI = 4.0;
/** generation-index offset per test realization (WakeField.realization) */
const REALIZATION_STRIDE = 104729;

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
  /** core contrast: density factor 1/gamma in the wake core at full local strength */
  gamma: number;
  /** gap density factor at full local strength (composite circle map; = gamma: the plain circle map) */
  gammaGap: number;
  /** spread of the envelope modes along m0 (irregularity of the spacing) */
  spreadPar: number;
  /** spread across m0 (controls wake length / orientation scatter) */
  spreadPerp: number;
  /** dislocation scale: local strength 1 - exp(-|W|^2/rc^2) */
  rc: number;
  /** generation lifetime (1/Omega); a new generation every tLife/2 */
  tLife: number;
  /** birth mode m0 = (m0x, 6): pitch at birth atan(6/m0x) */
  m0x: number;
  /** plateau envelope: handover over 2 envW of the half-life cycle */
  envW: number;
  /** local asynchrony: spread of the handover phase (fraction of the cycle; asyncD + 2 envW <= 1) */
  asyncD: number;
  /** correlation length of the asynchrony field (Toomre wavelengths) */
  asyncEll: number;
  /** tile = lambda * WAKE_TILE_PER_LAMBDA * tileScale: crest spacing at the envelope peak = tileScale * lambda */
  tileScale: number;
}

/**
 * The calibrated wake sets (docs/ring-physics.md 10.11; scripts/data/nbody/results/calib_*-v2.json): A from the
 * identical-particle mid-A-ring run (A128-ident, checked against A128-sd), B from the B-ring run (B105-sd, Sigma 600).
 */
export const WAKE_SETS: { A: WakeShape; B: WakeShape } = {
  A: { gamma: 0.132, gammaGap: 0.073, spreadPar: 1.6, spreadPerp: 5.0, rc: 0.8, tLife: 6, m0x: 1, envW: 0.1, asyncD: 0.25, asyncEll: 2, tileScale: 1.2 },
  B: { gamma: 0.126, gammaGap: 0.069, spreadPar: 1.2, spreadPerp: 9.0, rc: 0.6, tLife: 6, m0x: 2, envW: 0.2, asyncD: 0, asyncEll: 3, tileScale: 1 },
};

/**
 * The wake set at a ring radius: the zone's wakeB (0 = A-ring set, 1 = B-ring set), blended across zone boundaries like
 * every zone parameter (continuous parameters interpolated, gamma in log, m0x rounded so the texture stays tileable).
 * In practice A or B: no A-ring wake zone borders a B-ring wake zone (the wake-free Cassini Division lies between).
 */
export function wakeShapeFor(local: RingLocal): WakeShape {
  const w = Math.min(1, Math.max(0, zoneParamsAtKm(local.rKm).wakeB));
  const a = WAKE_SETS.A, b = WAKE_SETS.B;
  const lin = (x: number, y: number) => x * (1 - w) + y * w;
  const lg = (x: number, y: number) => Math.exp(Math.log(x) * (1 - w) + Math.log(y) * w);
  return {
    gamma: lg(a.gamma, b.gamma), gammaGap: lg(a.gammaGap, b.gammaGap),
    spreadPar: lin(a.spreadPar, b.spreadPar), spreadPerp: lin(a.spreadPerp, b.spreadPerp),
    rc: lin(a.rc, b.rc), tLife: lin(a.tLife, b.tLife), m0x: Math.round(lin(a.m0x, b.m0x)),
    envW: lin(a.envW, b.envW), asyncD: lin(a.asyncD, b.asyncD), asyncEll: lin(a.asyncEll, b.asyncEll),
    tileScale: lin(a.tileScale, b.tileScale),
  };
}

export class WakeField {
  readonly N = 256;
  readonly DN = 64;
  /** set to override the zone-derived wake shape (testing / tuning) */
  shapeOverride: Partial<WakeShape> | null = null;
  /** two layers (envelope fields A, B): (Re W, Im W, G_u, G_v) */
  readonly texture: DataArrayTexture;
  /** asynchrony field: (delta, d delta/du, d delta/dv, 0) over one delta tile */
  readonly deltaTexture: DataTexture;
  /** tile size (m) */
  tile = 1000;
  /** local Toomre wavelength (m) */
  lambda = 60;
  strength = 0;
  omega = 1e-4;
  qShear = 1.5;
  enabled = true;
  /** realization index (tests: an independent wake pattern at the same time and place; 0 in the app): offsets the
   * generation hash, so the generations' offsets and the asynchrony frame are redrawn (scripts/test/seam.mjs) */
  realization = 0;
  shape: WakeShape = { ...WAKE_SETS.A };
  private texKey = '';
  private readonly seed: number;
  private readonly data: Float32Array;
  private readonly ddata: Float32Array;
  private dscale = 1;

  readonly uniforms = {
    uWakeTex: { value: null as DataArrayTexture | null },
    uWakeDTex: { value: null as DataTexture | null },
    uWakeTile: { value: 1000 },
    // per generation (0 = older, 1 = younger): (shear S_g, offsetU, offsetV, texture layer)
    uWakeGen: { value: [new Vector4(), new Vector4()] },
    // (cycle phase phi in [0, 1), asyncD, 2 envW (0: sin^2 handover), strength)
    uWakeClock: { value: new Vector4(0, 0, 0.2, 0) },
    // asynchrony frame: (offsetU, offsetV, shear of the younger generation, delta-tile scale / L)
    uWakeDelta: { value: new Vector4(0, 0, 0, 1e-3) },
    // (ln gamma, ln g, 1/Rc^2, K_MIN): gammaCore = gamma g, gammaGap = gamma / g
    uWakeShape: { value: new Vector4(Math.log(0.1), 0, 1 / 0.64, WAKE_K_MIN) },
    uWakeM0: { value: new Vector2(1, WAKE_M0Y) },
    // (lower clamp of wakeDensity, upper clamp, max displacement per generation (m), 0)
    uWakeBounds: { value: new Vector4(1, 1, 1, 0) },
    uWakeOn: { value: 0 },
    // hook (next work package): tau-weighted mean participation of the medium in the wakes (wakeDensityTau); 1 now
    uWakePartTau: { value: 1 },
  };

  constructor(seed = 12345) {
    this.seed = seed;
    this.data = new Float32Array(this.N * this.N * 4 * 2);
    const t = new DataArrayTexture(this.data, this.N, this.N, 2);
    t.format = RGBAFormat;
    t.type = FloatType;
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.generateMipmaps = false;
    this.texture = t;
    this.ddata = new Float32Array(this.DN * this.DN * 4);
    const d = new DataTexture(this.ddata, this.DN, this.DN, RGBAFormat, FloatType);
    d.wrapS = RepeatWrapping;
    d.wrapT = RepeatWrapping;
    d.magFilter = LinearFilter;
    d.minFilter = LinearFilter;
    d.generateMipmaps = false;
    this.deltaTexture = d;
    this.uniforms.uWakeTex.value = t;
    this.uniforms.uWakeDTex.value = d;
    this.buildTexture(this.shape);
    this.buildDeltaTexture();
  }

  /**
   * Fill the two texture layers with independent smooth complex envelopes W_A, W_B (mean |W|^2 = 1) and their
   * regularised phase gradients G = Im(W* grad W) / max(|W|^2, G_EPS2) (radians per tile). The mode sums are separable
   * two-pass sums (rows, then columns) in float64; the port (procedural.py) uses inverse FFTs: equal to float32
   * rounding (--verify).
   */
  private buildTexture(shape: WakeShape): void {
    const N = this.N;
    const data = this.data;
    const m0x = shape.m0x, m0y = WAKE_M0Y;
    const m0n = Math.hypot(m0x, m0y);
    const px = m0x / m0n, py = m0y / m0n; // unit vector along m0 (texture u,v axes)
    const sp = shape.spreadPar, sq = shape.spreadPerp;
    const R = Math.ceil(3 * Math.max(sp, sq)) + 1;
    const nd = 2 * R + 1;
    // phasors e^{2 pi i d n / N} for d in [-R, R], n in [0, N)
    const cs = new Float64Array(nd * N), sn = new Float64Array(nd * N);
    for (let d = -R; d <= R; d++) {
      for (let n = 0; n < N; n++) {
        const ang = (2 * Math.PI * d * n) / N;
        cs[(d + R) * N + n] = Math.cos(ang);
        sn[(d + R) * N + n] = Math.sin(ang);
      }
    }
    const W = new Float64Array(N * N * 6); // per texel: W, dW/du, dW/dv (re, im)
    const A = new Float64Array(nd * N * 4); // per (dy, i): sum over dx of c e(dx, i) and of c (2 pi i dx) e(dx, i)
    for (let field = 0; field < 2; field++) {
      const rnd = mulberry32(this.seed + field * 977);
      const cre = new Float64Array(nd * nd), cim = new Float64Array(nd * nd);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const par = dx * px + dy * py;
          const perp = -dx * py + dy * px;
          const w = Math.exp(-0.5 * ((par * par) / (sp * sp) + (perp * perp) / (sq * sq)));
          if (w < 0.01) continue;
          // complex Gaussian amplitude (Rayleigh modulus, uniform phase)
          const ray = Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd())));
          const ph = rnd() * Math.PI * 2;
          cre[(dy + R) * nd + dx + R] = w * ray * Math.cos(ph);
          cim[(dy + R) * nd + dx + R] = w * ray * Math.sin(ph);
        }
      }
      // pass 1: rows
      A.fill(0);
      for (let dy = 0; dy < nd; dy++) {
        for (let dx = 0; dx < nd; dx++) {
          const cr = cre[dy * nd + dx], ci = cim[dy * nd + dx];
          if (cr === 0 && ci === 0) continue;
          const f = 2 * Math.PI * (dx - R);
          for (let i = 0; i < N; i++) {
            const c = cs[dx * N + i], s = sn[dx * N + i];
            const tr = cr * c - ci * s, ti = cr * s + ci * c;
            const k = (dy * N + i) * 4;
            A[k] += tr;
            A[k + 1] += ti;
            A[k + 2] -= f * ti; // (2 pi i dx) (tr + i ti)
            A[k + 3] += f * tr;
          }
        }
      }
      // pass 2: columns
      W.fill(0);
      for (let dy = 0; dy < nd; dy++) {
        const f = 2 * Math.PI * (dy - R);
        for (let j = 0; j < N; j++) {
          const c = cs[dy * N + j], s = sn[dy * N + j];
          for (let i = 0; i < N; i++) {
            const k = (dy * N + i) * 4;
            const ar = A[k], ai = A[k + 1], br = A[k + 2], bi = A[k + 3];
            if (ar === 0 && ai === 0 && br === 0 && bi === 0) continue;
            const tr = ar * c - ai * s, ti = ar * s + ai * c;
            const o = (j * N + i) * 6;
            W[o] += tr;
            W[o + 1] += ti;
            W[o + 2] += br * c - bi * s;
            W[o + 3] += br * s + bi * c;
            W[o + 4] -= f * ti;
            W[o + 5] += f * tr;
          }
        }
      }
      // float32 W, renormalised to unit mean |W|^2 over the texture (finite mode sums are not exactly unit)
      const L = field * N * N * 4;
      let s2 = 0;
      for (let p = 0; p < N * N; p++) {
        data[L + p * 4] = W[p * 6];
        data[L + p * 4 + 1] = W[p * 6 + 1];
        s2 += data[L + p * 4] * data[L + p * 4] + data[L + p * 4 + 1] * data[L + p * 4 + 1];
      }
      const f = 1 / Math.sqrt(s2 / (N * N));
      const f2 = f * f;
      for (let p = 0; p < N * N; p++) {
        const k = L + p * 4;
        data[k] *= f;
        data[k + 1] *= f;
        const wr = W[p * 6], wi = W[p * 6 + 1];
        const den = Math.max((wr * wr + wi * wi) * f2, G_EPS2);
        data[k + 2] = ((wr * W[p * 6 + 3] - wi * W[p * 6 + 2]) * f2) / den;
        data[k + 3] = ((wr * W[p * 6 + 5] - wi * W[p * 6 + 4]) * f2) / den;
      }
    }
    this.texture.needsUpdate = true;
    this.texKey = `${shape.spreadPar.toFixed(6)}/${shape.spreadPerp.toFixed(6)}/${shape.m0x}`;
  }

  /** The asynchrony field over one delta tile: delta = 0.5 + 0.5 tanh(kappa g) of a smooth isotropic unit Gaussian
   * field g (Gaussian spectrum, DELTA_SIGMA modes per tile, no mean) and its gradient (per tile unit). */
  private buildDeltaTexture(): void {
    const N = this.DN;
    const R = Math.ceil(3 * DELTA_SIGMA) + 1;
    const rnd = mulberry32(this.seed + 3 * 977);
    const modes: { mx: number; my: number; re: number; im: number }[] = [];
    for (let my = -R; my <= R; my++) {
      for (let mx = -R; mx <= R; mx++) {
        if (mx === 0 && my === 0) continue;
        const w = Math.exp((-0.5 * (mx * mx + my * my)) / (DELTA_SIGMA * DELTA_SIGMA));
        if (w < 0.01) continue;
        const ray = Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd())));
        const ph = rnd() * Math.PI * 2;
        modes.push({ mx, my, re: w * ray * Math.cos(ph), im: w * ray * Math.sin(ph) });
      }
    }
    const g = new Float64Array(N * N * 3);
    let s2 = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let v = 0, gu = 0, gv = 0;
        for (const m of modes) {
          const ang = (2 * Math.PI * (m.mx * i + m.my * j)) / N;
          const c = Math.cos(ang), s = Math.sin(ang);
          const tr = m.re * c - m.im * s, ti = m.re * s + m.im * c;
          v += tr;
          gu -= 2 * Math.PI * m.mx * ti; // Re((2 pi i m) (tr + i ti))
          gv -= 2 * Math.PI * m.my * ti;
        }
        const o = (j * N + i) * 3;
        g[o] = v;
        g[o + 1] = gu;
        g[o + 2] = gv;
        s2 += v * v;
      }
    }
    const sc = 1 / Math.sqrt(s2 / (N * N));
    for (let p = 0; p < N * N; p++) {
      const t = Math.tanh(DELTA_KAPPA * g[p * 3] * sc);
      const dd = 0.5 * DELTA_KAPPA * sc * (1 - t * t);
      this.ddata[p * 4] = 0.5 + 0.5 * t;
      this.ddata[p * 4 + 1] = dd * g[p * 3 + 1];
      this.ddata[p * 4 + 2] = dd * g[p * 3 + 2];
      this.ddata[p * 4 + 3] = 0;
    }
    this.deltaTexture.needsUpdate = true;
  }

  /** Configure for the local ring patch at the frame anchor. */
  configure(local: RingLocal, ring: RingFrame): void {
    this.omega = ring.omega;
    this.qShear = ring.qShear;
    const sigma = Math.max(local.sigma, 1e-3);
    this.lambda = (4 * Math.PI * Math.PI * G * sigma) / (ring.kappa * ring.kappa);
    // wakes only exist when the Toomre wavelength comfortably exceeds the largest particles
    const sizeOk = Math.min(1, Math.max(0, (this.lambda / Math.max(local.aMax, 0.1) - 2) / 4));
    this.strength = local.macroscopic ? Math.min(1, local.wake * sizeOk) : 0;
    this.shape = { ...wakeShapeFor(local), ...(this.shapeOverride ?? {}) };
    const sh = this.shape;
    this.tile = Math.max(this.lambda * WAKE_TILE_PER_LAMBDA * sh.tileScale, 1);
    sh.asyncD = Math.min(Math.max(sh.asyncD, 0), Math.max(0, 1 - 2 * sh.envW), 0.95);
    const key = `${sh.spreadPar.toFixed(6)}/${sh.spreadPerp.toFixed(6)}/${sh.m0x}`;
    if (key !== this.texKey) this.buildTexture(sh);
    this.uniforms.uWakeTile.value = this.tile;
    // delta tile = tile / dscale: 1/e correlation length of the underlying Gaussian field = asyncEll lambda
    this.dscale = this.tile / (Math.PI * DELTA_SIGMA * sh.asyncEll * this.lambda);
    const lgc = Math.log(sh.gamma), lgg = Math.log(sh.gammaGap);
    this.uniforms.uWakeShape.value.set(0.5 * (lgc + lgg), 0.5 * (lgc - lgg), 1 / (sh.rc * sh.rc), WAKE_K_MIN);
    this.uniforms.uWakeM0.value.set(sh.m0x, WAKE_M0Y);
    const kLo = ((2 * Math.PI) / this.tile) * WAKE_M0Y;
    this.uniforms.uWakeBounds.value.set(CLAMP_LO * Math.exp(lgg * this.strength), CLAMP_HI * Math.exp(-lgc * this.strength),
      Math.PI / (WAKE_K_MIN * kLo), 0);
  }

  /** Per-frame generation parameters. t = sim time (s since J2000). */
  update(t: number): void {
    const on = this.enabled && this.strength > 1e-3;
    this.uniforms.uWakeOn.value = on ? 1 : 0;
    const sh = this.shape;
    const tau = this.omega * t; // dimensionless time (radians of orbital phase)
    const P = 0.5 * sh.tLife;
    const ny = Math.floor(tau / P);
    const phi = tau / P - ny;
    const rz = REALIZATION_STRIDE * this.realization;
    for (let g = 0; g < 2; g++) {
      const n = ny - 1 + g; // g = 0 -> older generation, g = 1 -> younger
      const age = tau - n * P; // [P, 2P) for the older one, [0, P) for the younger
      this.uniforms.uWakeGen.value[g].set(this.qShear * age, hashFloat(n + rz, 1), hashFloat(n + rz, 2), ((n % 2) + 2) % 2);
    }
    this.uniforms.uWakeClock.value.set(phi, sh.asyncD, 2 * sh.envW, on ? this.strength : 0);
    this.uniforms.uWakeDelta.value.set(hashFloat(ny + rz, 3), hashFloat(ny + rz, 4), this.qShear * (tau - ny * P), this.dscale / this.tile);
    this._tau = tau;
  }
  private _tau = 0;

  /** Envelope of the younger generation at asynchrony phase delta (the older one has 1 - e); wakes.glsl wakeEnvYoung. */
  envYoung(delta: number): number {
    const c = this.uniforms.uWakeClock.value;
    if (c.z <= 0) {
      const x = c.y > 0 ? Math.min(1, Math.max(0, (c.x - c.y * delta) / (1 - c.y))) : c.x;
      return Math.sin(0.5 * Math.PI * x) ** 2;
    }
    return smooth(0, c.z, c.x - c.y * delta);
  }

  /** Mean amplitude (strength x envelope at the median delta) of generation g (0 older, 1 younger). */
  genAmplitude(g: number): number {
    const ey = this.envYoung(0.5);
    return this.strength * (g === 1 ? ey : 1 - ey);
  }

  /** Unit wave normal (local x, y) of generation g (mean mode, sheared). */
  genNormal(g: number, out: Vector2): Vector2 {
    const S = this.uniforms.uWakeGen.value[g].x;
    return out.set(this.shape.m0x + S * WAKE_M0Y, WAKE_M0Y).normalize();
  }

  /** Current amplitude-weighted mean pitch angle (deg) of the wake pattern, for the HUD. */
  get pitchDeg(): number {
    if (this.strength <= 1e-3) return 0;
    let wsum = 0, psum = 0;
    for (let g = 0; g < 2; g++) {
      const w = this.genAmplitude(g);
      const S = this.uniforms.uWakeGen.value[g].x;
      const pitch = Math.atan2(WAKE_M0Y, this.shape.m0x + S * WAKE_M0Y) * (180 / Math.PI);
      wsum += w;
      psum += w * pitch;
    }
    return wsum > 0 ? psum / wsum : 0;
  }

  /** Orbital phase (rad) used for the generation clock (for debugging). */
  get clockPhase(): number {
    return this._tau;
  }

  /**
   * Hook for size-dependent participation (next work package): the tau-weighted mean participation p of the medium in
   * the wakes, D_tau = 1 + p (D - 1) (sv_wakes wakeDensityTau). 1 = every size follows the wakes fully (the model now).
   */
  get participationTau(): number {
    return this.uniforms.uWakePartTau.value;
  }
  set participationTau(v: number) {
    this.uniforms.uWakePartTau.value = Math.min(1, Math.max(0, v));
  }
}
