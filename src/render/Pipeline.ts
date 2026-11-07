// Render pipeline orchestration.
//
//   sceneRT (RGBA32F: rgb = radiance W m^-2 sr^-1, a = distance from camera in m, SKY_DIST for sky)
//            + depth texture (log depth, see sv_common)
//     1. clear  -> (0,0,0,SKY_DIST), depth 1
//     2. far    -> sky, stars, Sun, Saturn, moons            (FarFieldPass)
//     3. near   -> discrete ring particles near the camera    (NearFieldPass)
//   hdrRT (RGBA32F radiance)
//     4. rings  -> ring layer composited over sceneRT        (RingLayerPass) [else plain copy]
//   screen
//     5. post   -> exposure, bloom, tone mapping             (PostPass)
//
// The pipeline also owns the shared local-ring state (RingLod + WakeField), reconfigured whenever the
// ring frame is re-anchored or the camera's pixel footprint changes significantly.
import {
  DepthTexture, FloatType, LinearFilter, NearestFilter, RGBAFormat, UnsignedIntType, WebGLRenderTarget,
  type WebGLRenderer,
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
  rings?: RenderPass;
  post?: RenderPass;
}

/** Ring-local LOD configuration policy (owned by the near-field system; tunable). */
export interface LocalRingPolicy {
  /** particle budget at particleDetail = 1 */
  baseBudget: number;
  /** recompute LOD if pixelAngle changes by more than this factor */
  pixelAngleTolerance: number;
  /** the near field is active only while |camera height above ring plane| < this (m) */
  maxHeight: number;
}

export class Pipeline {
  ctx!: PipelineContext;
  readonly passes: PipelinePasses;
  policy: LocalRingPolicy = { baseBudget: 4_000_000, pixelAngleTolerance: 1.3, maxHeight: 5_000 };
  private clearPass!: FullscreenPass;
  private copyPass!: FullscreenPass;
  private lastAnchorId = -1;
  private lastPixelAngle = 0;
  private lastDetail = 0;
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
    for (const p of [this.passes.far, this.passes.near, this.passes.rings, this.passes.post]) {
      if (p) await p.init(this.ctx);
    }
    this.ready = true;
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
    for (const p of [this.passes.far, this.passes.near, this.passes.rings, this.passes.post]) p?.resize?.(c);
  }

  /** Reconfigure the shared local-ring LOD + wake state when the anchor/footprint changes. */
  private updateLocalRing(f: FrameState): void {
    const c = this.ctx;
    const detail = f.settings.particleDetail;
    const pa = f.pixelAngle;
    const anchorChanged = f.ring.anchorId !== this.lastAnchorId;
    const rKm = (f.ring.r0 + f.ring.camLocal.x) / 1000;
    const movedFar = Math.abs(rKm - this.lastLocalRKm) > 1.0; // reconfigure each km of radial travel
    const paChanged = this.lastPixelAngle === 0 || Math.max(pa / this.lastPixelAngle, this.lastPixelAngle / pa) > this.policy.pixelAngleTolerance;
    if (anchorChanged || paChanged || movedFar || detail !== this.lastDetail) {
      const local = c.profile.local(rKm * 1000);
      const span = c.lod.options.rMax / 1000 + 1;
      const tauMax = c.profile.maxTauKm(rKm, span);
      c.lod.configure(local, tauMax, { pixelAngle: pa, budget: this.policy.baseBudget * detail });
      c.wakes.configure(local, f.ring);
      this.lastAnchorId = f.ring.anchorId;
      this.lastPixelAngle = pa;
      this.lastDetail = detail;
      this.lastLocalRKm = rKm;
    }
    const nearAllowed = f.settings.nearField && Math.abs(f.camPos.z) < this.policy.maxHeight && c.lod.totalParticles > 0;
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
    for (const p of [this.passes.far, this.passes.near, this.passes.rings, this.passes.post]) {
      if (p && p.enabled) p.update?.(f, c);
    }
    // 1. clear scene target
    r.setRenderTarget(c.sceneRT);
    r.clear(false, true, false);
    this.clearPass.render(r, c.sceneRT);
    // 2-3. opaque scene
    if (this.passes.far?.enabled) this.passes.far.render(f, c);
    if (this.passes.near?.enabled && c.lod.active) this.passes.near.render(f, c);
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
    for (const p of [this.passes.far, this.passes.near, this.passes.rings, this.passes.post]) {
      if (!p?.stats) continue;
      for (const [k, v] of Object.entries(p.stats())) out[`${p.name}.${k}`] = v;
    }
    return out;
  }
}
