// Ringshine: illumination of Saturn's cloud deck (and of the moons) by sunlight scattered from the main rings.
//
// Each ring element (radial bins of the shared profile x azimuth) has the classical single-scattering
// radiance (same model as the ring-layer thin-sheet approximation):
//   lit face:   I/F = w P(a)/4 * mu0/(mu+mu0) * (1 - exp(-tau (1/mu + 1/mu0)))
//   unlit face: I/F = w P(a)/4 * mu0/(mu-mu0) * (exp(-tau/mu) - exp(-tau/mu0))       (diffuse transmission)
// with P = ringPhase(cos a, dust), and is darkened by Saturn's (penumbral) shadow. The irradiance on a
// surface element is  E = sum L cos(theta) dOmega  over the elements above its horizon (exact visibility
// for a convex planet). Saturn: a 128 x 64 table over (longitude relative to the sub-solar meridian,
// planetographic latitude), recomputed on the GPU when the Sun direction changes. Moons: an irradiance
// vector per moon on the CPU (round robin).
import {
  ClampToEdgeWrapping, HalfFloatType, LinearFilter, RepeatWrapping, RGBAFormat, Vector3, Vector4, WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { RingProfile } from '../../rings/RingProfile';
import { SATURN } from '../../core/constants';
import { FullscreenPass } from '../fullscreen';

export const RS_BINS = 40;
const R0_KM = 66_900, R1_KM = 137_000;
const MU_REF = 0.3;
const TABLE_W = 128, TABLE_H = 64;
const NAZ = 64;

export interface RingBins { r: Float32Array; dr: Float32Array; tau: Float32Array; dust: Float32Array; alb: Float32Array }

export function ringBins(profile: RingProfile): RingBins {
  const n = RS_BINS;
  const out: RingBins = { r: new Float32Array(n), dr: new Float32Array(n), tau: new Float32Array(n), dust: new Float32Array(n), alb: new Float32Array(n * 3) };
  const dKm = (R1_KM - R0_KM) / n;
  for (let j = 0; j < n; j++) {
    const a = R0_KM + j * dKm, b = a + dKm;
    const i0 = Math.max(0, Math.floor((a - profile.rMinKm) / profile.drKm));
    const i1 = Math.min(profile.n - 1, Math.floor((b - profile.rMinKm) / profile.drKm));
    let sT = 0, sw = 0, sd = 0, cnt = 0;
    const al = [0, 0, 0];
    for (let i = i0; i <= i1; i++) {
      const tau = profile.tau[i];
      const T = Math.exp(-tau / MU_REF);
      const w = 1 - T + 1e-9;
      sT += T; cnt++;
      sw += w;
      sd += profile.dust[i] * w;
      for (let k = 0; k < 3; k++) al[k] += profile.albedo[i * 3 + k] * w;
    }
    const meanT = cnt > 0 ? sT / cnt : 1;
    out.r[j] = (a + 0.5 * dKm) * 1e3;
    out.dr[j] = dKm * 1e3;
    out.tau[j] = -MU_REF * Math.log(Math.max(meanT, 1e-12));
    out.dust[j] = sw > 0 ? sd / sw : 1;
    for (let k = 0; k < 3; k++) out.alb[j * 3 + k] = sw > 0 ? al[k] / sw : 0.5;
  }
  return out;
}

const TABLE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
#include <sv_common>
#include <sv_saturn>
#include <sv_ringProfile>
#include <sv_lighting>
#define NB ${RS_BINS}
#define NAZ ${NAZ}
uniform vec4 uBinA[NB];   // r (m), dr (m), tauEff, dust
uniform vec4 uBinB[NB];   // albedo rgb
in vec2 vUv;
layout(location = 0) out vec4 o;

vec3 ringIF(float tau, vec3 w0, float Pp, float mu, float mu0, bool lit) {
  if (lit) return w0 * Pp * 0.25 * mu0 / (mu + mu0) * (1.0 - exp(-tau * (1.0 / mu + 1.0 / mu0)));
  float d = mu - mu0;
  if (abs(d) < 1e-4) return w0 * Pp * 0.25 * tau / mu0 * exp(-tau / mu0);
  return w0 * Pp * 0.25 * mu0 / d * (exp(-tau / mu) - exp(-tau / mu0));
}

void main() {
  float dl = (vUv.x * 2.0 - 1.0) * PI;
  float latG = (vUv.y - 0.5) * PI;
  float az = atan(uSunDir.y, uSunDir.x) + dl;
  float a = uSaturnRadii.x, b = uSaturnRadii.y;
  float cg = cos(latG), sg = sin(latG);
  float den = sqrt(a * a * cg * cg + b * b * sg * sg);
  vec3 P = vec3(a * a * cg / den * cos(az), a * a * cg / den * sin(az), b * b * sg / den);
  vec3 n = vec3(cg * cos(az), cg * sin(az), sg);
  float sz = uSunDir.z;
  float mu0 = max(abs(sz), 1e-3);
  vec3 E = vec3(0.0);
  for (int j = 0; j < NB; j++) {
    vec4 A = uBinA[j];
    if (A.z < 1e-5) continue;
    vec3 w0 = uBinB[j].rgb;
    for (int k = 0; k < NAZ; k++) {
      float ph = (float(k) + 0.5) * (TWO_PI / float(NAZ));
      vec3 Q = vec3(A.x * cos(ph), A.x * sin(ph), 0.0);
      vec3 v = Q - P;
      float d2 = dot(v, v);
      vec3 u = v * inversesqrt(d2);
      float cp = dot(n, u);
      if (cp <= 0.0) continue;
      float mu = abs(u.z);
      if (mu < 1e-4) continue;
      float vis = saturnSunVisibility(Q + uSaturnCenter);
      if (vis <= 0.0) continue;
      bool lit = (P.z * sz) > 0.0;
      float Pp = ringPhase(dot(uSunDir, -u), A.w);
      vec3 IF = ringIF(A.z, w0, Pp, mu, mu0, lit);
      float dOm = A.x * A.y * (TWO_PI / float(NAZ)) * mu / d2;
      E += IF * (INV_PI * vis * cp * dOm);
    }
  }
  o = vec4(E, 1.0);  // irradiance in units of the solar irradiance
}`;

export class RingshineTable {
  readonly rt: WebGLRenderTarget;
  private fs: FullscreenPass;
  private lastSun = new Vector3(0, 0, 0);
  private bins: RingBins;
  valid = false;

  constructor(shared: Record<string, { value: any }>, profile: RingProfile) {
    this.rt = new WebGLRenderTarget(TABLE_W, TABLE_H, {
      type: HalfFloatType, format: RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      minFilter: LinearFilter, magFilter: LinearFilter, wrapS: RepeatWrapping, wrapT: ClampToEdgeWrapping,
    });
    this.bins = ringBins(profile);
    const A: Vector4[] = [], B: Vector4[] = [];
    for (let j = 0; j < RS_BINS; j++) {
      A.push(new Vector4(this.bins.r[j], this.bins.dr[j], this.bins.tau[j], this.bins.dust[j]));
      B.push(new Vector4(this.bins.alb[j * 3], this.bins.alb[j * 3 + 1], this.bins.alb[j * 3 + 2], 0));
    }
    this.fs = new FullscreenPass({ fragmentShader: TABLE_FRAG, uniforms: { ...shared, uBinA: { value: A }, uBinB: { value: B } } });
  }

  /** Recompute when the Sun has moved by more than ~0.01 deg (Saturn's shadow on the rings, ring illumination). */
  update(renderer: WebGLRenderer, sunDir: Vector3): boolean {
    if (this.valid && this.lastSun.distanceToSquared(sunDir) < 3e-8) return false;
    this.fs.render(renderer, this.rt);
    this.lastSun.copy(sunDir);
    this.valid = true;
    return true;
  }

  /**
   * Ringshine irradiance vector (W/m^2, SEF) at Saturn-centred point p (m): sum L dOmega u over visible
   * ring elements; E(n) ~ max(n . Evec, 0). Mirrors the GPU table physics (Saturn's shadow included).
   */
  irradianceVector(p: Vector3, sunDir: Vector3, Esun: number, sunAngRadius: number, out: Vector3): Vector3 {
    out.set(0, 0, 0);
    const b = this.bins;
    const sz = sunDir.z;
    const mu0 = Math.max(Math.abs(sz), 1e-3);
    const naz = 48;
    const lit = p.z * sz > 0;
    const k = SATURN.R_EQ / SATURN.R_POL;
    // sun direction in the oblate-scaled frame (for Saturn's shadow on the ring elements)
    let dx = sunDir.x, dy = sunDir.y, dz = sunDir.z * k;
    const dn = Math.hypot(dx, dy, dz);
    dx /= dn; dy /= dn; dz /= dn;
    for (let j = 0; j < RS_BINS; j++) {
      const tau = b.tau[j];
      if (tau < 1e-5) continue;
      const r = b.r[j];
      const w = (b.alb[j * 3] * 0.2126 + b.alb[j * 3 + 1] * 0.7152 + b.alb[j * 3 + 2] * 0.0722);
      const dust = b.dust[j];
      for (let a = 0; a < naz; a++) {
        const ph = ((a + 0.5) / naz) * 2 * Math.PI;
        const qx = r * Math.cos(ph), qy = r * Math.sin(ph);
        const vx = qx - p.x, vy = qy - p.y, vz = -p.z;
        const d2 = vx * vx + vy * vy + vz * vz;
        const d = Math.sqrt(d2);
        const ux = vx / d, uy = vy / d, uz = vz / d;
        const mu = Math.abs(uz);
        if (mu < 1e-4) continue;
        // Saturn's shadow on the ring element
        const ox = qx / SATURN.R_EQ, oy = qy / SATURN.R_EQ;
        const dist = Math.hypot(ox, oy);
        const angS = Math.asin(Math.min(1, 1 / dist));
        const sep = Math.acos(Math.max(-1, Math.min(1, -(ox * dx + oy * dy) / dist)));
        const tvis = (sep - (angS - sunAngRadius)) / (2 * sunAngRadius);
        const vis = tvis <= 0 ? 0 : tvis >= 1 ? 1 : tvis * tvis * (3 - 2 * tvis);
        if (vis <= 0) continue;
        const cosA = -(sunDir.x * ux + sunDir.y * uy + sunDir.z * uz);
        const P = ringPhaseJS(cosA, dust);
        let IF: number;
        if (lit) IF = w * P * 0.25 * mu0 / (mu + mu0) * (1 - Math.exp(-tau * (1 / mu + 1 / mu0)));
        else {
          const dd = mu - mu0;
          IF = Math.abs(dd) < 1e-4 ? w * P * 0.25 * tau / mu0 * Math.exp(-tau / mu0)
            : w * P * 0.25 * mu0 / dd * (Math.exp(-tau / mu) - Math.exp(-tau / mu0));
        }
        const dOm = (r * b.dr[j] * (2 * Math.PI / naz) * mu) / d2;
        const L = IF * Esun / Math.PI * vis * dOm;
        out.x += L * ux; out.y += L * uy; out.z += L * uz;
      }
    }
    return out;
  }

  dispose(): void {
    this.rt.dispose();
    this.fs.dispose();
  }
}

function phaseHGJS(c: number, g: number): number {
  const g2 = g * g;
  return (1 - g2) / Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-6), 1.5);
}
// Mirror of lighting.glsl ringPhase: power-law particle phase function (Dones et al. 1993) + dust.
function ringPhaseJS(cosAlpha: number, dust: number): number {
  const a = Math.acos(Math.max(-1, Math.min(1, cosAlpha)));
  const macro = 5.69698 * Math.pow(Math.max(0, 1 - a / Math.PI), 3.3) * (1 + 0.5 * Math.exp(-a / 0.05));
  const ct = -cosAlpha;
  const d = 0.75 * phaseHGJS(ct, 0.85) + 0.25 * phaseHGJS(ct, 0.3);
  return macro * (1 - dust) + d * dust;
}
