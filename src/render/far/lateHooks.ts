// Late HDR hooks: draw calls that must happen AFTER the ring layer has composited the rings (i.e. into
// ctx.hdrRT), before metering / glare / tone mapping. PostPass runs them at the start of its render().
//
// Used by the far field for sub-pixel moons: their light must not be attenuated by rings that lie behind
// them, nor may they punch holes into rings in front of which they sit — a single opaque distance per
// pixel (sceneRT.a) cannot express a sub-pixel source, so they are added here with an analytic ring
// transmission and an occlusion test against sceneRT.a. (Recommended pipeline change: an explicit
// "overlay" step between the ring layer and post.)
import type { FrameState } from '../../core/FrameState';
import type { PipelineContext } from '../Pipeline';

export type LateHdrHook = (f: FrameState, ctx: PipelineContext) => void;

const hooks = new WeakMap<object, Set<LateHdrHook>>();

export function addLateHdrHook(ctx: PipelineContext, hook: LateHdrHook): void {
  let s = hooks.get(ctx);
  if (!s) hooks.set(ctx, (s = new Set()));
  s.add(hook);
}
export function removeLateHdrHook(ctx: PipelineContext, hook: LateHdrHook): void {
  hooks.get(ctx)?.delete(hook);
}
export function runLateHdrHooks(f: FrameState, ctx: PipelineContext): void {
  const s = hooks.get(ctx);
  if (!s) return;
  for (const h of s) h(f, ctx);
}
