// Near-field ring particles: every macroscopic ring particle (1 cm .. 10 m) within a few hundred meters
// to a few km of the camera, drawn individually, at true size, moving with the exact linearized orbital
// dynamics of the local co-orbiting (Hill) frame.
//
// Population (shared LOD contract, src/rings/RingLod.ts): 14 octave size classes of slots[k] particle slots;
// each particle lives in its own shearing-periodic square box around the camera (half-size = its horizontal
// reach to the handover band, at most box[k]) at number density nPerTau*tauMax. Each slot is present with
// probability tau_macro(r)/tauMax at its guiding-center radius (real radial profile: gaps are empty, edges
// sharp). Static attributes (radius and box from the class sampler, epicycle and vertical amplitudes/phases,
// spin, shape, albedo) are hashes of the slot index, so the only GPU state is the azimuthal guiding center
// Y_e (R32F, ping-pong, re-based so that the shear drift stays small for any warp, including negative).
//
// Per frame:
//   1. per active class: (re-base / init the state rows when needed), update pass -> R0 rows: camera-relative
//      position + radius + "drawn" flag (LOD draw probability with a stable per-particle threshold,
//      view-frustum and statistical occlusion culling)
//  1b. contact resolution (NearContact.ts): the particles resolved on screen (3 -> 6 render px radius, not
//      statistically occluded, near the view) are pushed apart where their analytic positions overlap (hash grid per
//      size class, mass-weighted Jacobi iterations, displacements bounded by the overlaps), written back into R0
//      before anything reads it; presence unchanged, drawn flags only set for particles moved into view
//   2. HistoPyramid compaction of R0 into lists (point sprites / large quads / shadow casters)
//   3. sun shadow map of all present particles >= ~8 cm in a tube along the sun direction around the camera
//      (NearShadow.ts): per texel the most sunward caster's exact projected outline (x its relief profile at high
//      quality, second attachment), tested analytically by the lookups (resolution-independent edges, physical
//      penumbra); the statistical layer transmission keeps only the part the map cannot resolve
//   4. one point-sprite draw + one quad draw for all classes: each vertex fetches its particle through the
//      pyramid and ray-traces a triaxial ellipsoid in principal-axis rotation (high quality: its relief-
//      displaced surface, ray-marched above ~12 render px, nearCommon.glsl nearRelief), writing radiance,
//      distance and exact depth into ctx.sceneRT. Photometry matches the ring-layer medium (regolith surface
//      law x the per-particle factor that gives the power-law particle phase function, NearRegolith.ts; two-
//      stream multiple scattering with the same back-scatter fractions, wake-aware sun paths, shadow hiding),
//      so the particles fade into the medium without a brightness seam.
// Orbital phases kappa(t-tRef), nu(t-tRef), spin phases, the shear copy offsets etc. are computed in JS
// double precision and reduced before being passed to the GPU, so nothing degrades over long sim times.
// Debug views (settings.debugView): 11 shadow terms, 12 sun factor, 13 Saturnshine, 14 diffuse ring light,
// 15 wake density at the particles, 17 map-vs-statistics, 18 caster map, 19-22 shadow lookup tests,
// 31 no relief normals, 32 the former Lambert law, 33 ray-marched relief (red = amplitude), 34 relief
// self-shadowing. `skip` disables sub-passes for profiling.
import {
  BufferGeometry, DoubleSide, FloatType, GLSL3, InstancedBufferGeometry, LessEqualDepth, Mesh, NearestFilter, NoBlending,
  Points, RawShaderMaterial, RedFormat, RGBAFormat, Vector2, Vector3, Vector4, WebGLRenderTarget, type IUniform,
} from 'three';
import type { FrameState } from '../../core/FrameState';
import type { PipelineContext, RenderPass } from '../Pipeline';
import { fullscreenGeometry, fsCamera, FS_VERT } from '../fullscreen';
import { SV_HEADER_ALL } from '../shaders/chunks';
import { LOD_CLASSES, LOD_PIECES, type RingLod } from '../../rings/RingLod';
import { SATURN } from '../../core/constants';
import nearCommon from '../near/nearCommon.glsl?raw';
import nearUpdate from '../near/nearUpdate.glsl?raw';
import nearState from '../near/nearState.glsl?raw';
import nearDrawVert from '../near/nearDraw.vert.glsl?raw';
import nearDrawFrag from '../near/nearDraw.frag.glsl?raw';
import { NearCompaction, NEAR_PYR_GLSL } from '../near/NearCompaction';
import { phaseTables, PHASE_LUT_N } from '../rings/phase';
import {
  buildNearClasts, buildNearNoise, buildValueTexture, CLAST_N, CLAST_P, gradientBound, nearClastData, nearNoiseData, NOISE_N,
  NOISE_P, valueRange,
} from '../near/NearNoise';
import { REGOLITH_A0, REGOLITH_A1, REGOLITH_LUT_NA, REGOLITH_LUT_NALB, regolithTable } from '../near/NearRegolith';
import { reliefPhotUniform } from '../near/NearRelief';
import { NearContact } from '../near/NearContact';
import {
  NearShadow, NEAR_SHADOW_CASTER_FS, NEAR_SHADOW_CASTER_VS, NEAR_SHADOW_COMMON_GLSL, NEAR_SHADOW_LOOKUP_GLSL,
  NEAR_SHADOW_PROFILE_GLSL,
} from '../near/NearShadow';

const TEX_W = 2048;
const TWO_PI = Math.PI * 2;
/** largest sprite radius (px) handled by the point pass (GL max point size is 511 here) */
const PT_MAX_PX = 180;
/** quads are only needed for the few particles within a few radii of the camera */
const MAX_QUADS = 16384;
const modTwoPi = (x: number) => x - Math.floor(x / TWO_PI) * TWO_PI;
const frac = (x: number) => x - Math.floor(x);

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
// list membership of a slot: (point sprite, quad, shadow caster, counted: drawn and >= 1 display px across)
vec4 nearClassify(ivec2 tc) {
  if (tc.x >= uTexW || tc.y >= uTexRows) return vec4(0.0);
  vec4 r0 = texelFetch(tR0, tc, 0);
  if (r0.w == 0.0) return vec4(0.0);
  int k = nearClassOfRow(tc.y);
  if (k < 0) return vec4(0.0);
  // every present particle of the mapped classes inside the shadow tube casts (drawn or not)
  float cst = nearShadowCaster(r0.xyz, nearMaxExtent() * abs(r0.w), k) ? 1.0 : 0.0;
  if (r0.w < 0.0) return vec4(0.0, 0.0, cst, 0.0);
  float s = max(length(r0.xyz), 1e-4);
  float cnt = lodRho(r0.w, s) >= LOD_RHO_FULL ? 1.0 : 0.0;
  // rasterization (fidelity only; the count above is fixed): in the handover band with probability
  // lodCarryParticle, below half a render pixel as a disc of half a render pixel with probability (rho / 0.5)^2 x it
  uint idx = uint((tc.y - uClsRow0[k]) * uTexW + tc.x);
  float rhoR = r0.w / (s * uPixelAngle);
  float pr = lodCarryParticle(r0.w, k, s, r0.z) * min(1.0, 4.0 * rhoR * rhoR);
  if (nearU(idx, uint(uClsSeed[k]), NS_LOD) >= pr) return vec4(0.0, 0.0, cst, cnt);
  if (rhoR < 0.5) return vec4(1.0, 0.0, cst, cnt);
  // bounding radii of the drawn surface (as nearDraw.vert.glsl): the relief's outer / inner shells when it is
  // ray-marched, else the ellipsoid's major / minor semi-axes
  vec3 shp = r0.w * nearShape(idx, uint(uClsSeed[k]), r0.w);
  float amp = nearReliefAmp(shp.x / (s * uPixelAngle));
  vec2 shell = amp > 0.0 ? nearReliefShell(amp, nearReliefParams(idx, uint(uClsSeed[k]), r0.w).w) : vec2(1.0);
  float rb = shp.x * shell.y;
  if (s < shp.z * shell.x) return vec4(0.0, 0.0, cst, cnt);   // camera inside the particle
  float w = -(uWorldToCam * r0.xyz).z;
  float sinB = min(rb / s, 1.0), cosT = w / s;
  float rpx = w > 0.0 ? sinB * inversesqrt(max(1.0 - sinB * sinB, 1e-6)) / (uPixelAngle * cosT * cosT) : 1e9;
  // (camera inside the bounding shell: w < rb -> a whole-screen quad)
  bool big = w < 3.0 * rb || rpx > uPtMax || cosT < 0.35;
  return big ? vec4(0.0, 1.0, cst, cnt) : vec4(1.0, 0.0, cst, cnt);
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
  /** largest (horizontal) box half-size of the class (m); each particle has its own box (RingLod sampler) */
  D: number;
  /** 3-D reach factor: the class is active while the camera is within cBox aHi of the layer */
  cBox: number;
  aHi: number;
  /** radius / box sampler (RingLod.pieceP / pieceB of the class; fixed per allocation) */
  pieceP: Float32Array;
  pieceB: Float32Array;
  /** particles are generated at this tau and thinned by tau(r)/tauMax (presence) */
  tauMax: number;
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
  skip = { update: false, contact: false, compact: false, points: false, quads: false, shadow: false };
  /** contact resolution of the resolved particles (NearContact.ts; `contact.enabled` toggles it) */
  contact!: NearContact;
  private contactLayoutChanged = true;

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
  /** per class: half-size of the allocated periodic particle box (m) - where instantiated particles end */
  private readonly allocDU = { value: new Float32Array(LOD_CLASSES) };
  private readonly r0U = { value: null as any };
  /** two-stream back-scatter fractions of the particle phase function: (diffuse, beam at the current mu0) */
  private readonly betaU = { value: new Vector2(0.719, 0.55) };
  /** per-frame lighting environment (uniform over the near field): (Saturn sun visibility, Saturnshine
   *  irradiance, Saturn angular radius, 1 = evaluate moon shadows per particle) */
  private readonly envU = { value: new Vector4(1, 0, 0.48, 0) };
  /** (fraction of the layer column above the camera height, -, -, -) */
  private readonly env2U = { value: new Vector4(0.5, 0, 0, 0) };
  private readonly satDirU = { value: new Vector3(-1, 0, 0) };
  // particle surface relief (nearRelief, nearCommon.glsl): noise textures (value + gradient; value-only R16F
  // copies for the ray march and the shadow-outline profiles), the value ranges of their texels and the bounds of
  // their interpolated gradients (1% / 2% margins for the half-float rounding of the value-only copies)
  private readonly noiseU = { value: buildNearNoise() };
  private readonly clastU = { value: buildNearClasts() };
  private readonly noiseVU = { value: buildValueTexture(nearNoiseData(), NOISE_N) };
  private readonly clastVU = { value: buildValueTexture(nearClastData(), CLAST_N) };
  private readonly reliefU = { value: (() => {
    const c = valueRange(nearClastData()), n = valueRange(nearNoiseData());
    return new Vector4(c[0] * 1.01, c[1] * 1.01, n[0] * 1.01, n[1] * 1.01);
  })() };
  private readonly reliefGradU = { value: new Vector2(
    1.02 * gradientBound(nearNoiseData(), NOISE_N, NOISE_P), 1.02 * gradientBound(nearClastData(), CLAST_N, CLAST_P),
  ) };
  // regolith photometry of resolved particles: per-particle factor LUT (NearRegolith.ts) and the relief's
  // photometric correction table (NearRelief.ts RELIEF_PHOT)
  private readonly regolithU = { value: regolithTable().lut };
  private readonly reliefPhotU = { value: reliefPhotUniform() };
  private readonly regolithLutU = { value: new Vector4(REGOLITH_LUT_NA, REGOLITH_LUT_NALB, REGOLITH_A0, REGOLITH_A1) };
  /** render fidelity (settings.particleQuality): 0 low, 1 medium, 2 high */
  private readonly qualityU = { value: 2 };

  // stats
  private frame = 0;
  private readback: { pbo: WebGLBuffer; fence: WebGLSync; wait: number } | null = null;
  private readBuf = new Float32Array(4);
  /** last read-back list sizes: (opaque sprites, quads, shadow casters, blended dots) */
  private listCounts = [0, 0, 0, 0];

  init(ctx: PipelineContext): void {
    this.ctx = ctx;
    this.shadow = new NearShadow();
    // later passes (the astronaut) receive the particles' shadows from the same map
    ctx.nearShadow = { uniforms: { ...this.shadow.uniforms, uNearAllocD: this.allocDU }, frame: -1, prepare: (r) => this.shadow.prepare(r) };
    const sh = {
      ...ctx.shared.u, ...this.shadow.uniforms, uNearQuality: this.qualityU,
      tNearNoise: this.noiseU, tNearClast: this.clastU, tNearNoiseV: this.noiseVU, tNearClastV: this.clastVU,
      uNearRelief: this.reliefU, uNearReliefGrad: this.reliefGradU,
      tRegolithF: this.regolithU, uRegolithLut: this.regolithLutU, uNearReliefPhot: this.reliefPhotU,
    };
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
        uRadP: { value: new Float32Array(LOD_PIECES * 4) },
        uRadB: { value: new Float32Array(LOD_PIECES * 4) },
        uSig: { value: new Vector2(1, 1) },
        uCamOff: { value: new Vector2() },
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
        uRadP: { value: new Float32Array(LOD_PIECES * 4) },
        uRadB: { value: new Float32Array(LOD_PIECES * 4) },
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
    // (the particles' shadow lookups use the relief-profiled caster outlines; the astronaut's the plain ellipses)
    // RS_LIGHT_ONLY: the draw only does lighting lookups (sv_ringStructure LIGHT modulation), so the modulation's code
    // and sampler stay out of this program, which is at the 16 texture units ANGLE/Metal allows
    const lightOnly = '#define RS_LIGHT_ONLY\n';
    const vs = lightOnly + common + listGlsl + NEAR_SHADOW_PROFILE_GLSL + NEAR_SHADOW_LOOKUP_GLSL + nearDrawVert;
    const fs = lightOnly + common + NEAR_SHADOW_PROFILE_GLSL + NEAR_SHADOW_LOOKUP_GLSL + nearDrawFrag;
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
          uNearAllocD: this.allocDU,
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
      common + listGlsl + 'uniform float uClsSpinW[LOD_CLASSES];\n' + NEAR_SHADOW_PROFILE_GLSL + NEAR_SHADOW_CASTER_VS,
      common + NEAR_SHADOW_PROFILE_GLSL + NEAR_SHADOW_CASTER_FS,
      { ...sh, ...tables(), ...this.pyr.uniforms(), uClsSpinW: this.clsSpinW },
    );
    const cg = new BufferGeometry();
    cg.setDrawRange(0, 0);
    this.casters = new Points(cg, this.shMat);
    this.casters.frustumCulled = false;
    this.contact = new NearContact(common, sh, tables(), this.clsSpinW, this.pyr);

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
      this.classes.push({
        k, slots: 0, row0: 0, rows: 0, seed: 1, D: 1, cBox: 1, aHi: 0.02, tauMax: 1,
        pieceP: new Float32Array(LOD_PIECES * 4), pieceB: new Float32Array(LOD_PIECES * 4),
        c0x: 0, c0y: 0, tRef: 0, tE: 0, cur: 0, needsInit: true, active: false,
      });
    }
  }

  // ------------------------------------------------------------------ allocation
  private reallocate(lod: RingLod, f: FrameState): void {
    let row = 0;
    let total = 0;
    const anchorChanged = f.ring.anchorId !== this.anchorId;
    // largest particles first: the compacted lists follow texture order, so if a list is ever truncated
    // (stale draw cap for a frame) only the smallest particles are affected; classes added or dropped as the
    // camera height changes are the small ones at the end, so the larger ones keep their rows
    const np = LOD_PIECES * 4;
    for (let k = LOD_CLASSES - 1; k >= 0; k--) {
      const c = this.classes[k];
      const slots = Math.max(0, lod.slots[k]);
      // generation tau: the integer slot count is ceil(count), so the presence threshold is scaled to keep the
      // expected number of particles exact
      const tauMax = slots > 0 ? Math.max((lod.tauMax[k] * slots) / lod.count[k], 1e-6) : 1;
      const seed = hashSeed(f.ring.anchorId * 131, k + 1);   // deterministic per anchor and class
      const pP = lod.pieceP.subarray(k * np, (k + 1) * np), pB = lod.pieceB.subarray(k * np, (k + 1) * np);
      // a class whose allocation is unchanged keeps its particles exactly (its state rows are kept / copied)
      let same = !anchorChanged && !c.needsInit && slots > 0 && c.slots === slots && c.row0 === row && c.D === lod.box[k] &&
        c.tauMax === tauMax && c.seed === seed;
      for (let i = 0; same && i < np; i++) same = c.pieceP[i] === pP[i] && c.pieceB[i] === pB[i];
      c.slots = slots;
      c.rows = Math.ceil(c.slots / TEX_W);
      c.row0 = row;
      row += c.rows;
      total += c.slots;
      // each particle's own periodic box (horizontal reach to the handover band): nothing is simulated where it
      // can't be drawn
      c.D = lod.box[k];
      c.cBox = lod.cAlloc;
      c.aHi = lod.aHi[k];
      c.pieceP.set(pP);
      c.pieceB.set(pB);
      c.tauMax = tauMax;
      // the shadow map's statistical complement: where the class's instantiated particles end (cross-section
      // weighted: the box of a particle of radius aEff)
      this.allocDU.value[k] = slots > 0 ? Math.min(lod.boxOf(k, lod.aEff[k]), c.D) : 0;
      c.seed = seed;
      if (!same) c.needsInit = true;
    }
    this.totalSlots = total;
    const need = Math.max(row, 1);
    if (need > this.texRows) {
      const rows = Math.ceil((need * 1.1 + 16) / 64) * 64;
      const oldState = this.stateRT;
      this.r0RT?.dispose();
      this.r0RT = makeSlotRT(rows, true);
      this.stateRT = [makeSlotRT(rows, false), makeSlotRT(rows, false)];
      // classes that keep their particles: copy their state rows into the new textures
      for (const c of this.classes) if (!c.needsInit && c.rows > 0 && oldState.length) this.copyRows(oldState[c.cur], this.stateRT[c.cur], c.row0, c.rows);
      for (const s of oldState) s.dispose();
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
    this.contactLayoutChanged = true;
  }
  private capStale = true;

  private copyMesh: Mesh | null = null;
  /** copy rows [row0, row0 + rows) of a slot texture into another one (same rows) */
  private copyRows(src: WebGLRenderTarget, dst: WebGLRenderTarget, row0: number, rows: number): void {
    if (!this.copyMesh) {
      const m = new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: FS_VERT,
        fragmentShader: /* glsl */ `
          precision highp float; precision highp sampler2D;
          uniform sampler2D tSrc; layout(location = 0) out vec4 o;
          void main() { o = texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0); }`,
        uniforms: { tSrc: { value: null } },
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
      });
      this.copyMesh = new Mesh(fullscreenGeometry(), m);
      this.copyMesh.frustumCulled = false;
    }
    const r = this.ctx.renderer;
    (this.copyMesh.material as RawShaderMaterial).uniforms.tSrc.value = src.texture;
    dst.viewport.set(0, row0, TEX_W, rows);
    r.setRenderTarget(dst);
    r.render(this.copyMesh, fsCamera);
    dst.viewport.set(0, 0, dst.width, dst.height);
  }

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
    // the camera's height above the local mid-plane (vertical relief: f.ring.zMid)
    const camZ = cam.z - ring.zMid;
    this.frame++;
    // render fidelity only: the particle field (count, positions, sizes) is independent of it
    const qs = f.settings.particleQuality;
    this.qualityU.value = qs === 'low' ? 0 : qs === 'medium' ? 1 : 2;
    this.lastCamZ = camZ;

    // --- class activity, init and re-base
    for (const c of this.classes) {
      // active while the camera is within the class's 3-D reach of the layer (its box may be clipped horizontally)
      c.active = c.slots > 0 && Math.abs(camZ) - slab < Math.min(lod.options.rMax, c.cBox * c.aHi);
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
        // (the bulk shift q Omega c0x dtE is reduced per particle, modulo its own box)
        const dtE = t - c.tE;
        this.statePass(c, 1, qO * dtE, qO * c.c0x * dtE);
        c.tE = t;
        c.cur = 1 - c.cur;
      }
      this.clsSpinW.value[c.k] = modTwoPi((ring.omega / 8) * (t - c.tRef));
    }

    // --- shadow-map geometry first: the update pass keeps every possible caster in its tube
    // (low particle quality: statistical shadows only)
    this.shadow.enabled = this.shadowsEnabled && !this.skip.shadow && this.qualityU.value > 0;
    this.shadow.reliefSlope[0] = ctx.structure.cam.slopeR;
    this.shadow.reliefSlope[1] = ctx.structure.cam.slopeT;
    this.shadowOn = this.shadow.configure(f, lod);

    // --- update pass per class -> R0
    this.lap('update');
    const u = this.updMat.uniforms;
    u.uCull.value = this.cullEnabled ? Math.min(this.cullTau, lod.cullTau) : 0;
    // 2-D ring structure: the boxes are Lagrangian (nearUpdate.glsl); the camera's Lagrangian radial offset is
    // cam.x + st.da (st.da = a' - r = -xi_cam), and the optical depth at the camera is tau0(a') J
    const st = ctx.structure.cam;
    u.uTauCam.value = ctx.profile.tauAtKm((ring.r0 + cam.x + st.da) / 1000) * st.J;
    this.fsMesh.material = this.updMat;
    for (const c of this.classes) {
      if (!c.active || this.skip.update) continue;
      const k = c.k;
      const dtE = t - c.tE, dtRef = t - c.tRef;
      u.tState.value = this.stateRT[c.cur].texture;
      u.uRow0.value = c.row0;
      u.uCount.value = c.slots;
      u.uClass.value = k;
      u.uSeed.value = c.seed;
      u.uTauBoxMax.value = c.tauMax;
      u.uRadP.value = c.pieceP;
      u.uRadB.value = c.pieceB;
      (u.uSig.value as Vector2).set(lod.sigX(k), lod.sigZ(k));
      // camera offset from the box reference (radially: the camera's Lagrangian position) and the shear terms;
      // reduced per particle modulo its own box in the shader. F (the shear phase of the copies) is exact in double
      // precision for any elapsed time.
      (u.uCamOff.value as Vector2).set(cam.x + st.da - c.c0x, cam.y - c.c0y);
      (u.uKin.value as Vector4).set(modTwoPi(ring.kappa * dtRef), modTwoPi(ring.nu * dtRef), ring.omega / ring.kappa, 0);
      (u.uShear.value as Vector4).set(qO * dtE, qO * c.c0x * dtE, frac(qO * dtRef), 0);
      this.updMat.uniformsNeedUpdate = true;
      const rt = this.r0RT;
      rt.viewport.set(0, c.row0, TEX_W, c.rows);
      r.setRenderTarget(rt);
      r.render(this.fsMesh, fsCamera);
    }
    this.r0RT.viewport.set(0, 0, TEX_W, this.texRows);

    // --- contact resolution among the visibly resolved particles (NearContact.ts): their non-overlapping positions
    // go back into R0 before anything reads it (draw lists, shadow casters, the astronaut's shadow lookups)
    this.lap('contact');
    if (!this.skip.update && !this.skip.contact) {
      this.contact.run({
        renderer: r, frame: f, lod, profile: ctx.profile, wakes: ctx.wakes, r0RT: this.r0RT, texRows: this.texRows,
        active: this.classes.map((c) => c.active), quality: this.qualityU.value, layoutChanged: this.contactLayoutChanged,
      });
      this.contactLayoutChanged = false;
    } else this.contact.ran = false;

    // --- compaction (the shadow-map geometry, set before the update pass, decides the caster list)
    if (!this.shadowOn) this.shadow.prepare(r);
    this.lap('compact');
    this.l1Mat.uniformsNeedUpdate = true;
    if (!this.skip.compact) this.pyr.build(r, this.l1Mat);
    this.fsMesh.material = this.updMat;

    // --- sun shadow map of the casters around the camera
    if (this.shadowOn) {
      this.shMat.uniformsNeedUpdate = true;
      this.shadow.render(r, this.casters, this.listCap(2));
      if (ctx.nearShadow) ctx.nearShadow.frame = f.frameIndex;
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
    for (const m of [this.ptMat, this.qdMat]) {
      m.uniforms.uDebug.value = f.settings.debugView;
      m.uniformsNeedUpdate = true;
    }
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
    // propeller moonlets publish their shadow spheres in PropellerMoonletPass.update (before any render):
    // moonsSunVisibility includes them, so the per-particle test lets them shadow the particles too
    if ((this.ctx.shared.u.uShadowSphN.value as number) > 0) perParticle = 1;
    // Saturnshine at the camera (Saturn as a Lambert-phase sphere of geometric albedo 0.499)
    const dc = cam.length();
    const a = Math.acos(Math.min(1, Math.max(-1, (cam.x * s.x + cam.y * s.y + cam.z * s.z) / dc)));
    const phi = (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;
    const Rm = 0.96 * Req;
    const Ess = f.solarIrradiance * SATURN.GEOMETRIC_ALBEDO * ((Rm * Rm) / (dc * dc)) * phi;
    (this.envU.value as Vector4).set(vis, Ess, Math.asin(Math.min(1, Req / dc)), perParticle);
    (this.satDirU.value as Vector3).set(-cam.x / dc, -cam.y / dc, -cam.z / dc);
    // fraction of the layer's optical depth above the camera height (same vertical model as sv_ringLod; height above
    // the local mid-plane)
    const zc = f.ring.camLocal.z - f.ring.zMid;
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
    su.uRadP.value = c.pieceP;
    su.uRadB.value = c.pieceB;
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
      for (let i = 0; i < 4; i++) this.listCounts[i] = this.readBuf[i];
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

  private lastCamZ = 0;
  private defCache = { v: -1, z: NaN, value: 0 };
  /** visibility-weighted count deficit from the camera's current height (cached) */
  visibleDeficit(): number {
    const lod = this.ctx?.lod;
    if (!lod || lod.deficit <= 0) return 0;
    const dc = this.defCache;
    if (dc.v !== lod.allocVersion || !(Math.abs(this.lastCamZ - dc.z) <= 0.05 * Math.abs(dc.z) + 0.5)) {
      dc.v = lod.allocVersion;
      dc.z = this.lastCamZ;
      dc.value = lod.visibleDeficit(this.lastCamZ);
    }
    return dc.value;
  }

  stats(): Record<string, string | number> {
    const per: string[] = [];
    for (const c of this.classes) if (c.active) per.push(`${c.k}:${fmtCount(c.slots)}`);
    const lod = this.ctx?.lod;
    const boxes: string[] = [];
    if (lod) for (let k = 0; k < LOD_CLASSES; k++) if (lod.slots[k] > 0 && (k % 2 === 0 || k === LOD_CLASSES - 1)) boxes.push(`${fmtSize(lod.aLo[k])}:${fmtDist(lod.box[k])}`);
    const def = this.visibleDeficit();
    return {
      // particles >= 1 display px across in view (not statistically occluded): all drawn, whatever the render
      // scale; rasterized: sprites + quads incl. the handover band (below half a render pixel, coverage-exact
      // discs with probability (rho / 0.5)^2: the render scale only changes how they are rasterized)
      drawn: `${fmtCount(this.listCounts[3])} ≥1 px (${fmtCount(this.listCounts[0] + this.listCounts[1])} rasterized, ${fmtCount(this.listCounts[1])} large)`,
      count: def > 1e-3
        ? `DEFICIT: ~${(def * 100).toFixed(def < 0.1 ? 1 : 0)}% of the visible particles ≥1 px missing (slot cap: boxes clipped at ${fmtDist(lod!.capRadius)})`
        : lod && lod.deficit > 1e-3
          ? `complete: every visible particle ≥1 px across (boxes clipped at ${fmtDist(lod.capRadius)}, beyond what the layer lets you see)`
          : 'complete: every particle ≥1 px across',
      // dense rings: the allocation is fitted to the camera height (re-fitted outside the band); the slot cap may
      // have cut the zoom-in headroom (re-fitted when zooming in beyond it)
      allocated: `${fmtCount(this.totalSlots)} slots` + (lod?.heightBand
        ? ` (for heights ${fmtDist(lod.heightBand[0])}–${fmtDist(lod.heightBand[1])}, zoom-in headroom ${lod.marginEff.toFixed(2)}×)`
        : ''),
      boxes: boxes.join(' '),
      shadowCasters: fmtCount(this.listCounts[2]),
      // resolved particles pushed apart where their analytic positions overlap (NearContact.ts)
      contact: this.contact ? this.contact.stats() : 'off',
      classes: per.join(' '),
    };
  }

  dispose(): void {
    this.r0RT?.dispose();
    for (const s of this.stateRT) s.dispose();
    this.contact?.dispose();
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
function fmtSize(a: number): string {
  return a < 0.01 ? `${(a * 1000).toFixed(a < 0.002 ? 1 : 0)}mm` : a < 1 ? `${(a * 100).toFixed(0)}cm` : `${a.toFixed(1)}m`;
}
function fmtDist(d: number): string {
  return !Number.isFinite(d) ? '∞' : d < 1000 ? `${d.toFixed(d < 10 ? 1 : 0)}m` : `${(d / 1000).toFixed(1)}km`;
}
