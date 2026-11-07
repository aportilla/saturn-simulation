// Simulation time. Internal time variable `t` = seconds since J2000.0 (TDB ~ TT) as a JS double.
import { DAY, J2000_JD, JULIAN_CENTURY_DAYS, UNIX_J2000_OFFSET } from './constants';

/** Unix milliseconds (UTC) -> seconds since J2000 TDB (TDB-TT periodic term < 2 ms ignored). */
export function tdbFromUnixMs(ms: number): number {
  return ms / 1000 - UNIX_J2000_OFFSET;
}
/** Seconds since J2000 TDB -> Unix milliseconds (UTC). */
export function unixMsFromTdb(t: number): number {
  return (t + UNIX_J2000_OFFSET) * 1000;
}
export function jdFromTdb(t: number): number {
  return J2000_JD + t / DAY;
}
export function tdbFromJd(jd: number): number {
  return (jd - J2000_JD) * DAY;
}
/** Julian centuries since J2000 TDB. */
export function centuriesFromTdb(t: number): number {
  return t / DAY / JULIAN_CENTURY_DAYS;
}
/** Parse an ISO date string (assumed UTC if no zone) -> t. */
export function tdbFromIso(iso: string): number {
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z';
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`bad date: ${iso}`);
  return tdbFromUnixMs(ms);
}
export function isoFromTdb(t: number): string {
  return new Date(unixMsFromTdb(t)).toISOString();
}

/**
 * Simulation clock. Real-time (warp = 1) by default, starting at the current wall-clock time.
 * Warp may be negative (time runs backwards) or zero.
 */
export class SimClock {
  t: number;
  warp = 1;
  paused = false;
  /** Upper bound on simulated seconds advanced per frame (protects against tab-switch spikes). */
  maxRealDt = 0.25;

  constructor(t0: number = tdbFromUnixMs(Date.now())) {
    this.t = t0;
  }
  /** Advance by a wall-clock interval; returns simulated seconds advanced. */
  tick(dtReal: number): number {
    const dr = Math.min(Math.max(dtReal, 0), this.maxRealDt);
    const dt = this.paused ? 0 : dr * this.warp;
    this.t += dt;
    return dt;
  }
  setNow(): void {
    this.t = tdbFromUnixMs(Date.now());
  }
  get date(): Date {
    return new Date(unixMsFromTdb(this.t));
  }
}
