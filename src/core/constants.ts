// Physical constants and Saturn parameters. SI units (m, s, kg, rad) unless noted.
// Sources are noted inline; see docs/physics-notes.md for discussion.

export const DEG = Math.PI / 180;
export const ARCSEC = DEG / 3600;
export const TWO_PI = Math.PI * 2;

export const G = 6.6743e-11; // m^3 kg^-1 s^-2 (CODATA 2018)
export const AU = 1.495978707e11; // m (IAU 2012)
export const C_LIGHT = 299_792_458; // m/s
export const DAY = 86_400; // s
export const JULIAN_YEAR = 365.25 * DAY;
export const JULIAN_CENTURY_DAYS = 36_525;
export const J2000_JD = 2_451_545.0; // JD of 2000-01-01 12:00:00 TT

// TT - UTC = 32.184 s + 37 leap seconds (valid from 2017-01-01; no leap seconds since).
export const TT_MINUS_UTC = 69.184;
// Seconds such that  t_TT(since J2000) = unixSecondsUTC - UNIX_J2000_OFFSET  (valid after 2017-01-01).
// J2000 = 2000-01-01T11:58:55.816 UTC = Unix 946727935.816; 5 leap seconds were inserted 2000..2017.
export const UNIX_J2000_OFFSET = 946_727_930.816;

// ---------------------------------------------------------------- Sun
export const SUN_RADIUS = 6.957e8; // m (IAU nominal)
export const SOLAR_IRRADIANCE_1AU = 1361.0; // W/m^2 (TSI, Kopp & Lean 2011)
/** Mean radiance of the solar disk, W m^-2 sr^-1 (independent of distance). */
export const SUN_RADIANCE = SOLAR_IRRADIANCE_1AU / (Math.PI * (SUN_RADIUS / AU) ** 2);
export const SUN_APPARENT_MAG_1AU = -26.74; // V

// ---------------------------------------------------------------- Saturn
export const SATURN = {
  /** GM of Saturn alone (no moons), m^3/s^2. Jacobson (2022) SAT441-era value 37,931,206.2 km^3/s^2. */
  GM: 3.79312062e16,
  MASS: 5.6834e26, // kg
  /** 1-bar equatorial radius (m) */
  R_EQ: 60_268e3,
  /** 1-bar polar radius (m) */
  R_POL: 54_364e3,
  /** Reference radius for the zonal gravity harmonics (m) */
  R_GRAV_REF: 60_330e3,
  /** Unnormalized zonal harmonics, Iess et al. (2019, Science 364) */
  J2: 16_290.573e-6,
  J4: -935.314e-6,
  J6: 86.34e-6,
  /** IAU WGCCRE 2015 pole (ICRF, J2000): alpha0 = 40.589 - 0.036 T, delta0 = 83.537 - 0.004 T (T in Julian centuries) */
  POLE_RA0: 40.589 * DEG,
  POLE_RA_RATE: -0.036 * DEG, // per Julian century
  POLE_DEC0: 83.537 * DEG,
  POLE_DEC_RATE: -0.004 * DEG,
  /** IAU System III prime meridian: W = 38.90 + 810.7939024 d (deg, d = days since J2000 TDB) */
  W0: 38.9 * DEG,
  W_RATE: 810.7939024 * DEG, // per day
  /** System III (radio) period: 10h 39m 22.4s */
  ROT_PERIOD_SYSIII: 38_362.4,
  /** Interior (ring-seismology) period: 10h 33m 38s (Mankovich et al. 2019) */
  ROT_PERIOD_INTERIOR: 38_018,
  GEOMETRIC_ALBEDO: 0.499,
  BOND_ALBEDO: 0.342,
  /** Mean obliquity of Saturn's equator to its orbit */
  OBLIQUITY: 26.73 * DEG,
} as const;

// ---------------------------------------------------------------- Rendering conventions
/** Far value (m) for the logarithmic depth encoding shared by all passes: depth = log2(1+w)/log2(1+FAR). */
export const LOG_DEPTH_FAR = 1e13;
/** Distance (m) written to the scene distance channel for empty sky. */
export const SKY_DISTANCE = 1e30;
/** Max number of moons passed to shaders. */
export const MAX_MOONS = 32;

// ---------------------------------------------------------------- Orbital frequencies around oblate Saturn
/**
 * Mean motion (Omega), epicyclic (kappa) and vertical (nu) frequencies of a circular, equatorial orbit
 * at radius r (m), including J2, J4 and J6 to the usual expansion order (e.g. Nicholson & Porco 1988,
 * Murray & Dermott 1999). Returns rad/s.
 */
export function orbitalFrequencies(r: number): { omega: number; kappa: number; nu: number } {
  const n2 = SATURN.GM / (r * r * r);
  const x = SATURN.R_GRAV_REF / r;
  const x2 = x * x;
  const x4 = x2 * x2;
  const x6 = x4 * x2;
  const { J2, J4, J6 } = SATURN;
  const omega2 = n2 * (1 + 1.5 * J2 * x2 - (15 / 8) * J4 * x4 + (35 / 16) * J6 * x6);
  const kappa2 = n2 * (1 - 1.5 * J2 * x2 + (45 / 8) * J4 * x4 - (175 / 16) * J6 * x6);
  const nu2 = n2 * (1 + 4.5 * J2 * x2 - (75 / 8) * J4 * x4 + (245 / 16) * J6 * x6);
  return { omega: Math.sqrt(omega2), kappa: Math.sqrt(kappa2), nu: Math.sqrt(nu2) };
}

/** Local Keplerian shear rate d(v_phi)/dr in the rotating frame: v_y = -q_shear * Omega * x (q_shear ~ 1.5). */
export function shearParameter(r: number): number {
  // q = -dlnOmega/dlnr, evaluated numerically (includes oblateness terms)
  const h = r * 1e-4;
  const o1 = orbitalFrequencies(r - h).omega;
  const o2 = orbitalFrequencies(r + h).omega;
  const dlnO = (Math.log(o2) - Math.log(o1)) / (Math.log(r + h) - Math.log(r - h));
  return -dlnO;
}
