// Far-field pass: everything that is not ring material — sky (stars, Milky Way, Sun), Saturn and the moons —
// ray traced in one fullscreen pass at true scale and in physical units.
//
// Writes ctx.sceneRT: rgb = radiance (W m^-2 sr^-1), a = distance from the camera (m; SKY_DIST for sky),
// gl_FragDepth = logDepth01(view depth). Sub-step order per frame:
//   1. ringshine table (only when the Sun direction changed)          -> far/Ringshine.ts
//   2. star layer: catalog stars as PSF points into a float target    -> far/StarLayer.ts
//   3. fullscreen ray trace: sky + Saturn (+haze shell) + resolved moons, analytic AA, depth-sorted composite
//   (late, from PostPass) sub-pixel moons as points into hdrRT          -> far/MoonPoints.ts, far/lateHooks.ts
// See src/render/far/* for the physical models.
import {
  AlwaysDepth, DataArrayTexture, DataTexture, Matrix3, RawShaderMaterial, RGBAFormat, UnsignedByteType, Vector3,
  Vector4,
} from 'three';
import type { FrameState, MoonState } from '../../core/FrameState';
import type { PipelineContext, RenderPass } from '../Pipeline';
import { FullscreenPass } from '../fullscreen';
import { DEG, MAX_MOONS } from '../../core/constants';
import { raDecToSef } from '../../core/ephemeris';
import { FAR_HEADER } from '../far/glsl/header';
import { FAR_NOISE_GLSL } from '../far/glsl/noise';
import { FAR_SATURN_GLSL } from '../far/glsl/saturn';
import { FAR_MOONS_GLSL } from '../far/glsl/moons';
import { FAR_PSF_GLSL, FAR_SKY_GLSL } from '../far/glsl/sky';
import {
  advectionState, angularRate, buildSaturnLut, MAX_STORMS, SATURN_MINNAERT_K, SATURN_P_RGB, STORM_T_REF, STORMS,
  type AdvectionState,
} from '../far/saturnModel';
import { MoonMat, moonLook, photFactor, type MoonLook } from '../far/moonModel';
import { StarLayer, loadStars } from '../far/StarLayer';
import { RingshineTable } from '../far/Ringshine';
import { MoonPoints } from '../far/MoonPoints';
import { addLateHdrHook, removeLateHdrHook, type LateHdrHook } from '../far/lateHooks';
import { loadManifest, loadMoonTextures, loadSaturnTexture, type MoonTextureSet } from '../far/textures';
import { GpuTimer } from '../far/GpuTimer';

const MAX_RESOLVED = 8;
const TITAN_BODY_DH = 240e3;

const FRAG = /* glsl */ `
${FAR_HEADER}
${FAR_NOISE_GLSL}
${FAR_PSF_GLSL}
${FAR_SATURN_GLSL}
${FAR_MOONS_GLSL}
${FAR_SKY_GLSL}
uniform int uResCount;
uniform int uResIdx[${MAX_RESOLVED}];
in vec2 vUv;
layout(location = 0) out vec4 outColor;

void main() {
  gAAPix = uPixelAngle;
  vec3 rd = cameraRayDir(vUv);
  vec2 ndc = vUv * 2.0 - 1.0;
  vec2 tp = vec2(ndc.x * uTanHalfFov * uAspect, ndc.y * uTanHalfFov);
  float om = pixelSolidAngle(tp);
  vec3 col = skyRadiance(rd, gl_FragCoord.xy, om);
  // up to three depth-sorted layers: Saturn (+ haze) and the two nearest resolved moons
  vec3 LL[3]; vec3 TT[3]; float DD[3]; float CC[3];
  int n = 0;
  SatResult S = traceSaturn(rd);
  if (S.any) { LL[0] = S.L; TT[0] = S.T; DD[0] = S.sortDist; CC[0] = S.cov; DD[0] = S.cov >= 0.5 ? S.dist : S.sortDist; n = 1; }
  for (int k = 0; k < ${MAX_RESOLVED}; k++) {
    if (k >= uResCount) break;
    int i = uResIdx[k];
    MoonTrace m = traceMoon(i, rd);
    if (m.cov <= 0.0 && m.T.g > 0.99999 && max(m.L.r, max(m.L.g, m.L.b)) <= 0.0) continue;
    float w = uMoonRing[i].w;
    m.L *= w;
    m.T = mix(vec3(1.0), m.T, w);
    m.cov *= w;
    if (n < 3) {
      LL[n] = m.L; TT[n] = m.T; DD[n] = m.dist; CC[n] = m.cov; n++;
    } else {
      // replace the farthest layer if this one is nearer
      int far = 0;
      for (int j = 1; j < 3; j++) if (DD[j] > DD[far]) far = j;
      if (m.dist < DD[far]) { LL[far] = m.L; TT[far] = m.T; DD[far] = m.dist; CC[far] = m.cov; }
    }
  }
  // composite far -> near
  float dist = SKY_DIST;
  for (int pass = 0; pass < 3; pass++) {
    if (pass >= n) break;
    int far = -1;
    float df = -1.0;
    for (int j = 0; j < 3; j++) {
      if (j >= n) break;
      if (DD[j] > df) { df = DD[j]; far = j; }
    }
    col = col * TT[far] + LL[far];
    if (CC[far] >= 0.5) dist = min(dist, DD[far]);
    DD[far] = -2.0;
  }
  outColor = vec4(col, dist);
  gl_FragDepth = dist >= SKY_DIST ? 1.0 : logDepth01(dist * max(-(uWorldToCam * rd).z, 1e-6));
}`;

function smooth01(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
const TWO_PI = 2 * Math.PI;
function wrap(x: number): number {
  return x - Math.floor(x / TWO_PI) * TWO_PI;
}

export interface FarFieldOptions {
  /** measure the pass on the GPU (EXT_disjoint_timer_query_webgl2); shown in stats() */
  gpuTiming?: boolean;
}

export class FarFieldPass implements RenderPass {
  readonly name = 'far';
  enabled = true;
  private fs!: FullscreenPass;
  private u: Record<string, { value: any }> = {};
  private stars!: StarLayer;
  private ringshine!: RingshineTable;
  private moonPts!: MoonPoints;
  private timer: GpuTimer | null = null;
  private lateTimer: GpuTimer | null = null;
  private ctx!: PipelineContext;
  private adv: AdvectionState = advectionState(0);
  private infos = new Map<number, { look: MoonLook; key: string; knownColor: boolean }>();
  private moonTex: MoonTextureSet | null = null;
  private rsVec: Vector3[] = [];
  private rsNext = 0;
  private resolved = 0;
  private resList: { i: number; th: number }[] = Array.from({ length: MAX_MOONS }, () => ({ i: 0, th: 0 }));
  private tmpV = new Vector3();
  private tmpV2 = new Vector3();
  private lateHook: LateHdrHook;
  private lastExposure = 0.25;
  private texStatus = 'none';

  constructor(private readonly opts: FarFieldOptions = {}) {
    this.lateHook = (f, ctx) => this.renderLate(f, ctx);
  }

  init(ctx: PipelineContext): void {
    this.ctx = ctx;
    const gl = ctx.renderer.getContext() as WebGL2RenderingContext;
    gl.getExtension('EXT_float_blend');
    gl.getExtension('OES_texture_float_linear');
    const v4 = () => Array.from({ length: MAX_MOONS }, () => new Vector4());
    const dummy2D = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    dummy2D.needsUpdate = true;
    const dummyArr = new DataArrayTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, 1);
    dummyArr.needsUpdate = true;
    // galactic frame (IAU 1958 / ICRS: NGP RA 192.85948, Dec 27.12825; centre RA 266.40500, Dec -28.93617)
    const zg = raDecToSef(192.85948 * DEG, 27.12825 * DEG);
    const xg0 = raDecToSef(266.405 * DEG, -28.93617 * DEG);
    const xg = xg0.clone().addScaledVector(zg, -xg0.dot(zg)).normalize();
    const yg = new Vector3().crossVectors(zg, xg);
    const gal = new Matrix3().set(xg.x, xg.y, xg.z, yg.x, yg.y, yg.z, zg.x, zg.y, zg.z);
    const hazeTau = new Vector3(0.07, 0.08, 0.09);
    const rayTau = new Vector3(0.008, 0.012, 0.027);
    const comp = new Vector3(Math.exp(2.2 * (hazeTau.x + rayTau.x)), Math.exp(2.2 * (hazeTau.y + rayTau.y)), Math.exp(2.2 * (hazeTau.z + rayTau.z)));
    this.u = {
      uSatLut: { value: buildSaturnLut() },
      uSatAdv: { value: new Vector4(0, 0, 1, 0) },
      uSatSeed0: { value: new Vector3() },
      uSatSeed1: { value: new Vector3() },
      uStormCount: { value: 0 },
      uStormA: { value: Array.from({ length: MAX_STORMS }, () => new Vector4()) },
      uStormB: { value: Array.from({ length: MAX_STORMS }, () => new Vector4()) },
      uSatPolar: { value: new Vector4(0.6, 0, 0, 0) },
      uRingshine: { value: null },
      uRingshineOn: { value: 1 },
      uSatTex: { value: dummy2D },
      uSatTexInfo: { value: new Vector4(0, 0.5, 1, 1) },
      uSatTexGain: { value: new Vector3(1, 1, 1) },
      uSatHazeTau: { value: hazeTau },
      uSatRayTau: { value: rayTau },
      uSatDeckComp: { value: comp },
      uMoonQuat: { value: v4() },
      uMoonRadii: { value: v4() },
      uMoonPhot: { value: v4() },
      uMoonPhot2: { value: v4() },
      uMoonColor: { value: v4() },
      uMoonExtra: { value: v4() },
      uMoonRing: { value: v4() },
      uMoonTex: { value: dummyArr },
      uMoonTexW: { value: 1 },
      uStarTex: { value: null },
      uStarsOn: { value: 1 },
      uGalRot: { value: gal },
      uMilkyWay: { value: 0 },
      uResCount: { value: 0 },
      uResIdx: { value: new Int32Array(MAX_RESOLVED) },
      uFarDebug: { value: 0 },
    };
    for (let i = 0; i < MAX_MOONS; i++) this.rsVec.push(new Vector3());
    const all = { ...ctx.shared.u, ...this.u };
    this.stars = new StarLayer(all, ctx.width, ctx.height);
    this.u.uStarTex.value = this.stars.rt.texture;
    this.ringshine = new RingshineTable(ctx.shared.u, ctx.profile);
    this.u.uRingshine.value = this.ringshine.rt.texture;
    this.fs = new FullscreenPass({
      fragmentShader: FRAG,
      uniforms: { ...ctx.shared.u, ...this.u },
      depthTest: true,
      depthWrite: true,
      depthFunc: AlwaysDepth,
    });
    this.moonPts = new MoonPoints({ ...ctx.shared.u, ...this.u });
    addLateHdrHook(ctx, this.lateHook);
    if (this.opts.gpuTiming) {
      this.timer = new GpuTimer(gl, true);
      this.lateTimer = new GpuTimer(gl, true);
    }
    // asynchronous data (render with fallbacks meanwhile)
    loadStars().then((d) => this.stars.setData(d)).catch((e) => console.warn('[FarField] stars', e));
    this.loadTextures().catch((e) => console.warn('[FarField] textures', e));
  }

  private async loadTextures(): Promise<void> {
    const maps = await loadManifest();
    if (maps.size === 0) { this.texStatus = 'no manifest'; return; }
    const keys = [...maps.keys()];
    const [moonSet, sat] = await Promise.all([
      loadMoonTextures(maps, keys),
      loadSaturnTexture(maps, SATURN_P_RGB.map((p, k) => (p * (2 * SATURN_MINNAERT_K[k] + 1)) / 2) as [number, number, number]),
    ]);
    if (moonSet) {
      this.moonTex = moonSet;
      this.u.uMoonTex.value = moonSet.texture;
      this.u.uMoonTexW.value = moonSet.width;
    }
    if (sat) {
      this.u.uSatTex.value = sat.texture;
      (this.u.uSatTexInfo.value as Vector4).set(1, sat.u0, sat.dir, sat.texture.image.width);
      (this.u.uSatTexGain.value as Vector3).set(sat.gain[0], sat.gain[1], sat.gain[2]);
    }
    this.texStatus = `${moonSet ? moonSet.layers.size : 0} moon maps${sat ? ' + saturn' : ''}`;
  }

  resize(ctx: PipelineContext): void {
    this.stars.resize(ctx.width, ctx.height);
  }

  private infoFor(m: MoonState): { look: MoonLook; key: string; knownColor: boolean } {
    let l = this.infos.get(m.id);
    if (!l) {
      const key = m.name.toLowerCase();
      l = { look: moonLook(m.name, m.kind), key, knownColor: MOON_COLOR_KNOWN.has(key) };
      this.infos.set(m.id, l);
    }
    return l;
  }

  update(f: FrameState, ctx: PipelineContext): void {
    const u = this.u;
    this.lastExposure = f.exposure > 0 ? f.exposure : this.lastExposure;
    // ---- Saturn: advection clock, storms, polar features
    advectionState(f.t, undefined, this.adv);
    const a = this.adv;
    (u.uSatAdv.value as Vector4).set(a.tau0, a.tau1, a.w0, a.w1);
    (u.uSatSeed0.value as Vector3).set(a.seed0[0], a.seed0[1], a.seed0[2]);
    (u.uSatSeed1.value as Vector3).set(a.seed1[0], a.seed1[1], a.seed1[2]);
    const dt = f.t - STORM_T_REF;
    const sa = u.uStormA.value as Vector4[];
    const sb = u.uStormB.value as Vector4[];
    const ns = Math.min(STORMS.length, MAX_STORMS);
    for (let i = 0; i < ns; i++) {
      const s = STORMS[i];
      const lat = s.latDeg * DEG;
      const lon = wrap(s.lonDeg * DEG + angularRate(lat) * dt);
      const cl = Math.cos(lat);
      sa[i].set(cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat), (s.radiusKm * 1e3) / 60_000e3);
      sb[i].set(s.kind, s.strength, s.kind === 0 ? 1.3 : 1.6, 1);
    }
    u.uStormCount.value = ns;
    const pol = u.uSatPolar.value as Vector4;
    pol.y = wrap(-angularRate(89.5 * DEG) * dt);
    pol.z = wrap(-angularRate(-89.5 * DEG) * dt);
    pol.w = wrap(-50 * angularRate(47 * DEG) * dt);
    // ---- sky
    u.uFarDebug.value = f.settings.debugView | 0;
    u.uStarsOn.value = f.settings.stars ? 1 : 0;
    u.uMilkyWay.value = f.settings.stars ? smooth01(1.5e-4, 6e-4, this.lastExposure * 6e-6) : 0;
    // ---- moons
    this.updateMoons(f);
  }

  private updateMoons(f: FrameState): void {
    const u = this.u;
    const quat = u.uMoonQuat.value as Vector4[];
    const radii = u.uMoonRadii.value as Vector4[];
    const phot = u.uMoonPhot.value as Vector4[];
    const phot2 = u.uMoonPhot2.value as Vector4[];
    const color = u.uMoonColor.value as Vector4[];
    const extra = u.uMoonExtra.value as Vector4[];
    const ring = u.uMoonRing.value as Vector4[];
    const n = Math.min(f.moons.length, MAX_MOONS);
    const rel = this.tmpV;
    const camV = this.tmpV2;
    let nRes = 0;
    // ringshine vectors: one moon per frame (they move slowly relative to the ring illumination)
    if (n > 0) {
      const k = this.rsNext++ % n;
      const m = f.moons[k];
      this.ringshine.irradianceVector(m.pos, f.sunDir, f.solarIrradiance, f.sunAngularRadius, this.rsVec[k]);
    }
    for (let i = 0; i < n; i++) {
      const m = f.moons[i];
      const mi = this.infoFor(m);
      const look = mi.look;
      const isTitan = look.mat === MoonMat.Titan;
      quat[i].set(m.orient.x, m.orient.y, m.orient.z, m.orient.w);
      radii[i].set(m.radii.x, m.radii.y, m.radii.z, look.mat);
      const pGeom = look.pGeom ?? m.albedo;
      const An = pGeom / photFactor(look.phot);
      phot[i].set(An, look.phot.B0, look.phot.h, look.phot.beta);
      const tex = this.moonTex?.layers.get(mi.key);
      phot2[i].set(look.phot.L0, look.phot.L1, tex && !isTitan ? tex.layer : -1, look.seed);
      const col = mi.knownColor ? look.color : m.color;
      color[i].set(col[0], col[1], col[2], look.craters);
      extra[i].set(look.bump, tex ? tex.u0 : 0, tex ? tex.dir : 1, tex ? tex.gain : 1);
      // resolved weight
      rel.copy(m.pos).sub(f.camPos);
      const d = rel.length();
      const Rres = isTitan ? m.radii.x + TITAN_BODY_DH : Math.max(m.radii.x, m.radii.y, m.radii.z);
      const thPx = Rres / Math.max(d, 1) / f.pixelAngle;
      let w = smooth01(1.0, 2.5, thPx);
      if (w > 0) {
        // in front of the camera and within the (padded) frustum?
        camV.copy(rel).applyMatrix3(f.worldToCam);
        const Rb = isTitan ? m.radii.x + 900e3 : Rres;
        if (camV.z > Rb) w = 0;
        else if (-camV.z > Rb) {
          const th = Math.tan(f.fovY / 2);
          const sx = Math.abs(camV.x / -camV.z) - Rb / -camV.z * 1.5;
          const sy = Math.abs(camV.y / -camV.z) - Rb / -camV.z * 1.5;
          if (sx > th * f.aspect || sy > th) w = 0;
        }
        if (w > 0) {
          const e = this.resList[nRes++];
          e.i = i;
          e.th = thPx;
        }
      }
      const rs = this.rsVec[i];
      ring[i].set(rs.x, rs.y, rs.z, w);
    }
    for (let i = n; i < MAX_MOONS; i++) ring[i].w = 0;
    // keep the MAX_RESOLVED apparently largest moons resolved; the rest fall back to points
    if (nRes > MAX_RESOLVED) {
      // partial selection sort (n <= 32): largest first
      for (let a = 0; a < MAX_RESOLVED; a++) {
        let best = a;
        for (let b = a + 1; b < nRes; b++) if (this.resList[b].th > this.resList[best].th) best = b;
        if (best !== a) {
          const ti = this.resList[a].i, tt = this.resList[a].th;
          this.resList[a].i = this.resList[best].i; this.resList[a].th = this.resList[best].th;
          this.resList[best].i = ti; this.resList[best].th = tt;
        }
      }
      for (let k = MAX_RESOLVED; k < nRes; k++) ring[this.resList[k].i].w = 0;
      nRes = MAX_RESOLVED;
    }
    const idx = u.uResIdx.value as Int32Array;
    for (let k = 0; k < nRes; k++) idx[k] = this.resList[k].i;
    u.uResCount.value = nRes;
    this.resolved = nRes;
  }

  render(f: FrameState, ctx: PipelineContext): void {
    const r = ctx.renderer;
    this.timer?.poll();
    this.timer?.begin();
    this.ringshine.update(r, f.sunDir);
    if (f.moons.length > 0) this.moonPts.integrate(r);
    this.stars.render(r, this.lastExposure, f.settings.stars);
    this.fs.render(r, ctx.sceneRT);
    this.timer?.end();
  }

  private renderLate(f: FrameState, ctx: PipelineContext): void {
    if (!this.enabled || f.moons.length === 0) return;
    this.lateTimer?.poll();
    this.lateTimer?.begin();
    this.moonPts.render(ctx.renderer, ctx.hdrRT, ctx.sceneRT.texture, this.lastExposure);
    this.lateTimer?.end();
  }

  get material(): RawShaderMaterial {
    return this.fs.material;
  }

  stats(): Record<string, string | number> {
    const s: Record<string, string | number> = {
      stars: `${this.stars?.count ?? 0} (${this.stars?.source ?? '-'})`,
      moons: `${this.resolved} resolved`,
      maps: this.texStatus,
    };
    if (this.timer?.available) s.gpu = `${this.timer.ms.toFixed(2)} ms (+late ${this.lateTimer?.ms.toFixed(2)})`;
    return s;
  }

  dispose(): void {
    removeLateHdrHook(this.ctx, this.lateHook);
    this.fs.dispose();
    this.stars.dispose();
    this.ringshine.dispose();
    this.moonPts.dispose();
  }
}

const MOON_COLOR_KNOWN = new Set(['mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'titan', 'iapetus', 'hyperion', 'phoebe']);
