// Ring structure: the 2-D (radius, azimuth, time) structure of the main rings. EVERY main-ring optical-depth
// lookup goes through it (GLSL: src/render/shaders/ringStructure.glsl, chunk sv_ringStructure; model and CPU math:
// src/rings/streamlines.ts). This class
//   * loads the universal moonlet response table (public/data/rings/moonlet_response.{json,f32}, built by
//     scripts/data/rings/moonlet_response.mjs) into a float texture,
//   * owns the shared uniforms (spread through SharedUniforms into every material),
//   * updates them once per frame from the moons (Pan 618, Daphnis 635), the normal modes of eccentric edges
//     (ringModes.ts EDGE_FEATURES: phases at the ring-frame origin) and the ring frame (Pipeline.render), and
//   * is the CPU mirror: the camera's Lagrangian position for the near field, tau at the camera for the HUD,
//     tests (window.__sv.pipeline.ctx.structure).
//   * owns the vertical relief (src/rings/relief.ts: bending waves, the 1983 corrugation, B-ring-edge structures; GLSL
//     sv_ringRelief / sv_ringReliefShade): ONE height field z0 = the moonlets' streamline zeta + the relief (the
//     propellers' relief only with PROPELLER_RELIEF), exposed as StreamPoint.zeta / slopes, and the camera's local
//     mid-plane height f.ring.zMid (every consumer takes heights relative to it; the ring frame stays in the SEF plane).
// The 2-D optical-depth modulation M (tauMod hooks) comes from the sub-km texture (`texture`, src/rings/ringTexture.ts)
// and the propeller moonlets (`propellers`, src/rings/propellers.ts); both are owned here (uniforms merged into this
// object's, updated in update(), CPU mirrors through tauModAt / streamAt).
// Without the table (load failure) it is the identity map (uRsOn = 0): straight edges, as before.
import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RGBAFormat, Vector2, Vector4 } from 'three';
import type { FrameState } from '../core/FrameState';
import { PROFILE_DR_KM, PROFILE_R_MIN_KM, type RingProfile } from './RingProfile';
import { SATURN, orbitalFrequencies, shearParameter } from '../core/constants';
import { dataUrl } from '../core/assets';
import {
  MoonletTable, B_IN, invertStreamlines, moonletDisplacement, moonletFootprintFade, wrapPi,
  type MoonletParams, type MoonletTableMeta, type StreamPoint,
} from './streamlines';
import { EDGE_FEATURES, featureDisplacement } from './ringModes';
import { RingTexture, texAmplitude } from './ringTexture';
import { PropellerSystem } from './propellers';
import { CORRUGATION, REGION_A, REGION_A_CELLS, RELIEF_MAX_PEAKS, RELIEF_WAVES, RingRelief, WAVE_TABLE_N } from './relief';

/** moonlet slots in the shader (uRsMl has 3 vec4 per slot) */
export const RS_MOONLETS = 2;
/** normal-mode slots and edge-feature slots in the shader (uRsMode / uRsModeF, uRsFeat) */
export const RS_MODES = 8;
export const RS_FEATURES = 2;
/** reach of the near field around the camera (m): largest particle box + margin (RingLod boxes <= 60 km) */
const NEAR_REACH = 70e3;

const DEFAULT_MOONLETS = [
  // gap edges (km): the rendered profile's half-level crossings (docs/ring-physics.md section 5), for the edge waves'
  // relief shadows (sv_ringReliefShade)
  { id: 618, name: 'Pan', edgesKm: [133_424, 133_745] },
  { id: 635, name: 'Daphnis', edgesKm: [136_483, 136_523] },
];
/** bound of the moonlets' |zeta| relative to their vertical amplitude Z (the Hill response peaks at ~0.1 Z at the edges) */
const ZETA_BOUND_PER_Z = 0.15;
/** radial reach (m) around the camera in which relief sources make the march / near field evaluate z0 per step */
const RELIEF_NEAR_MARGIN = 70e3;
/**
 * The same for the propellers' relief bound (uRpTF.w, added to uRrCamN.z: the march's slab and the near field's culling
 * pad): the march's points lie within ~25 km of the camera (rays whose mid-slab distance is within the near-field LOD
 * range, ~2 a_max / pixel angle ~ 20 km, or the wake-resolving range, ~12 km), drawn particles within ~20 km. Below
 * NEAR_REACH, so the collected list (reach 70 km) stays complete until the camera has moved 30 km since the last re-fit
 * (beyond that: the classes' bound, ~330 m in the belts -- with the margin = the reach that fallback was ALWAYS taken,
 * widening the march's slab by ~330 m: +5-6 ms at a-ring-1km).
 */
const PROPELLER_RELIEF_MARGIN = 40e3;
/**
 * The propellers' relief in z0 (mirror of RS_PROPELLER_RELIEF in sv_ringStructure): prefiltered to the footprint, part
 * of the relief bounds (reliefBoundCam / uRrCamN, uRpTF.w) and the relief shadows.
 */
const PROPELLER_RELIEF = true;

function emptyPoint(): StreamPoint {
  return { da: 0, J: 1, drda: 1, tauMod: 1, tauVar: 0, wakeMod: 1, zeta: 0, slopeR: 0, slopeT: 0 };
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
  readonly moonlets: { id: number; name: string; gm: number; edgesKm: number[] }[];
  /** per-frame moonlet state (same order as `moonlets`) */
  readonly params: MoonletParams[];
  /** multiplier on the moonlet streamline amplitudes (1 = physical, 0 = straight edges, > 1 for inspection) */
  edgeWaveScale = 1;
  /** multiplier on the normal modes of eccentric edges (EDGE_FEATURES; 1 = physical, 0 = circular at the mean radii) */
  edgeModeScale = 1;
  /** sim time of the last update (s TDB) */
  t = 0;
  /** the camera's streamline state this frame (Eulerian -> Lagrangian at the camera; xi_cam = -cam.da) */
  readonly cam: StreamPoint = emptyPoint();
  /** ring frame of the last update (r0, phi0) */
  r0 = 1.3e8;
  phi0 = 0;
  /** true when a moonlet's zone lies within the near field's reach of the camera */
  nearActive = false;
  /** sub-km optical-depth texture (tauMod hook rsTauModTexture); `texture.amp` 0 switches it off */
  readonly texture: RingTexture;
  /** propeller moonlets (tauMod hook rsTauModPropellers, relief hook rsReliefPropellers); `propellers.scale` 0: off */
  readonly propellers: PropellerSystem;
  /** the radial profile (the texture's amplitude law reads its 1 km level); attached by the pipeline */
  private profile: RingProfile | null = null;
  /** vertical relief sources (bending waves, corrugation, sites): src/rings/relief.ts */
  readonly relief: RingRelief;
  /** true when a relief source lies within the near field's reach of the camera (march / particles evaluate z0) */
  reliefNear = false;
  /** bound of |z0| (m) within RELIEF_NEAR_MARGIN of the camera (the march's slab is widened by it) */
  reliefBoundCam = 0;
  /** the relief has been updated at least once (its phases are known) */
  private reliefReady = false;

  readonly uniforms: {
    uRsTab: { value: DataTexture | null };
    uRsTabT: { value: Vector4 };
    uRsTabB: { value: Vector4 };
    uRsMl: { value: Vector4[] };
    uRsCam: { value: Vector4 };
    uRsOn: { value: number };
    uRsJFloor: { value: number };
    uRsIdx0: { value: Vector2 };
    uRsMode: { value: Vector4[] };
    uRsModeF: { value: Int32Array };
    uRsFeat: { value: Vector4[] };
    // sv_ringRelief / sv_ringReliefShade
    uRrOn: { value: number };
    uRrTab: { value: DataTexture };
    uRrWave: { value: Vector4[] };
    uRrWaveT: { value: Vector4[] };
    uRrWaveI: { value: Vector4[] };
    uRrWaveX: { value: Vector4[] };
    uRrCorr: { value: Vector4 };
    uRrCorrT: { value: Vector4 };
    uRrCorrZ: { value: Vector4 };
    uRrRipZ: { value: Vector4 };
    uRrRip0: { value: Vector4 };
    uRrRip2: { value: Vector4 };
    uRrPeak: { value: Vector4[] };
    uRrPeakS: { value: Float32Array };
    uRrPeakN: { value: number };
    uRrSiteA: { value: Vector4 };
    uRrSiteB: { value: Vector4 };
    uRrSiteC: { value: Vector4 };
    uRrSiteD: { value: Vector4 };
    uRrMlEdge: { value: Vector4[] };
    uRrCamN: { value: Vector4 };
  } & RingTexture['uniforms'] & PropellerSystem['uniforms'];

  private constructor(table: MoonletTable | null) {
    this.table = table;
    this.texture = new RingTexture();
    this.propellers = new PropellerSystem(this.texture, table);
    const meta = table?.meta;
    this.moonlets = DEFAULT_MOONLETS.slice(0, RS_MOONLETS).map((m) => {
      const j = meta?.moonlets.find((x) => x.id === m.id);
      return { ...m, gm: j ? j.gmKm3s2 * 1e9 : 0 };
    });
    this.relief = new RingRelief(orbitalFrequencies);
    // bending-wave tables: row 2i the profile (A, phi, dA/dx, dphi/dx), row 2i+1 the crest table (x, A, |k|, 0)
    const W = WAVE_TABLE_N;
    const tabData = new Float32Array(W * 2 * RELIEF_WAVES * 4);
    this.relief.waves.forEach((w, i) => {
      tabData.set(w.T.data, 2 * i * W * 4);
      tabData.set(w.T.inv, (2 * i + 1) * W * 4);
    });
    const rrTab = new DataTexture(tabData, W, 2 * RELIEF_WAVES, RGBAFormat, FloatType);
    rrTab.minFilter = NearestFilter;
    rrTab.magFilter = NearestFilter;
    rrTab.wrapS = ClampToEdgeWrapping;
    rrTab.wrapT = ClampToEdgeWrapping;
    rrTab.generateMipmaps = false;
    rrTab.needsUpdate = true;
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
      uRsMode: { value: Array.from({ length: RS_MODES }, () => new Vector4()) },
      uRsModeF: { value: new Int32Array(RS_MODES) },
      uRsFeat: { value: Array.from({ length: RS_FEATURES }, () => new Vector4(1e12, -1, 1e-12, 0)) },
      uRrOn: { value: 0 },
      uRrTab: { value: rrTab },
      uRrWave: { value: Array.from({ length: RELIEF_WAVES }, () => new Vector4()) },
      uRrWaveT: { value: this.relief.waves.map((w) => new Vector4(w.T.x0, 1 / w.T.dx, w.T.N, w.T.peak)) },
      uRrWaveI: { value: this.relief.waves.map((w) => new Vector4(w.T.phiLo, 1 / w.T.dPhi, w.T.NI, w.T.side)) },
      uRrWaveX: { value: this.relief.waves.map((w) => new Vector4(w.T.xLo, w.T.xHi, 0, 0)) },
      uRrCorr: { value: new Vector4() },
      uRrCorrT: { value: new Vector4(CORRUGATION.tiltC, CORRUGATION.tiltD, 0, 0) },
      uRrCorrZ: { value: new Vector4(CORRUGATION.rD0, CORRUGATION.rCD, CORRUGATION.rC1, CORRUGATION.rC2) },
      uRrRipZ: { value: new Vector4(CORRUGATION.ripR0, CORRUGATION.ripR1, CORRUGATION.ripR2, CORRUGATION.ripR3) },
      uRrRip0: { value: new Vector4() },
      uRrRip2: { value: new Vector4() },
      uRrPeak: { value: Array.from({ length: RELIEF_MAX_PEAKS }, () => new Vector4()) },
      uRrPeakS: { value: new Float32Array(RELIEF_MAX_PEAKS) },
      uRrPeakN: { value: 0 },
      uRrSiteA: { value: new Vector4(1e12, 0, REGION_A.cellArc / REGION_A.a, REGION_A_CELLS) },
      uRrSiteB: { value: new Vector4(0, REGION_A.a, REGION_A.taper, REGION_A.occupancy) },
      uRrSiteC: { value: new Vector4(REGION_A.bandLo, REGION_A.bandHi, REGION_A.hMax, REGION_A.srMax) },
      uRrSiteD: { value: new Vector4(REGION_A.seed, 2 * REGION_A.halfSpan, 0, 0) },
      uRrMlEdge: { value: Array.from({ length: RS_MOONLETS }, () => new Vector4(1e12, 1e12, 0, 0)) },
      uRrCamN: { value: new Vector4() },
      ...this.texture.uniforms,
      ...this.propellers.uniforms,
    };
  }

  /** The radial profile: the texture's amplitude law (CPU mirror) reads its 1 km-prefiltered level. */
  attachProfile(p: RingProfile): void {
    this.profile = p;
  }

  /** Multiplier on all relief sources (1 = physical, 0 = flat; > 1 for inspection). */
  get reliefScale(): number {
    return this.relief.scale;
  }
  set reliefScale(v: number) {
    this.relief.scale = v;
    this.propellers.reliefScale = v;
  }

  /**
   * Relief + moonlet zeta: the local mid-plane height (m) at an SEF radius / azimuth (state of the last update; NaN
   * before the first one -- the phases need the moons).
   */
  midPlaneAtSEF(r: number, theta: number): number {
    return this.reliefReady ? this.streamAtSEF(r, theta, 0, true).zeta : NaN;
  }

  /** Per frame: the relief's state and uniforms (phases at the ring-frame origin, site positions). */
  private updateRelief(f: FrameState): void {
    const u = this.uniforms;
    const R = this.relief;
    R.update(f.t, this.r0, this.phi0, f.moons, f.sunDir.z);
    this.reliefReady = true;
    let any = false;
    R.waves.forEach((w, i) => {
      u.uRrWave.value[i].set(w.T.rV - this.r0, w.theta0, w.T.def.m, w.scale);
      any = any || w.scale !== 0;
    });
    const c = u.uRrCorr.value;
    if (R.corrOn) {
      c.set(1, R.corrPsi1, R.corrDt, R.rip.amp);
      u.uRrCorrT.value.set(CORRUGATION.tiltC * R.scale, CORRUGATION.tiltD * R.scale, R.nodalRate(this.r0), R.rip.psi2dth);
      const e0 = R.rip.e0, e2 = R.rip.e2;
      u.uRrRip0.value.set(e0.p0, e0.c1, e0.c2, e0.c3);
      u.uRrRip2.value.set(e2.p0, e2.c1, e2.c2, e2.c3);
      any = true;
    } else {
      c.set(0, 0, 0, 0);
    }
    const P = u.uRrPeak.value, S = u.uRrPeakS.value;
    for (let i = 0; i < RELIEF_MAX_PEAKS; i++) {
      const p = R.peaks[i];
      if (p) { P[i].set(p.aL, p.dth, p.h, p.sr); S[i] = p.ss; } else { P[i].set(1e12, 0, 0, 1); S[i] = 1; }
    }
    u.uRrPeakN.value = R.scale !== 0 ? Math.min(R.peaks.length, RELIEF_MAX_PEAKS) : 0;
    any = any || u.uRrPeakN.value > 0;
    u.uRrSiteA.value.x = R.regionA.aL;
    u.uRrSiteA.value.y = R.regionA.dthStart;
    u.uRrSiteB.value.x = R.regionA.hScale;
    any = any || R.regionA.hScale !== 0;
    u.uRrOn.value = any ? 1 : 0;
    // moonlet gap edges and their zeta bound (relief shadows of the edge waves)
    this.moonlets.forEach((m, k) => {
      const p = this.params[k];
      const Z = Math.hypot(p.zCos, p.zSin);
      u.uRrMlEdge.value[k].set(m.edgesKm[0] * 1e3 - this.r0, m.edgesKm[1] * 1e3 - this.r0, ZETA_BOUND_PER_Z * Z, 0);
    });
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
    // 2-D optical-depth modulation sources: sub-km texture (flow model at r0) and propellers
    this.texture.update(f.t, this.r0, this.phi0);
    this.propellers.update(f.t, this.r0, this.phi0, f.sunDir.z);
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
    // ---- normal modes of eccentric edges: per mode the phase m (phi0 - varpi(t)) at the ring-frame origin (double)
    this.t = f.t;
    let km = 0;
    const md = u.uRsMode.value, mf = u.uRsModeF.value, fv = u.uRsFeat.value;
    for (let fi = 0; fi < RS_FEATURES; fi++) {
      const ft = fi < EDGE_FEATURES.length ? EDGE_FEATURES[fi] : null;
      if (!ft || this.edgeModeScale === 0) {
        fv[fi].set(1e12, -1, 1e-12, 0);
        continue;
      }
      fv[fi].set(ft.aEdge - this.r0, ft.material, 1 / ft.gap, ft.reach);
      for (const mode of ft.modes) {
        if (km >= RS_MODES) break;
        const phase = wrapPi(mode.m * (this.phi0 - mode.varpi0 - mode.omegaP * (f.t - ft.epoch)));
        md[km].set(mode.amp * this.edgeModeScale, phase, mode.m, 1 / mode.decay);
        mf[km] = fi;
        km++;
      }
      on = true;
    }
    for (; km < RS_MODES; km++) md[km].set(0, 0, 0, 1);
    u.uRsOn.value = on ? 1 : 0;
    this.updateRelief(f);
    // the camera's streamline state (double precision), incl. the local mid-plane height z0 (moonlet zeta + relief)
    const c = f.ring.camLocal;
    const dr = ringDr(this.r0, c.x, c.y);
    const dth = Math.atan2(c.y, this.r0 + c.x);
    this.streamAt(dr, dth, 0, true, this.cam);
    f.ring.zMid = this.cam.zeta;
    // relief near the camera: the march's slab and the near field's per-particle z0
    this.reliefBoundCam = this.relief.bound(dr, RELIEF_NEAR_MARGIN);
    for (let k = 0; k < this.params.length; k++) {
      const p = this.params[k];
      if (p.amp !== 0 && this.table && Math.abs(dr + this.cam.da - p.agMinusR0) < this.table.meta.bHi * p.rH + RELIEF_NEAR_MARGIN) {
        this.reliefBoundCam += ZETA_BOUND_PER_Z * Math.hypot(p.zCos, p.zSin) * Math.abs(p.amp);
      }
    }
    // the propellers' relief near the camera (their amplitudes, from the near-field collection): the march's slab, the
    // near field's culling pad (uRpTF.w)
    const propB = PROPELLER_RELIEF ? this.propellers.nearReliefBound(this.r0 + dr, this.phi0 + dth, PROPELLER_RELIEF_MARGIN) : 0;
    this.propellers.uniforms.uRpTF.value.w = propB;
    this.reliefBoundCam += propB;
    this.reliefNear = this.relief.bound(dr, RELIEF_NEAR_MARGIN) > 0 || propB > 0;
    // camera's mid-plane slope in the frame axes (the frame's radial / prograde axes at the camera, |dth| < 2e-4 rad)
    u.uRrCamN.value.set(this.cam.slopeR, this.cam.slopeT, this.reliefBoundCam, this.reliefNear ? 1 : 0);
    this.nearActive = false;
    if (on) {
      const aL = dr + this.cam.da;
      if (T) {
        for (const p of this.params) {
          if (p.amp !== 0 && Math.abs(aL - p.agMinusR0) < T.meta.bHi * p.rH + NEAR_REACH) this.nearActive = true;
        }
      }
      if (this.edgeModeScale !== 0) {
        for (const ft of EDGE_FEATURES) {
          if (Math.abs(aL - (ft.aEdge - this.r0)) < ft.reach + ft.gap + NEAR_REACH) this.nearActive = true;
        }
      }
    }
    u.uRsCam.value.set(-this.cam.da, this.cam.zeta, this.cam.J, this.nearActive ? 1 : 0);
  }

  // ---------------------------------------------------------------- CPU mirror
  /** All sources at Lagrangian offset aL = a' - r0 (m) and azimuth offset dth from the ring-frame origin. */
  readonly evalAt = (aL: number, dth: number, fp: number, wantZ: boolean, o: number[]): void => {
    for (let i = 0; i < 6; i++) o[i] = 0;
    // normal modes of eccentric edges
    if (this.edgeModeScale !== 0) {
      for (const ft of EDGE_FEATURES) {
        featureDisplacement(ft, this.r0 + aL, this.phi0 + dth, this.t, this._m);
        o[0] += this.edgeModeScale * this._m[0];
        o[1] += this.edgeModeScale * this._m[1];
        o[2] += this.edgeModeScale * this._m[2];
      }
    }
    // vertical relief (ringStructureRelief: bending waves, corrugation, sites; the propellers')
    if (wantZ) {
      this.relief.eval(aL, dth, fp, this._h);
      o[3] += this._h[0];
      o[4] += this._h[1];
      o[5] += this._h[2];
      if (PROPELLER_RELIEF) {
        this.propellers.reliefAt(aL, dth, fp, this._z);
        o[3] += this._z[0]; o[4] += this._z[1]; o[5] += this._z[2];
      }
    }
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
  private readonly _z = [0, 0, 0];
  private readonly _h = [0, 0, 0];

  /** amplitude A of the sub-km texture at Lagrangian offset aL: the 1 km-prefiltered profile (as the GLSL) */
  textureAmplitudeAt(aL: number): number {
    const p = this.profile;
    const d = p?.texA?.image.data as Float32Array | undefined;
    if (!p || !d) return 0;
    const fi0 = (this.r0 + aL - PROFILE_R_MIN_KM * 1000) / (PROFILE_DR_KM * 1000);
    if (fi0 < -0.5 || fi0 > p.levelCounts[0] - 0.5) return 0;
    const L = Math.min(2, p.levelOffsets.length - 1), sc = 2 ** L;
    const n = p.levelCounts[L];
    const c = Math.min(Math.max((fi0 - 0.5 * (sc - 1)) / sc, 0), n - 1);
    const j0 = Math.floor(c), j1 = Math.min(j0 + 1, n - 1), f = c - j0;
    const off = p.levelOffsets[L];
    const tau = d[(off + j0) * 4] * (1 - f) + d[(off + j1) * 4] * f;
    const wake = d[(off + j0) * 4 + 3] * (1 - f) + d[(off + j1) * 4 + 3] * f;
    return tau > 0 ? texAmplitude(tau, wake) : 0;
  }

  /**
   * The 2-D modulation at Lagrangian offset aL (m), azimuth offset dth (rad), footprint fp (m): texture x propellers,
   * [mean tau factor, sub-footprint variance, self-gravity-wake strength factor] (sv_ringStructure ringStructureMod).
   */
  tauModAt(aL: number, dth: number, fp = 0, out: number[] = [1, 0, 1]): number[] {
    const t = this.texture.evalAt(aL, dth, fp, this.textureAmplitudeAt(aL), this._t);
    const p = this.propellers.tauModAt(aL, dth, fp, this._p);
    out[0] = t[0] * p[0];
    out[1] = t[1] * p[0] * p[0] + p[1] * t[0] * t[0] + t[1] * p[1];
    out[2] = p[2];
    return out;
  }
  private readonly _t = [1, 0];
  private readonly _p = [1, 0, 1];

  /**
   * Upper bound of the modulation within a box of half-width hw (m) around the point prepared by prepareNear (the
   * near field thins its particles by tau0 M / tauMax: tauMax must cover the largest M in each class's box).
   */
  maxTauModNear(rAbs: number, hw: number): number {
    // texture: the clamp of F at the largest amplitude within the box (tau and wake of the 1 km level)
    let A = 0;
    for (let dr = -hw; dr <= hw; dr += Math.max(250, hw / 64)) A = Math.max(A, this.textureAmplitudeAt(rAbs + dr - this.r0));
    return this.texture.maxFactor(A) * this.propellers.boxFactor(hw);
  }
  /** Collect the propellers around the SEF point (r, theta) for maxTauModNear (once per near-field re-fit). */
  prepareNear(r: number, theta: number, reach = NEAR_REACH): void {
    this.propellers.collectNear(r, theta, reach);
  }
  /** Signature of the propeller bounds of the given box half-widths (changes when a propeller drifts into a box). */
  nearBoundKey(boxes: ArrayLike<number>): string {
    let k = '';
    for (let i = 0; i < boxes.length; i++) k += `${this.propellers.boxFactor(boxes[i]).toFixed(2)},`;
    return k;
  }

  /** Streamline state at the Eulerian point (dr = r - r0, dth = azimuth - phi0) of the current ring frame. */
  streamAt(dr: number, dth: number, fp = 0, wantZ = false, out: StreamPoint = emptyPoint()): StreamPoint {
    if (this.uniforms.uRsOn.value < 0.5) {
      // identity map (as rsIdentityAt in the GLSL): only the relief's height
      Object.assign(out, emptyPoint());
      if (wantZ) {
        this.relief.eval(dr, dth, fp, this._h);
        if (PROPELLER_RELIEF) this.propellers.reliefAt(dr, dth, fp, this._z);
        else this._z[0] = this._z[1] = this._z[2] = 0;
        out.zeta = this._h[0] + this._z[0];
        out.slopeR = this._h[1] + this._z[1];
        out.slopeT = this._h[2] + this._z[2];
      }
    } else {
      invertStreamlines(this.evalAt, dr, dth, fp, this.uniforms.uRsJFloor.value, wantZ, out);
    }
    this.tauModAt(dr + out.da, dth, fp * out.J, this._tm);
    out.tauMod = this._tm[0];
    out.tauVar = this._tm[1];
    out.wakeMod = this._tm[2];
    return out;
  }
  private readonly _tm = [1, 0, 1];

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

  /**
   * Upper bound of |xi| (m) for material within the near field's reach of the Eulerian radius r: how far the
   * streamline map can move the material under a co-orbiting camera (near-field allocation margin).
   */
  maxDisplacementNear(r: number): number {
    let d = 0;
    if (this.edgeModeScale !== 0) {
      for (const ft of EDGE_FEATURES) {
        if (Math.abs(r - ft.aEdge) < ft.reach + ft.gap + NEAR_REACH) d += Math.abs(this.edgeModeScale) * ft.modes.reduce((s, m) => s + m.amp, 0);
      }
    }
    if (this.table) {
      for (const p of this.params) {
        if (p.amp !== 0 && Math.abs(r - this.r0 - p.agMinusR0) < this.table.meta.bHi * p.rH + NEAR_REACH) d += 1.5 * p.rH * Math.abs(p.amp);
      }
    }
    return d;
  }

  /** The camera's Lagrangian radius (m): the material around it has the profile values of this radius. */
  cameraLagrangianRadius(f: FrameState): number {
    const c = f.ring.camLocal;
    return f.ring.r0 + ringDr(f.ring.r0, c.x, c.y) + this.cam.da;
  }

  dispose(): void {
    this.uniforms.uRsTab.value?.dispose();
    this.texture.dispose();
    this.uniforms.uRrTab.value.dispose();
  }
}

/** Radius offset from r0 of a local-frame point (x radial, y azimuthal), without cancellation (= ringDrFromLocal). */
export function ringDr(r0: number, x: number, y: number): number {
  return (2 * r0 * x + x * x + y * y) / (Math.sqrt((r0 + x) * (r0 + x) + y * y) + r0);
}
