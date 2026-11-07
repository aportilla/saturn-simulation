// Frames and solar ephemeris.
//
// SEF = "Saturn Equatorial Frame": inertial, origin at Saturn's center, +Z along Saturn's north
// rotation pole (IAU 2015 pole at J2000, held fixed: precession is 0.036 deg/century), +X toward the
// ascending node of Saturn's equator on the ICRF (J2000 Earth) equator, +Y = Z x X.
// The main rings lie in the SEF XY plane and orbit counter-clockwise seen from +Z.
import { Matrix3, Vector3 } from 'three';
import { AU, DEG, SATURN, SOLAR_IRRADIANCE_1AU, SUN_RADIUS, TWO_PI, DAY } from './constants';
import { centuriesFromTdb, jdFromTdb } from './time';
import { dataUrl } from './assets';

const OBLIQUITY_J2000 = 84381.406 / 3600 * DEG; // IAU 2006 mean obliquity of the ecliptic

/** SEF basis vectors expressed in ICRF (fixed J2000 pole). */
export const SEF_AXES_ICRF = (() => {
  const ra = SATURN.POLE_RA0;
  const dec = SATURN.POLE_DEC0;
  const z = new Vector3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
  const x = new Vector3(-Math.sin(ra), Math.cos(ra), 0);
  const y = new Vector3().crossVectors(z, x);
  return { x, y, z };
})();

/** Rotation matrix taking ICRF vectors to SEF vectors (rows = SEF axes in ICRF). */
export const ICRF_TO_SEF = new Matrix3().set(
  SEF_AXES_ICRF.x.x, SEF_AXES_ICRF.x.y, SEF_AXES_ICRF.x.z,
  SEF_AXES_ICRF.y.x, SEF_AXES_ICRF.y.y, SEF_AXES_ICRF.y.z,
  SEF_AXES_ICRF.z.x, SEF_AXES_ICRF.z.y, SEF_AXES_ICRF.z.z,
);
export const SEF_TO_ICRF = ICRF_TO_SEF.clone().transpose();

/** J2000 ecliptic -> ICRF (rotation about X by the obliquity). */
export function eclipticToIcrf(v: Vector3, out = new Vector3()): Vector3 {
  const c = Math.cos(OBLIQUITY_J2000);
  const s = Math.sin(OBLIQUITY_J2000);
  return out.set(v.x, c * v.y - s * v.z, s * v.y + c * v.z);
}

/** RA/Dec (radians, ICRF) -> unit vector in SEF. */
export function raDecToSef(ra: number, dec: number, out = new Vector3()): Vector3 {
  out.set(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
  return out.applyMatrix3(ICRF_TO_SEF);
}

/** Saturn's System III prime-meridian angle W (rad, mod 2pi), measured in SEF from +X toward +Y. */
export function saturnRotationAngle(t: number): number {
  const d = t / DAY;
  // reduce in two steps to keep precision for large |d|
  const turns = (SATURN.W_RATE / TWO_PI) * d;
  const frac = turns - Math.floor(turns);
  let w = SATURN.W0 + frac * TWO_PI;
  w %= TWO_PI;
  return w < 0 ? w + TWO_PI : w;
}

// ---------------------------------------------------------------- Saturn heliocentric orbit
// E. M. Standish, "Keplerian Elements for Approximate Positions of the Major Planets" (JPL SSD).
// Table 1: 1800 AD - 2050 AD; Table 2: 3000 BC - 3000 AD (with extra terms for Saturn).
const STANDISH_T1 = {
  a: [9.53667594, -0.0012506], e: [0.05386179, -0.00050991], I: [2.48599187, 0.00193609],
  L: [49.95424423, 1222.49362201], w: [92.59887831, -0.41897216], O: [113.66242448, -0.28867794],
};
const STANDISH_T2 = {
  a: [9.54149883, -0.00003065], e: [0.05550825, -0.00032044], I: [2.49424102, 0.00451969],
  L: [50.07571329, 1222.11494724], w: [92.86136063, 0.54179478], O: [113.63998702, -0.25015002],
  b: 0.00025899, c: -0.13434469, s: 0.87320147, f: 38.35125,
};

function solveKepler(M: number, e: number): number {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 20; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-15) break;
  }
  return E;
}

/** Heliocentric position of Saturn, J2000 ecliptic frame, meters. */
export function saturnHeliocentricEcliptic(t: number, out = new Vector3()): Vector3 {
  const T = centuriesFromTdb(t);
  const useT1 = T >= -2 && T <= 0.5;
  const tb = useT1 ? STANDISH_T1 : STANDISH_T2;
  const a = (tb.a[0] + tb.a[1] * T) * AU;
  const e = tb.e[0] + tb.e[1] * T;
  const I = (tb.I[0] + tb.I[1] * T) * DEG;
  const L = tb.L[0] + tb.L[1] * T;
  const varpi = tb.w[0] + tb.w[1] * T;
  const Om = (tb.O[0] + tb.O[1] * T) * DEG;
  let Mdeg = L - varpi;
  if (!useT1) {
    const t2 = STANDISH_T2;
    Mdeg += t2.b * T * T + t2.c * Math.cos(t2.f * T * DEG) + t2.s * Math.sin(t2.f * T * DEG);
  }
  Mdeg = ((((Mdeg + 180) % 360) + 360) % 360) - 180;
  const w = varpi * DEG - Om;
  const E = solveKepler(Mdeg * DEG, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(I), sI = Math.sin(I);
  return out.set(
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp,
  );
}

// ---------------------------------------------------------------- Optional high-accuracy table
/**
 * Sun position relative to Saturn from a JPL Horizons table (ICRF, km), regularly sampled.
 * File format (public/data/ephemeris/sun_from_saturn.json):
 *   { "frame": "ICRF", "center": "699", "target": "10", "start_jd_tdb": number, "step_days": number,
 *     "pos_km": [x0,y0,z0, x1,y1,z1, ...] }
 */
export interface SunTable {
  startJd: number;
  stepDays: number;
  pos: Float64Array; // km, flat xyz
  count: number;
}
let sunTable: SunTable | null = null;

export async function loadSunTable(url = dataUrl('data/ephemeris/sun_from_saturn.json')): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return false;
    const j = await res.json();
    if (!Array.isArray(j.pos_km) || !(j.step_days > 0)) return false;
    const pos = new Float64Array(j.pos_km);
    sunTable = { startJd: j.start_jd_tdb, stepDays: j.step_days, pos, count: pos.length / 3 };
    return true;
  } catch {
    return false;
  }
}
export function hasSunTable(): boolean {
  return sunTable !== null;
}

function sunFromTable(t: number, out: Vector3): boolean {
  const tb = sunTable;
  if (!tb) return false;
  const f = (jdFromTdb(t) - tb.startJd) / tb.stepDays;
  const i1 = Math.floor(f);
  if (i1 < 1 || i1 + 2 >= tb.count) return false;
  // 4-point Lagrange interpolation
  const u = f - i1;
  const w0 = (-u * (u - 1) * (u - 2)) / 6;
  const w1 = ((u + 1) * (u - 1) * (u - 2)) / 2;
  const w2 = (-(u + 1) * u * (u - 2)) / 2;
  const w3 = ((u + 1) * u * (u - 1)) / 6;
  const p = tb.pos;
  const b = (i1 - 1) * 3;
  out.set(
    w0 * p[b] + w1 * p[b + 3] + w2 * p[b + 6] + w3 * p[b + 9],
    w0 * p[b + 1] + w1 * p[b + 4] + w2 * p[b + 7] + w3 * p[b + 10],
    w0 * p[b + 2] + w1 * p[b + 5] + w2 * p[b + 8] + w3 * p[b + 11],
  ).multiplyScalar(1000);
  return true;
}

/** Vector from Saturn's center to the Sun, ICRF, meters. */
export function sunFromSaturnIcrf(t: number, out = new Vector3()): Vector3 {
  if (sunFromTable(t, out)) return out;
  const h = saturnHeliocentricEcliptic(t, out);
  eclipticToIcrf(h, out);
  return out.multiplyScalar(-1);
}

/** Vector from Saturn's center to the Sun, SEF, meters. */
export function sunFromSaturnSef(t: number, out = new Vector3()): Vector3 {
  return sunFromSaturnIcrf(t, out).applyMatrix3(ICRF_TO_SEF);
}

export interface SunInfo {
  dir: Vector3; // unit, Saturn -> Sun (SEF)
  distance: number; // m
  irradiance: number; // W/m^2 at Saturn
  angularRadius: number; // rad
  /** Solar elevation above the ring plane (rad); negative = Sun south of the rings (south face lit). */
  ringElevation: number;
}
export function sunInfo(t: number, out?: SunInfo): SunInfo {
  const v = sunFromSaturnSef(t, out?.dir ?? new Vector3());
  const d = v.length();
  v.divideScalar(d);
  const o = out ?? ({ dir: v } as SunInfo);
  o.dir = v;
  o.distance = d;
  o.irradiance = SOLAR_IRRADIANCE_1AU * (AU / d) ** 2;
  o.angularRadius = Math.asin(SUN_RADIUS / d);
  o.ringElevation = Math.asin(v.z);
  return o;
}
