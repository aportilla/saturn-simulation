// Camera-centred clipmap of the self-gravity-wake surface-density factor W(x, y) (local Hill frame),
// evaluated with the shared sv_wakes `wakeDensity` (the same field the near-field particles follow).
// `wakeDensity` costs ~10 texture fetches (+6 with asynchrony), so the ray marcher reads this cache instead (1 fetch/step).
//
// Level k has N x N texels of size d_k = d_0 * 2^k centred (snapped) on the camera; levels are stacked
// vertically in one R16F atlas (N x N*6). d_0 follows the pixel footprint at the camera's height above
// the ring plane (quantized to powers of two); levels are added until the texel exceeds ~lambda/4 (wakes
// unresolvable beyond) or the level covers the distance where wakes span < 2 px.
//
// Levels are refreshed incrementally: only when the camera has moved by > 1/16 of the level's coverage,
// its texel size changed, the anchor changed, or the wake pattern has evolved (sheared) noticeably since
// it was rendered — at most `maxPerFrame` levels per frame (finest first). Each level keeps its own
// centre/texel size, so a level that is not refreshed stays self-consistent.
import {
  HalfFloatType, LinearFilter, RedFormat, Vector4, WebGLRenderTarget, ClampToEdgeWrapping,
  type WebGLRenderer,
} from 'three';
import type { FrameState } from '../../core/FrameState';
import type { PipelineContext } from '../Pipeline';
import { FullscreenPass } from '../fullscreen';
import { SV_HEADER_ALL } from '../shaders/chunks';

export const WAKE_CLIP_N = 1024;
export const WAKE_CLIP_MAX_LEVELS = 6;

const FRAG = /* glsl */ `
${SV_HEADER_ALL}
uniform vec4 uLev;
uniform float uN;
uniform float uLevIndex;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 ij = vec2(gl_FragCoord.x, gl_FragCoord.y - uLevIndex * uN) - 0.5 * uN;
  vec2 xy = uLev.xy + ij * uLev.z;
  // texel = box average of the density over its area (2x2 supersampling): the wake crests are much
  // sharper than coarse texels, and the optical depth is linear in W, so this is the right prefilter
  float h = 0.25 * uLev.z;
  float w = wakeDensity(xy + vec2(-h, -h)) + wakeDensity(xy + vec2(h, -h))
          + wakeDensity(xy + vec2(-h, h)) + wakeDensity(xy + vec2(h, h));
  outColor = vec4(0.25 * w, 0.0, 0.0, 1.0);
}`;

interface LevelState {
  cx: number;
  cy: number;
  d: number;
  t: number;
  anchorId: number;
  valid: boolean;
}

export class WakeClipmap {
  readonly rt: WebGLRenderTarget;
  /** state of each level as rendered (xyz = centre x, centre y, texel; w = valid) — main-pass uniform */
  readonly levels: Vector4[] = [];
  levelCount = 0;
  /** texel size of level 0 (m) */
  d0 = 1;
  maxPerFrame = 2;
  /** levels re-rendered in the last frame (stats) */
  rendered = 0;
  private fs: FullscreenPass;
  private st: LevelState[] = [];
  private want: { cx: number; cy: number; d: number }[] = [];
  private todo: number[] = [];
  private wantT = 0;
  private wantAnchor = 0;
  private readonly cmp = (a: number, b: number): number => {
    const ia = this.st[a].valid && this.st[a].anchorId === this.wantAnchor ? 1 : 0;
    const ib = this.st[b].valid && this.st[b].anchorId === this.wantAnchor ? 1 : 0;
    return ia - ib || a - b;
  };

  constructor(ctx: PipelineContext) {
    for (let i = 0; i < WAKE_CLIP_MAX_LEVELS; i++) {
      this.levels.push(new Vector4(0, 0, 1, 0));
      this.st.push({ cx: 0, cy: 0, d: 0, t: -1e30, anchorId: -1, valid: false });
      this.want.push({ cx: 0, cy: 0, d: 1 });
    }
    this.rt = new WebGLRenderTarget(WAKE_CLIP_N, WAKE_CLIP_N * WAKE_CLIP_MAX_LEVELS, {
      type: HalfFloatType,
      format: RedFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.fs = new FullscreenPass({
      fragmentShader: FRAG,
      uniforms: { ...ctx.shared.u, uLev: { value: new Vector4() }, uN: { value: WAKE_CLIP_N }, uLevIndex: { value: 0 } },
    });
  }

  /**
   * Choose the level layout for this frame and decide which levels to refresh. Returns false if no level
   * is needed (wakes off, camera far from the ring plane).
   */
  configure(f: FrameState, lambda: number, omega: number, enabled: boolean): boolean {
    this.todo.length = 0;
    if (!enabled) {
      this.levelCount = 0;
      return false;
    }
    const zc = Math.abs(f.ring.camLocal.z);
    const pa = f.pixelAngle;
    if (!(Number.isFinite(zc) && Number.isFinite(pa) && pa > 0 && Number.isFinite(lambda) && lambda > 0) || zc * pa > lambda / 2) {
      this.levelCount = 0;
      return false;
    }
    // finest texel ~ half the pixel footprint at the nearest ring point (power of two), >= 0.35 m
    const raw = Math.min(Math.max(0.5 * zc * pa, 0.35), lambda / 8);
    const d0 = Math.pow(2, Math.round(Math.log2(raw)));
    this.d0 = d0;
    const cx = f.ring.camLocal.x;
    const cy = f.ring.camLocal.y;
    let n = 0;
    let d = d0;
    while (n < WAKE_CLIP_MAX_LEVELS) {
      const s = 2 * d;
      const w = this.want[n];
      w.cx = Math.round(cx / s) * s;
      w.cy = Math.round(cy / s) * s;
      w.d = d;
      n++;
      const halfCover = 0.5 * WAKE_CLIP_N * d;
      if (d >= lambda / 4 || halfCover > lambda / (2 * pa)) break;
      d *= 2;
    }
    this.levelCount = n;
    this.wantT = f.t;
    this.wantAnchor = f.ring.anchorId;
    // pattern evolution: shear S = q Omega age changes the displacement by ~dS * L; refresh when the
    // accumulated orbital phase since the last render exceeds ~0.003 rad
    const tStale = 0.003 / Math.max(omega, 1e-9);
    for (let k = 0; k < n; k++) {
      const s = this.st[k], w = this.want[k];
      const cover = 0.5 * WAKE_CLIP_N * w.d;
      const dirty = !s.valid || s.anchorId !== this.wantAnchor || s.d !== w.d ||
        Math.abs(s.cx - w.cx) > cover / 16 || Math.abs(s.cy - w.cy) > cover / 16 || Math.abs(f.t - s.t) > tStale;
      if (dirty) this.todo.push(k);
    }
    // invalid levels and anchor changes first, then finest first
    this.todo.sort(this.cmp);
    if (this.todo.length > this.maxPerFrame) this.todo.length = this.maxPerFrame;
    // levels beyond the count or from another anchor are not usable
    for (let k = 0; k < WAKE_CLIP_MAX_LEVELS; k++) {
      const s = this.st[k];
      const usable = k < n && s.valid && s.anchorId === this.wantAnchor;
      this.levels[k].set(s.cx, s.cy, s.d || 1, usable ? 1 : 0);
    }
    return true;
  }

  render(renderer: WebGLRenderer): void {
    this.rendered = 0;
    if (this.levelCount === 0 || this.todo.length === 0) return;
    const u = this.fs.material.uniforms;
    const N = WAKE_CLIP_N;
    for (const k of this.todo) {
      const w = this.want[k];
      (u.uLev.value as Vector4).set(w.cx, w.cy, w.d, 0);
      u.uLevIndex.value = k;
      this.rt.viewport.set(0, k * N, N, N);
      this.rt.scissor.set(0, k * N, N, N);
      this.rt.scissorTest = true;
      this.fs.render(renderer, this.rt);
      const s = this.st[k];
      s.cx = w.cx; s.cy = w.cy; s.d = w.d; s.t = this.wantT; s.anchorId = this.wantAnchor; s.valid = true;
      this.levels[k].set(s.cx, s.cy, s.d, 1);
      this.rendered++;
    }
    this.rt.scissorTest = false;
    this.rt.viewport.set(0, 0, N, N * WAKE_CLIP_MAX_LEVELS);
  }

  dispose(): void {
    this.rt.dispose();
    this.fs.dispose();
  }
}
