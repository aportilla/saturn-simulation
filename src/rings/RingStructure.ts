// Ring structure: the 2-D (radius, azimuth, time) structure of the main rings. EVERY main-ring optical-depth
// lookup goes through it (GLSL: src/render/shaders/ringStructure.glsl, chunk sv_ringStructure; model and CPU math:
// src/rings/streamlines.ts). This class
//   * loads the universal moonlet response table (public/data/rings/moonlet_response.{json,f32}, built by
//     scripts/data/rings/moonlet_response.mjs) into a float texture,
//   * owns the shared uniforms (spread through SharedUniforms into every material),
//   * updates them once per frame from the moons (Pan 618, Daphnis 635) and the ring frame (Pipeline.render), and
//   * is the CPU mirror: the camera's Lagrangian position for the near field, tau at the camera for the HUD,
//     tests (window.__sv.pipeline.ctx.structure).
// Without the table (load failure) it is the identity map (uRsOn = 0): straight edges, as before.
import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RGBAFormat, Vector2, Vector4 } from 'three';
import type { FrameState } from '../core/FrameState';
import { PROFILE_DR_KM, PROFILE_R_MIN_KM } from './RingProfile';
import { SATURN, orbitalFrequencies, shearParameter } from '../core/constants';
import { dataUrl } from '../core/assets';
import {
  MoonletTable, B_IN, invertStreamlines, moonletDisplacement, moonletFootprintFade, wrapPi,
  type MoonletParams, type MoonletTableMeta, type StreamPoint,
} from './streamlines';

/** moonlet slots in the shader (uRsMl has 3 vec4 per slot) */
export const RS_MOONLETS = 2;
/** reach of the near field around the camera (m): largest particle box + margin (RingLod boxes <= 60 km) */
const NEAR_REACH = 70e3;

const DEFAULT_MOONLETS = [
  { id: 618, name: 'Pan' },
  { id: 635, name: 'Daphnis' },
];

function emptyPoint(): StreamPoint {
  return { da: 0, J: 1, drda: 1, tauMod: 1, zeta: 0, slopeR: 0, slopeT: 0 };
}

async function loadTable(base = dataUrl('data/rings/moonlet_response')): Promise<MoonletTable | null> {
  try {
    // the dev server answers unknown paths with index.html (200): validate the content
    const mres = await fetch(base + '.json');
    if (!mres.ok || !(mres.headers.get('content-type') ?? '').includes('json')) return null;
    const meta = (await mres.json()) as MoonletTableMeta;
    const bres = await fetch(base + '.f32');
    if (!bres.ok || (bres.headers.get('content-type') ?? '').includes('html')) return null;
    const buf = await bres.arrayBuffer();
    if (buf.byteLength !== 3 * meta.nb * meta.nt * 4 * 4) {
      console.warn(`[RingStructure] moonlet_response.f32 has ${buf.byteLength} bytes, expected ${3 * meta.nb * meta.nt * 16}; edges stay straight`);
      return null;
    }
    return new MoonletTable(meta, new Float32Array(buf));
  } catch (e) {
    console.warn('[RingStructure] no moonlet response table; gap edges stay straight', e);
    return null;
  }
}

export class RingStructure {
  readonly table: MoonletTable | null;
  /** moonlets with their GM (m^3/s^2) from the table header (= moons.json) */
  readonly moonlets: { id: number; name: string; gm: number }[];
  /** per-frame moonlet state (same order as `moonlets`) */
  readonly params: MoonletParams[];
  /** multiplier on the moonlet streamline amplitudes (1 = physical, 0 = straight edges, > 1 for inspection) */
  edgeWaveScale = 1;
  /** the camera's streamline state this frame (Eulerian -> Lagrangian at the camera; xi_cam = -cam.da) */
  readonly cam: StreamPoint = emptyPoint();
  /** ring frame of the last update (r0, phi0) */
  r0 = 1.3e8;
  phi0 = 0;
  /** true when a moonlet's zone lies within the near field's reach of the camera */
  nearActive = false;

  readonly uniforms: {
    uRsTab: { value: DataTexture | null };
    uRsTabT: { value: Vector4 };
    uRsTabB: { value: Vector4 };
    uRsMl: { value: Vector4[] };
    uRsCam: { value: Vector4 };
    uRsOn: { value: number };
    uRsJFloor: { value: number };
    uRsIdx0: { value: Vector2 };
  };

  private constructor(table: MoonletTable | null) {
    this.table = table;
    const meta = table?.meta;
    this.moonlets = DEFAULT_MOONLETS.slice(0, RS_MOONLETS).map((m) => {
      const j = meta?.moonlets.find((x) => x.id === m.id);
      return { ...m, gm: j ? j.gmKm3s2 * 1e9 : 0 };
    });
    this.params = this.moonlets.map(() => ({ agMinusR0: 1e12, s0: 0, rH: 0, amp: 0, xEpi: 0, xEpiDot: 0, zCos: 0, zSin: 0, ag: 1.3e8 }));
    const ml: Vector4[] = [];
    for (let i = 0; i < 3 * RS_MOONLETS; i++) ml.push(new Vector4(i % 3 === 0 ? 1e12 : 0, 0, 0, 0));
    let tex: DataTexture | null = null;
    if (table) {
      tex = new DataTexture(table.data, table.meta.nt, 3 * table.meta.nb, RGBAFormat, FloatType);
      tex.minFilter = NearestFilter;
      tex.magFilter = NearestFilter;
      tex.wrapS = ClampToEdgeWrapping;
      tex.wrapT = ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
    }
    const m = table?.meta;
    this.uniforms = {
      uRsTab: { value: tex },
      uRsTabT: { value: new Vector4(m?.t0 ?? 0, m?.dt ?? 1, m?.nt ?? 2, 1 / (m?.dt ?? 1)) },
      uRsTabB: { value: new Vector4(m?.bLo ?? 2.5, table?.dlnb ?? 1, m?.nb ?? 2, B_IN) },
      uRsMl: { value: ml },
      uRsCam: { value: new Vector4(0, 0, 1, 0) },
      uRsOn: { value: 0 },
      uRsJFloor: { value: m?.envelope.jFloor ?? 0.2 },
      uRsIdx0: { value: new Vector2() },
    };
  }

  static async load(): Promise<RingStructure> {
    const t = await loadTable();
    if (t) console.info(`[RingStructure] moonlet response ${t.meta.nb} x ${t.meta.nt} (b ${t.meta.bLo}..${t.meta.bHi}, t ${t.meta.t0}..${t.meta.t1})`);
    return new RingStructure(t);
  }

  /** Per frame, before any pass: moonlet states from the ephemeris, the ring frame, the camera's streamline state. */
  update(f: FrameState): void {
    const u = this.uniforms;
    this.r0 = f.ring.r0;
    this.phi0 = f.ring.phi0;
    // precise split of the level-0 profile index of r0 (ringSampleIdxPrecise)
    const idx0 = (this.r0 - PROFILE_R_MIN_KM * 1000) / (PROFILE_DR_KM * 1000);
    const i0 = Math.floor(idx0);
    u.uRsIdx0.value.set(i0, idx0 - i0);
    let on = false;
    const T = this.table;
    for (let k = 0; k < this.moonlets.length; k++) {
      const ml = this.moonlets[k];
      const p = this.params[k];
      p.amp = 0;
      const m = T && ml.gm > 0 ? f.moons.find((x) => x.id === ml.id) : undefined;
      if (m) {
        const x = m.pos.x, y = m.pos.y;
        const r = Math.hypot(x, y);
        const th = Math.atan2(y, x);
        const fr = orbitalFrequencies(r);
        // guiding centre and radial epicycle from the state vector (epicyclic approximation, J2..J6 frequencies):
        // theta' = Omega(r) - (2 - q) Omega (r - a_g) / r  ->  r - a_g = (Omega(r) - theta') r / ((2 - q) Omega)
        const thDot = (x * m.vel.y - y * m.vel.x) / (r * r);
        const q = shearParameter(r);
        const xEpi = ((fr.omega - thDot) * r) / ((2 - q) * fr.omega);
        const ag = r - xEpi;
        const rDot = (x * m.vel.x + y * m.vel.y) / r;
        const fg = orbitalFrequencies(ag);
        p.ag = ag;
        p.agMinusR0 = ag - this.r0;
        p.s0 = ag * wrapPi(this.phi0 - th);
        p.rH = ag * Math.cbrt(ml.gm / (3 * SATURN.GM));
        p.amp = this.edgeWaveScale;
        p.xEpi = xEpi;
        p.xEpiDot = rDot / fg.kappa;
        // vertical oscillation z_m = Z cos(nu t + psi): Z cos psi = z, Z sin psi = -z' / nu
        p.zCos = m.pos.z;
        p.zSin = -m.vel.z / fg.nu;
        on = on || p.amp !== 0;
      } else {
        p.agMinusR0 = 1e12;
      }
      const v = u.uRsMl.value;
      v[3 * k].set(p.agMinusR0, p.s0, p.rH, p.amp);
      v[3 * k + 1].set(p.xEpi, p.xEpiDot, p.zCos, p.zSin);
      v[3 * k + 2].set(p.ag, T ? T.meta.bHi * p.rH : 0, 0, 0);
    }
    u.uRsOn.value = on ? 1 : 0;
    // the camera's streamline state (double precision)
    const c = f.ring.camLocal;
    const dr = ringDr(this.r0, c.x, c.y);
    const dth = Math.atan2(c.y, this.r0 + c.x);
    this.streamAt(dr, dth, 0, true, this.cam);
    this.nearActive = false;
    if (on && T) {
      const aL = dr + this.cam.da;
      for (const p of this.params) {
        if (p.amp !== 0 && Math.abs(aL - p.agMinusR0) < T.meta.bHi * p.rH + NEAR_REACH) this.nearActive = true;
      }
    }
    u.uRsCam.value.set(-this.cam.da, this.cam.zeta, this.cam.J, this.nearActive ? 1 : 0);
  }

  // ---------------------------------------------------------------- CPU mirror
  /** All sources at Lagrangian offset aL = a' - r0 (m) and azimuth offset dth from the ring-frame origin. */
  readonly evalAt = (aL: number, dth: number, fp: number, wantZ: boolean, o: number[]): void => {
    for (let i = 0; i < 6; i++) o[i] = 0;
    const T = this.table;
    if (!T) return;
    for (const p of this.params) {
      if (p.amp === 0) continue;
      const dag = aL - p.agMinusR0;
      if (Math.abs(dag) >= T.meta.bHi * p.rH) continue;
      let S = p.s0 + p.ag * dth;
      const half = Math.PI * p.ag;
      if (Math.abs(S) > half) S -= 2 * half * Math.round(S / (2 * half));
      const amp0 = p.amp;
      p.amp = amp0 * moonletFootprintFade(p.rH, fp);
      moonletDisplacement(T, p, dag, S, wantZ, this._m);
      p.amp = amp0;
      for (let i = 0; i < 6; i++) o[i] += this._m[i];
    }
  };
  private readonly _m = [0, 0, 0, 0, 0, 0];

  /** Streamline state at the Eulerian point (dr = r - r0, dth = azimuth - phi0) of the current ring frame. */
  streamAt(dr: number, dth: number, fp = 0, wantZ = false, out: StreamPoint = emptyPoint()): StreamPoint {
    if (this.uniforms.uRsOn.value < 0.5) {
      Object.assign(out, emptyPoint());
      return out;
    }
    return invertStreamlines(this.evalAt, dr, dth, fp, this.uniforms.uRsJFloor.value, wantZ, out);
  }

  /** Streamline state at an SEF radius r (m) and azimuth theta (rad). */
  streamAtSEF(r: number, theta: number, fp = 0, wantZ = false, out?: StreamPoint): StreamPoint {
    return this.streamAt(r - this.r0, wrapPi(theta - this.phi0), fp, wantZ, out);
  }

  /** Streamline displacement xi (m) of the Lagrangian radius a' (m) at SEF azimuth theta (forward map). */
  xiAtSEF(aPrime: number, theta: number, fp = 0): number {
    const o = [0, 0, 0, 0, 0, 0];
    this.evalAt(aPrime - this.r0, wrapPi(theta - this.phi0), fp, false, o);
    return o[0];
  }

  /** Eulerian optical depth at (r, theta): tau0(a') J M, with tau0 from `tau0Km` (level-0 profile, km argument). */
  tauAtSEF(tau0Km: (rKm: number) => number, r: number, theta: number): number {
    const s = this.streamAtSEF(r, theta);
    return tau0Km((r + s.da) / 1000) * s.J * s.tauMod;
  }

  /** The camera's Lagrangian radius (m): the material around it has the profile values of this radius. */
  cameraLagrangianRadius(f: FrameState): number {
    const c = f.ring.camLocal;
    return f.ring.r0 + ringDr(f.ring.r0, c.x, c.y) + this.cam.da;
  }

  dispose(): void {
    this.uniforms.uRsTab.value?.dispose();
  }
}

/** Radius offset from r0 of a local-frame point (x radial, y azimuthal), without cancellation (= ringDrFromLocal). */
export function ringDr(r0: number, x: number, y: number): number {
  return (2 * r0 * x + x * x + y * y) / (Math.sqrt((r0 + x) * (r0 + x) + y * y) + r0);
}
