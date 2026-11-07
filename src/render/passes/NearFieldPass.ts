// Near-field ring particles: every macroscopic ring particle (1 cm .. 10 m) within a few hundred meters
// to a few km of the camera, drawn individually, at true size, moving with the exact linearized orbital
// dynamics of the local co-orbiting (Hill) frame.
//
// Population (shared LOD contract, src/rings/RingLod.ts): 10 octave size classes. Class k is a
// shearing-periodic square box of half-size box[k] around the camera holding slots[k] particle slots
// (number density nPerTau*tauBoxMax). Each slot is present with probability tau_macro(r)/tauBoxMax at its
// guiding-center radius (real radial profile: gaps are empty, edges sharp). Static attributes (radius from
// the power law, epicycle and vertical amplitudes/phases, spin, shape, albedo) are hashes of the slot
// index, so the only GPU state is the azimuthal guiding center Y_e (R32F, ping-pong, re-based so that
// the shear drift stays small for any warp, including negative).
//
// Per frame:
//   1. per active class: (re-base / init the state rows when needed), update pass -> R0 rows: camera-relative
//      position + radius + "drawn" flag (LOD draw probability with a stable per-particle threshold,
//      view-frustum and statistical occlusion culling)
//   2. HistoPyramid compaction of R0 into lists (point sprites / large quads / shadow casters)
//   3. sun shadow map of all present particles >= ~8 cm in a tube along the sun direction around the camera
//      (NearShadow.ts): per texel the most sunward caster's exact projected outline, tested analytically by
//      the lookups (resolution-independent edges, physical penumbra); the statistical layer transmission keeps
//      only the part the map cannot resolve
//   4. one point-sprite draw + one quad draw for all classes: each vertex fetches its particle through the
//      pyramid and ray-traces a spinning lumpy triaxial ellipsoid, writing radiance, distance and exact
//      depth into ctx.sceneRT. Photometry matches the ring-layer medium (power-law particle phase function,
//      two-stream multiple scattering with the same back-scatter fractions, wake-aware sun paths, shadow
//      hiding), so the particles fade into the medium without a brightness seam.
// Orbital phases kappa(t-tRef), nu(t-tRef), spin phases, the shear copy offsets etc. are computed in JS
// double precision and reduced before being passed to the GPU, so nothing degrades over long sim times.
// Debug views (settings.debugView): 11 shadow terms, 12 sun factor, 13 Saturnshine, 14 diffuse ring light,
// 15 wake density at the particles, 17 map-vs-statistics, 18 caster map, 19-22 shadow lookup tests,
// 31 no surface noise. `skip` disables sub-passes for profiling.
import {
  BufferGeometry, DoubleSide, FloatType, GLSL3, InstancedBufferGeometry, LessEqualDepth, Mesh, NearestFilter,
  NoBlending, Points, RawShaderMaterial, RedFormat, RGBAFormat, Vector2, Vector3, Vector4, WebGLRenderTarget,
  type IUniform,
} from 'three';
import type { FrameState } from '../../core/FrameState';
import type { PipelineContext, RenderPass } from '../Pipeline';
import { fullscreenGeometry, fsCamera, FS_VERT } from '../fullscreen';
import { SV_HEADER_ALL } from '../shaders/chunks';
import { LOD_CLASSES, type RingLod } from '../../rings/RingLod';
import { SATURN } from '../../core/constants';
import nearCommon from '../near/nearCommon.glsl?raw';
import nearUpdate from '../near/nearUpdate.glsl?raw';
import nearState from '../near/nearState.glsl?raw';
import nearDrawVert from '../near/nearDraw.vert.glsl?raw';
import nearDrawFrag from '../near/nearDraw.frag.glsl?raw';
import { NearCompaction, NEAR_PYR_GLSL } from '../near/NearCompaction';
import { phaseTables, PHASE_LUT_N } from '../rings/phase';
import { buildNearNoise } from '../near/NearNoise';
import {
  NearShadow, NEAR_SHADOW_CASTER_FS, NEAR_SHADOW_CASTER_VS, NEAR_SHADOW_COMMON_GLSL, NEAR_SHADOW_LOOKUP_GLSL,
} from '../near/NearShadow';

const TEX_W = 2048;
const TWO_PI = Math.PI * 2;
/** largest sprite radius (px) handled by the point pass (GL max point size is 511 here) */
const PT_MAX_PX = 180;
/** quads are only needed for the few particles within a few radii of the camera */
const MAX_QUADS = 16384;
const modTwoPi = (x: number) => x - Math.floor(x / TWO_PI) * TWO_PI;
const frac = (x: number) => x - Math.floor(x);
const wrapPos = (x: number, p: number) => x - Math.floor(x / p) * p;

/** Slot classification shared by the pyramid build and the list traversal. */
const NEAR_CLASSIFY_GLSL = /* glsl */ `
uniform sampler2D tR0;
uniform int uTexW;
uniform int uTexRows;
uniform int uClsRow0[LOD_CLASSES];
uniform int uClsRows[LOD_CLASSES];   // 0 for inactive classes
uniform int uClsSeed[LOD_CLASSES];
uniform float uPtMax;
int nearClassOfRow(int row) {
  for (int k = 0; k < LOD_CLASSES; k++) {
    if (row >= uClsRow0[k] && row < uClsRow0[k] + uClsRows[k]) return k;
  }
  return -1;
}
// list membership of a slot: (point sprite, quad, shadow caster, 0)
vec4 nearClassify(ivec2 tc) {
  if (tc.x >= uTexW || tc.y >= uTexRows) return vec4(0.0);
  vec4 r0 = texelFetch(tR0, tc, 0);
  if (r0.w == 0.0) return vec4(0.0);
  int k = nearClassOfRow(tc.y);
  if (k < 0) return vec4(0.0);
  // every present particle of the mapped classes inside the shadow tube casts (drawn or not)
  float cst = nearShadowCaster(r0.xyz, 1.4 * abs(r0.w), k) ? 1.0 : 0.0;
  if (r0.w < 0.0) return vec4(0.0, 0.0, cst, 0.0);
  uint idx = uint((tc.y - uClsRow0[k]) * uTexW + tc.x);
  float rb = r0.w * nearShape(idx, uint(uClsSeed[k])).x;
  float s = length(r0.xyz);
  if (s < 1.02 * rb + 1e-3) return vec4(0.0, 0.0, cst, 0.0);   // camera inside the particle
  float w = -(uWorldToCam * r0.xyz).z;
  float sinB = rb / s, cosT = w / s;
  float rpx = w > 0.0 ? sinB * inversesqrt(max(1.0 - sinB * sinB, 1e-6)) / (uPixelAngle * cosT * cosT) : 1e9;
  bool big = w < 3.0 * rb || rpx > uPtMax || cosT < 0.35;
  return big ? vec4(0.0, 1.0, cst, 0.0) : vec4(1.0, 0.0, cst, 0.0);
}
`;

const LEVEL1_FRAG = /* glsl */ `
uniform ivec2 uDstOff;
layout(location = 0) out vec4 o;
void main() {
  ivec2 p = (ivec2(gl_FragCoord.xy) - uDstOff) * 2;
  o = nearClassify(p) + nearClassify(p + ivec2(1, 0)) + nearClassify(p + ivec2(0, 1)) + nearClassify(p + ivec2(1, 1));
}`;

interface ClassState {
  k: number;
  slots: number;
  row0: number;
  rows: number;
  seed: number;
  D: number;
  /** box reference (local frame, m): camera position when the class was initialized */
  c0x: number;
  c0y: number;
  tRef: number;
  tE: number;
  cur: number;
  needsInit: boolean;
  active: boolean;
}

function hashSeed(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h & 0x7fffffff) >>> 0;
}

function makeSlotRT(h: number, rgba: boolean): WebGLRenderTarget {
  return new WebGLRenderTarget(TEX_W, h, {
    type: FloatType,
    format: rgba ? RGBAFormat : RedFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

export class NearFieldPass implements RenderPass {
  readonly name = 'near';
  enabled = true;
  /** statistical occlusion culling (essential in the B ring) */
  cullEnabled = true;
  /**
   * cull particles whose line-of-sight optical depth (slab model, emptiest wake-gap density) exceeds this
   * (visibility e^-5 = 0.7%); tighter than the shared uLodCullTau because it bounds the overdraw
   */
  cullTau = 5;
  /** near-field sun shadow map (crisp shadows from nearby particles) */
  shadowsEnabled = true;
  /** debugging / profiling: skip sub-passes */
  skip = { update: false, compact: false, points: false, quads: false, shadow: false };

  private ctx!: PipelineContext;
  private texRows = 0;
  private r0RT: WebGLRenderTarget | null = null;
  private stateRT: WebGLRenderTarget[] = [];
  private classes: ClassState[] = [];
  private allocVersion = -1;
  private anchorId = -1;
  private totalSlots = 0;
  private readonly pyr = new NearCompaction();
  private shadow!: NearShadow;
  private shMat!: RawShaderMaterial;
  private casters!: Points;
  private shadowOn = false;

  private updMat!: RawShaderMaterial;
  private stMat!: RawShaderMaterial;
  private l1Mat!: RawShaderMaterial;
  private ptMat!: RawShaderMaterial;
  private qdMat!: RawShaderMaterial;
  private fsMesh!: Mesh;
  private points!: Points;
  private ptGeom!: BufferGeometry;
  private quads!: Mesh;
  private qdGeom!: InstancedBufferGeometry;

  // shared class tables (by reference in every material that needs them)
  private readonly clsRow0 = { value: new Int32Array(LOD_CLASSES) };
  private readonly clsRows = { value: new Int32Array(LOD_CLASSES) };
  private readonly clsSeed = { value: new Int32Array(LOD_CLASSES) };
  private readonly clsSpinW = { value: new Float32Array(LOD_CLASSES) };
  private readonly texRowsU = { value: 1 };
  private readonly r0U = { value: null as any };
  /** two-stream back-scatter fractions of the particle phase function: (diffuse, beam at the current mu0) */
  private readonly betaU = { value: new Vector2(0.719, 0.55) };
  /** per-frame lighting environment (uniform over the near field): (Saturn sun visibility, Saturnshine
   *  irradiance, Saturn angular radius, 1 = evaluate moon shadows per particle) */
  private readonly envU = { value: new Vector4(1, 0, 0.48, 0) };
  /** (fraction of the layer column above the camera height, -, -, -) */
  private readonly env2U = { value: new Vector4(0.5, 0, 0, 0) };
  private readonly satDirU = { value: new Vector3(-1, 0, 0) };
  private readonly noiseU = { value: buildNearNoise() };

  // stats
  private frame = 0;
  private readback: { pbo: WebGLBuffer; fence: WebGLSync; wait: number } | null = null;
  private readBuf = new Float32Array(4);
  private listCounts = [0, 0, 0];

  init(ctx: PipelineContext): void {
    this.ctx = ctx;
    this.shadow = new NearShadow();
    const sh = { ...ctx.shared.u, ...this.shadow.uniforms };
    const common = SV_HEADER_ALL + '\n' + nearCommon + '\n' + NEAR_SHADOW_COMMON_GLSL + '\n';
    const tables = (): Record<string, IUniform> => ({
      tR0: this.r0U,
      uTexW: { value: TEX_W },
      uTexRows: this.texRowsU,
      uClsRow0: this.clsRow0,
      uClsRows: this.clsRows,
      uClsSeed: this.clsSeed,
      uPtMax: { value: PT_MAX_PX },
    });
    this.updMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FS_VERT,
      fragmentShader: common + nearUpdate,
      uniforms: {
        ...sh,
        tState: { value: null },
        uTexW: { value: TEX_W },
        uRow0: { value: 0 },
        uCount: { value: 0 },
        uClass: { value: 0 },
        uSeed: { value: 1 },
        uBoxD: { value: 1 },
        uRad: { value: new Vector3(0.01, 0.02, 3) },
        uSig: { value: new Vector2(1, 1) },
        uCamMod: { value: new Vector2() },
        uKin: { value: new Vector4() },
        uShear: { value: new Vector4() },
        uTauBoxMax: { value: 1 },
        uTauCam: { value: 0 },
        uCull: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
    this.stMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FS_VERT,
      fragmentShader: common + nearState,
      uniforms: {
        ...sh,
        tState: { value: null },
        uTexW: { value: TEX_W },
        uRow0: { value: 0 },
        uCount: { value: 0 },
        uSeed: { value: 1 },
        uMode: { value: 0 },
        uBoxD: { value: 1 },
        uShear: { value: new Vector4() },
      },
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
    this.l1Mat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FS_VERT,
      fragmentShader: common + NEAR_CLASSIFY_GLSL + LEVEL1_FRAG,
      uniforms: { ...sh, ...tables(), uDstOff: { value: [0, 0] } },
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
    const listGlsl = NEAR_CLASSIFY_GLSL + NEAR_PYR_GLSL;
    const vs = common + listGlsl + NEAR_SHADOW_LOOKUP_GLSL + nearDrawVert;
    const fs = common + NEAR_SHADOW_LOOKUP_GLSL + nearDrawFrag;
    const drawMat = (quad: number) =>
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: vs,
        fragmentShader: fs,
        uniforms: {
          ...sh,
          ...tables(),
          ...this.pyr.uniforms(),
          uQuad: { value: quad },
          uClsSpinW: this.clsSpinW,
          uNearBeta: this.betaU,
          uNearEnv: this.envU,
          uNearEnv2: this.env2U,
          uNearSatDir: this.satDirU,
          tNearNoise: this.noiseU,
          uDebug: { value: 0 },
        },
        depthTest: true,
        depthWrite: true,
        depthFunc: LessEqualDepth,
        blending: NoBlending,
        side: DoubleSide,
      });
    this.ptMat = drawMat(0);
    this.qdMat = drawMat(1);
    this.shMat = NearShadow.casterMaterial(
      common + listGlsl + 'uniform float uClsSpinW[LOD_CLASSES];\n' + NEAR_SHADOW_CASTER_VS,
      common + NEAR_SHADOW_CASTER_FS,
      { ...sh, ...tables(), ...this.pyr.uniforms(), uClsSpinW: this.clsSpinW },
    );
    const cg = new BufferGeometry();
    cg.setDrawRange(0, 0);
    this.casters = new Points(cg, this.shMat);
    this.casters.frustumCulled = false;

    this.fsMesh = new Mesh(fullscreenGeometry(), this.updMat);
    this.fsMesh.frustumCulled = false;
    this.ptGeom = new BufferGeometry();
    this.ptGeom.setDrawRange(0, 0);
    this.points = new Points(this.ptGeom, this.ptMat);
    this.points.frustumCulled = false;
    this.qdGeom = new InstancedBufferGeometry();
    this.qdGeom.setDrawRange(0, 6);
    this.qdGeom.instanceCount = 0;
    this.quads = new Mesh(this.qdGeom, this.qdMat);
    this.quads.frustumCulled = false;

    for (let k = 0; k < LOD_CLASSES; k++) {
      this.classes.push({ k, slots: 0, row0: 0, rows: 0, seed: 1, D: 1, c0x: 0, c0y: 0, tRef: 0, tE: 0, cur: 0, needsInit: true, active: false });
    }
  }

  // ------------------------------------------------------------------ allocation
  private reallocate(lod: RingLod, f: FrameState): void {
    let row = 0;
    let total = 0;
    // largest particles first: the compacted lists follow texture order, so if a list is ever truncated
    // (stale draw cap for a frame) only the smallest particles are affected
    for (let k = LOD_CLASSES - 1; k >= 0; k--) {
      const c = this.classes[k];
      c.slots = Math.max(0, lod.slots[k]);
      c.rows = Math.ceil(c.slots / TEX_W);
      c.row0 = row;
      row += c.rows;
      total += c.slots;
      c.D = lod.box[k];
      c.seed = hashSeed(f.ring.anchorId * 131 + lod.allocVersion, k + 1);
      c.needsInit = true;
    }
    this.totalSlots = total;
    const need = Math.max(row, 1);
    if (need > this.texRows) {
      const rows = Math.ceil((need * 1.1 + 16) / 64) * 64;
      this.r0RT?.dispose();
      for (const s of this.stateRT) s.dispose();
      this.r0RT = makeSlotRT(rows, true);
      this.stateRT = [makeSlotRT(rows, false), makeSlotRT(rows, false)];
      this.texRows = rows;
      this.texRowsU.value = rows;
      this.r0U.value = this.r0RT.texture;
      this.pyr.resize(TEX_W, rows);
      for (const m of [this.ptMat, this.qdMat, this.shMat]) {
        m.uniforms.tPyrA.value = this.pyr.atlas[0].texture;
        m.uniforms.tPyrB.value = this.pyr.atlas[1].texture;
      }
    }
    this.allocVersion = lod.allocVersion;
    this.anchorId = f.ring.anchorId;
    this.capStale = true;
  }
  private capStale = true;

  update(f: FrameState, ctx: PipelineContext): void {
    const lod = ctx.lod;
    if (lod.allocVersion !== this.allocVersion || f.ring.anchorId !== this.anchorId) this.reallocate(lod, f);
  }

  // ------------------------------------------------------------------ rendering
  render(f: FrameState, ctx: PipelineContext): void {
    if (!this.r0RT) return;
    const r = ctx.renderer;
    const lod = ctx.lod;
    const ring = f.ring;
    const t = f.t;
    const cam = ring.camLocal;
    const qO = ring.qShear * ring.omega;
    const slab = 1.6 * lod.H + 0.5;
    this.frame++;

    // --- class activity, init and re-base
    for (const c of this.classes) {
      c.active = c.slots > 0 && Math.abs(cam.z) - slab < c.D;
      this.clsRow0.value[c.k] = c.row0;
      this.clsRows.value[c.k] = c.active ? c.rows : 0;
      this.clsSeed.value[c.k] = c.seed;
      if (!c.active) continue;
      if (c.needsInit) {
        c.c0x = cam.x;
        c.c0y = cam.y;
        c.tRef = t;
        c.tE = t;
        this.statePass(c, 0, 0, 0);
        c.needsInit = false;
      } else if (Math.abs(qO * (t - c.tE)) > 0.25) {
        const dtE = t - c.tE;
        this.statePass(c, 1, qO * dtE, wrapPos(qO * c.c0x * dtE, 2 * c.D));
        c.tE = t;
        c.cur = 1 - c.cur;
      }
      this.clsSpinW.value[c.k] = modTwoPi((ring.omega / 8) * (t - c.tRef));
    }

    // --- update pass per class -> R0
    this.lap('update');
    const u = this.updMat.uniforms;
    u.uCull.value = this.cullEnabled ? Math.min(this.cullTau, lod.cullTau) : 0;
    u.uTauBoxMax.value = Math.max(lod.tauBoxMax, 1e-6);
    u.uTauCam.value = ctx.profile.tauAtKm((ring.r0 + cam.x) / 1000);
    this.fsMesh.material = this.updMat;
    for (const c of this.classes) {
      if (!c.active || this.skip.update) continue;
      const k = c.k;
      const D = c.D, D2 = 2 * D;
      const dtE = t - c.tE, dtRef = t - c.tRef;
      u.tState.value = this.stateRT[c.cur].texture;
      u.uRow0.value = c.row0;
      u.uCount.value = c.slots;
      u.uClass.value = k;
      u.uSeed.value = c.seed;
      u.uBoxD.value = D;
      (u.uRad.value as Vector3).set(lod.aLo[k], lod.aHi[k], lod.q);
      (u.uSig.value as Vector2).set(lod.sigX(k), lod.sigZ(k));
      const sx = cam.x - c.c0x;
      const nCam = Math.floor(sx / D2);
      const F = frac(qO * dtRef);
      (u.uCamMod.value as Vector2).set(sx - nCam * D2, wrapPos(cam.y - c.c0y, D2));
      (u.uKin.value as Vector4).set(modTwoPi(ring.kappa * dtRef), modTwoPi(ring.nu * dtRef), ring.omega / ring.kappa, 0);
      (u.uShear.value as Vector4).set(qO * dtE, wrapPos(qO * c.c0x * dtE, D2), F, frac(nCam * F));
      this.updMat.uniformsNeedUpdate = true;
      const rt = this.r0RT;
      rt.viewport.set(0, c.row0, TEX_W, c.rows);
      r.setRenderTarget(rt);
      r.render(this.fsMesh, fsCamera);
    }
    this.r0RT.viewport.set(0, 0, TEX_W, this.texRows);

    // --- compaction (the shadow-map geometry must be set first: it decides the caster list)
    this.shadow.enabled = this.shadowsEnabled && !this.skip.shadow;
    this.shadowOn = this.shadow.configure(f, lod);
    if (!this.shadowOn) this.shadow.prepare(r);
    this.lap('compact');
    this.l1Mat.uniformsNeedUpdate = true;
    if (!this.skip.compact) this.pyr.build(r, this.l1Mat);
    this.fsMesh.material = this.updMat;

    // --- sun shadow map of the casters around the camera
    if (this.shadowOn) {
      this.shMat.uniformsNeedUpdate = true;
      this.shadow.render(r, this.casters, this.listCap(2));
    }

    // --- two-stream back-scatter fractions of the (power-law) particle phase function, as the medium uses
    const pt = phaseTables(1);
    const mu = Math.min(1, Math.abs(f.sunDir.z)) * (PHASE_LUT_N - 1);
    const i0 = Math.min(PHASE_LUT_N - 2, Math.floor(mu));
    const b0 = pt.beta0Macro[i0] + (pt.beta0Macro[i0 + 1] - pt.beta0Macro[i0]) * (mu - i0);
    (this.betaU.value as Vector2).set(pt.betaMacro, b0);
    this.updateEnv(f, lod);

    // --- draw into the scene target
    this.lap('points');
    r.setRenderTarget(ctx.sceneRT);
    this.ptMat.uniforms.uDebug.value = f.settings.debugView;
    this.qdMat.uniforms.uDebug.value = f.settings.debugView;
    this.ptMat.uniformsNeedUpdate = true;
    this.qdMat.uniformsNeedUpdate = true;
    this.ptGeom.setDrawRange(0, this.listCap(0));
    if (!this.skip.points) r.render(this.points, fsCamera);
    this.lap('quads');
    this.qdGeom.instanceCount = MAX_QUADS;
    if (!this.skip.quads) r.render(this.quads, fsCamera);
    if (f.settings.debugView === 18) this.debugBlitShadow(ctx);
    this.readCounts(ctx);
  }

  private dbgShadow: Mesh | null = null;
  /** debug 18: show the caster map (caster centre depth along the sun, grey; empty = blue) over the scene */
  private debugBlitShadow(ctx: PipelineContext): void {
    if (!this.dbgShadow) {
      const m = new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: FS_VERT,
        fragmentShader: /* glsl */ `
          precision highp float; precision highp int;
          uniform highp usampler2D tShadow; in vec2 vUv; layout(location = 0) out vec4 o;
          void main() {
            uvec4 e = texelFetch(tShadow, ivec2(vUv * vec2(textureSize(tShadow, 0))), 0);
            vec3 c = e.w == 0u ? vec3(0.0, 0.0, 0.3) : vec3(0.5 + 0.5 * tanh(uintBitsToFloat(e.z) / 60.0));
            o = vec4(c * 3.0, 1.0);
          }`,
        uniforms: { tShadow: this.shadow.uniforms.tShadow },
        depthTest: false,
        depthWrite: false,
      });
      this.dbgShadow = new Mesh(fullscreenGeometry(), m);
      this.dbgShadow.frustumCulled = false;
    }
    ctx.renderer.setRenderTarget(ctx.sceneRT);
    ctx.renderer.render(this.dbgShadow, fsCamera);
  }

  /**
   * Number of point vertices to launch: the list size is only known on the GPU; vertices past the end
   * exit after one fetch. Use the last read-back size with generous headroom (never fewer than 64k).
   */
  private listCap(list: number): number {
    const n = this.listCounts[list];
    if (!(n > 0) || this.capStale) return this.totalSlots;
    return Math.min(this.totalSlots, Math.max(65536, Math.ceil(n * 2 + 32768)));
  }

  /**
   * Per-frame lighting environment at the camera (mirrors saturnSunVisibility / moonsSunVisibility /
   * saturnshine of sv_saturn / sv_lighting). Saturn's penumbra on the rings is ~100 km wide and Saturn is
   * >60,000 km away, so these are uniform over the near field (<= 2.5 km). Moon shadows can be small: if any
   * moon's shadow could reach the near field the shader evaluates moon visibility per particle.
   */
  private updateEnv(f: FrameState, lod: RingLod): void {
    const cam = f.camPos, s = f.sunDir;
    const Req = SATURN.R_EQ, kz = SATURN.R_EQ / SATURN.R_POL;
    const ox = cam.x / Req, oy = cam.y / Req, oz = (cam.z / Req) * kz;
    let dx = s.x, dy = s.y, dz = s.z * kz;
    const dl = Math.hypot(dx, dy, dz);
    dx /= dl; dy /= dl; dz /= dl;
    const dist = Math.hypot(ox, oy, oz);
    let vis = 0;
    if (dist > 1) {
      const angS = Math.asin(Math.min(1, 1 / dist));
      const sep = Math.acos(Math.min(1, Math.max(-1, -(ox * dx + oy * dy + oz * dz) / dist)));
      const e0 = angS - f.sunAngularRadius, e1 = angS + f.sunAngularRadius;
      const t = Math.min(1, Math.max(0, (sep - e0) / (e1 - e0)));
      vis = t * t * (3 - 2 * t);
    }
    let perParticle = 0;
    for (const m of f.moons) {
      const cx = m.pos.x - cam.x, cy = m.pos.y - cam.y, cz = m.pos.z - cam.z;
      const d = Math.hypot(cx, cy, cz);
      if (d <= m.meanRadius * 1.01) { perParticle = 1; continue; }
      const cs = cx * s.x + cy * s.y + cz * s.z;
      if (cs <= 0) continue;
      const sep = Math.atan2(Math.hypot(cy * s.z - cz * s.y, cz * s.x - cx * s.z, cx * s.y - cy * s.x), cs);
      // + parallax across the near field
      if (sep < Math.asin(m.meanRadius / d) + f.sunAngularRadius + 3000 / d) perParticle = 1;
    }
    // Saturnshine at the camera (Saturn as a Lambert-phase sphere of geometric albedo 0.499)
    const dc = cam.length();
    const a = Math.acos(Math.min(1, Math.max(-1, (cam.x * s.x + cam.y * s.y + cam.z * s.z) / dc)));
    const phi = (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;
    const Rm = 0.96 * Req;
    const Ess = f.solarIrradiance * SATURN.GEOMETRIC_ALBEDO * ((Rm * Rm) / (dc * dc)) * phi;
    (this.envU.value as Vector4).set(vis, Ess, Math.asin(Math.min(1, Req / dc)), perParticle);
    (this.satDirU.value as Vector3).set(-cam.x / dc, -cam.y / dc, -cam.z / dc);
    // fraction of the layer's optical depth above the camera height (same vertical model as sv_ringLod)
    const zc = f.ring.camLocal.z;
    let fu = 0, ws = 0;
    for (let k = 0; k < LOD_CLASSES; k++) {
      const w = lod.tauFrac[k];
      if (w <= 0) continue;
      fu += w * Qf(zc, Math.max(lod.sigZFrac[k] * lod.H, 0.02));
      ws += w;
    }
    if (lod.tauSub > 0) { fu += lod.tauSub * Qf(zc, Math.max(lod.sigZFracSub * lod.H, 0.02)); ws += lod.tauSub; }
    if (ws <= 0) fu = Qf(zc, Math.max(0.3 * lod.H, 0.02));
    (this.env2U.value as Vector4).set(fu, 0, 0, 0);
  }

  private statePass(c: ClassState, mode: number, shearX: number, bulk: number): void {
    const r = this.ctx.renderer;
    const su = this.stMat.uniforms;
    // init writes the current state texture (and must not sample it); re-base reads current -> writes other
    su.tState.value = mode === 0 ? this.stateRT[1 - c.cur].texture : this.stateRT[c.cur].texture;
    su.uRow0.value = c.row0;
    su.uCount.value = c.slots;
    su.uSeed.value = c.seed;
    su.uMode.value = mode;
    su.uBoxD.value = c.D;
    (su.uShear.value as Vector4).set(shearX, bulk, 0, 0);
    this.stMat.uniformsNeedUpdate = true;
    const dst = mode === 0 ? this.stateRT[c.cur] : this.stateRT[1 - c.cur];
    dst.viewport.set(0, c.row0, TEX_W, c.rows);
    this.fsMesh.material = this.stMat;
    r.setRenderTarget(dst);
    r.render(this.fsMesh, fsCamera);
    dst.viewport.set(0, 0, TEX_W, this.texRows);
    this.fsMesh.material = this.updMat;
  }

  // ------------------------------------------------------------------ stats: list sizes (async readback)
  private readCounts(ctx: PipelineContext): void {
    const gl = ctx.renderer.getContext() as WebGL2RenderingContext;
    const rb = this.readback;
    if (rb) {
      if (gl.getSyncParameter(rb.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return;
      gl.deleteSync(rb.fence);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, rb.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.readBuf);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(rb.pbo);
      this.readback = null;
      this.listCounts[0] = this.readBuf[0];
      this.listCounts[1] = this.readBuf[1];
      this.listCounts[2] = this.readBuf[2];
      this.capStale = false;
      return;
    }
    if (this.frame % 4 !== 0) return;
    const top = this.pyr.topLocation;
    const pbo = gl.createBuffer();
    if (!pbo) return;
    ctx.renderer.setRenderTarget(top.rt);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
    gl.readPixels(top.x, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (fence) this.readback = { pbo, fence, wait: 0 };
    ctx.renderer.setRenderTarget(ctx.sceneRT);
  }

  // (GPU timer queries are not usable for sub-pass timing on ANGLE/Metal; profile with `skip` + fps.)
  private lap(_name: string): void {}

  stats(): Record<string, string | number> {
    const per: string[] = [];
    for (const c of this.classes) if (c.active) per.push(`${c.k}:${fmtCount(c.slots)}`);
    return {
      allocated: fmtCount(this.totalSlots),
      drawn: `${fmtCount(this.listCounts[0] + this.listCounts[1])} (${fmtCount(this.listCounts[1])} large)`,
      shadowCasters: fmtCount(this.listCounts[2]),
      classes: per.join(' '),
    };
  }

  dispose(): void {
    this.r0RT?.dispose();
    for (const s of this.stateRT) s.dispose();
    this.pyr.dispose();
    for (const m of [this.updMat, this.stMat, this.l1Mat, this.ptMat, this.qdMat, this.shMat]) m?.dispose();
    this.shadow?.dispose();
  }
}

/** Gaussian tail P(Z > x) for std sig */
function Qf(x: number, sig: number): number {
  return 0.5 * erfc(x / (Math.SQRT2 * sig));
}

/** complementary error function (Abramowitz & Stegun 7.1.26, |err| < 1.5e-7) */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z);
  return x >= 0 ? y : 2 - y;
}

function fmtCount(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
