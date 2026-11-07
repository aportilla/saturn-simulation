// Computes the physical state of the Saturn system for a simulation time: Sun, Saturn rotation, moons.
import { SUN_RADIANCE } from './constants';
import { sunInfo, type SunInfo } from './ephemeris';
import { saturnRotationAngle } from './ephemeris';
import { jdFromTdb } from './time';
import type { FrameState } from './FrameState';
import type { MoonProvider } from '../moons/types';
import { StubMoons } from '../moons/stubMoons';

export class World {
  moons: MoonProvider;
  private _sun: SunInfo | undefined;

  constructor(moons?: MoonProvider) {
    this.moons = moons ?? new StubMoons();
  }

  setMoonProvider(p: MoonProvider): void {
    this.moons = p;
  }

  /** Fill time-dependent physical state into the frame (sun, Saturn, moons). */
  update(f: FrameState): void {
    f.jdTdb = jdFromTdb(f.t);
    this._sun = sunInfo(f.t, this._sun);
    f.sunDir.copy(this._sun.dir);
    f.sunDistance = this._sun.distance;
    f.solarIrradiance = this._sun.irradiance;
    f.sunAngularRadius = this._sun.angularRadius;
    f.sunRadiance = SUN_RADIANCE;
    f.saturnRotation = saturnRotationAngle(f.t);
    this.moons.getStates(f.t, f.moons);
  }
}
