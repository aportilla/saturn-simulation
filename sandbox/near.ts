// Near-field particle sandbox: stub far field + near-field particles, no ring layer (plain copy), so the
// discrete particles are seen alone. Extra URL parameters:
//   rings=1      use the real RingLayerPass (to check the LOD seam)
//   rings=stub   use the stub ring layer
//   cull=0       disable statistical occlusion culling
//   wakes=0      disable self-gravity wakes
//   shadows=0    disable the near-field shadow map
//   nearfield=0  disable the near field (the medium then carries the whole optical depth: seam checks)
//   post=simple  fixed-exposure tone mapping instead of PostPass (exp=<multiplier>, default 0.25*2^ev)
import { startSandbox } from './common';
import { FarFieldStub } from '../src/render/passes/stubs/FarFieldStub';
import { RingLayerStub } from '../src/render/passes/stubs/RingLayerStub';
import { NearFieldPass } from '../src/render/passes/NearFieldPass';
import type { PipelineContext, PipelinePasses, RenderPass } from '../src/render/Pipeline';
import type { FrameState } from '../src/core/FrameState';
import { FullscreenPass } from '../src/render/fullscreen';

const params = new URLSearchParams(location.search);
const near = new NearFieldPass();
if (params.get('cull') === '0') near.cullEnabled = false;
if (params.get('shadows') === '0') near.shadowsEnabled = false;

/** Minimal post: fixed exposure, ACES, sRGB (independent of the far-field agent's PostPass). */
class SimplePost implements RenderPass {
  readonly name = 'post';
  enabled = true;
  private fs!: FullscreenPass;
  constructor(private exposure: number) {}
  init(): void {
    this.fs = new FullscreenPass({
      fragmentShader: /* glsl */ `
        precision highp float; precision highp sampler2D;
        uniform sampler2D tHdr; uniform float uExp;
        in vec2 vUv; layout(location = 0) out vec4 o;
        vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
        void main() {
          vec3 c = aces(max(texture(tHdr, vUv).rgb, vec3(0.0)) * uExp);
          o = vec4(mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)), 1.0);
        }`,
      uniforms: { tHdr: { value: null }, uExp: { value: this.exposure } },
    });
  }
  render(f: FrameState, ctx: PipelineContext): void {
    this.fs.material.uniforms.tHdr.value = ctx.hdrRT.texture;
    this.fs.render(ctx.renderer, null);
    f.exposure = this.exposure;
  }
  stats() { return { exposure: this.exposure.toExponential(2) }; }
}

// other agents' passes are loaded lazily so that their in-progress edits can't break / reload this page
let rings: RenderPass | undefined;
if (params.get('rings') === '1') {
  const m = await import(/* @vite-ignore */ '../src/render/passes/RingLayer' + 'Pass');
  rings = new m.RingLayerPass();
} else if (params.get('rings') === 'stub') {
  rings = new RingLayerStub();
}
const simpleExp = params.has('exp') ? parseFloat(params.get('exp')!) : 0.25 * Math.pow(2, parseFloat(params.get('ev') ?? '0'));
/** Uses PostPass, falling back to SimplePost if it fails to load / initialize (another agent's WIP). */
class SafePost implements RenderPass {
  readonly name = 'post';
  enabled = true;
  private p: RenderPass;
  constructor(inner: RenderPass | null, private fallback: RenderPass) { this.p = inner ?? fallback; }
  async init(ctx: PipelineContext) {
    try { await this.p.init(ctx); } catch (e) { console.warn('[near sandbox] PostPass init failed, using SimplePost', e); this.p = this.fallback; await this.p.init(ctx); }
  }
  resize(ctx: PipelineContext) { this.p.resize?.(ctx); }
  update(f: FrameState, ctx: PipelineContext) { this.p.update?.(f, ctx); }
  render(f: FrameState, ctx: PipelineContext) { this.p.render(f, ctx); }
  stats() { return this.p.stats?.() ?? {}; }
}
let inner: RenderPass | null = null;
if (params.get('post') !== 'simple') {
  try {
    const m = await import(/* @vite-ignore */ '../src/render/Post' + 'Pass');
    inner = new m.PostPass();
  } catch (e) {
    console.warn('[near sandbox] PostPass unavailable, using SimplePost', e);
  }
}
const post: RenderPass = new SafePost(inner, new SimplePost(simpleExp));

startSandbox({
  passes: () => {
    const p: PipelinePasses = { far: new FarFieldStub(), near, post };
    if (rings) p.rings = rings;
    return p;
  },
  onFrame: (f) => {
    if (params.get('wakes') === '0') f.settings.wakes = false;
    if (params.get('nearfield') === '0') f.settings.nearField = false;
  },
  overlay: (f, pipe) => {
    const c = pipe.ctx;
    const lod = c.lod;
    const r = f.ring;
    const lines = [
      `${new Date((f.t + 946727930.816) * 1000).toISOString()}  warp ${f.timeWarp}`,
      `r0 ${(r.r0 / 1e3).toFixed(1)} km  cam (${r.camLocal.x.toFixed(1)}, ${r.camLocal.y.toFixed(1)}, ${r.camLocal.z.toFixed(2)}) m`,
      `tau ${lod.tau.toFixed(3)}  tauBoxMax ${lod.tauBoxMax.toFixed(3)}  H ${lod.H} m  q ${lod.q.toFixed(2)}  a ${lod.aMin}-${lod.aMax} m`,
      `boxes ${Array.from(lod.box).map((b, k) => (lod.slots[k] > 0 ? `${k}:${b.toFixed(0)}` : '')).filter(Boolean).join(' ')}  ` +
        `display px ${(f.canvasPixelAngle * 1e3).toFixed(3)} mrad  deficit ${(lod.deficit * 100).toFixed(1)}%`,
      `wakes: lambda ${c.wakes.lambda.toFixed(1)} m  strength ${c.wakes.strength.toFixed(2)}  pitch ${c.wakes.pitchDeg.toFixed(1)} deg`,
      `sun elev ${(Math.asin(f.sunDir.z) * 180 / Math.PI).toFixed(2)} deg  local dir (${f.sunDir.dot(r.eR).toFixed(3)}, ${f.sunDir.dot(r.ePhi).toFixed(3)}, ${f.sunDir.z.toFixed(3)})  ` +
        `orbit phase from noon ${(((Math.atan2(r.eR.y, r.eR.x) - Math.atan2(f.sunDir.y, f.sunDir.x)) * 180 / Math.PI + 540) % 360 - 180).toFixed(1)} deg`,
      ...Object.entries(pipe.stats()).map(([k, v]) => `${k}: ${v}`),
    ];
    return lines.join('\n');
  },
});
