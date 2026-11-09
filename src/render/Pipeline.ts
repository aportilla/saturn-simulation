// Render pipeline orchestration.
//
//   sceneRT (RGBA32F: rgb = radiance W m^-2 sr^-1, a = distance from camera in m, SKY_DIST for sky)
//            + depth texture (log depth, see sv_common)
//     1. clear  -> (0,0,0,SKY_DIST), depth 1
//     2. far    -> sky, stars, Sun, Saturn, moons            (FarFieldPass)
//     3. near   -> discrete ring particles near the camera    (NearFieldPass)
//    3a. bodies -> propeller moonlets (depth-tested)           (PropellerMoonletPass)
//    3b. overlay -> camera-pinned astronaut (depth-tested)    (AstronautPass)
//   hdrRT (RGBA32F radiance)
//     4. rings  -> ring layer composited over sceneRT        (RingLayerPass) [else plain copy]
//   screen
//     5. post   -> exposure, bloom, tone mapping             (PostPass)
//
// The pipeline also owns the shared local-ring state (RingLod + WakeField), reconfigured whenever the
// ring frame is re-anchored or the camera's pixel footprint changes significantly, and the 2-D ring structure
// (RingStructure: streamline map of the moonlet-perturbed gap edges), updated first every frame.
import {
  DepthTexture, FloatType, LinearFilter, NearestFilter, RGBAFormat, UnsignedIntType, WebGLRenderTarget,
  type IUniform, type Texture, type WebGLRenderer,
} from 'three';
import type { FrameState } from '../core/FrameState';
import { RingProfile } from '../rings/RingProfile';
import { RingLod } from '../rings/RingLod';
import { WakeField } from '../rings/WakeField';
import { WAKE_D_BINS } from '../rings/WakeStats';
import { RingStructure } from '../rings/RingStructure';
import { SharedUniforms } from './SharedUniforms';
import { FullscreenPass } from './fullscreen';
import { ModClipmap } from './rings/ModClipmap';
import { registerShaderChunks } from './shaders/chunks';
import { SKY_DISTANCE } from '../core/constants';

/**
 * margin on the modulation cache's block maxima for the near-field presence bound (float rounding; a level refreshed for
 * the pattern's drift since the read-back -- <= 1/2 azimuthal texel, ModClipmap.maxNear -- moves its samples between the
 * dilated blocks' texels)
 */
const MOD_BOUND_MARGIN = 1.02;

/** erfc(x) for x >= 0 (Abramowitz & Stegun 7.1.26: absolute error < 1.5e-7, ~0.3 % of erfc(2.83) = 6.3e-5) */
function erfcPos(x: number): number {
  const t = 1 / (1 + 0.3275911 * x);
  return (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
}

export interface PipelineContext {
  renderer: WebGLRenderer;
  shared: SharedUniforms;
  profile: RingProfile;
  lod: RingLod;
  wakes: WakeField;
  /**
   * 2-D structure of the main rings (sv_ringStructure): every main-ring tau lookup maps through it; CPU mirror
   * (camera's Lagrangian position, tau at a point). Updated at the start of each frame, before any pass.
   */
  structure: RingStructure;
  /**
   * cache of the 2-D modulation around the camera (sv_ringModClip rsModCached: near-field presence, the march near the
   * camera); updated and rendered by the pipeline before any pass renders
   */
  modClip: ModClipmap;
  /**
   * per near-field size class: an upper bound of the presence test's tau0 M over the class's box this frame (the
   * modulation cache's block maxima, ModClipmap.maxNear), <= the class's tauMax -- the update pass skips the slots whose
   * presence threshold exceeds it before computing anything (cost only: they would fail the presence test anyway);
   * = tauMax where no current bound is known. Set by the pipeline every frame (updateLocalRing).
   */
  presenceBound: Float64Array;
  /** far + near opaque scene: rgb radiance + distance (a), with depth texture */
  sceneRT: WebGLRenderTarget;
  /** radiance after the ring layer */
  hdrRT: WebGLRenderTarget;
  width: number;
  height: number;
  /** the near field's sun shadow map, for other surfaces that receive particle shadows (set by NearFieldPass) */
  nearShadow?: NearShadowShare;
  /**
   * ringshine on Saturn's cloud deck (set by FarFieldPass, updated in its render): (E_ring / E_sun) rgb,
   * u = (longitude from the sub-solar meridian + pi) / 2pi, v = (planetographic latitude + pi/2) / pi
   */
  ringshineTable?: Texture;
  /**
   * pixels of camera-pinned overlays (the astronaut) that PostPass meters as the scene they hide: r > 0.5 where
   * visible, at the render resolution, inside the screen columns [x0, x1] (render px); valid only in the frame it
   * was written (set by AstronautPass)
   */
  meterMask?: { texture: Texture; frame: number; x0: number; x1: number };
  /**
   * the ring layer's camera-centred wake-density clipmap (set by RingLayerPass at init; WakeClipmap.ts): R16F atlas of
   * `levelCount` levels (N x N each, stacked vertically, WAKE_CLIP_MAX_LEVELS rows of levels), `levels[k]` = (centre x,
   * centre y, texel (m), usable) in the local frame, describing the content as rendered (valid for passes that render
   * before the ring layer refreshes it: the near field's occlusion cull)
   */
  wakeClip?: { texture: Texture; levels: { x: number; y: number; z: number; w: number }[]; readonly levelCount: number; n: number; maxLevels: number };
}

/** Near-field sun shadow map shared with later passes (NEAR_SHADOW_COMMON_GLSL / NEAR_SHADOW_LOOKUP_GLSL). */
export interface NearShadowShare {
  /** uShU, uShV, uShInfo, uShPen, tShadow and uNearAllocD (shared objects, current after the near pass) */
  uniforms: Record<string, IUniform>;
  /** frameIndex of the last frame the map was rendered: it holds this frame's particles only then */
  frame: number;
  /** allocate the integer target so it can be bound before it was ever rendered */
  prepare(r: WebGLRenderer): void;
}

export interface RenderPass {
  readonly name: string;
  enabled: boolean;
  init(ctx: PipelineContext): Promise<void> | void;
  /** called after the internal resolution changes (ctx.width/height, targets already resized) */
  resize?(ctx: PipelineContext): void;
  /** CPU-side per-frame work, before any pass renders */
  update?(frame: FrameState, ctx: PipelineContext): void;
  render(frame: FrameState, ctx: PipelineContext): void;
  /** key/value stats for the HUD */
  stats?(): Record<string, string | number>;
  dispose?(): void;
}

export interface PipelinePasses {
  far?: RenderPass;
  near?: RenderPass;
  /** further opaque bodies in the ring layer, drawn after the near field (the propeller moonlets) */
  bodies?: RenderPass;
  /** opaque overlays drawn after the near field, before the ring layer (the camera-pinned astronaut) */
  overlay?: RenderPass;
  rings?: RenderPass;
  post?: RenderPass;
}

/** Ring-local LOD configuration policy (owned by the near-field system; tunable). */
export interface LocalRingPolicy {
  /**
   * cap on the near-field particle slots (memory / update cost; ~30 B of GPU state per slot). The count
   * contract (every particle >= 1 display pixel drawn) normally fits; if the cap binds, the deficit is
   * reported in the near-field stats (src/rings/RingLod.ts).
   */
  maxSlots: number;
}

export class Pipeline {
  ctx!: PipelineContext;
  readonly passes: PipelinePasses;
  policy: LocalRingPolicy = { maxSlots: 12_000_000 };
  private clearPass!: FullscreenPass;
  private copyPass!: FullscreenPass;
  private lastAnchorId = -1;
  private lastWakesOn = true;
  private lastLocalRKm = -1;
  private lastLocalRKmL = -1;
  private lastLocalMacro = false;
  private lastModKey = '';
  private modCheckFrame = 0;
  /** the near-field presence bound's box centre (aL, S) and drift margin (m), from updateLocalRing */
  private readonly presCam = [0, 0, 0];
  ready = false;

  constructor(readonly renderer: WebGLRenderer, passes: PipelinePasses) {
    this.passes = passes;
    renderer.autoClear = false;
  }

  async init(width: number, height: number): Promise<void> {
    registerShaderChunks();
    const [profile, structure] = await Promise.all([RingProfile.load(), RingStructure.load()]);
    structure.attachProfile(profile);
    const lod = new RingLod();
    const wakes = new WakeField();
    const shared = new SharedUniforms(profile, lod, wakes, structure);
    // (its uniforms join the shared set before any pass makes its materials)
    const modClip = new ModClipmap(shared.u);
    Object.assign(shared.u, modClip.uniforms);
    const sceneRT = Pipeline.makeTarget(width, height, true);
    const hdrRT = Pipeline.makeTarget(width, height, false);
    const presenceBound = new Float64Array(lod.tauMax.length);
    this.ctx = { renderer: this.renderer, shared, profile, lod, wakes, structure, modClip, presenceBound, sceneRT, hdrRT, width, height };
    // color clear via shader (float targets: clearColor values may be clamped); depth via renderer.clear
    this.clearPass = new FullscreenPass({
      fragmentShader: /* glsl */ `
        precision highp float;
        layout(location = 0) out vec4 outColor;
        void main() { outColor = vec4(0.0, 0.0, 0.0, ${SKY_DISTANCE.toExponential()}); }`,
    });
    this.copyPass = new FullscreenPass({
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler2D;
        uniform sampler2D tSrc;
        in vec2 vUv;
        layout(location = 0) out vec4 outColor;
        void main() { outColor = vec4(texture(tSrc, vUv).rgb, 1.0); }`,
      uniforms: { tSrc: { value: null } },
    });
    // (the overlay after the near field: it uses the near field's shadow map)
    for (const p of this.ordered()) {
      if (p) await p.init(this.ctx);
    }
    this.ready = true;
  }

  /** The passes in pipeline order. */
  private ordered(): (RenderPass | undefined)[] {
    const p = this.passes;
    return [p.far, p.near, p.bodies, p.overlay, p.rings, p.post];
  }

  static makeTarget(w: number, h: number, depth: boolean): WebGLRenderTarget {
    // scene target: nearest (it stores distances); hdr target: linear (post pass may rescale)
    const filter = depth ? NearestFilter : LinearFilter;
    const rt = new WebGLRenderTarget(w, h, {
      type: FloatType,
      format: RGBAFormat,
      minFilter: filter,
      magFilter: filter,
      depthBuffer: depth,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    if (depth) {
      const dt = new DepthTexture(w, h);
      dt.type = UnsignedIntType;
      rt.depthTexture = dt;
    }
    return rt;
  }

  setSize(width: number, height: number): void {
    if (!this.ready) return;
    const c = this.ctx;
    if (c.width === width && c.height === height) return;
    c.width = width;
    c.height = height;
    c.sceneRT.setSize(width, height);
    c.hdrRT.setSize(width, height);
    for (const p of this.ordered()) p?.resize?.(c);
  }

  /** Reconfigure the shared local-ring LOD + wake state when the anchor/footprint changes. */
  private updateLocalRing(f: FrameState): void {
    const c = this.ctx;
    // the count contract is in DISPLAY pixels (render scale changes fidelity only) and follows the current
    // field of view exactly; the particle allocation is re-fitted only beyond its zoom headroom
    const pa = f.canvasPixelAngle;
    c.lod.setPixelAngle(pa);
    const anchorChanged = f.ring.anchorId !== this.lastAnchorId;
    const rKmE = (f.ring.r0 + f.ring.camLocal.x) / 1000;
    const movedFar = Math.abs(rKmE - this.lastLocalRKm) > 1.0; // reconfigure each km of radial travel
    // The material around the camera is that of its Lagrangian (streamline) radius (sv_ringStructure: gap-edge waves,
    // B-ring edge modes; the near-field boxes are Lagrangian, nearUpdate.glsl). The map moves material under a
    // co-orbiting camera (km near the Keeler gap, +-75 km at the B-ring edge), so the boxes' tau_max covers that drift
    // and the allocation is re-fitted only when the material under the camera changes (ring <-> gap) or drifted far.
    const rKm = rKmE + c.structure.cam.da / 1000;
    const local = c.profile.local(rKm * 1000);
    this.slabLocal = local;
    const drifted = local.macroscopic !== this.lastLocalMacro || Math.abs(rKm - this.lastLocalRKmL) > 20;
    // the camera's height above the local mid-plane (vertical relief; the frame stays in the SEF plane)
    const camZ = f.ring.camLocal.z - f.ring.zMid;
    // The particles are thinned by tau0 M / tauMax with M the 2-D modulation (sub-km texture, propellers): each class's
    // tauMax covers the largest M in its box AT ANY TIME (the texture's 3-sigma clamp: the pattern evolves and shears
    // through the co-orbiting boxes -- its maximum over a box varies by +-15 % within a day -- and a re-fit re-seeds the
    // particles, so the allocation must not follow it). Propellers drift through the boxes: their bounds are re-checked
    // every 60 frames and the allocation re-fitted when one changes.
    const thCam = Math.atan2(f.camPos.y, f.camPos.x);
    const driftKm = c.structure.maxDisplacementNear(rKmE * 1000) / 1000;
    // (the presence bound's box centre and margin: the camera's Lagrangian polar position in the ring frame -- the
    // modulation cache's coordinates aL = a' - r0, S = r0 dth -- and the streamline map's drift)
    this.presCam[0] = rKm * 1000 - f.ring.r0;
    this.presCam[1] = f.ring.r0 * Math.atan2(f.ring.camLocal.y, f.ring.r0 + f.ring.camLocal.x);
    this.presCam[2] = driftKm * 1000;
    let modKey = this.lastModKey;
    if (++this.modCheckFrame % 60 === 0 && c.lod.active) {
      c.structure.prepareNear(rKm * 1000, thCam);
      modKey = c.structure.nearBoundKey(c.lod.box);
    }
    const wakesOn = f.settings.wakes;
    if (anchorChanged || movedFar || drifted || c.lod.needsRealloc(pa, camZ) || modKey !== this.lastModKey || wakesOn !== this.lastWakesOn) {
      c.structure.prepareNear(rKm * 1000, thCam);
      // each size class is generated at the max particle optical depth (tau_dyn with wakes: RingProfile.tauDyn) over the
      // radial span of its own box (+ the possible drift)
      const tauArr = wakesOn ? c.profile.tauDyn : c.profile.tauIso;
      c.lod.configure(local, (halfWidth) => c.profile.maxTauKm(rKm, halfWidth / 1000 + driftKm, tauArr) * c.structure.maxTauModNear(rKm * 1000, halfWidth + driftKm * 1000), camZ, { pixelAngle: pa, maxSlots: this.policy.maxSlots, wakes: wakesOn });
      c.wakes.configure(local, f.ring);
      // the medium's mean participation in the wakes (sv_wakes wakeDensityTau, the tau-weighted mean of the column)
      c.wakes.participationTau = wakesOn ? c.lod.pbarTot : 1;
      this.lastWakesOn = wakesOn;
      this.lastAnchorId = f.ring.anchorId;
      this.lastLocalRKm = rKmE;
      this.lastLocalRKmL = rKm;
      this.lastLocalMacro = local.macroscopic;
      this.lastModKey = c.structure.nearBoundKey(c.lod.box);
    }
    // near-field cost gate: the size classes whose guiding centres a propeller's structure can reach (elsewhere its
    // factor is exactly 1, so nearUpdate.glsl skips the enumeration there)
    const P = c.structure.propellers;
    P.uniforms.uRpNearMask.value = P.nearClassMask(rKm * 1000, thCam, c.lod.box, 500);
    // the near field is active while the camera is within the distance its largest particles can be drawn at
    const nearAllowed = f.settings.nearField && Math.abs(camZ) < c.lod.maxReach && c.lod.totalParticles > 0;
    c.lod.setActive(nearAllowed && (this.passes.near?.enabled ?? false));
    c.wakes.enabled = f.settings.wakes;
    c.wakes.update(f.t);
  }

  /**
   * The slab that holds the particle layer (sv_ringLod ringSlabHalfThickness; the march's segment, the ring layer's
   * "inside" mode, the vertical-structure LUT's range). RingLod.configure sizes it at 4 sigma of the THICKEST class, the
   * participating ones thickened by the packing ceiling as in the densest 0.4 % of the wake field at the worst tau near
   * the camera (the texture's 3-sigma maximum of tau x M over +-5 km): every column of every class contained. Here the
   * same standard -- no more of the layer's column outside than a single Gaussian leaves beyond 4 sigma, 2 Q(4) =
   * 6.3e-5 -- for the layer as it is: the mixture of the classes (each its tau share) and the sub-class particles, the
   * participating share p_k at the wake field's density distribution (WakeStats WAKE_D_BINS at the zone's strength:
   * each bin's D x that share, thickened by the packing ceiling at its D) and the largest particle optical depth near
   * the camera this frame (tau0 tau_dyn / tau0 x M over +-5 km: the modulation cache's presence channel,
   * ModClipmap.maxNear). The thickest classes carry a few % of tau and the packing binds only in the dense cores: a
   * camera tens of metres from the A ring's mid-plane was "inside" the worst-case slab (~85 m there), and every ray
   * marched from it. RingLod's slab where the cache cannot bound the region (localSlab = false: always). Every 10th
   * frame (the inputs change slowly; ~0.1 ms).
   */
  private updateSlab(f: FrameState): void {
    const L = this.ctx.lod;
    if (L.version !== this.slabLodVersion) {
      this.slabLodVersion = L.version;
      this.slabWorst = L.slabK;
      this.slabFrame = 0;
    }
    if (this.slabFrame++ % 10 !== 0) {
      L.slabK = this.slabCur;
      L.uniforms.uLodSlabK.value = this.slabCur;
      return;
    }
    let k = this.slabWorst;
    const p = this.localSlab && L.active
      ? this.ctx.modClip.maxNear(this.presCam[0], this.presCam[1], 5000 + this.presCam[2], f.ring.anchorId, 1, f.t)
      : null;
    const loc = this.slabLocal;
    if (p !== null && loc) {
      const tauNear = Math.max(L.tau, p * MOD_BOUND_MARGIN);
      // the participating share's density distribution: equal-area bins of D (wakes on), grouped by their packing
      const groups = this.slabGroups;
      groups.length = 0;
      const bins = f.settings.wakes && loc.wakeStrength > 1e-3 ? WAKE_D_BINS[loc.wakeB >= 0.5 ? 'B' : 'A'] : null;
      if (bins && bins.length > 0) {
        const nb = bins.length;
        let mPrev = -1, wD = 0;
        for (let b = 0; b < nb; b++) {
          const D = 1 + loc.wakeStrength * (bins[b] - 1);
          const m = L.pack[3] > 0.5 ? L.packM(tauNear, D) : 1;
          if (mPrev >= 0 && Math.abs(m - mPrev) > 0.01 * mPrev) { groups.push(wD, mPrev); wD = 0; }
          if (wD === 0) mPrev = m;
          wD += Math.max(D, 0) / nb;
        }
        if (wD > 0) groups.push(wD, mPrev);
      } else groups.push(1, L.pack[3] > 0.5 ? L.packM(tauNear, 1) : 1);
      // the layer's two-sided tail fraction beyond +-z (units of H) over (weight, sigma) components
      const comp = this.slabComp;
      comp.length = 0;
      let wT = 0, sMax = 0;
      const add = (w: number, s: number) => { if (w > 0 && s > 0) { comp.push(w, s); wT += w; sMax = Math.max(sMax, s); } };
      for (let j = 0; j < L.tauFrac.length; j++) {
        const w = L.tauFrac[j];
        if (!(w > 0)) continue;
        const s = Math.max(L.sigZFrac[j], 0.02 / Math.max(L.H, 1e-3)), pj = L.partP[j];
        add(w * (1 - pj), s);
        for (let g = 0; g < groups.length; g += 2) add(w * pj * groups[g], s * groups[g + 1]);
      }
      if (L.tauSub > 0) add(L.tauSub, L.sigZFracSub);
      if (wT > 0) {
        const tail = (z: number) => { let t = 0; for (let i = 0; i < comp.length; i += 2) t += comp[i] * erfcPos(z / (Math.SQRT2 * comp[i + 1])); return t / wT; };
        // 2 Q(4) = erfc(4 / sqrt 2); the 4-sigma point of the thickest component already meets it
        const eps = erfcPos(4 / Math.SQRT2);
        let lo = 0, hi = 4 * sMax;
        for (let it = 0; it < 30; it++) {
          const mid = 0.5 * (lo + hi);
          if (tail(mid) > eps) lo = mid; else hi = mid;
        }
        k = Math.min(k, Math.max(1.6, hi));
      }
    }
    this.slabCur = k;
    L.slabK = k;
    L.uniforms.uLodSlabK.value = k;
  }
  private readonly slabComp: number[] = [];
  private readonly slabGroups: number[] = [];
  private slabFrame = 0;
  private slabCur = 1.6;
  /** the local ring zone at the camera (updateLocalRing): the wake set and strength of the slab's density distribution */
  private slabLocal: { wakeB: number; wakeStrength: number } | null = null;
  /** the slab from the local packing (updateSlab); false: RingLod's worst case near the camera */
  localSlab = true;
  private slabLodVersion = -1;
  private slabWorst = 1.6;

  render(f: FrameState): void {
    if (!this.ready) return;
    const c = this.ctx;
    const r = this.renderer;
    c.structure.update(f);
    this.updateLocalRing(f);
    c.shared.update(f, c.profile);
    // the 2-D modulation around the camera, over the near field's largest particle box (+ the presence bound's 500 m
    // margin and room for the boxes to grow at a re-fit)
    {
      const P = c.structure.propellers, tf = P.uniforms.uRpTF.value;
      const reach = c.lod.active ? 1.5 * c.lod.maxBox + 600 : 0;
      const rc = Math.hypot(f.camPos.x, f.camPos.y);
      const propNear = P.scale > 0 && rc > tf.y - reach && rc < tf.z + reach;
      // (the cache's presence channel holds tau0 tau_dyn / tau0 x M: a checksum of the anchor zone's tau_dyn table)
      let dynKey = 0;
      const dt = c.lod.dynTab;
      for (let i = 0; i < dt.length; i++) dynKey += dt[i] * (i + 1);
      c.modClip.update(f, c.structure, reach, propNear, dynKey);
      c.modClip.render(r);
      // per size class: the largest presence tau0 M over its box (+ the allocation's 500 m margin and the streamline
      // drift) the cache's lookups can return this frame -- the update pass skips the slots above it unevaluated
      const pb = c.presenceBound, L = c.lod;
      for (let k = 0; k < pb.length; k++) {
        pb[k] = L.tauMax[k];
        if (!L.active || L.slots[k] <= 0) continue;
        const p = c.modClip.maxNear(this.presCam[0], this.presCam[1], L.box[k] + 500 + this.presCam[2], f.ring.anchorId, 1, f.t);
        if (p !== null) pb[k] = Math.min(L.tauMax[k], Math.max(p * MOD_BOUND_MARGIN, L.tau));
      }
      this.updateSlab(f);
    }
    for (const p of this.ordered()) {
      if (p && p.enabled) p.update?.(f, c);
    }
    // 1. clear scene target
    r.setRenderTarget(c.sceneRT);
    r.clear(false, true, false);
    this.clearPass.render(r, c.sceneRT);
    // 2-3. opaque scene
    if (this.passes.far?.enabled) this.passes.far.render(f, c);
    if (this.passes.near?.enabled && c.lod.active) this.passes.near.render(f, c);
    // 3a. further bodies in the ring layer (propeller moonlets), depth-tested against the particles
    if (this.passes.bodies?.enabled) this.passes.bodies.render(f, c);
    // 3b. opaque overlays (camera-pinned astronaut), depth-tested against the particles, under the ring medium
    if (this.passes.overlay?.enabled) this.passes.overlay.render(f, c);
    // 4. ring layer (or plain copy)
    if (this.passes.rings?.enabled) {
      this.passes.rings.render(f, c);
    } else {
      this.copyPass.material.uniforms.tSrc.value = c.sceneRT.texture;
      this.copyPass.render(r, c.hdrRT);
    }
    // 5. post to screen
    if (this.passes.post?.enabled) this.passes.post.render(f, c);
    r.setRenderTarget(null);
  }

  stats(): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (const p of this.ordered()) {
      if (!p?.stats) continue;
      for (const [k, v] of Object.entries(p.stats())) out[`${p.name}.${k}`] = v;
    }
    return out;
  }
}
