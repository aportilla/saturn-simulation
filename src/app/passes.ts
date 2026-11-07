// Render-pass loading with graceful degradation.
//
// The real passes are being developed in parallel, so each is imported dynamically and wrapped in a
// GuardedPass: any exception (import, init, update, render, resize) or shader compile error disables that
// pass and, where available, switches to a fallback (the orchestrator's stubs, or a minimal tone mapper
// for the post pass) — the app keeps running instead of dying.
import type { WebGLRenderer } from 'three';
import type { FrameState } from '../core/FrameState';
import type { PipelineContext, PipelinePasses, RenderPass } from '../render/Pipeline';
import { FullscreenPass } from '../render/fullscreen';

/** The subset of PostPass the app relies on. */
export interface PostLike extends RenderPass {
  exposure: number;
  snapExposure?(): void;
}

export interface PassStatus {
  name: string;
  source: string;
  state: 'ok' | 'fallback' | 'failed' | 'missing';
  error?: string;
}

export class GuardedPass implements RenderPass {
  static current: GuardedPass | null = null;
  readonly name: string;
  failed: string | null = null;
  private want = true;
  private ctx: PipelineContext | null = null;
  private fallbackReady = false;

  constructor(readonly inner: RenderPass, readonly label: string, readonly source: string, readonly fallback: GuardedPass | null = null) {
    this.name = inner.name;
  }

  /** The pass actually rendering (this, or the fallback after a failure), or null. */
  get live(): GuardedPass | null {
    if (!this.failed) return this;
    return this.fallback && this.fallbackReady ? this.fallback.live : null;
  }

  get enabled(): boolean {
    if (!this.want) return false;
    if (!this.failed) return this.inner.enabled;
    return !!this.live && this.live.inner.enabled;
  }
  set enabled(v: boolean) {
    this.want = v;
  }

  fail(where: string, e: unknown): void {
    if (this.failed) return;
    const msg = e instanceof Error ? e.message : String(e);
    this.failed = `${where}: ${msg}`;
    console.error(`[app] ${this.label} pass (${this.source}) failed in ${where} — disabled${this.fallback ? ', using fallback' : ''}.`, e);
    if (this.fallback && this.ctx) void this.initFallback(this.ctx);
  }

  private async initFallback(ctx: PipelineContext): Promise<void> {
    if (!this.fallback || this.fallbackReady) return;
    await this.fallback.init(ctx);
    this.fallbackReady = !this.fallback.failed;
  }

  private run<T>(where: string, fn: () => T): T | undefined {
    const prev = GuardedPass.current;
    GuardedPass.current = this;
    try {
      return fn();
    } catch (e) {
      this.fail(where, e);
      return undefined;
    } finally {
      GuardedPass.current = prev;
    }
  }

  async init(ctx: PipelineContext): Promise<void> {
    this.ctx = ctx;
    const prev = GuardedPass.current;
    GuardedPass.current = this;
    try {
      await this.inner.init(ctx);
    } catch (e) {
      this.fail('init', e);
    } finally {
      GuardedPass.current = prev;
    }
    if (this.failed) await this.initFallback(ctx);
  }

  resize(ctx: PipelineContext): void {
    this.ctx = ctx;
    if (!this.failed) this.run('resize', () => this.inner.resize?.(ctx));
    else this.live?.resize(ctx);
  }

  update(f: FrameState, ctx: PipelineContext): void {
    if (!this.failed) this.run('update', () => this.inner.update?.(f, ctx));
    else this.live?.update(f, ctx);
  }

  render(f: FrameState, ctx: PipelineContext): void {
    if (!this.failed) this.run('render', () => this.inner.render(f, ctx));
    else this.live?.render(f, ctx);
  }

  stats(): Record<string, string | number> {
    if (this.failed) return this.live ? { ...this.live.stats(), fallback: 1 } : { failed: 1 };
    try {
      return this.inner.stats?.() ?? {};
    } catch {
      return {};
    }
  }

  dispose(): void {
    try {
      this.inner.dispose?.();
    } catch {
      /* ignore */
    }
  }

  status(): PassStatus {
    if (!this.failed) return { name: this.label, source: this.source, state: 'ok' };
    if (this.live) return { name: this.label, source: `${this.live.source} (fallback)`, state: 'fallback', error: this.failed };
    return { name: this.label, source: this.source, state: 'failed', error: this.failed };
  }
}

// ------------------------------------------------------------------ minimal post pass (fallback)
const FALLBACK_POST_FRAG = /* glsl */ `
precision highp float; precision highp sampler2D;
uniform sampler2D tHdr;
uniform float uExposure;
in vec2 vUv;
layout(location = 0) out vec4 o;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() { o = vec4(toSRGB(aces(max(texture(tHdr, vUv).rgb, vec3(0.0)) * uExposure)), 1.0); }`;

export class FallbackPostPass implements PostLike {
  readonly name = 'post';
  enabled = true;
  exposure = 0.25;
  private fs!: FullscreenPass;
  init(): void {
    this.fs = new FullscreenPass({ fragmentShader: FALLBACK_POST_FRAG, uniforms: { tHdr: { value: null }, uExposure: { value: 0.25 } } });
  }
  render(f: FrameState, ctx: PipelineContext): void {
    this.exposure = 0.25 * Math.pow(2, f.settings.exposureEV);
    this.fs.material.uniforms.tHdr.value = ctx.hdrRT.texture;
    this.fs.material.uniforms.uExposure.value = this.exposure;
    this.fs.render(ctx.renderer, null);
    f.exposure = this.exposure;
  }
  stats(): Record<string, string | number> {
    return { EV: Math.log2(this.exposure / 0.25).toFixed(1), mode: 'fallback' };
  }
}

// ------------------------------------------------------------------ loading
type Ctor = new () => RenderPass;

async function tryImport<T>(label: string, load: () => Promise<T>): Promise<{ mod: T | null; error?: string }> {
  try {
    return { mod: await load() };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[app] could not load the ${label} pass module:`, e);
    return { mod: null, error };
  }
}

function construct(label: string, C: unknown): RenderPass | null {
  if (typeof C !== 'function') return null;
  try {
    return new (C as Ctor)();
  } catch (e) {
    console.error(`[app] ${label} pass constructor threw:`, e);
    return null;
  }
}

export interface LoadedPasses {
  passes: PipelinePasses;
  guards: GuardedPass[];
  /** the real PostPass when it is the live post pass (for exposure readout / snapExposure) */
  post(): PostLike | null;
}

export interface PassLoadOptions {
  /** use the orchestrator's stub far/ring passes and no near field (isolated app testing) */
  stubs?: boolean;
}

export async function loadPasses(opts: PassLoadOptions = {}): Promise<LoadedPasses> {
  const [farStubM, ringStubM] = await Promise.all([
    tryImport('far-field stub', () => import('../render/passes/stubs/FarFieldStub')),
    tryImport('ring-layer stub', () => import('../render/passes/stubs/RingLayerStub')),
  ]);
  const farStub = construct('far-field stub', farStubM.mod?.FarFieldStub);
  const ringStub = construct('ring-layer stub', ringStubM.mod?.RingLayerStub);
  const guards: GuardedPass[] = [];
  const passes: PipelinePasses = {};

  // far field
  let far: RenderPass | null = null;
  if (!opts.stubs) {
    const m = await tryImport('far-field', () => import('../render/passes/FarFieldPass'));
    far = construct('far-field', m.mod?.FarFieldPass);
  }
  const farStubG = farStub ? new GuardedPass(farStub, 'far field', 'stub') : null;
  if (far) passes.far = new GuardedPass(far, 'far field', 'FarFieldPass', farStubG);
  else if (farStubG) passes.far = farStubG;

  // near field (no fallback: without it, the ring-layer pass carries all optical depth)
  if (!opts.stubs) {
    const m = await tryImport('near-field', () => import('../render/passes/NearFieldPass'));
    const near = construct('near-field', m.mod?.NearFieldPass);
    if (near) passes.near = new GuardedPass(near, 'near field', 'NearFieldPass');
  }

  // ring layer
  let rings: RenderPass | null = null;
  if (!opts.stubs) {
    const m = await tryImport('ring-layer', () => import('../render/passes/RingLayerPass'));
    rings = construct('ring-layer', m.mod?.RingLayerPass);
  }
  const ringStubG = ringStub ? new GuardedPass(ringStub, 'ring layer', 'stub') : null;
  if (rings) passes.rings = new GuardedPass(rings, 'ring layer', 'RingLayerPass', ringStubG);
  else if (ringStubG) passes.rings = ringStubG;

  // post
  const pm = await tryImport('post', () => import('../render/PostPass'));
  const realPost = construct('post', pm.mod?.PostPass) as PostLike | null;
  const fb = new GuardedPass(new FallbackPostPass(), 'post', 'fallback tone mapper');
  const postG = realPost ? new GuardedPass(realPost, 'post', 'PostPass', fb) : fb;
  passes.post = postG;

  for (const g of [passes.far, passes.near, passes.rings, passes.post]) if (g) guards.push(g as GuardedPass);
  return {
    passes,
    guards,
    post: () => (realPost && !postG.failed ? realPost : null),
  };
}

/** Route three.js shader compile errors to the pass being rendered, and disable it. */
export function installShaderErrorHook(renderer: WebGLRenderer): void {
  renderer.debug.checkShaderErrors = true;
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const pass = GuardedPass.current;
    const parts: string[] = [];
    const pl = gl.getProgramInfoLog(program);
    if (pl) parts.push(`program: ${pl.trim()}`);
    for (const [kind, sh] of [['vertex', vs], ['fragment', fs]] as const) {
      if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) continue;
      const log = (gl.getShaderInfoLog(sh) ?? '').trim();
      const src = (gl.getShaderSource(sh) ?? '').split('\n');
      const m = /ERROR: \d+:(\d+)/.exec(log);
      let ctxLines = '';
      if (m) {
        const ln = parseInt(m[1], 10);
        ctxLines = src.slice(Math.max(0, ln - 4), ln + 2).map((l, i) => `${Math.max(1, ln - 3) + i}: ${l}`).join('\n');
      }
      parts.push(`${kind}: ${log}${ctxLines ? `\n${ctxLines}` : ''}`);
    }
    console.error(`[app] shader compile error in the ${pass ? pass.label : 'unknown'} pass:\n${parts.join('\n')}`);
    if (pass) pass.fail('shader', new Error('shader compile error'));
  };
}
