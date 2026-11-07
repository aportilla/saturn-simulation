// Ring-layer pass: the ring material as a continuous scattering medium at every scale.
//
//   far field   physically based thin sheet (single scattering + interparticle shadow hiding +
//               two-stream multiple scattering), lit and unlit faces, Saturnshine on both faces,
//               Saturn/moon shadows, granola-bar self-gravity wakes (azimuthal asymmetry, viewing-angle
//               dependent transmission), spokes, moonlet edge waves, exact footprint prefiltering.
//   near field  ray march through the particle slab with the same radiative transfer, explicit wake
//               density W(x,y) (clipmap), wake self-shadowing, carrying only the optical depth NOT drawn
//               as discrete near-field particles (sv_ringLod `ringExtinction` sigUnres).
//   outer rings F (eccentric, inclined, precessing; core/strands/clumps/Prometheus channels), G (+arc),
//               Janus/Epimetheus, E (dust torus around Enceladus' orbit).
//
// Reads ctx.sceneRT (rgb radiance, a = distance), writes ctx.hdrRT = scene * T + L.
// Shaders: src/render/rings/*.glsl. CPU helpers: src/render/rings/*.ts.
//
// Per frame: (1) wake-density clipmap levels that went stale are refreshed (usually none), (2) the
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
import rlOptics from '../rings/rlOptics.glsl?raw';
import rlSheet from '../rings/rlSheet.glsl?raw';
import rlOuter from '../rings/rlOuter.glsl?raw';
import rlMarch from '../rings/rlMarch.glsl?raw';
import rlMain from '../rings/rlMain.glsl?raw';

const FRAG_BODY = [SV_HEADER_ALL, rlOptics, rlSheet, rlOuter, rlMarch, rlMain].join('\n');
const FRAG = '#define RL_USE_LOW\n' + FRAG_BODY;
const FRAG_LOW = '#define RL_LOWRES\n' + FRAG_BODY;

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
// Read back every STAT_EVERY frames to give the far-field sheet the statistics of the field the
// near-field march and particles use (two-column summary, see rlSheet.glsl).
const STAT_N = 32, STAT_EVERY = 60;
const STAT_FRAG = /* glsl */ `
${SV_HEADER_ALL}
uniform vec4 uP;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 xy = uP.xy + (gl_FragCoord.xy + vec2(0.37, 0.71)) * uP.z;
  outColor = vec4(wakeDensity(xy), 0.0, 0.0, 1.0);
}`;
const WAKE_M0X = 3, WAKE_M0Y = 6; // lattice mode of sv_wakes (wave normal k = (M0X + S*M0Y, M0Y))

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
  private statFrame = 0;
  private statDue = true;
  /** last measured wake statistics: fB, Wb, Wg and the profile wake value they refer to (0 = none) */
  private wakeStat = new Vector4(0.33, 2.0, 0.5, 0);
  /** march the near field at half resolution (depth-aware upsampling); set false for full resolution */
  halfRes = true;
  /** peak spoke dust optical depth (Cassini: ~0.01-0.1 in the visible) */
  spokeTau = 0.06;
  /** multiplier on the moonlet edge-wave amplitudes (1 = physical; >1 for inspection) */
  edgeWaveScale = 1;
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
      uRlFineAmp: { value: 1 },
      uRlCoarse: { value: this.pyr.coarsestSpacing },
      uRlPhaseModel: { value: this.phaseModel },
      uRlSSScale: { value: 1 },
      uRlMSScale: { value: 1 },
      uRlWakeScale: { value: 1 },
      uRlPhaseN: { value: PHASE_POWER_N },
      uRlPhaseC: { value: pt.powerC },
      uRlPan: { value: new Vector4(133_584e3, 0, 1.5e3, 0) },
      uRlDaphnis: { value: new Vector4(136_505e3, 0, 0, 0) },
      uRlSpoke: { value: this.spokes },
      uRlSpokeAct: { value: [0, 0.06] },
      uRlWakeStat: { value: new Vector4(0.33, 2.0, 0.5, 0) },
      uRlWakeNrm: { value: new Vector2(Math.cos(21 * DEG), Math.sin(21 * DEG)) },
      uRlWakeLamRef: { value: new Vector2(40, 0) },
      // calibrated against the explicit-field march (sheet/march 0.94-1.02 lit, 0.88-0.98 unlit)
      uRlWakeHeff: { value: new Vector4(0.8, 0.8, 0.0, 0.0) },
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

    // ---- moonlets & Prometheus
    const pan = u.uRlPan.value as Vector4;
    const dap = u.uRlDaphnis.value as Vector4;
    pan.w = 0;
    dap.z = 0;
    dap.w = 0;
    let promLon = 0;
    for (const m of f.moons) {
      if (m.id === 618) {
        pan.set(Math.hypot(m.pos.x, m.pos.y), Math.atan2(m.pos.y, m.pos.x), 1.5e3 * this.edgeWaveScale, 1);
      } else if (m.id === 635) {
        // Daphnis: radial waves ~1.5 km; vertical waves scale with its height above the plane (i ~ 0.0036 deg)
        const a = Math.hypot(m.pos.x, m.pos.y);
        const zmax = a * Math.sin(0.0036 * DEG);
        dap.set(a, Math.atan2(m.pos.y, m.pos.x), 1.5e3 * this.edgeWaveScale, this.edgeWaveScale * 1.2e3 * (0.35 + 0.65 * Math.min(1, Math.abs(m.pos.z) / zmax)) * (m.pos.z >= 0 ? 1 : -1));
      } else if (m.id === 616) {
        promLon = Math.atan2(m.pos.y, m.pos.x);
      }
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
    const nearZ = Math.abs(f.ring.camLocal.z);
    const useClip = this.wake.configure(f, lambda, f.ring.omega, wakesOn && nearZ < 1e5);
    u.uRlWakeLevels.value = useClip ? this.wake.levelCount : 0;
    let lodRange = 0;
    if (ctx.lod.active) for (let k = 0; k < ctx.lod.box.length; k++) lodRange = Math.max(lodRange, ctx.lod.box[k]);
    u.uRlLodRange.value = lodRange;
    u.uRlNearOn.value = nearZ < 2e5 ? 1 : 0;
    this.lastLevels = this.wake.levelCount;
    const inside = nearZ < ringSlabHalf(u.uRlHSlab.value as number);
    const marching = nearZ < 2e5 && (inside || useClip || lodRange > 0);
    // well above the layer the slab is crossed in a few steps -> full resolution keeps the wake detail;
    // close to / inside the layer (long, many-step rays) march at half resolution
    this.lowActive = this.halfRes && marching && nearZ < 300;
    u.uRlUseLow.value = this.lowActive ? 1 : 0;
    this.lastMode = inside ? 'inside' : marching ? 'near' : 'far';

    // ---- statistics of the explicit wake field for the far-field sheet (seamless march -> sheet handover)
    const wf = ctx.wakes;
    const gen = wf.uniforms.uWakeGen.value as Vector4[];
    let nx = 0, ny = 0;
    for (let g = 0; g < gen.length; g++) {
      const kx = WAKE_M0X + gen[g].y * WAKE_M0Y, ky = WAKE_M0Y, kn = Math.hypot(kx, ky);
      nx += gen[g].x * (kx / kn);
      ny += gen[g].x * (ky / kn);
    }
    const nn = Math.hypot(nx, ny);
    if (nn > 1e-6) (u.uRlWakeNrm.value as Vector2).set(nx / nn, ny / nn);
    const ia = Math.round((f.ring.r0 / 1000 - prof.rMinKm) / prof.drKm);
    const sigA = ia >= 0 && ia < prof.n ? prof.sigma[ia] : 0;
    (u.uRlWakeLamRef.value as Vector2).set(lambda, wf.strength > 1e-3 && Number.isFinite(sigA) ? sigA : 0);
    const wakeRef = ia >= 0 && ia < prof.n ? prof.wake[ia] : 0;
    this.statDue = wakesOn && wf.strength > 1e-3 && wakeRef > 1e-3 && this.statFrame++ % STAT_EVERY === 0;
    if (this.statDue) {
      (this.statFs.material.uniforms.uP.value as Vector4).set(f.ring.camLocal.x, f.ring.camLocal.y, wf.tile / STAT_N, 0);
      this.wakeStatRef = wakeRef;
    }
    // with wakes switched off the explicit field is flat -> no statistical wakes either
    const ws = u.uRlWakeStat.value as Vector4;
    if (wakesOn) ws.copy(this.wakeStat);
    else ws.set(0, 1, 1, 0);
  }
  private wakeStatRef = 0;

  /** Measure fB, Wb, Wg of the live wake field (GPU probe + 16 KB read-back, every STAT_EVERY frames). */
  private measureWakeStats(ctx: PipelineContext): void {
    this.statFs.render(ctx.renderer, this.statRT);
    ctx.renderer.readRenderTargetPixels(this.statRT, 0, 0, STAT_N, STAT_N, this.statBuf);
    let sb = 0, nb = 0, sg = 0, ng = 0;
    for (let i = 0; i < STAT_N * STAT_N; i++) {
      const w = this.statBuf[i * 4];
      if (!Number.isFinite(w)) continue;
      if (w > 1) { sb += w; nb++; } else { sg += w; ng++; }
    }
    if (nb === 0 || ng === 0) return;
    const fB = nb / (nb + ng);
    let Wb = sb / nb, Wg = sg / ng;
    const mean = fB * Wb + (1 - fB) * Wg;
    Wb /= mean;
    Wg /= mean;
    this.wakeStat.set(fB, Wb, Wg, this.wakeStatRef);
    (this.u.uRlWakeStat.value as Vector4).copy(this.wakeStat);
  }

  render(_f: FrameState, ctx: PipelineContext): void {
    this.wake.render(ctx.renderer);
    if (this.statDue) this.measureWakeStats(ctx);
    if ((this.u.uRlNearOn.value as number) > 0.5) this.lutFs.render(ctx.renderer, this.lutRT);
    this.u.tScene.value = ctx.sceneRT.texture;
    if (this.lowActive) this.lowFs.render(ctx.renderer, this.lowRT);
    this.fs.render(ctx.renderer, ctx.hdrRT);
  }

  stats(): Record<string, string | number> {
    return {
      mode: this.lastMode,
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
