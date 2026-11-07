// Real Saturnian moon system: positions/velocities from mean-element models fitted to JPL Horizons
// (see orbitModel.ts and docs/data-sources.md), IAU-2015 shapes, measured albedos, rotation states:
//   synchronous  body +x toward Saturn's MEAN direction (so the natural optical libration of +-2e appears),
//                +z = orbit pole, + forced physical libration where measured (Mimas, Enceladus, Epimetheus)
//   iau          IAU WGCCRE pole + prime-meridian model (Phoebe; irregulars with assumed pole)
//   chaotic      Hyperion: integrated Euler equations (hyperionRotation.ts)
// Phoebe and the irregulars are modelled relative to the Saturn-system barycentre; Saturn's reflex offset
// W = sum mu_i r_i / (1 + sum mu) (Titan-dominated, ~290 km) is added back every frame.
//
// Usage:  const moons = await loadMoonSystem();  moons.getStates(t, frame.moons);
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { MoonKind, MoonState } from '../core/FrameState';
import { dataUrl } from '../core/assets';
import { ICRF_TO_SEF } from '../core/ephemeris';
import type { MoonProvider } from './types';
import { OrbitModel, OrbitSample, tauFromT, type OrbitJson, type OrbitTables } from './orbitModel';
import { HyperionRotation, type ChaoticRotationJson } from './hyperionRotation';
import { StubMoons } from './stubMoons';

const DEG = Math.PI / 180;

export type MoonRotationJson =
  | { type: 'synchronous'; librationDeg: number }
  | { type: 'iau'; poleRaDeg: number; poleDecDeg: number; w0Deg: number; wDotDegPerDay: number; estimated?: boolean }
  | ChaoticRotationJson;

export interface MoonJson {
  id: number;
  name: string;
  kind: MoonKind;
  textureKey: string;
  radiiKm: [number, number, number];
  meanRadiusKm: number;
  gmKm3s2: number;
  gmEstimated: boolean;
  albedo: number;
  color: [number, number, number];
  rotation: MoonRotationJson;
  center: 'saturn' | 'barycenter';
  orbit: OrbitJson;
  ephemeris: { source: string; horizonsCoverageJd: [number, number]; globalFitJd: [number, number]; tableJd: [number, number] };
  accuracy2020to2035: unknown;
}

export interface MoonsFileJson {
  format: string;
  epochJdTdb: number;
  tables: { i16: { file: string; type: string; count: number }; f32: { file: string; type: string; count: number } };
  wobble: { moons: string[]; mu: number[] };
  moons: MoonJson[];
}

interface IauRot { nx: number; ny: number; nz: number; mx: number; my: number; mz: number; zx: number; zy: number; zz: number; w0: number; wd: number }

export class MoonSystem implements MoonProvider {
  readonly count: number;
  readonly data: MoonsFileJson;
  private readonly models: OrbitModel[];
  private readonly iau: (IauRot | null)[];
  private readonly lib: Float64Array;
  private readonly hyperion: HyperionRotation | null = null;
  private readonly hyperionIndex: number = -1;
  private readonly bary: Uint8Array;
  private readonly wobIdx: Int32Array;
  private readonly wobMu: Float64Array;
  private readonly wobNorm: number;
  // scratch
  private readonly s = new OrbitSample();
  private readonly _x = new Vector3();
  private readonly _y = new Vector3();
  private readonly _z = new Vector3();
  private readonly _m = new Matrix4();
  private readonly W = new Float64Array(6);

  constructor(data: MoonsFileJson, tables: OrbitTables, hyperionData: Float32Array | null) {
    this.data = data;
    this.count = data.moons.length;
    this.models = data.moons.map((m) => new OrbitModel(m.orbit, tables));
    this.lib = Float64Array.from(data.moons, (m) => (m.rotation.type === 'synchronous' ? m.rotation.librationDeg * DEG : 0));
    this.bary = Uint8Array.from(data.moons, (m) => (m.center === 'barycenter' ? 1 : 0));
    this.iau = data.moons.map((m) => {
      const r = m.rotation;
      if (r.type !== 'iau') return null;
      const a = r.poleRaDeg * DEG, d = r.poleDecDeg * DEG;
      // pole and node of the body equator on the ICRF equator, then -> SEF
      const z = new Vector3(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d));
      const n = new Vector3(-Math.sin(a), Math.cos(a), 0);
      const mm = new Vector3().crossVectors(z, n);
      z.applyMatrix3(ICRF_TO_SEF); n.applyMatrix3(ICRF_TO_SEF); mm.applyMatrix3(ICRF_TO_SEF);
      return { nx: n.x, ny: n.y, nz: n.z, mx: mm.x, my: mm.y, mz: mm.z, zx: z.x, zy: z.y, zz: z.z, w0: r.w0Deg, wd: r.wDotDegPerDay };
    });
    const hi = data.moons.findIndex((m) => m.rotation.type === 'chaotic');
    if (hi >= 0 && hyperionData) {
      this.hyperionIndex = hi;
      this.hyperion = new HyperionRotation(data.moons[hi].rotation as ChaoticRotationJson, hyperionData, this.models[hi]);
    }
    const names = data.moons.map((m) => m.name);
    const idx: number[] = [];
    const mu: number[] = [];
    data.wobble.moons.forEach((n, i) => {
      const j = names.indexOf(n);
      if (j >= 0) { idx.push(j); mu.push(data.wobble.mu[i]); }
    });
    this.wobIdx = Int32Array.from(idx);
    this.wobMu = Float64Array.from(mu);
    this.wobNorm = 1 / (1 + mu.reduce((a, b) => a + b, 0));
  }

  /** Index of a moon by (case-insensitive) name, or -1. */
  indexOf(name: string): number {
    const n = name.toLowerCase();
    return this.data.moons.findIndex((m) => m.name.toLowerCase() === n);
  }

  /** JD span over which a moon's fitted residual table is fully active (best accuracy), or null. */
  accurateSpanJd(i: number): [number, number] | null {
    return this.models[i].tableSpanJd();
  }

  private init(out: MoonState[]): void {
    for (let i = 0; i < this.count; i++) {
      if (out[i] && out[i].id === this.data.moons[i].id) continue;
      const m = this.data.moons[i];
      out[i] = {
        id: m.id, name: m.name, kind: m.kind,
        pos: new Vector3(), vel: new Vector3(),
        radii: new Vector3(m.radiiKm[0] * 1e3, m.radiiKm[1] * 1e3, m.radiiKm[2] * 1e3),
        meanRadius: m.meanRadiusKm * 1e3,
        orient: new Quaternion(),
        albedo: m.albedo,
        color: [m.color[0], m.color[1], m.color[2]],
        textureKey: m.textureKey,
      };
    }
    out.length = this.count;
  }

  getStates(t: number, out: MoonState[]): void {
    if (out.length !== this.count || (this.count > 0 && (!out[0] || out[0].id !== this.data.moons[0].id))) this.init(out);
    const tau = tauFromT(t);
    const s = this.s;
    // pass 0: Saturn-centred moons; pass 1: barycentric moons (+ Saturn's reflex offset)
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) this.computeWobble(out);
      for (let i = 0; i < this.count; i++) {
        if (this.bary[i] !== pass) continue;
        const st = out[i];
        this.models[i].evaluate(tau, s);
        let x = s.x, y = s.y, z = s.z, vx = s.vx, vy = s.vy, vz = s.vz;
        if (pass === 1) {
          const W = this.W;
          x += W[0]; y += W[1]; z += W[2]; vx += W[3]; vy += W[4]; vz += W[5];
        }
        st.pos.set(x * 1e3, y * 1e3, z * 1e3);
        st.vel.set(vx * 1e3, vy * 1e3, vz * 1e3);
        this.orient(i, t, tau, s, st.orient);
      }
    }
  }

  /** Saturn centre - system barycentre offset (km, km/s) from the already-evaluated major moons. */
  private computeWobble(out: MoonState[]): void {
    const W = this.W;
    W.fill(0);
    for (let j = 0; j < this.wobIdx.length; j++) {
      const m = out[this.wobIdx[j]];
      const mu = this.wobMu[j] * this.wobNorm * 1e-3; // m -> km
      W[0] += mu * m.pos.x; W[1] += mu * m.pos.y; W[2] += mu * m.pos.z;
      W[3] += mu * m.vel.x; W[4] += mu * m.vel.y; W[5] += mu * m.vel.z;
    }
  }

  private orient(i: number, t: number, tau: number, s: OrbitSample, q: Quaternion): void {
    if (i === this.hyperionIndex && this.hyperion) {
      this.hyperion.orientation(tau, q);
      return;
    }
    const r = this.iau[i];
    if (r) {
      const d = t / 86400; // days since J2000 TDB
      const w = (r.w0 + ((r.wd * d) % 360)) * DEG;
      const cw = Math.cos(w), sw = Math.sin(w);
      this._z.set(r.zx, r.zy, r.zz);
      this._x.set(cw * r.nx + sw * r.mx, cw * r.ny + sw * r.my, cw * r.nz + sw * r.mz);
      this._y.crossVectors(this._z, this._x);
      this._m.makeBasis(this._x, this._y, this._z);
      q.setFromRotationMatrix(this._m);
      return;
    }
    // synchronous: +x toward Saturn along the mean direction, +z orbit normal, +y = z x x (trailing side)
    let xx = -s.ux, xy = -s.uy, xz = -s.uz;
    const zx = s.wx, zy = s.wy, zz = s.wz;
    let yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const A = this.lib[i];
    if (A !== 0) {
      // forced physical libration, anti-phased with the optical libration (body rotated by g = -A sin M)
      const g = -A * Math.sin(s.M);
      const c = Math.cos(g), sn = Math.sin(g);
      const nx = c * xx + sn * yx, ny = c * xy + sn * yy, nz = c * xz + sn * yz;
      yx = c * yx - sn * xx; yy = c * yy - sn * xy; yz = c * yz - sn * xz;
      xx = nx; xy = ny; xz = nz;
    }
    this._x.set(xx, xy, xz);
    this._y.set(yx, yy, yz);
    this._z.set(zx, zy, zz);
    this._m.makeBasis(this._x, this._y, this._z);
    q.setFromRotationMatrix(this._m);
  }
}

function isLittleEndian(): boolean {
  return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
}
function int16le(buf: ArrayBuffer): Int16Array {
  if (isLittleEndian()) return new Int16Array(buf);
  const dv = new DataView(buf);
  const out = new Int16Array(buf.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(2 * i, true);
  return out;
}
function float32le(buf: ArrayBuffer): Float32Array {
  if (isLittleEndian()) return new Float32Array(buf);
  const dv = new DataView(buf);
  const out = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(4 * i, true);
  return out;
}

/** Build a MoonSystem from already-fetched files (e.g. in Node tests). */
export function createMoonSystem(json: MoonsFileJson, i16: ArrayBuffer, f32: ArrayBuffer | null, hyperion: ArrayBuffer | null): MoonSystem {
  return new MoonSystem(json, { i16: int16le(i16), f32: f32 ? float32le(f32) : null }, hyperion ? float32le(hyperion) : null);
}

/**
 * Load the real moon system from public/data/moons/ (moons.json, moon_tables.i16, hyperion_rotation.f32).
 * Falls back to the circular-orbit StubMoons (with a console warning) if the data cannot be loaded.
 */
export async function loadMoonSystem(): Promise<MoonProvider> {
  try {
    const jr = await fetch(dataUrl('data/moons/moons.json'));
    if (!jr.ok) throw new Error(`moons.json: HTTP ${jr.status}`);
    const json = (await jr.json()) as MoonsFileJson;
    const hm = json.moons.find((m) => m.rotation.type === 'chaotic');
    const [ti, tf, th] = await Promise.all([
      fetch(dataUrl(json.tables.i16.file)),
      json.tables.f32.count > 0 ? fetch(dataUrl(json.tables.f32.file)) : Promise.resolve(null),
      hm ? fetch(dataUrl((hm.rotation as ChaoticRotationJson).file)) : Promise.resolve(null),
    ]);
    if (!ti.ok) throw new Error(`${json.tables.i16.file}: HTTP ${ti.status}`);
    if (tf && !tf.ok) throw new Error(`${json.tables.f32.file}: HTTP ${tf.status}`);
    let hyp: ArrayBuffer | null = null;
    if (th && th.ok) hyp = await th.arrayBuffer();
    else if (hm) console.warn('[moons] Hyperion rotation table missing; Hyperion will be shown synchronous');
    return createMoonSystem(json, await ti.arrayBuffer(), tf ? await tf.arrayBuffer() : null, hyp);
  } catch (e) {
    console.warn('[moons] could not load the moon ephemeris, using StubMoons:', e);
    return new StubMoons();
  }
}
