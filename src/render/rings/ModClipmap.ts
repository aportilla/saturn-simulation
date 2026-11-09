// Camera-centred clipmap of the 2-D optical-depth modulation of sv_ringStructure (sub-km texture x propellers):
// (M, self-gravity-wake strength factor) = ringStructureMod(aL, dth, fp).xz on a Lagrangian polar grid (aL = a' - r0,
// S = r0 dth). Read by sv_ringModClip's rsModCached (GLSL; documentation of the layout and the prefilter there): the
// near field's presence test (nearUpdate.glsl) and the march's modulation near the camera (rlMarch.glsl). Owned by the
// Pipeline: updated and rendered every frame after the 2-D structure and the local LOD, before any pass renders.
//
// Level k: MC_NR x MC_NS texels of dr_k x MC_ASPECT dr_k, dr_k = d0 2^k (d0 = 1 m), centred on the camera's Lagrangian
// position (snapped to the level's texels, so texel centres are fixed in the ring frame), coverage +-MC_NR/2 dr_k;
// levels are added until they cover the largest near-field particle box (RingLod.maxBox) or MC_LEVELS. Stacked
// vertically in one RGBA32F atlas (LINEAR: bilinear lookups): (M, wake factor, tau0 x M for maxNear, -).
//
// Refresh (incremental, like the wake clipmap): a level is re-rendered when it is invalid, the ring frame was
// re-anchored, the camera moved by > 1/16 of its coverage, or the pattern drifted by > 1/8 of an azimuthal texel since
// it was rendered -- material at radius offset x moves along the ring frame at 1.5 Omega x (the texture is carried by
// the material: up to the level's edge; a propeller's structure moves with its moonlet, up to MC_PROP_REACH beyond
// it) -- at most `maxPerFrame` levels per frame (invalid / anchor-changed first, then finest first). Until a level is
// valid its points are evaluated directly (exact). Each level keeps its own centre, so a level not refreshed this frame
// stays self-consistent.
//
// Allocation bound (maxNear): after any refresh, a reduction pass writes the maximum of M over every block of
// MC_BLOCK x MC_BLOCK texels of every level, dilated by one texel (a bilinear lookup inside a block reaches one texel
// beyond it), and reads it back asynchronously (pixel-pack buffer + fence). The CPU bounds M over a square around the
// camera's Lagrangian position by the blocks overlapping it, in every level valid at the read-back -- the values the
// near field's presence test actually uses (texture x propellers jointly, at each level's prefilter) -- and likewise
// tau0 x M jointly (a third channel: the largest tau0 over each texel's support x its M), so the particles of a size
// class need to be generated only at that local maximum of their presence factor (Pipeline.updateLocalRing), not at
// max tau0 x the modulation's global bound (the texture's 3-sigma clamp: 1.43 in the B-ring core).
import {
  ClampToEdgeWrapping, FloatType, LinearFilter, NearestFilter, RGBAFormat, Vector4, WebGLRenderTarget, type WebGLRenderer,
} from 'three';
import type { FrameState } from '../../core/FrameState';
import type { RingStructure } from '../../rings/RingStructure';
import { ringDr } from '../../rings/RingStructure';
import { FullscreenPass } from '../fullscreen';
import { SV_HEADER_ALL } from '../shaders/chunks';

/** texels per level: radial, azimuthal (sv_ringModClip uMcInfo.yz) */
export const MC_NR = 512;
export const MC_NS = 128;
/** azimuthal / radial texel size */
export const MC_ASPECT = 4;
/** level slots (MC_LEVELS in sv_ringModClip) */
export const MC_LEVELS = 9;
/** finest radial texel (m) */
export const MC_D0 = 1;
/** radial reach (m) of the largest propeller structures beyond the level (belt propellers: 13.5 r_H <= 4.7 km) */
const MC_PROP_REACH = 4700;
/** texels per side of a block of the maximum map (maxNear) */
export const MC_BLOCK = 16;
const MC_BR = MC_NR / MC_BLOCK, MC_BS = MC_NS / MC_BLOCK;

// maxima of M and of P = tau0 x M over each block (+ a one-texel ring) of each level; one fragment per block
const MAX_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tMc;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy);
  int level = b.y / ${MC_BS};
  int y0 = level * ${MC_NS};
  ivec2 lo = ivec2(0, y0), hi = ivec2(${MC_NR - 1}, y0 + ${MC_NS - 1});
  ivec2 t0 = ivec2(b.x * ${MC_BLOCK}, y0 + (b.y - level * ${MC_BS}) * ${MC_BLOCK}) - 1;
  vec2 m = vec2(0.0);
  for (int dy = 0; dy < ${MC_BLOCK + 2}; dy++) {
    for (int dx = 0; dx < ${MC_BLOCK + 2}; dx++) m = max(m, texelFetch(tMc, clamp(t0 + ivec2(dx, dy), lo, hi), 0).rb);
  }
  outColor = vec4(m, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
${SV_HEADER_ALL}
uniform vec4 uMcB;   // level being built: (centre aL, centre S, dr, first atlas row)
layout(location = 0) out vec4 outColor;
// the largest tau0 (level-0 profile at the Lagrangian radius, as the presence test reads it) over [aL - dr, aL + dr]:
// the profile is piecewise linear, so at the interval's ends or at an interior node
float mcTauMaxSupport(float aL, float dr) {
  float m = max(ringSampleLagrangian(aL - dr, 0.0).tau, ringSampleLagrangian(aL + dr, 0.0).tau);
  float i0 = uRsIdx0.y + (aL - dr) / uRingDr0, i1 = uRsIdx0.y + (aL + dr) / uRingDr0;
  float n0 = ceil(i0);
  for (int j = 0; j < 4; j++) {
    float n = n0 + float(j);
    if (n > i1) break;
    m = max(m, ringSampleIdxPrecise(uRsIdx0.x, n, 0.0).tau);
  }
  return m;
}
void main() {
  float dr = uMcB.z;
  float aL = uMcB.x + (gl_FragCoord.x - 0.5 * ${MC_NR}.0) * dr;
  float S = uMcB.y + (gl_FragCoord.y - uMcB.w - 0.5 * ${MC_NS}.0) * dr * ${MC_ASPECT}.0;
  // (M, -, wake factor) prefiltered at the level's radial texel; P = the largest tau0 this texel's lookups can meet x M
  // (the allocation bound's joint maximum, maxNear)
  vec3 m = ringStructureMod(aL, S / uRingR0, dr);
  outColor = vec4(m.x, m.z, mcTauMaxSupport(aL, dr) * m.x, 1.0);
}`;

interface LevelState {
  cr: number;
  cs: number;
  d: number;
  t: number;
  anchorId: number;
  valid: boolean;
}

export class ModClipmap {
  readonly rt: WebGLRenderTarget;
  /** sv_ringModClip uniforms (shared objects: spread into the shared set before the passes' materials are made) */
  readonly uniforms: { uMcTex: { value: unknown }; uMcLev: { value: Vector4[] }; uMcInfo: { value: Vector4 } };
  /** false: no cache (every lookup evaluates the modulation directly, the allocation takes the analytic bound) */
  enabled = true;
  /**
   * false: the shaders evaluate the modulation directly while the cache keeps updating and bounding the allocation (A/B
   * tests of the lookups with the same particles: switching `enabled` off re-fits the near field)
   */
  useInShaders = true;
  maxPerFrame = 3;
  levelCount = 0;
  /** levels re-rendered in the last frame (stats) */
  rendered = 0;
  private fs: FullscreenPass;
  private st: LevelState[] = [];
  private want: { cr: number; cs: number; d: number }[] = [];
  private todo: number[] = [];
  private wantT = 0;
  private wantAnchor = -1;
  private modelKey = '';
  // block maxima (maxNear): reduction target, in-flight read-back, last result and the level states it describes
  private maxRT: WebGLRenderTarget;
  private maxFs: FullscreenPass;
  private maxDirty = false;
  private maxPending: { pbo: WebGLBuffer; fence: WebGLSync; st: LevelState[] } | null = null;
  private readonly maxBuf = new Float32Array(MC_BR * MC_BS * MC_LEVELS * 4);
  private maxState: LevelState[] | null = null;
  /** read-backs of the block maxima completed (tests) */
  maxVersion = 0;

  constructor(shared: Record<string, { value: any }>) {
    this.maxRT = new WebGLRenderTarget(MC_BR, MC_BS * MC_LEVELS, {
      type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.rt = new WebGLRenderTarget(MC_NR, MC_NS * MC_LEVELS, {
      type: FloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    for (let k = 0; k < MC_LEVELS; k++) {
      this.st.push({ cr: 0, cs: 0, d: 0, t: -1e30, anchorId: -1, valid: false });
      this.want.push({ cr: 0, cs: 0, d: 1 });
    }
    this.uniforms = {
      uMcTex: { value: this.rt.texture },
      uMcLev: { value: Array.from({ length: MC_LEVELS }, () => new Vector4(0, 0, 1, 0)) },
      uMcInfo: { value: new Vector4(0, MC_NR, MC_NS, MC_ASPECT) },
    };
    this.fs = new FullscreenPass({ fragmentShader: FRAG, uniforms: { ...shared, uMcB: { value: new Vector4() } } });
    this.maxFs = new FullscreenPass({ fragmentShader: MAX_FRAG, uniforms: { tMc: { value: this.rt.texture } } });
  }

  /**
   * Per frame, after RingStructure.update and the local LOD: the level layout around the camera's Lagrangian position
   * covering `reach` (m; the largest particle box + margins; 0 = no cache needed) and the levels to refresh.
   */
  update(f: FrameState, structure: RingStructure, reach: number, propellersNear: boolean): void {
    this.todo.length = 0;
    const lev = this.uniforms.uMcLev.value;
    if (!this.enabled || !(reach > 0)) {
      this.levelCount = 0;
      this.uniforms.uMcInfo.value.x = 0;
      return;
    }
    // the model's switches (tests toggle them): any change invalidates the cache
    const key = `${structure.texture.amp}|${structure.propellers.scale}`;
    if (key !== this.modelKey) {
      this.modelKey = key;
      for (const s of this.st) s.valid = false;
      // (the last block maxima describe the old model; an in-flight read-back too)
      this.maxState = null;
      if (this.maxPending) this.maxPending.st.forEach((s) => { s.valid = false; });
    }
    const r0 = f.ring.r0, c = f.ring.camLocal;
    // the camera's Lagrangian position (radial offset of its streamline, arc at r0)
    const aLc = ringDr(r0, c.x, c.y) + structure.cam.da;
    const sc = r0 * Math.atan2(c.y, r0 + c.x);
    let n = 0;
    let d = MC_D0;
    while (n < MC_LEVELS) {
      const w = this.want[n];
      w.d = d;
      w.cr = Math.round(aLc / d) * d;
      w.cs = Math.round(sc / (d * MC_ASPECT)) * d * MC_ASPECT;
      n++;
      if (0.4 * MC_NR * d >= reach) break;   // (the outer 20 % of a level blends into the next)
      d *= 2;
    }
    this.levelCount = n;
    this.wantT = f.t;
    this.wantAnchor = f.ring.anchorId;
    const om = Math.max(f.ring.omega, 1e-9);
    for (let k = 0; k < n; k++) {
      const s = this.st[k], w = this.want[k];
      const cover = 0.5 * MC_NR * w.d;
      // pattern drift along the orbit at the level's farthest point (texture: the material's shear; propellers: their
      // moonlets' rate, up to MC_PROP_REACH beyond the level) -> stale after 1/8 of an azimuthal texel
      const rate = 1.5 * om * (Math.abs(aLc) + cover + (propellersNear ? MC_PROP_REACH : 0));
      const tStale = (0.125 * w.d * MC_ASPECT) / rate;
      const dirty = !s.valid || s.anchorId !== this.wantAnchor || s.d !== w.d ||
        Math.abs(s.cr - w.cr) > cover / 16 || Math.abs(s.cs - w.cs) > cover / 16 || Math.abs(f.t - s.t) > tStale;
      if (dirty) this.todo.push(k);
    }
    // invalid levels and anchor changes first, then finest first
    this.todo.sort((a, b) => {
      const ia = this.st[a].valid && this.st[a].anchorId === this.wantAnchor ? 1 : 0;
      const ib = this.st[b].valid && this.st[b].anchorId === this.wantAnchor ? 1 : 0;
      return ia - ib || a - b;
    });
    if (this.todo.length > this.maxPerFrame) this.todo.length = this.maxPerFrame;
    // the content as rendered (levels beyond the count or from another anchor are not usable)
    for (let k = 0; k < MC_LEVELS; k++) {
      const s = this.st[k];
      const usable = k < n && s.valid && s.anchorId === this.wantAnchor;
      lev[k].set(s.cr, s.cs, 1 / (s.d || 1), usable ? 1 : 0);
    }
    this.uniforms.uMcInfo.value.x = this.useInShaders ? n : 0;
  }

  /** Re-render the levels chosen by update() (before any pass renders); block maxima of what changed. */
  render(renderer: WebGLRenderer): void {
    this.rendered = 0;
    this.pollMax(renderer);
    if (this.levelCount === 0) return;
    if (this.todo.length > 0) this.renderLevels(renderer);
    if (this.maxDirty && !this.maxPending) this.startMax(renderer);
  }

  private renderLevels(renderer: WebGLRenderer): void {
    const u = this.fs.material.uniforms;
    const lev = this.uniforms.uMcLev.value;
    for (const k of this.todo) {
      const w = this.want[k];
      (u.uMcB.value as Vector4).set(w.cr, w.cs, w.d, k * MC_NS);
      this.rt.viewport.set(0, k * MC_NS, MC_NR, MC_NS);
      this.rt.scissor.set(0, k * MC_NS, MC_NR, MC_NS);
      this.rt.scissorTest = true;
      this.fs.render(renderer, this.rt);
      const s = this.st[k];
      s.cr = w.cr; s.cs = w.cs; s.d = w.d; s.t = this.wantT; s.anchorId = this.wantAnchor; s.valid = true;
      lev[k].set(s.cr, s.cs, 1 / s.d, 1);
      this.rendered++;
    }
    this.rt.scissorTest = false;
    this.rt.viewport.set(0, 0, MC_NR, MC_NS * MC_LEVELS);
    this.maxDirty = true;
  }

  /** reduction to block maxima + asynchronous read-back (pollMax picks it up once the GPU is done) */
  private startMax(renderer: WebGLRenderer): void {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.maxFs.render(renderer, this.maxRT);
    const pbo = gl.createBuffer();
    if (!pbo) return;
    renderer.setRenderTarget(this.maxRT);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.maxBuf.byteLength, gl.STREAM_READ);
    gl.readPixels(0, 0, MC_BR, MC_BS * MC_LEVELS, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    renderer.setRenderTarget(null);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!fence) { gl.deleteBuffer(pbo); return; }
    gl.flush();
    this.maxPending = { pbo, fence, st: this.st.map((s) => ({ ...s })) };
    this.maxDirty = false;
  }
  private pollMax(renderer: WebGLRenderer): void {
    const p = this.maxPending;
    if (!p) return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (gl.getSyncParameter(p.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return;
    gl.deleteSync(p.fence);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.maxBuf);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteBuffer(p.pbo);
    this.maxPending = null;
    this.maxState = p.st;
    this.maxVersion++;
  }

  /**
   * Upper bound over the square |aL - aLc| <= hw, |S - sc| <= hw (Lagrangian polar offsets, m) of the cached M (which
   * = 0: the values rsModCached returns -- bilinear lookups and level blends never exceed the texels they combine) or
   * of tau0 x M, the presence test's tau (which = 1: each texel holds the largest tau0 over its +-dr support x its M;
   * at any point tau0 is at most every surrounding texel's support maximum and M at most the largest surrounding M, so
   * the product is at most that texel's value), from the last read-back of the block maxima; null when nothing usable
   * was read back yet, the ring frame was re-anchored since, or no valid level covered the whole square then (points
   * outside every level are evaluated directly: unbounded here).
   */
  maxNear(aLc: number, sc: number, hw: number, anchorId: number, which: 0 | 1 = 0): number | null {
    const S = this.maxState;
    if (!S || !this.enabled) return null;
    let m = 0, covered = false;
    for (let k = 0; k < MC_LEVELS; k++) {
      const s = S[k];
      if (!s.valid || s.anchorId !== anchorId) continue;
      // the level's usable area (sv_ringModClip: 1.5 texels inside its edge)
      const hr = (0.5 * MC_NR - 1.5) * s.d, hs = (0.5 * MC_NS - 1.5) * s.d * MC_ASPECT;
      const r0 = Math.max(aLc - hw, s.cr - hr), r1 = Math.min(aLc + hw, s.cr + hr);
      const s0 = Math.max(sc - hw, s.cs - hs), s1 = Math.min(sc + hw, s.cs + hs);
      if (r0 > r1 || s0 > s1) continue;
      if (aLc - hw >= s.cr - hr && aLc + hw <= s.cr + hr && sc - hw >= s.cs - hs && sc + hw <= s.cs + hs) covered = true;
      // blocks overlapping the intersection
      const br = MC_BLOCK * s.d, bs = MC_BLOCK * s.d * MC_ASPECT;
      const i0 = Math.max(0, Math.floor((r0 - s.cr) / br + MC_BR / 2)), i1 = Math.min(MC_BR - 1, Math.floor((r1 - s.cr) / br + MC_BR / 2));
      const j0 = Math.max(0, Math.floor((s0 - s.cs) / bs + MC_BS / 2)), j1 = Math.min(MC_BS - 1, Math.floor((s1 - s.cs) / bs + MC_BS / 2));
      for (let j = j0; j <= j1; j++) {
        const row = (k * MC_BS + j) * MC_BR;
        for (let i = i0; i <= i1; i++) m = Math.max(m, this.maxBuf[(row + i) * 4 + which]);
      }
    }
    return covered && m > 0 ? m : null;
  }

  stats(): string {
    return this.levelCount > 0 ? `${this.levelCount} levels (${MC_D0}-${MC_D0 * 2 ** (this.levelCount - 1)} m), ${this.rendered} refreshed` : 'off';
  }

  dispose(): void {
    this.maxPending = null;
    this.rt.dispose();
    this.fs.dispose();
    this.maxRT.dispose();
    this.maxFs.dispose();
  }
}
