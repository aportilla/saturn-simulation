// CPU mirror of the shared ring phase function (src/render/shaders/lighting.glsl: ringPhase) and the
// hemispheric scattering fractions the two-stream multiple-scattering model needs.
//
//   beta0(mu0): fraction of the light singly scattered out of a collimated beam (incident at direction
//               cosine mu0 on a face of the layer) that goes back into the hemisphere of that face.
//   beta:       the same for a hemispherically isotropic diffuse field (= integral of beta0 over mu).
// Two components: macroscopic particles (Lambert-sphere law + intrinsic opposition surge) and fine dust
// (forward-scattering double Henyey-Greenstein). The shader mixes them by the local dust fraction.
import { DataTexture, FloatType, LinearFilter, RGBAFormat, ClampToEdgeWrapping } from 'three';

export const PHASE_LUT_N = 64;

function phaseLambertSphere(cosA: number): number {
  const a = Math.acos(Math.min(1, Math.max(-1, cosA)));
  return (8 / (3 * Math.PI)) * (Math.sin(a) + (Math.PI - a) * Math.cos(a));
}
function phaseHG(cosT: number, g: number): number {
  const g2 = g * g;
  return (1 - g2) / Math.pow(Math.max(1 + g2 - 2 * g * cosT, 1e-6), 1.5);
}
/**
 * Ring-particle phase-function model used by the ring layer:
 *   0 = the shared ringPhase (Lambert-sphere law + intrinsic surge) — mirror of lighting.glsl
 *   1 = power law P = C (1 - alpha/pi)^n (Dones, Cuzzi & Showalter 1993, Voyager A-ring photometry,
 *       n = 3.3; regolith-covered particles back-scatter much more strongly than Lambert spheres:
 *       P(0) = 5.8 vs 2.67) with the same intrinsic opposition surge. This is what reproduces the HST /
 *       Cassini low-phase I/F with the zone albedos (B ~0.5, A ~0.35, C/CD ~0.07).
 * Dust (both models): 0.75 HG(0.85) + 0.25 HG(0.3).
 */
export const PHASE_POWER_N = 3.3;
let powerC = 0;
export function powerLawNorm(n = PHASE_POWER_N): number {
  // (1/2) Int_0^pi C (1 - a/pi)^n sin a da = 1  ->  C = 2 / (pi Int_0^1 u^n sin(pi u) du)
  const N = 4000;
  let s = 0;
  for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N;
    s += Math.pow(u, n) * Math.sin(Math.PI * u);
  }
  s /= N;
  return 2 / (Math.PI * s);
}
export function ringPhaseCpu(cosA: number, dust: number, model = 1): number {
  const a = Math.acos(Math.min(1, Math.max(-1, cosA)));
  let base: number;
  if (model === 1) {
    if (powerC === 0) powerC = powerLawNorm();
    base = powerC * Math.pow(Math.max(0, 1 - a / Math.PI), PHASE_POWER_N);
  } else {
    base = phaseLambertSphere(cosA);
  }
  const macro = base * (1 + 0.5 * Math.exp(-a / 0.05));
  const cosT = -cosA;
  const d = 0.75 * phaseHG(cosT, 0.85) + 0.25 * phaseHG(cosT, 0.3);
  return macro * (1 - dust) + d * dust;
}

/**
 * beta0 for a beam with direction cosine mu0 (0..1) and dust fraction `dust` (0 or 1).
 * Incident propagation direction (sin th0, 0, -mu0); the face normal is +z. Scattered direction
 * (sin th cos ph, sin th sin ph, cos th); phase angle cos(alpha) = -cos(scattering angle).
 */
function beta0(mu0: number, dust: number, model: number, nu = 48, nph = 64): number {
  const s0 = Math.sqrt(Math.max(0, 1 - mu0 * mu0));
  let up = 0, down = 0;
  for (let i = 0; i < nu; i++) {
    // cos(theta) in (-1, 1), denser near the horizon (u = sign * (1 - (1-x)^2))
    const x = (i + 0.5) / nu;
    const uAbs = 1 - (1 - x) * (1 - x);
    const du = 2 * (1 - x) / nu;
    for (const sgn of [1, -1]) {
      const u = sgn * uAbs;
      const st = Math.sqrt(Math.max(0, 1 - u * u));
      let acc = 0;
      for (let j = 0; j < nph; j++) {
        const ph = ((j + 0.5) / nph) * Math.PI; // symmetric in phi: integrate 0..pi, double
        const cosTheta = s0 * st * Math.cos(ph) - mu0 * u;
        acc += ringPhaseCpu(-cosTheta, dust, model);
      }
      const v = acc * (Math.PI / nph) * 2 * du; // d(phi) d(u)
      if (sgn > 0) up += v; else down += v;
    }
  }
  return up / (up + down);
}

export interface PhaseTables {
  /** RGBA32F 64x1: (beta0 macro, beta0 dust, -, -) at mu = i/63 */
  lut: DataTexture;
  betaMacro: number;
  betaDust: number;
  beta0Macro: Float32Array;
  beta0Dust: Float32Array;
  /** power-law normalization C (model 1) */
  powerC: number;
  model: number;
}

const cached: Record<number, PhaseTables> = {};

export function phaseTables(model = 1): PhaseTables {
  if (cached[model]) return cached[model];
  const N = PHASE_LUT_N;
  const bm = new Float32Array(N);
  const bd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const mu = Math.max(1e-3, i / (N - 1));
    bm[i] = beta0(mu, 0, model);
    bd[i] = model === 1 && cached[0] ? cached[0].beta0Dust[i] : beta0(mu, 1, model);
  }
  // diffuse fraction: uniform average over mu (hemispherically isotropic radiance -> extinction per unit
  // vertical optical depth is uniform in solid angle)
  let sm = 0, sd = 0;
  for (let i = 0; i < N; i++) {
    const w = i === 0 || i === N - 1 ? 0.5 : 1;
    sm += w * bm[i];
    sd += w * bd[i];
  }
  sm /= N - 1;
  sd /= N - 1;
  const data = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    data[i * 4] = bm[i];
    data[i * 4 + 1] = bd[i];
  }
  const lut = new DataTexture(data, N, 1, RGBAFormat, FloatType);
  lut.minFilter = LinearFilter;
  lut.magFilter = LinearFilter;
  lut.wrapS = ClampToEdgeWrapping;
  lut.wrapT = ClampToEdgeWrapping;
  lut.generateMipmaps = false;
  lut.needsUpdate = true;
  cached[model] = { lut, betaMacro: sm, betaDust: sd, beta0Macro: bm, beta0Dust: bd, powerC: powerLawNorm(), model };
  return cached[model];
}
