// Render pipeline orchestration.
//
//   sceneRT (RGBA32F: rgb = radiance W m^-2 sr^-1, a = distance from camera in m, SKY_DIST for sky)
//            + depth texture (log depth, see sv_common)
//     1. clear  -> (0,0,0,SKY_DIST), depth 1
//     2. far    -> sky, stars, Sun, Saturn, moons            (FarFieldPass)
//     3. near   -> discrete ring particles near the camera    (NearFieldPass)
//    3b. overlay -> camera-pinned astronaut (depth-tested)    (AstronautPass)
//   hdrRT (RGBA32F radiance)
//     4. rings  -> ring layer composited over sceneRT        (RingLayerPass) [else plain copy]
//   screen
//     5. post   -> exposure, bloom, tone mapping             (PostPass)
//
// The pipeline also owns the shared local-ring state (RingLod + WakeField), reconfigured whenever the
// ring frame is re-anchored or the camera's pixel footprint changes significantly.
import {
  DepthTexture, FloatType, LinearFilter, NearestFilter, RGBAFormat, UnsignedIntType, WebGLRenderTarget,
  type IUniform, type Texture, type WebGLRenderer,
} from 'three';
import type { FrameState } from '../core/FrameState';
import { RingProfile } from '../rings/RingProfile';
import { RingLod } from '../rings/RingLod';
import { WakeField } from '../rings/WakeField';
import { SharedUniforms } from './SharedUniforms';
import { FullscreenPass } from './fullscreen';
import { registerShaderChunks } from './shaders/chunks';
import { SKY_DISTANCE } from '../core/constants';

export interface PipelineContext {
  renderer: WebGLRenderer;
  shared: SharedUniforms;
  profile: RingProfile;
  lod: RingLod;
  wakes: WakeField;
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
  ready = false;

  constructor(readonly renderer: WebGLRenderer, passes: PipelinePasses) {
    this.passes = passes;
    renderer.autoClear = false;
  }

  async init(width: number, height: number): Promise<void> {
    registerShaderChunks();
    const profile = await RingProfile.load();
    const lod = new RingLod();
    const wakes = new WakeField();
    const shared = new SharedUniforms(profile, lod, wakes);
    const sceneRT = Pipeline.makeTarget(width, height, true);
    const hdrRT = Pipeline.makeTarget(width, height, false);
    this.ctx = { renderer: this.renderer, shared, profile, lod, wakes, sceneRT, hdrRT, width, height };
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
    return [p.far, p.near, p.overlay, p.rings, p.post];
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
    const rKm = (f.ring.r0 + f.ring.camLocal.x) / 1000;
    const movedFar = Math.abs(rKm - this.lastLocalRKm) > 1.0; // reconfigure each km of radial travel
    const camZ = f.ring.camLocal.z;
    if (anchorChanged || movedFar || c.lod.needsRealloc(pa, camZ)) {
      const local = c.profile.local(rKm * 1000);
      // each size class is generated at the max tau over the radial span of its own box
      c.lod.configure(local, (halfWidth) => c.profile.maxTauKm(rKm, halfWidth / 1000), camZ, { pixelAngle: pa, maxSlots: this.policy.maxSlots });
      c.wakes.configure(local, f.ring);
      this.lastAnchorId = f.ring.anchorId;
      this.lastLocalRKm = rKm;
    }
    // the near field is active while the camera is within the distance its largest particles can be drawn at
    const nearAllowed = f.settings.nearField && Math.abs(f.camPos.z) < c.lod.maxReach && c.lod.totalParticles > 0;
    c.lod.setActive(nearAllowed && (this.passes.near?.enabled ?? false));
    c.wakes.enabled = f.settings.wakes;
    if (this.lastWakesOn !== f.settings.wakes) this.lastWakesOn = f.settings.wakes;
    c.wakes.update(f.t);
  }

  render(f: FrameState): void {
    if (!this.ready) return;
    const c = this.ctx;
    const r = this.renderer;
    this.updateLocalRing(f);
    c.shared.update(f, c.profile);
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
