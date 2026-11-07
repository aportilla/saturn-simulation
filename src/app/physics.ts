// Physical quantities derived for the HUD from the live ring model (RingProfile.local, RingLod) and the
// system geometry. SI units.
import { Vector3 } from 'three';
import { G, SATURN } from '../core/constants';
import type { RingLocal } from '../rings/RingProfile';

// ------------------------------------------------------------------ size distribution
/** dN/da = C a^-q per m^2 of ring for aMin <= a <= aMax, normalized so that pi Int a^2 dN = tau. */
export interface SizeDist {
  q: number;
  aMin: number;
  aMax: number;
  C: number;
}

export function sizeDistribution(l: RingLocal): SizeDist | null {
  if (!(l.tau > 0) || !(l.aMax > l.aMin) || !(l.aMin > 0)) return null;
  const q = l.q;
  const I2 = Math.abs(3 - q) < 1e-9 ? Math.log(l.aMax / l.aMin) : (Math.pow(l.aMax, 3 - q) - Math.pow(l.aMin, 3 - q)) / (3 - q);
  if (!(I2 > 0)) return null;
  return { q, aMin: l.aMin, aMax: l.aMax, C: l.tau / (Math.PI * I2) };
}

/** Column number density (particles per m^2 of ring area) with radius greater than a (m). */
export function columnAbove(sd: SizeDist, a: number): number {
  const lo = Math.max(a, sd.aMin);
  if (lo >= sd.aMax) return 0;
  const q = sd.q;
  const I0 = Math.abs(q - 1) < 1e-9 ? Math.log(sd.aMax / lo) : (Math.pow(lo, 1 - q) - Math.pow(sd.aMax, 1 - q)) / (q - 1);
  return sd.C * I0;
}

/** Fraction of the optical depth (cross-section) carried by particles of radius > a. */
export function tauFractionAbove(sd: SizeDist, a: number): number {
  const lo = Math.max(a, sd.aMin);
  if (lo >= sd.aMax) return 0;
  const q = sd.q;
  const I = (x0: number, x1: number) => (Math.abs(3 - q) < 1e-9 ? Math.log(x1 / x0) : (Math.pow(x1, 3 - q) - Math.pow(x0, 3 - q)) / (3 - q));
  return I(lo, sd.aMax) / I(sd.aMin, sd.aMax);
}

/** Radius that splits the optical depth (geometric cross-section) in half: larger particles carry 50%. */
export function medianCrossSectionRadius(sd: SizeDist): number {
  let lo = sd.aMin, hi = sd.aMax;
  for (let i = 0; i < 60; i++) {
    const m = Math.sqrt(lo * hi);
    if (tauFractionAbove(sd, m) > 0.5) lo = m;
    else hi = m;
  }
  return Math.sqrt(lo * hi);
}

// ------------------------------------------------------------------ vertical structure (mirror of sv_ringLod)
export function erfApprox(x: number): number {
  const x2 = x * x;
  const t = 1 - Math.exp((-x2 * (1.27323954 + 0.147 * x2)) / (1 + 0.147 * x2));
  return Math.sign(x) * Math.sqrt(Math.max(t, 0));
}
function gaussQ(z: number, sig: number): number {
  return 0.5 * (1 - erfApprox(z / (Math.SQRT2 * sig)));
}

export interface LodLike {
  tauFrac: ArrayLike<number>;
  sigZFrac: ArrayLike<number>;
}

/** Normal optical depth of the part of the layer beyond height z toward +z (dirSign > 0) or -z (mirror of
 *  ringLayerTauBeyond in ringLod.glsl). */
export function layerTauBeyond(lod: LodLike | null, z: number, tau: number, H: number, dirSign: number): number {
  let f = 0, wsum = 0;
  if (lod) {
    for (let k = 0; k < lod.tauFrac.length; k++) {
      const w = lod.tauFrac[k];
      if (!(w > 0)) continue;
      f += w * gaussQ(dirSign * z, Math.max(lod.sigZFrac[k] * H, 0.02));
      wsum += w;
    }
  }
  if (wsum <= 0) f = gaussQ(dirSign * z, Math.max(0.3 * H, 0.02));
  return tau * f;
}

/** Vertical rms thickness (std-dev, m) of particles of radius a, from the live LOD classes when available. */
export function sigmaZForRadius(lod: (LodLike & { aLo?: ArrayLike<number>; aHi?: ArrayLike<number> }) | null, a: number, H: number): number {
  if (lod && lod.aLo && lod.aHi) {
    for (let k = 0; k < lod.sigZFrac.length; k++) {
      if (a >= lod.aLo[k] && a < lod.aHi[k] && lod.sigZFrac[k] > 0) return lod.sigZFrac[k] * H;
    }
  }
  return 0.3 * H;
}

// ------------------------------------------------------------------ dynamics
/** Toomre critical wavelength lambda = 4 pi^2 G Sigma / kappa^2 (m). */
export function toomreLambda(sigma: number, kappa: number): number {
  return (4 * Math.PI * Math.PI * G * sigma) / (kappa * kappa);
}

// ------------------------------------------------------------------ Saturn's shadow
const K_OBL = SATURN.R_EQ / SATURN.R_POL;
const _s = new Vector3();

/** Fraction of the solar disk visible from SEF point p considering Saturn only (mirror of saturnSunVisibility). */
export function saturnSunVisibility(p: Vector3, sunDir: Vector3, sunAngRadius: number): number {
  const ox = p.x / SATURN.R_EQ, oy = p.y / SATURN.R_EQ, oz = (p.z / SATURN.R_EQ) * K_OBL;
  _s.set(sunDir.x, sunDir.y, sunDir.z * K_OBL).normalize();
  const dist = Math.hypot(ox, oy, oz);
  if (dist <= 1) return 0;
  const angS = Math.asin(Math.min(1, 1 / dist));
  const c = Math.max(-1, Math.min(1, -(ox * _s.x + oy * _s.y + oz * _s.z) / dist));
  const sep = Math.acos(c);
  const e0 = angS - sunAngRadius, e1 = angS + sunAngRadius;
  const t = Math.min(1, Math.max(0, (sep - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export interface ShadowTiming {
  inShadow: boolean;
  /** next event in the direction time is flowing */
  nextEvent: 'entry' | 'exit' | null;
  /** sim seconds until the next event */
  nextIn: number;
  /** sim seconds spent in the shadow per pass */
  duration: number;
  /** angular half-width of the shadow arc seen from Saturn's axis (rad) */
  halfWidth: number;
}

/**
 * Analytic shadow passage for a point co-rotating about Saturn's polar axis at angular rate omega (rad/s,
 * prograde > 0) at constant cylindrical radius and height (umbra as the oblate cylinder behind Saturn).
 * timeDir = sign of the time warp. Returns null if the geometry is degenerate.
 */
export function shadowTiming(p: Vector3, omega: number, sunDir: Vector3, timeDir: number): ShadowTiming | null {
  _s.set(sunDir.x, sunDir.y, sunDir.z * K_OBL).normalize();
  const h = Math.hypot(_s.x, _s.y);
  const r = Math.hypot(p.x, p.y);
  const kz = K_OBL * p.z;
  const D2 = r * r + kz * kz - SATURN.R_EQ * SATURN.R_EQ;
  if (D2 <= 0 || r * h < 1e-3) return null;
  const cStar = (-Math.sqrt(D2) - kz * _s.z) / (r * h);
  const psi = wrap2Pi(Math.atan2(p.y, p.x) - Math.atan2(_s.y, _s.x));
  if (cStar <= -1) return { inShadow: false, nextEvent: null, nextIn: Infinity, duration: 0, halfWidth: 0 };
  if (cStar >= 1) return { inShadow: true, nextEvent: null, nextIn: Infinity, duration: Infinity, halfWidth: Math.PI };
  const psi1 = Math.acos(cStar);
  const psi2 = 2 * Math.PI - psi1;
  const inShadow = psi > psi1 && psi < psi2;
  const w = Math.abs(omega);
  const duration = w > 0 ? (psi2 - psi1) / w : Infinity;
  const half = Math.PI - psi1;
  if (!(w > 0)) return { inShadow, nextEvent: null, nextIn: Infinity, duration, halfWidth: half };
  const forward = omega * (timeDir >= 0 ? 1 : -1) > 0;
  let d: number;
  let ev: 'entry' | 'exit';
  if (forward) {
    if (inShadow) { d = psi2 - psi; ev = 'exit'; } else { d = wrap2Pi(psi1 - psi); ev = 'entry'; }
  } else {
    if (inShadow) { d = psi - psi1; ev = 'exit'; } else { d = wrap2Pi(psi - psi2); ev = 'entry'; }
  }
  return { inShadow, nextEvent: ev, nextIn: d / w, duration, halfWidth: half };
}

function wrap2Pi(a: number): number {
  return a - 2 * Math.PI * Math.floor(a / (2 * Math.PI));
}

/** Local solar time on Saturn's rings/sky at azimuth phi (hours, 12 = noon i.e. the sunward side). */
export function localSolarTime(phi: number, sunDir: Vector3): number {
  const d = wrap2Pi(phi - Math.atan2(sunDir.y, sunDir.x));
  return (12 + (d / (2 * Math.PI)) * 24) % 24;
}

/** Azimuth (rad) at which a point at (r, z) sits `fromEntry` radians after entering Saturn's shadow (or noon+180 if never). */
export function shadowEntryAzimuth(r: number, z: number, sunDir: Vector3): { entry: number; halfWidth: number } {
  _s.set(sunDir.x, sunDir.y, sunDir.z * K_OBL).normalize();
  const h = Math.hypot(_s.x, _s.y);
  const kz = K_OBL * z;
  const D2 = r * r + kz * kz - SATURN.R_EQ * SATURN.R_EQ;
  const phiS = Math.atan2(_s.y, _s.x);
  if (D2 <= 0 || r * h <= 0) return { entry: phiS + Math.PI, halfWidth: 0 };
  const cStar = Math.max(-1, Math.min(1, (-Math.sqrt(D2) - kz * _s.z) / (r * h)));
  const psi1 = Math.acos(cStar);
  return { entry: phiS + psi1, halfWidth: Math.PI - psi1 };
}
