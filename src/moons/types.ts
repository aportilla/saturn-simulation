import type { MoonState } from '../core/FrameState';

/**
 * Supplies moon states for a simulation time. Implementations: StubMoons (circular placeholder orbits)
 * and MoonSystem (real ephemeris; see src/moons/MoonSystem.ts).
 *
 * Body-frame convention for MoonState.orient (body -> SEF):
 *   +x = 0 deg longitude (sub-Saturn point for synchronous rotators)
 *   +z = north pole (IAU north, i.e. the pole on the north side of the invariable plane)
 *   +y = 90 deg EAST longitude (= 270 W; the TRAILING hemisphere center for prograde synchronous moons)
 *   A surface point at planetocentric latitude lat, east longitude lonE has body direction
 *   (cos lat cos lonE, cos lat sin lonE, sin lat). West longitude lonW = 360 - lonE.
 */
export interface MoonProvider {
  readonly count: number;
  /** Fill `out` (resized/allocated by the provider as needed) with states at time t (s since J2000 TDB). */
  getStates(t: number, out: MoonState[]): void;
}
