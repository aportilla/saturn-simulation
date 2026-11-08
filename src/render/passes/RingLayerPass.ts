// Ring-layer pass: the ring material as a continuous scattering medium at every scale.
//
//   far field   physically based thin sheet (single scattering + interparticle shadow hiding +
//               two-stream multiple scattering), lit and unlit faces, Saturnshine on both faces,
//               Saturn/moon shadows, granola-bar self-gravity wakes (azimuthal asymmetry, viewing-angle
//               dependent transmission), spokes, exact footprint prefiltering.
//   (both)      every profile lookup goes through the shared 2-D ring structure (sv_ringStructure, ctx.structure):
//               streamline map of the moonlet-perturbed Encke / Keeler gap edges (Pan, Daphnis).
//   near field  ray march through the particle slab with the same radiative transfer, explicit wake
//               density W(x,y) (clipmap), wake self-shadowing, carrying only the optical depth NOT drawn
//               as discrete near-field particles (sv_ringLod `ringExtinction` sigUnres).
//   outer rings F (eccentric, inclined, precessing; core/strands/clumps/Prometheus channels), G (+arc),
//               Janus/Epimetheus, E (dust torus around Enceladus' orbit).
//
// Reads ctx.sceneRT (rgb radiance, a = distance), writes ctx.hdrRT = scene * T + L.
// Shaders: src/render/rings/*.glsl. CPU helpers: src/render/rings/*.ts.
//
// Per frame: (0) every STAT_EVERY frames (and on re-anchoring) the live wake field is probed: the window mean of
// the shared wakeDensity (a check: ~1), the sheet's two-column summary and the path statistics of its
// transmission model, (1) wake-density clipmap levels that went stale are refreshed (usually none), (2) the
// vertical-structure LUT (shared sv_ringLod contract) is regenerated, (3) near / inside the layer the
// slab is ray-marched at half resolution, (4) the full-resolution pass composites everything; pixels
// whose opaque object (a near-field particle) lies inside the slab march themselves up to it.
// Particle phase function: power law (Dones et al. 1993) by default — see `phaseModel`.
import {
  ClampToEdgeWrapping, FloatType, HalfFloatType, LinearFilter, NearestFilter, RGBAFormat, Vector2, Vector4, WebGLRenderTarget,
} from 'three';
import type { FrameState } from '../../core/FrameState';
import type { PipelineContext, RenderPass } from '../Pipeline';
import { FullscreenPass } from '../fullscreen';
import { SV_HEADER_ALL } from '../shaders/chunks';
import { DEG, orbitalFrequencies } from '../../core/constants';
import { OUTER_RINGS } from '../../rings/ringRegions';
import { phaseTables, PHASE_POWER_N } from '../rings/phase';
import { TauPyramid } from '../rings/TauPyramid';
import { WakeClipmap, WAKE_CLIP_N } from '../rings/WakeClipmap';
import type { RingStructure } from '../../rings/RingStructure';
import rlOptics from '../rings/rlOptics.glsl?raw';
import rlSheet from '../rings/rlSheet.glsl?raw';
import rlOuter from '../rings/rlOuter.glsl?raw';
import rlMarch from '../rings/rlMarch.glsl?raw';
import rlMain from '../rings/rlMain.glsl?raw';

// Vertical-structure LUT: the shared sv_ringLod contract evaluated on a (u = z/H, log10 s) grid.
// R = H sigTot / tau, G = H sigUnres / tau (both exact: the class pdfs scale as 1/H), B = column fraction
// above z. Regenerated every frame (pixel angle and LOD state change it); 16k texels.
const LUT_NU = 256, LUT_NS = 64;
const LUT_P = new Vector4(-2.5, 5 / (LUT_NU - 1), -2, 7 / (LUT_NS - 1));
const LUT_FRAG = /* glsl */ `
${SV_HEADER_ALL}
uniform vec4 uP;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float u = uP.x + float(p.x) * uP.y;
  float s = pow(10.0, uP.z + float(p.y) * uP.w);
  float H = 10.0;
  float st, su;
  ringExtinction(s, u * H, 1.0, H, 1.0, st, su);
  outColor = vec4(st * H, su * H, ringLayerTauBeyond(u * H, 1.0, H, 1.0), 0.0);
}`;

// Wake statistics probe: the shared wakeDensity on a STAT_N x STAT_N grid spanning one wake tile.
// Read back every STAT_EVERY frames (and on re-anchoring) to give the far-field sheet the statistics of the field the
// near-field march and particles use (two-column summary, see rlSheet.glsl) and as a check of wakeDensity's mass: its
// window mean (stats `wakeMean`) is 1 within the window's sampling noise (~+-2 % over one tile). wakeDensity inverts
// the particles' map (sv_wakes), so no correction is applied (the former single-branch inverse lacked ~10 % of the
// mass, restored by a measured factor uWakeMassK ~ 1.24 on the dense part; removed Nov 2026).
const STAT_N = 64, STAT_EVERY = 60;
const STAT_FRAG = /* glsl */ `
${SV_HEADER_ALL}
uniform vec4 uP;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 xy = uP.xy + (gl_FragCoord.xy + vec2(0.37, 0.71)) * uP.z;
  outColor = vec4(wakeDensity(xy), 0.0, 0.0, 1.0);
}`;

// Path statistics probe (with the wake statistics): for KER_N x KER_N points over one wake tile and each across-crest
// run chi = KER_X[i] (horizontal run across the crests over one layer thickness H, in wake spacings), the wake density
// averaged along a straight path through the whole layer -- the vertical profile's KER_Z stratified nodes (sv_ringLod
// column centroids), offset by chi * lambda * z / H along the wake normal. Per column class of the path's mid-plane
// point (W > 1: dense wake, else gap) the mean and variance of that path density give the statistical transmission
// (Gamma model, rlSheet.glsl rlTransG): exact to a few % against the transmission of explicit paths, where carrying
// the class mean alone (2-column model) underestimated it by up to 2x across the wakes.
const KER_N = 32, KER_Z = 16;
export const KER_X = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.25, 3.5, 5.0];
const KER_FRAG = /* glsl */ `
${SV_HEADER_ALL}
uniform vec4 uP;     // (x0, y0, point spacing, lambda) in the local frame (m)
uniform vec2 uN;     // unit wake normal (local x, y)
uniform float uX[${KER_X.length}];
layout(location = 0) out vec4 outColor;
void main() {
  int ix = int(gl_FragCoord.x);
  vec2 cell = vec2(float(ix % ${KER_N}), floor(gl_FragCoord.y));
  vec2 xy = uP.xy + (cell + vec2(0.37, 0.71)) * uP.z;
  float run = uX[ix / ${KER_N}] * uP.w;
  float acc = 0.0;
  for (int j = 0; j < ${KER_Z}; j++) {
    float z = ringColumnCentroid(float(j) / ${KER_Z}.0, float(j + 1) / ${KER_Z}.0);
    acc += wakeDensity(xy + uN * (run * z));
  }
  outColor = vec4(acc / ${KER_Z}.0, wakeDensity(xy), 0.0, 1.0);
}`;

const FRAG_BODY = [SV_HEADER_ALL, `#define RL_KER_NX ${KER_X.length}`, rlOptics, rlSheet, rlOuter, rlMarch, rlMain].join('\n');
const FRAG = '#define RL_USE_LOW\n' + FRAG_BODY;
const FRAG_LOW = '#define RL_LOWRES\n' + FRAG_BODY;

const DAY = 86_400;
const N_SPOKES = 12;
const F_VARPI0 = 24.1 * DEG; // Bosh et al. 2002, epoch J2000
const F_VARPI_RATE = 2.7001 * DEG; // per day
const F_NODE0 = 16.1 * DEG;
const F_NODE_RATE = -2.6876 * DEG; // per day
const G_ARC_RATE = 445.4757 * DEG; // per day (Mimas 7:6 corotation eccentricity resonance; Hedman et al. 2007)
const G_ARC_LON0 = 0; // epoch longitude unknown here (placeholder)

function hash01(a: number, b: number): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x27d4eb2f, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
function modTwoPi(x: number): number {
  const t = 2 * Math.PI;
  return x - Math.floor(x / t) * t;
}

export class RingLayerPass implements RenderPass {
  readonly name = 'rings';
  enabled = true;
  private fs!: FullscreenPass;
  private lowFs!: FullscreenPass;
  private lowRT!: WebGLRenderTarget;
  private lutFs!: FullscreenPass;
  private lutRT!: WebGLRenderTarget;
  private statFs!: FullscreenPass;
  private statRT!: WebGLRenderTarget;
  private statBuf = new Float32Array(STAT_N * STAT_N * 4);
  private kerFs!: FullscreenPass;
  private kerRT!: WebGLRenderTarget;
  private kerBuf = new Float32Array(KER_N * KER_X.length * KER_N * 4);
  /** per KER_X entry: class-conditional path density through the layer (mean dense, var dense, mean gap, var gap) */
  private kerT = KER_X.map(() => new Vector4(1, 0, 1, 0));
  /** per KER_X entry: class minimum of that path density (dense, gap) */
  private kerF = KER_X.map(() => new Vector2(1, 1));
  private statFrame = 0;
  /** last measured wake statistics: fB, Wb, Wg and the profile wake value they refer to (0 = none) */
  private wakeStat = new Vector4(0.33, 2.0, 0.5, 0);
  /** march the near field at half resolution (depth-aware upsampling); set false for full resolution */
  halfRes = true;
  /** peak spoke dust optical depth (Cassini: ~0.01-0.1 in the visible) */
  spokeTau = 0.06;
  private structure: RingStructure | null = null;
  /**
   * Multiplier on the moonlet streamline amplitudes (1 = physical, 0 = straight edges, > 1 for inspection; above
   * ~1.5 the map may fold, J is then clamped). Forwards to the shared RingStructure: every renderer (sheet, march,
   * near-field particles, astronaut) sees the same map.
   */
  get edgeWaveScale(): number {
    return this.structure?.edgeWaveScale ?? 1;
  }
  set edgeWaveScale(v: number) {
    if (this.structure) this.structure.edgeWaveScale = v;
  }
  private lowActive = false;
  private pyr!: TauPyramid;
  private wake!: WakeClipmap;
  private u!: Record<string, { value: any }>;
  private spokes: Vector4[] = [];
  private nF = 0;
  private nProm = 0;
  private lastMode = 'far';
  private lastLevels = 0;

  /**
   * Particle phase-function model: 1 = power law (photometrically calibrated, default; identical to the
   * shared ringPhase / ringParticlePhase in lighting.glsl, which near-field particles also follow),
   * 0 = Lambert sphere (diagnostics only). Set before init().
   */
  phaseModel = 1;

  init(ctx: PipelineContext): void {
    const pt = phaseTables(this.phaseModel);
    this.structure = ctx.structure;
    this.pyr = new TauPyramid(ctx.profile);
    this.wake = new WakeClipmap(ctx);
    this.lutRT = new WebGLRenderTarget(LUT_NU, LUT_NS, {
      type: FloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping, wrapT: ClampToEdgeWrapping, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.lutFs = new FullscreenPass({ fragmentShader: LUT_FRAG, uniforms: { ...ctx.shared.u, uP: { value: LUT_P } } });
    this.statRT = new WebGLRenderTarget(STAT_N, STAT_N, {
      type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.statFs = new FullscreenPass({ fragmentShader: STAT_FRAG, uniforms: { ...ctx.shared.u, uP: { value: new Vector4() } } });
    this.kerRT = new WebGLRenderTarget(KER_N * KER_X.length, KER_N, {
      type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.kerFs = new FullscreenPass({
      fragmentShader: KER_FRAG,
      uniforms: { ...ctx.shared.u, uP: { value: new Vector4() }, uN: { value: new Vector2(1, 0) }, uX: { value: KER_X } },
    });
    for (let i = 0; i < N_SPOKES; i++) this.spokes.push(new Vector4(0, 0, 1.08e8, 0));
    const wakeLev: Vector4[] = this.wake.levels;
    this.nF = orbitalFrequencies(OUTER_RINGS.F.aKm * 1000).omega;
    this.nProm = orbitalFrequencies(139_380e3).omega;
    this.u = {
      tScene: { value: ctx.sceneRT.texture },
      uRlP0: { value: this.pyr.texP0 },
      uRlP1: { value: this.pyr.texP1 },
      uRlP2: { value: this.pyr.texP2 },
      uRlPhaseLut: { value: pt.lut },
      uRlBetaM: { value: pt.betaMacro },
      uRlBetaD: { value: pt.betaDust },
      uRlSunSign: { value: -1 },
      uRlMu0: { value: 0.14 },
      uRlIdx0I: { value: 0 },
      uRlIdx0F: { value: 0 },
      uRlPhi0: { value: 0 },
      uRlShScale: { value: 1 },
      uRlCoarse: { value: this.pyr.coarsestSpacing },
      uRlPhaseModel: { value: this.phaseModel },
      uRlSSScale: { value: 1 },
      uRlMSScale: { value: 1 },
      uRlWakeScale: { value: 1 },
      uRlPhaseN: { value: PHASE_POWER_N },
      uRlPhaseC: { value: pt.powerC },
      uRlSpoke: { value: this.spokes },
      uRlSpokeAct: { value: [0, 0.06] },
      uRlWakeStat: { value: new Vector4(0.33, 2.0, 0.5, 0) },
      uRlWakeNrm: { value: new Vector2(Math.cos(21 * DEG), Math.sin(21 * DEG)) },
      uRlWakeLamRef: { value: new Vector2(40, 0) },
      uRlWakeReach: { value: 0 },
      // path decorrelation heights / H of the two-column REFLECTION (lit view, lit sun, unlit view, unlit sun);
      // checked against the reference explicit field by scripts/test/seam.mjs (handover): within ~5 % at low phase,
      // ~10-15 % at high phase / on the unlit face along the wakes (README). The transmission uses the measured
      // path statistics (uRlKerT, Gamma model).
      uRlWakeHeff: { value: new Vector4(0.8, 0.8, 0.0, 0.0) },
      uRlKerX: { value: KER_X },
      uRlKerT: { value: this.kerT },
      uRlKerF: { value: this.kerF },
      uRlKerSig: { value: 0.26 },
      uRlF: { value: new Vector4() },
      uRlF2: { value: new Vector4() },
      uRlF3: { value: new Vector4() },
      uRlProm: { value: new Vector4() },
      uRlG: { value: new Vector4() },
      uRlE: { value: new Vector4() },
      uRlDust: { value: 1 },
      uRlWakeTex: { value: this.wake.rt.texture },
      uRlWakeLev: { value: wakeLev },
      uRlWakeLevels: { value: 0 },
      uRlWakeN: { value: WAKE_CLIP_N },
      uRlLambda: { value: 60 },
      uRlHSlab: { value: 15 },
      uRlMarchMax: { value: 2.0e6 },
      uRlMaxSteps: { value: 160 },
      // tests only (rlMarch.glsl): forced wake representation / reference explicit field
      uRlForce: { value: new Vector4(0, 0, 12, 0) },
      uRlDebug: { value: 0 },
      uRlLodRange: { value: 0 },
      uRlNearOn: { value: 1 },
      uRlExtLut: { value: this.lutRT.texture },
      uRlExtLutP: { value: LUT_P },
      uRlUseLow: { value: 0 },
    };
    this.lowRT = new WebGLRenderTarget(Math.max(1, Math.ceil(ctx.width / 2)), Math.max(1, Math.ceil(ctx.height / 2)), {
      type: HalfFloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.u.tLow = { value: this.lowRT.texture };
    // shared uniforms are spread first: the shared objects are referenced (not copied). Both materials
    // share the same uniform objects.
    const uni = { ...ctx.shared.u, ...this.u };
    this.fs = new FullscreenPass({ fragmentShader: FRAG, uniforms: uni });
    this.lowFs = new FullscreenPass({ fragmentShader: FRAG_LOW, uniforms: uni });
    this.u = uni;
  }

  resize(ctx: PipelineContext): void {
    this.u.tScene.value = ctx.sceneRT.texture;
    this.lowRT.setSize(Math.max(1, Math.ceil(ctx.width / 2)), Math.max(1, Math.ceil(ctx.height / 2)));
  }

  update(f: FrameState, ctx: PipelineContext): void {
    const u = this.u;
    const t = f.t;
    const days = t / DAY;
    const sd = f.sunDir;
    u.uRlSunSign.value = sd.z >= 0 ? 1 : -1;
    u.uRlMu0.value = Math.max(Math.abs(sd.z), 1e-3);
    // precise split of the level-0 profile index of the ring-frame origin
    const prof = ctx.profile;
    const idx0 = (f.ring.r0 - prof.rMinKm * 1000) / (prof.drKm * 1000);
    const i0 = Math.floor(idx0);
    u.uRlIdx0I.value = i0;
    u.uRlIdx0F.value = idx0 - i0;
    u.uRlPhi0.value = f.ring.phi0;
    u.uRlDebug.value = f.settings.debugView | 0;
    u.uRlDust.value = f.settings.dustRings ? 1 : 0;

    // ---- slab thickness near the camera (max H over +-5 km of the camera radius)
    const rc = Math.hypot(f.camPos.x, f.camPos.y);
    const ic = Math.round((rc / 1000 - prof.rMinKm) / prof.drKm);
    let hMax = 4;
    if (ic >= -20 && ic < prof.n + 20) {
      for (let i = Math.max(0, ic - 20); i <= Math.min(prof.n - 1, ic + 20); i++) {
        if (prof.tau[i] > 0.01) hMax = Math.max(hMax, prof.H[i]);
      }
    }
    u.uRlHSlab.value = Math.min(hMax, 60);

    // ---- Prometheus (F-ring channels). The moonlet gap edges (Pan, Daphnis) are the shared streamline map
    // (ctx.structure, sv_ringStructure), updated by the pipeline before the passes.
    let promLon = 0;
    for (const m of f.moons) {
      if (m.id === 616) promLon = Math.atan2(m.pos.y, m.pos.x);
    }

    // ---- F ring
    const F = OUTER_RINGS.F;
    (u.uRlF.value as Vector4).set(F.aKm * 1e3, F.e, modTwoPi(F_VARPI0 + F_VARPI_RATE * days), Math.sin(F.incDeg * DEG));
    (u.uRlF2.value as Vector4).set(modTwoPi(F_NODE0 + F_NODE_RATE * days), modTwoPi(this.nF * t), (F.coreWidthKm * 1e3) / 2.355, F.coreTau);
    (u.uRlF3.value as Vector4).set((F.envelopeWidthKm * 1e3) / 2.355 / 2, F.envelopeTau, 0.03, 0.6);
    const chanSpacing = 2 * Math.PI * (1 - this.nF / this.nProm);
    (u.uRlProm.value as Vector4).set(promLon, chanSpacing, (-1.5 * this.nF) / (F.aKm * 1e3), (2 * Math.PI) / this.nProm);

    // ---- G ring (+ arc), E ring
    const G = OUTER_RINGS.G;
    (u.uRlG.value as Vector4).set(G.peakKm * 1e3, G.tau, G.arcTau, modTwoPi(G_ARC_LON0 + G_ARC_RATE * days));
    const E = OUTER_RINGS.E;
    (u.uRlE.value as Vector4).set(E.peakKm * 1e3, E.tau, E.scaleHeightKm * 1e3, E.rOuterKm * 1e3);

    // ---- spokes: seasonal (low solar elevation), formed near the morning ansa
    const elev = Math.abs(Math.asin(Math.min(1, Math.abs(sd.z))));
    const act = 1 - smooth(10 * DEG, 18 * DEG, elev);
    (u.uRlSpokeAct.value as number[])[0] = act;
    (u.uRlSpokeAct.value as number[])[1] = this.spokeTau;
    const sunLon = Math.atan2(sd.y, sd.x);
    for (let k = 0; k < N_SPOKES; k++) {
      const P = 3.5 * 3600 + 1013 * k;
      const ph = (k * 0.6180339 + 0.13) * P;
      const x = t + ph;
      const gen = Math.floor(x / P);
      const age = x - gen * P;
      const s1 = hash01(k, gen), s2 = hash01(k + 101, gen), s3 = hash01(k + 202, gen);
      const active = s1 < 0.75 ? 1 : 0; // some slots stay empty
      this.spokes[k].set(sunLon - Math.PI / 2 + (s2 - 0.5) * 0.9, active ? age : -1, 1.03e8 + 1.0e7 * s3, s1);
    }

    // ---- wakes / near field
    // (Math.max propagates NaN: sanitize the shared WakeField's wavelength before it reaches log2 / shaders)
    const lam0 = ctx.wakes.lambda;
    const lambda = Number.isFinite(lam0) && lam0 > 0 ? Math.max(lam0, 20) : 60;
    u.uRlLambda.value = lambda;
    const wakesOn = (ctx.wakes.uniforms.uWakeOn.value as number) > 0.5 && f.settings.wakes;
    // the camera's height above the local mid-plane (vertical relief)
    const nearZ = Math.abs(f.ring.camLocal.z - f.ring.zMid);

    // ---- statistics of the live wake field (GPU probe, every STAT_EVERY frames and on re-anchoring): the far-field
    // sheet's two-column summary (seamless march -> sheet handover) and the window mean of wakeDensity (a check)
    const wf = ctx.wakes;
    let nx = 0, ny = 0;
    for (let g = 0; g < 2; g++) {
      const a = wf.genAmplitude(g);
      wf.genNormal(g, this.tmpN);
      nx += a * this.tmpN.x;
      ny += a * this.tmpN.y;
    }
    const nn = Math.hypot(nx, ny);
    if (nn > 1e-6) (u.uRlWakeNrm.value as Vector2).set(nx / nn, ny / nn);
    const ia = Math.round((f.ring.r0 / 1000 - prof.rMinKm) / prof.drKm);
    const sigA = ia >= 0 && ia < prof.n ? prof.sigma[ia] : 0;
    (u.uRlWakeLamRef.value as Vector2).set(lambda, wf.strength > 1e-3 && Number.isFinite(sigA) ? sigA : 0);
    const wakeRef = ia >= 0 && ia < prof.n ? prof.wake[ia] : 0;
    const live = wakesOn && wf.strength > 1e-3 && wakeRef > 1e-3;
    if (live && (this.statFrame++ % STAT_EVERY === 0 || f.ring.anchorId !== this.statAnchor)) {
      (this.statFs.material.uniforms.uP.value as Vector4).set(f.ring.camLocal.x, f.ring.camLocal.y, wf.tile / STAT_N, 0);
      (this.kerFs.material.uniforms.uP.value as Vector4).set(f.ring.camLocal.x, f.ring.camLocal.y, wf.tile / KER_N, lambda);
      (this.kerFs.material.uniforms.uN.value as Vector2).copy(u.uRlWakeNrm.value as Vector2);
      this.statAnchor = f.ring.anchorId;
      this.measureWakeStats(ctx, wakeRef);
    }
    // rms height of the layer's column in units of H (the sv_ringLod Gaussian mixture: sum w s^2 / sum w)
    {
      const lod = ctx.lod;
      let w2 = 0, wt = 0;
      for (let k = 0; k < lod.tauFrac.length; k++) if (lod.tauFrac[k] > 0) { w2 += lod.tauFrac[k] * lod.sigZFrac[k] ** 2; wt += lod.tauFrac[k]; }
      if (lod.tauSub > 0) { w2 += lod.tauSub * lod.sigZFracSub ** 2; wt += lod.tauSub; }
      u.uRlKerSig.value = wt > 0 ? Math.sqrt(w2 / wt) : 0.3;
    }
    const useClip = this.wake.configure(f, lambda, f.ring.omega, wakesOn && nearZ < 1e5);
    u.uRlWakeLevels.value = useClip ? this.wake.levelCount : 0;
    // reach of the explicit field (half the coarsest level's cover): the statistics use the anchor's wavelength in it
    u.uRlWakeReach.value = useClip && this.wake.levelCount > 0 ? 0.5 * WAKE_CLIP_N * this.wake.d0 * 2 ** (this.wake.levelCount - 1) : 0;
    // march (subtracting the near field's optical depth) where the near field carries >= 0.5% of the layer's
    // tau; beyond that the drawn particles (rare boulders >= 1 px out to ~10-30 km) are few enough for the sheet
    const lodRange = ctx.lod.active ? ctx.lod.carryRange(0.005) : 0;
    u.uRlLodRange.value = lodRange;
    u.uRlNearOn.value = nearZ < 2e5 ? 1 : 0;
    this.lastLevels = this.wake.levelCount;
    const inside = nearZ < ringSlabHalf(u.uRlHSlab.value as number);
    const marching = nearZ < 2e5 && (inside || useClip || lodRange > 0);
    // well above the layer the slab is crossed in a few steps -> full resolution keeps the wake detail;
    // close to / inside the layer (long, many-step rays) march at half resolution -- unless the frame itself
    // is already rendered at reduced scale (0.5 = a quarter of the display pixels): a further 2x2 reduction
    // turned the wakes into blocks of 4x4 display px for no saving over the full-scale configuration
    const renderScale = f.pixelAngle > 0 ? f.canvasPixelAngle / f.pixelAngle : 1;
    this.lowActive = this.halfRes && marching && nearZ < 300 && renderScale > 0.7;
    u.uRlUseLow.value = this.lowActive ? 1 : 0;
    this.lastMode = inside ? 'inside' : marching ? 'near' : 'far';

    // with wakes switched off the explicit field is flat -> no statistical wakes either
    const ws = u.uRlWakeStat.value as Vector4;
    if (wakesOn) ws.copy(this.wakeStat);
    else ws.set(0, 1, 1, 0);
  }
  private statAnchor = -1;
  /** window mean of wakeDensity at the last probe (a check of its mass: ~1) */
  private wakeMean = 1;
  private readonly tmpN = new Vector2();

  /**
   * Measure the live wake field (GPU probe of wakeDensity over one wake tile + read-back): its window mean (check) and
   * the two-column summary fB, Wb, Wg of the sheet.
   */
  private measureWakeStats(ctx: PipelineContext, wakeRef: number): void {
    this.statFs.render(ctx.renderer, this.statRT);
    ctx.renderer.readRenderTargetPixels(this.statRT, 0, 0, STAT_N, STAT_N, this.statBuf);
    const buf = this.statBuf, n = STAT_N * STAT_N;
    let s = 0, m = 0;
    for (let i = 0; i < n; i++) {
      const w = buf[i * 4];
      if (!Number.isFinite(w)) continue;
      s += w;
      m++;
    }
    if (m === 0) return;
    this.wakeMean = s / m;
    let sb = 0, nb = 0, sg = 0, ng = 0;
    for (let i = 0; i < n; i++) {
      const w = buf[i * 4];
      if (!Number.isFinite(w)) continue;
      if (w > 1) { sb += w; nb++; } else { sg += w; ng++; }
    }
    if (nb === 0 || ng === 0) return;
    const fB = nb / (nb + ng);
    let Wb = sb / nb, Wg = sg / ng;
    const mean = fB * Wb + (1 - fB) * Wg;
    Wb /= mean;
    Wg /= mean;
    this.wakeStat.set(fB, Wb, Wg, wakeRef);
    (this.u.uRlWakeStat.value as Vector4).copy(this.wakeStat);

    // path statistics through the layer
    this.kerFs.render(ctx.renderer, this.kerRT);
    const kb = this.kerBuf, NX = KER_X.length, W = KER_N * NX;
    ctx.renderer.readRenderTargetPixels(this.kerRT, 0, 0, W, KER_N, kb);
    for (let i = 0; i < NX; i++) {
      let s0 = 0, n0 = 0, sb1 = 0, sb2 = 0, cb = 0, sg1 = 0, sg2 = 0, cg = 0, fb = Infinity, fg = Infinity;
      for (let y = 0; y < KER_N; y++) {
        for (let x = 0; x < KER_N; x++) {
          const o = (y * W + i * KER_N + x) * 4;
          const wk = kb[o], w0 = kb[o + 1];
          if (!Number.isFinite(wk) || !Number.isFinite(w0)) continue;
          s0 += w0; n0++;
          if (w0 > 1) { sb1 += wk; sb2 += wk * wk; cb++; fb = Math.min(fb, wk); } else { sg1 += wk; sg2 += wk * wk; cg++; fg = Math.min(fg, wk); }
        }
      }
      if (cb === 0 || cg === 0) continue;
      const m0 = s0 / n0;   // normalization of the point density (as the two-column summary)
      const mb = sb1 / cb, mg = sg1 / cg;
      this.kerT[i].set(mb / m0, Math.max(sb2 / cb - mb * mb, 0) / (m0 * m0), mg / m0, Math.max(sg2 / cg - mg * mg, 0) / (m0 * m0));
      this.kerF[i].set(fb / m0, fg / m0);
    }
  }

  render(_f: FrameState, ctx: PipelineContext): void {
    this.wake.render(ctx.renderer);
    if ((this.u.uRlNearOn.value as number) > 0.5) this.lutFs.render(ctx.renderer, this.lutRT);
    this.u.tScene.value = ctx.sceneRT.texture;
    if (this.lowActive) this.lowFs.render(ctx.renderer, this.lowRT);
    this.fs.render(ctx.renderer, ctx.hdrRT);
  }

  stats(): Record<string, string | number> {
    return {
      mode: this.lastMode,
      wakeMean: this.wakeMean.toFixed(3),
      wakeLev: this.lastLevels,
      wakeD0: this.wake && this.wake.levelCount > 0 ? this.wake.d0.toFixed(2) : '-',
      lambda: (this.u?.uRlLambda.value as number)?.toFixed(1) ?? '',
      wakeStat: this.wakeStat.w > 0 ? `fB ${this.wakeStat.x.toFixed(2)} Wb ${this.wakeStat.y.toFixed(2)} Wg ${this.wakeStat.z.toFixed(2)}` : '-',
      sunElev: ((Math.asin(this.u?.uRlMu0.value ?? 0) / DEG) * (this.u?.uRlSunSign.value ?? 1)).toFixed(2),
    };
  }

  dispose(): void {
    this.fs.dispose();
    this.lowFs.dispose();
    this.lowRT.dispose();
    this.lutFs.dispose();
    this.lutRT.dispose();
    this.statFs.dispose();
    this.statRT.dispose();
    this.kerFs.dispose();
    this.kerRT.dispose();
    this.pyr.dispose();
    this.wake.dispose();
  }
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
function ringSlabHalf(H: number): number {
  return 1.6 * H + 0.5;
}
