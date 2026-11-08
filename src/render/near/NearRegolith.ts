// Regolith photometry of resolved ring particles: the surface law, its disk integration and the per-particle
// factor LUT that keeps the near-field / medium photometry contract.
//
// GLSL: ringRegolithIF (the surface law, src/render/shaders/lighting.glsl) is evaluated per pixel by
// src/render/near/nearDraw.frag.glsl; the LUT built here (tRegolithF, nearRegolithFactor in
// src/render/near/nearCommon.glsl) is read per particle by nearDraw.vert.glsl, for the Sun and for Saturnshine.
//
// Surface law (radiance factor I/F of a surface element, lit at incidence cosine mu0, seen at mu, phase angle g):
// Hapke's model with macroscopic roughness (Hapke 1984, Icarus 59, 41; mean slope theta-bar) and the improved
// isotropic multiple-scattering H function (Hapke 2002, Icarus 157, 523), single-term Henyey-Greenstein grains:
//   I/F = (w/4) mu0e/(mu0e + mue) [p(g) + H(mu0e) H(mue) - 1] S(i, e, psi)
// Parameters for icy ring-particle regolith:
//   theta-bar = 30 deg: between the Hapke fits to HST ring phase curves for the C ring (26 +- 9 deg) and the
//     roughness of Rhea's icy regolith (33 deg, Ciarniello et al. 2011, Icarus 214, 541); icy satellites are
//     <= 40 deg, ~20 deg typical (Poulet et al. 2002, Icarus 158, 224). Poulet et al. find A/B-ring particles far
//     rougher (63-70 deg, beyond the model's range) and conclude they are lumpy: that part of the roughness is
//     resolved geometry here (the displaced particle surfaces, nearRelief in nearCommon.glsl).
//   xi = -0.35 (back-scattering grains): Poulet et al. 2002 Hapke fits, -0.26 (C) ... -0.38 (A) at 555 nm.
//   w (grain single-scattering albedo) per particle, from its albedo A (the particle's Bond albedo, i.e. the
//     medium's single-scattering albedo) by inverting the spherical albedo A_s(w) of a Hapke sphere
//     (A_s = 0.50 at w ~ 0.95: A/B-ring ice; C ring A ~ 0.25 -> w ~ 0.7). Only the brightness distribution
//     over the particle depends on w; the brightness itself is fixed by A and the contract below.
//   No opposition term in the surface law: the surge is an alpha-only factor and is carried by the LUT factor
//     through ringParticlePhase (the medium's intrinsic surge, 1 + 0.5 exp(-alpha/0.05)).
// With these parameters a Hapke sphere already has almost the power-law phase function of the medium
// (P(0) = 4.6-5.3 vs 5.70; Lambert sphere: 2.67): the factor below stays within ~0.95-1.25 for alpha <= 90 deg
// (Lambert: 2.1 ... 0.68), i.e. the regolith law, not the correction, carries the observed back-scattering.
//
// Contract (as for the Lambert law it replaces): a particle shaded L = (A E / pi) (I/F) f(alpha) has the disk-
// integrated phase function ringParticlePhase(alpha) at every phase angle, so an ensemble of resolved particles
// is exactly as bright as the medium they replace (and as the sub-pixel discs, which use ringParticlePhase):
//   f(alpha) = ringParticlePhase(alpha) / (4 Phi_w(alpha)),
//   Phi_w(alpha) = (1/pi) Int Int (I/F)(mu0, mu, alpha) cos^2(beta) cos(Lambda) dbeta dLambda
// over the lit and visible part of a unit sphere in photometric coordinates (luminance longitude Lambda in
// [alpha - pi/2, pi/2], latitude beta; mu0 = cos(beta) cos(Lambda - alpha), mu = cos(beta) cos(Lambda), projected
// area element cos(beta) cos(Lambda) dA). Lambert check: (I/F) = mu0 gives 4 Phi = phaseLambertSphere.
// Method: Gauss-Legendre quadrature, 24 nodes in Lambda x 12 in beta (beta symmetric); relative error <= 1.2e-4
// against 96 x 48 nodes for alpha <= 170 deg. A_s(w) = 2 Int Phi_w sin(alpha) d(alpha) (Simpson, 32 intervals) on a
// 24-point w grid, inverted linearly for each row's albedo.
// LUT (RGBA32F, REGOLITH_LUT_NA x REGOLITH_LUT_NALB): x = alpha / pi at texel centres (alpha_i = i pi/(NA-1)),
// y = particle albedo A_j = A0 + (A1 - A0) (j/(NALB-1))^2 (rows denser at low albedo, where w(A) is steep);
// R = f(alpha)/surge(alpha) = P_power(alpha) / (4 Phi_w(alpha)) (the narrow surge is multiplied analytically in
// GLSL), G = w(A_j), B = A_s(w). Beyond 172 deg (P < 1e-4 of its peak) R is held constant.
// scripts/test/particles.mjs checks the LUT against direct disk integrals and the GLSL law against this mirror.
import { ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, RGBAFormat } from 'three';
import { PHASE_POWER_N, powerLawNorm } from '../rings/phase';

export const REGOLITH_THETA_BAR_DEG = 30;
export const REGOLITH_XI = -0.35;
export const REGOLITH_LUT_NA = 64;
export const REGOLITH_LUT_NALB = 32;
/**
 * albedo range of the LUT rows (particle albedo, luminance-weighted; the zones span 0.13-0.8 with the particle-to-
 * particle spread; below 0.08 w(A) is so steep that the rows would need a finer spacing)
 */
export const REGOLITH_A0 = 0.08;
export const REGOLITH_A1 = 0.95;
/** grain albedo range (w -> 1: conservative grains) */
export const REGOLITH_W_MIN = 0.02;
export const REGOLITH_W_MAX = 0.999;
/** phase angle (deg) beyond which the factor is held constant (the scattered light is < 1e-4 of the peak there) */
const ALPHA_HOLD_DEG = 172;

const PI = Math.PI;
const TAN_T = Math.tan((REGOLITH_THETA_BAR_DEG * PI) / 180);
const COT_T = 1 / TAN_T;
const CHI = 1 / Math.sqrt(1 + PI * TAN_T * TAN_T);

/**
 * Radiance factor I/F of the regolith surface (Hapke 1984 roughness, Hapke 2002 H functions), CPU mirror of
 * ringRegolithIF in lighting.glsl (keep both identical). mu0, mu: cosines of incidence / emission w.r.t. the
 * local normal; cosg: cos(phase angle); w: grain single-scattering albedo. 0 where unlit or invisible.
 */
export function regolithIF(mu0: number, mu: number, cosg: number, w: number): number {
  if (mu0 <= 0 || mu <= 0) return 0;
  const si = Math.sqrt(Math.max(1 - mu0 * mu0, 0)), se = Math.sqrt(Math.max(1 - mu * mu, 0));
  const cp = si * se > 1e-6 ? Math.min(1, Math.max(-1, (cosg - mu0 * mu) / (si * se))) : 1;
  const psi = Math.acos(cp);
  const f = Math.exp(-2 * Math.sqrt(Math.max(1 - cp, 0) / Math.max(1 + cp, 1e-6)));   // exp(-2 tan(psi/2))
  const ci = mu0 / Math.max(si, 1e-6), ce = mu / Math.max(se, 1e-6);                  // cot i, cot e
  const E1i = Math.exp((-2 / PI) * COT_T * ci), E1e = Math.exp((-2 / PI) * COT_T * ce);
  const qi = COT_T * ci, qe = COT_T * ce;
  const E2i = Math.exp((-1 / PI) * qi * qi), E2e = Math.exp((-1 / PI) * qe * qe);
  const etai = CHI * (mu0 + (si * TAN_T * E2i) / (2 - E1i));
  const etae = CHI * (mu + (se * TAN_T * E2e) / (2 - E1e));
  const s2 = 0.5 * (1 - cp);
  let mu0e: number, mue: number, S: number;
  if (mu0 >= mu) {
    const den = 2 - E1e - (psi / PI) * E1i;
    mu0e = CHI * (mu0 + (si * TAN_T * (cp * E2e + s2 * E2i)) / den);
    mue = CHI * (mu + (se * TAN_T * (E2e - s2 * E2i)) / den);
    S = (mue / etae) * (mu0 / etai) * (CHI / (1 - f + (f * CHI * mu0) / etai));
  } else {
    const den = 2 - E1i - (psi / PI) * E1e;
    mu0e = CHI * (mu0 + (si * TAN_T * (E2i - s2 * E2e)) / den);
    mue = CHI * (mu + (se * TAN_T * (cp * E2i + s2 * E2e)) / den);
    S = (mue / etae) * (mu0 / etai) * (CHI / (1 - f + (f * CHI * mu) / etae));
  }
  mu0e = Math.max(mu0e, 1e-6);
  mue = Math.max(mue, 1e-6);
  const gam = Math.sqrt(Math.max(1 - w, 0)), r0 = (1 - gam) / (1 + gam);
  const H0 = 1 / (1 - w * mu0e * (r0 + (0.5 - r0 * mu0e) * Math.log((1 + mu0e) / mu0e)));
  const H1 = 1 / (1 - w * mue * (r0 + (0.5 - r0 * mue) * Math.log((1 + mue) / mue)));
  const xi = REGOLITH_XI;
  const p = (1 - xi * xi) / Math.pow(1 + 2 * xi * cosg + xi * xi, 1.5);
  return Math.max(0.25 * w * (mu0e / (mu0e + mue)) * (p + H0 * H1 - 1) * S, 0);
}

// ---------------------------------------------------------------------------------------------- quadrature
function gaussLegendre(n: number): { x: Float64Array; w: Float64Array } {
  const x = new Float64Array(n), w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let z = Math.cos((PI * (i + 0.75)) / (n + 0.5));
    for (let it = 0; it < 100; it++) {
      let p1 = 1, p2 = 0;
      for (let j = 0; j < n; j++) { const p3 = p2; p2 = p1; p1 = ((2 * j + 1) * z * p2 - j * p3) / (j + 1); }
      const pp = (n * (z * p1 - p2)) / (z * z - 1);
      const z1 = z;
      z = z1 - p1 / pp;
      if (Math.abs(z - z1) < 1e-15) { w[i] = 2 / ((1 - z * z) * pp * pp); break; }
    }
    x[i] = z;
  }
  return { x, w };
}
let GL_L: ReturnType<typeof gaussLegendre> | null = null;
let GL_B: ReturnType<typeof gaussLegendre> | null = null;

/**
 * Phi(alpha) = (1 / (pi a^2)) Int (I/F) dA_projected over a sphere of radius a at phase angle alpha (rad), for any
 * surface law `law(mu0, mu, cosg)` (default: the regolith law with grain albedo w). nL x nB quadrature nodes.
 */
export function sphereDiskPhi(alpha: number, w: number, law?: (mu0: number, mu: number, cosg: number) => number, nL = 24, nB = 12): number {
  const gl = nL === 24 && nB === 12
    ? { L: (GL_L ??= gaussLegendre(24)), B: (GL_B ??= gaussLegendre(12)) }
    : { L: gaussLegendre(nL), B: gaussLegendre(nB) };
  const fn = law ?? ((m0: number, m: number, cg: number) => regolithIF(m0, m, cg, w));
  const L0 = alpha - PI / 2, L1 = PI / 2, cg = Math.cos(alpha);
  let s = 0;
  for (let i = 0; i < gl.L.x.length; i++) {
    const L = 0.5 * (L1 - L0) * gl.L.x[i] + 0.5 * (L1 + L0), wL = 0.5 * (L1 - L0) * gl.L.w[i];
    const cL = Math.cos(L), cLa = Math.cos(L - alpha);
    for (let j = 0; j < gl.B.x.length; j++) {
      // beta in [0, pi/2] (the integrand is symmetric in beta): factor 2
      const be = (PI / 4) * gl.B.x[j] + PI / 4, wb = (PI / 4) * gl.B.w[j];
      const cb = Math.cos(be);
      s += 2 * wL * wb * fn(cb * cLa, cb * cL, cg) * cb * cb * cL;
    }
  }
  return s / PI;
}

/** Spherical (Bond) albedo of a sphere with the regolith law: A_s = 2 Int_0^pi Phi_w(alpha) sin(alpha) d alpha. */
export function regolithSphericalAlbedo(w: number, n = 64): number {
  // Simpson over alpha (Phi -> 0 at pi)
  let s = 0;
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * PI;
    const c = k === 0 || k === n ? 1 : k % 2 ? 4 : 2;
    s += c * (k === n ? 0 : sphereDiskPhi(a, w)) * Math.sin(a);
  }
  return 2 * s * (PI / n) / 3;
}

/** CPU mirror of extendedSourceCosine (lighting.glsl): incidence cosine of a uniform spherical source. */
export function extendedSourceCosine(cosTheta: number, sinSigma: number): number {
  const s2 = sinSigma * sinSigma;
  if (cosTheta * cosTheta >= s2) return Math.max(cosTheta, 0);
  const sinTheta = Math.sqrt(Math.max(1 - cosTheta * cosTheta, 1e-8));
  const x = Math.sqrt(Math.max(1 / Math.max(s2, 1e-8) - 1, 0));
  const y = Math.min(1, Math.max(-1, (-x * cosTheta) / sinTheta));
  const sty = sinTheta * Math.sqrt(Math.max(1 - y * y, 0));
  return Math.max(((cosTheta * Math.acos(y) - x * sty) * s2 + Math.atan2(sty, Math.max(x, 1e-6))) / (PI * s2), 0);
}

/** power-law particle phase function without the opposition surge (lighting.glsl ringParticlePhase / surge) */
export function powerLawPhase(alpha: number): number {
  return powerLawNorm() * Math.pow(Math.max(0, 1 - alpha / PI), PHASE_POWER_N);
}
/** intrinsic opposition surge factor of ringParticlePhase (lighting.glsl ringParticleSurge) */
export function particleSurge(alpha: number): number {
  return 1 + 0.5 * Math.exp(-alpha / 0.05);
}

export interface RegolithTable {
  /** RGBA32F NA x NALB: (P_power / (4 Phi_w), w, A_s(w), -) */
  lut: DataTexture;
  /** per row: particle albedo, grain albedo w, spherical albedo of the regolith sphere at that w */
  albedo: Float32Array;
  w: Float32Array;
  As: Float32Array;
  /** R channel, row-major [row * NA + i] */
  factor: Float32Array;
  /** build time (ms) */
  ms: number;
}

let cached: RegolithTable | null = null;

/** particle albedo of LUT row j: A0 + (A1 - A0) (j / (NALB - 1))^2 (denser at low albedo, where w(A) is steep) */
export function rowAlbedo(j: number): number {
  const y = j / (REGOLITH_LUT_NALB - 1);
  return REGOLITH_A0 + (REGOLITH_A1 - REGOLITH_A0) * y * y;
}
/** fractional LUT row of a particle albedo (inverse of rowAlbedo; GLSL nearRegolithFactor) */
export function albedoRow(A: number): number {
  return Math.sqrt(Math.min(Math.max((A - REGOLITH_A0) / (REGOLITH_A1 - REGOLITH_A0), 0), 1)) * (REGOLITH_LUT_NALB - 1);
}

/** Grain albedo w whose regolith sphere has spherical albedo A (monotonic; clamped to [W_MIN, W_MAX]). */
function invertAlbedo(A: number, ws: number[], as: number[]): number {
  if (A <= as[0]) return ws[0];
  for (let k = 1; k < ws.length; k++) {
    if (A <= as[k]) return ws[k - 1] + ((ws[k] - ws[k - 1]) * (A - as[k - 1])) / (as[k] - as[k - 1]);
  }
  return ws[ws.length - 1];
}

/** The factor LUT (built once, ~50-100 ms). */
export function regolithTable(): RegolithTable {
  if (cached) return cached;
  const t0 = performance.now();
  const NA = REGOLITH_LUT_NA, NR = REGOLITH_LUT_NALB;
  // spherical albedo on a grid in w, denser toward w -> 1 (A_s changes fastest there)
  const ws: number[] = [], as: number[] = [];
  const NW = 24;
  for (let k = 0; k < NW; k++) {
    const t = k / (NW - 1);
    const w = REGOLITH_W_MIN + (REGOLITH_W_MAX - REGOLITH_W_MIN) * (1 - (1 - t) * (1 - t));
    ws.push(w);
    as.push(regolithSphericalAlbedo(w, 32));
  }
  const albedo = new Float32Array(NR), wRow = new Float32Array(NR), AsRow = new Float32Array(NR);
  const factor = new Float32Array(NR * NA);
  const data = new Float32Array(NR * NA * 4);
  const aHold = (ALPHA_HOLD_DEG * PI) / 180;
  for (let j = 0; j < NR; j++) {
    const A = rowAlbedo(j);
    const w = invertAlbedo(A, ws, as);
    albedo[j] = A;
    wRow[j] = w;
    AsRow[j] = Math.min(A, as[NW - 1]);   // (A_s(w) = A unless w is clamped at W_MAX)
    let hold = 0;
    for (let i = 0; i < NA; i++) {
      const a = (i / (NA - 1)) * PI;
      let F: number;
      if (a <= aHold) {
        F = powerLawPhase(a) / Math.max(4 * sphereDiskPhi(a, w), 1e-30);
        hold = F;
      } else F = hold;
      factor[j * NA + i] = F;
      const q = (j * NA + i) * 4;
      data[q] = F;
      data[q + 1] = w;
      data[q + 2] = AsRow[j];
    }
  }
  const lut = new DataTexture(data, NA, NR, RGBAFormat, FloatType);
  lut.minFilter = LinearFilter;
  lut.magFilter = LinearFilter;
  lut.wrapS = ClampToEdgeWrapping;
  lut.wrapT = ClampToEdgeWrapping;
  lut.generateMipmaps = false;
  lut.needsUpdate = true;
  cached = { lut, albedo, w: wRow, As: AsRow, factor, ms: performance.now() - t0 };
  return cached;
}

/**
 * CPU mirror of nearRegolithFactor (nearCommon.glsl): bilinear LUT lookup -> (f incl. the surge, w) for a phase
 * angle alpha (rad) and particle albedo A. Used by the tests.
 */
export function regolithFactorLookup(alpha: number, A: number): { f: number; w: number } {
  const tb = regolithTable();
  const NA = REGOLITH_LUT_NA, NR = REGOLITH_LUT_NALB;
  const x = Math.min(Math.max(alpha / PI, 0), 1) * (NA - 1);
  const y = albedoRow(A);
  const i0 = Math.min(NA - 2, Math.floor(x)), j0 = Math.min(NR - 2, Math.floor(y));
  const fx = x - i0, fy = y - j0;
  const at = (i: number, j: number) => tb.factor[j * NA + i];
  const F = (1 - fy) * ((1 - fx) * at(i0, j0) + fx * at(i0 + 1, j0)) + fy * ((1 - fx) * at(i0, j0 + 1) + fx * at(i0 + 1, j0 + 1));
  const w = (1 - fy) * tb.w[j0] + fy * tb.w[j0 + 1];
  return { f: F * particleSurge(alpha), w };
}
