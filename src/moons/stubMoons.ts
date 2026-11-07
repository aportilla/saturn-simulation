// Placeholder moon provider: circular orbits in Saturn's equatorial plane (Iapetus inclined), synchronous
// rotation, arbitrary phases. Used until/unless the real ephemeris (MoonSystem) is available.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { DEG, orbitalFrequencies } from '../core/constants';
import type { MoonKind, MoonState } from '../core/FrameState';
import type { MoonProvider } from './types';

interface StubDef {
  id: number;
  name: string;
  kind: MoonKind;
  aKm: number;
  radiiKm: [number, number, number];
  incDeg: number;
  phaseDeg: number;
  albedo: number;
  color: [number, number, number];
}

const DEFS: StubDef[] = [
  { id: 618, name: 'Pan', kind: 'ring', aKm: 133_584, radiiKm: [17.3, 14.1, 10.5], incDeg: 0, phaseDeg: 10, albedo: 0.5, color: [1, 0.95, 0.88] },
  { id: 635, name: 'Daphnis', kind: 'ring', aKm: 136_505, radiiKm: [4.9, 4.2, 2.8], incDeg: 0, phaseDeg: 40, albedo: 0.5, color: [1, 0.95, 0.88] },
  { id: 615, name: 'Atlas', kind: 'ring', aKm: 137_670, radiiKm: [20.4, 17.7, 9.4], incDeg: 0, phaseDeg: 80, albedo: 0.4, color: [1, 0.95, 0.88] },
  { id: 616, name: 'Prometheus', kind: 'ring', aKm: 139_380, radiiKm: [68.2, 41.6, 28.2], incDeg: 0, phaseDeg: 120, albedo: 0.48, color: [1, 0.95, 0.88] },
  { id: 617, name: 'Pandora', kind: 'ring', aKm: 141_720, radiiKm: [51.5, 39.5, 31.5], incDeg: 0, phaseDeg: 160, albedo: 0.49, color: [1, 0.95, 0.88] },
  { id: 611, name: 'Epimetheus', kind: 'coorbital', aKm: 151_422, radiiKm: [64.9, 57.3, 53.0], incDeg: 0, phaseDeg: 200, albedo: 0.73, color: [1, 0.97, 0.92] },
  { id: 610, name: 'Janus', kind: 'coorbital', aKm: 151_472, radiiKm: [101.7, 93.0, 76.3], incDeg: 0, phaseDeg: 30, albedo: 0.71, color: [1, 0.97, 0.92] },
  { id: 601, name: 'Mimas', kind: 'major', aKm: 185_539, radiiKm: [207.8, 196.7, 190.6], incDeg: 1.57, phaseDeg: 0, albedo: 0.96, color: [1, 1, 1] },
  { id: 602, name: 'Enceladus', kind: 'major', aKm: 237_948, radiiKm: [256.6, 251.4, 248.3], incDeg: 0.01, phaseDeg: 60, albedo: 1.375, color: [1, 1, 1] },
  { id: 603, name: 'Tethys', kind: 'major', aKm: 294_619, radiiKm: [538.4, 528.3, 526.3], incDeg: 1.09, phaseDeg: 140, albedo: 1.229, color: [1, 1, 1] },
  { id: 604, name: 'Dione', kind: 'major', aKm: 377_396, radiiKm: [563.4, 561.3, 559.6], incDeg: 0.03, phaseDeg: 210, albedo: 0.998, color: [1, 0.99, 0.97] },
  { id: 605, name: 'Rhea', kind: 'major', aKm: 527_108, radiiKm: [765.0, 763.1, 762.4], incDeg: 0.35, phaseDeg: 300, albedo: 0.949, color: [1, 0.98, 0.95] },
  { id: 606, name: 'Titan', kind: 'major', aKm: 1_221_870, radiiKm: [2575.15, 2574.78, 2574.47], incDeg: 0.35, phaseDeg: 90, albedo: 0.22, color: [1, 0.72, 0.38] },
  { id: 608, name: 'Iapetus', kind: 'major', aKm: 3_560_820, radiiKm: [745.7, 745.7, 712.1], incDeg: 15.5, phaseDeg: 250, albedo: 0.6, color: [1, 0.95, 0.85] },
];

export class StubMoons implements MoonProvider {
  readonly count = DEFS.length;
  private n = DEFS.map((d) => orbitalFrequencies(d.aKm * 1000).omega);
  private _m = new Matrix4();
  private _x = new Vector3();
  private _y = new Vector3();
  private _z = new Vector3();

  getStates(t: number, out: MoonState[]): void {
    for (let i = 0; i < DEFS.length; i++) {
      const d = DEFS[i];
      let s = out[i];
      if (!s) {
        s = out[i] = {
          id: d.id, name: d.name, kind: d.kind,
          pos: new Vector3(), vel: new Vector3(),
          radii: new Vector3(d.radiiKm[0] * 1e3, d.radiiKm[1] * 1e3, d.radiiKm[2] * 1e3),
          meanRadius: Math.cbrt(d.radiiKm[0] * d.radiiKm[1] * d.radiiKm[2]) * 1e3,
          orient: new Quaternion(), albedo: d.albedo, color: d.color,
          textureKey: d.name.toLowerCase(),
        };
      }
      const a = d.aKm * 1e3;
      const n = this.n[i];
      let u = d.phaseDeg * DEG + n * t;
      u -= Math.floor(u / (2 * Math.PI)) * 2 * Math.PI;
      const inc = d.incDeg * DEG;
      const cu = Math.cos(u), su = Math.sin(u), ci = Math.cos(inc), si = Math.sin(inc);
      // node on +X; orbit plane tilted about X
      s.pos.set(a * cu, a * su * ci, a * su * si);
      s.vel.set(-a * n * su, a * n * cu * ci, a * n * cu * si);
      // synchronous: body +x toward Saturn, +z orbit normal, +y = z cross x
      this._x.copy(s.pos).normalize().multiplyScalar(-1);
      this._z.crossVectors(s.pos, s.vel).normalize();
      this._y.crossVectors(this._z, this._x);
      this._m.makeBasis(this._x, this._y, this._z);
      s.orient.setFromRotationMatrix(this._m);
    }
    out.length = DEFS.length;
  }
}
