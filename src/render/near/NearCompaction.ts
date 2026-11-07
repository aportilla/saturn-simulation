// GPU stream compaction of the near-field particle slots (HistoPyramid, Ziegler et al. 2006).
//
// The update pass leaves one RGBA32F texel per particle slot (R0). Only a few percent of the slots are
// drawn, randomly scattered, so drawing every slot would make each SIMD group of vertices pay for the
// drawn few. Instead a reduction pyramid counts, per 2x2 block, how many slots belong to each output
// list (rgba = point sprites, quads, shadow casters, -), and the draw vertex shaders walk the pyramid
// top-down to find their j-th list element: exactly one (coherent) vertex per drawn particle.
//
// The pyramid levels live side by side in two atlases (level L in atlas L&1) so that each reduction
// pass reads one atlas and writes the other (no framebuffer/texture feedback loop).
import { FloatType, GLSL3, Mesh, NearestFilter, NoBlending, RawShaderMaterial, RGBAFormat, WebGLRenderTarget, type IUniform, type WebGLRenderer } from 'three';
import { fsCamera, fullscreenGeometry, FS_VERT } from '../fullscreen';

export const MAX_PYR_LEVELS = 16;

export interface PyrLevel {
  xOff: number;
  w: number;
  h: number;
  atlas: number;
}

/**
 * GLSL shared by the reduction and the traversal: class lookup by texture row, classification of a slot.
 * Requires the including shader to provide `vec4 nearClassify(ivec2 tc)` (defined in NearFieldPass,
 * because it depends on view and shadow parameters) and the uniforms below.
 */
export const NEAR_PYR_GLSL = /* glsl */ `
uniform sampler2D tPyrA;
uniform sampler2D tPyrB;
uniform int uPyrTop;                      // number of pyramid levels (level uPyrTop is 1x1)
uniform ivec4 uPyrLv[${MAX_PYR_LEVELS}];   // level L (1-based) at [L-1]: (xOff, w, h, atlas)

float nearPyrCount(int L, ivec2 p, int lst) {
  ivec4 lv = uPyrLv[L - 1];
  if (p.x >= lv.y || p.y >= lv.z) return 0.0;
  ivec2 q = ivec2(lv.x + p.x, p.y);
  vec4 v = lv.w == 0 ? texelFetch(tPyrA, q, 0) : texelFetch(tPyrB, q, 0);
  return v[lst];
}
float nearListTotal(int lst) { return nearPyrCount(uPyrTop, ivec2(0), lst); }
// Texel (in the slot texture) of the j-th element of list lst; false if j is past the end of the list.
bool nearListFetch(int lst, int j, out ivec2 tc) {
  float jj = float(j);
  tc = ivec2(0);
  if (jj >= nearListTotal(lst)) return false;
  ivec2 p = ivec2(0);
  for (int L = ${MAX_PYR_LEVELS}; L >= 2; L--) {
    if (L > uPyrTop) continue;
    p *= 2;
    float c0 = nearPyrCount(L - 1, p, lst);
    float c1 = nearPyrCount(L - 1, p + ivec2(1, 0), lst);
    float c2 = nearPyrCount(L - 1, p + ivec2(0, 1), lst);
    if (jj < c0) {
    } else if (jj < c0 + c1) { p.x += 1; jj -= c0; }
    else if (jj < c0 + c1 + c2) { p.y += 1; jj -= c0 + c1; }
    else { p += ivec2(1); jj -= c0 + c1 + c2; }
  }
  p *= 2;
  float c0 = nearClassify(p)[lst];
  float c1 = nearClassify(p + ivec2(1, 0))[lst];
  float c2 = nearClassify(p + ivec2(0, 1))[lst];
  if (jj < c0) {
  } else if (jj < c0 + c1) { p.x += 1; }
  else if (jj < c0 + c1 + c2) { p.y += 1; }
  else { p += ivec2(1); }
  tc = p;
  return true;
}
`;

const REDUCE_FRAG = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D tSrc;
uniform ivec4 uSrc;   // previous level: (xOff, w, h, -)
uniform ivec2 uDstOff;
layout(location = 0) out vec4 o;
vec4 f(ivec2 p) { return (p.x < uSrc.y && p.y < uSrc.z) ? texelFetch(tSrc, ivec2(uSrc.x + p.x, p.y), 0) : vec4(0.0); }
void main() {
  ivec2 p = (ivec2(gl_FragCoord.xy) - uDstOff) * 2;
  o = f(p) + f(p + ivec2(1, 0)) + f(p + ivec2(0, 1)) + f(p + ivec2(1, 1));
}`;

export class NearCompaction {
  levels: PyrLevel[] = [];
  atlas: WebGLRenderTarget[] = [];
  private srcW = 0;
  private srcH = 0;
  private reduceMat: RawShaderMaterial;
  private mesh: Mesh;
  readonly lvUniform: { value: Int32Array };
  readonly topUniform: { value: number };

  constructor() {
    this.reduceMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FS_VERT,
      fragmentShader: REDUCE_FRAG,
      uniforms: { tSrc: { value: null }, uSrc: { value: [0, 0, 0, 0] }, uDstOff: { value: [0, 0] } },
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
    this.mesh = new Mesh(fullscreenGeometry(), this.reduceMat);
    this.mesh.frustumCulled = false;
    this.lvUniform = { value: new Int32Array(MAX_PYR_LEVELS * 4) };
    this.topUniform = { value: 1 };
  }

  /** Uniforms for shaders that include NEAR_PYR_GLSL. */
  uniforms(): Record<string, IUniform> {
    return {
      tPyrA: { value: this.atlas[0]?.texture ?? null },
      tPyrB: { value: this.atlas[1]?.texture ?? null },
      uPyrTop: this.topUniform,
      uPyrLv: this.lvUniform,
    };
  }

  /** (Re)build the level layout for a slot texture of size w x h. */
  resize(w: number, h: number): void {
    if (w === this.srcW && h === this.srcH) return;
    this.srcW = w;
    this.srcH = h;
    this.levels = [];
    let lw = w, lh = h;
    const off = [0, 0];
    while (lw > 1 || lh > 1) {
      lw = Math.ceil(lw / 2);
      lh = Math.ceil(lh / 2);
      const atlas = this.levels.length & 1;
      this.levels.push({ xOff: off[atlas], w: lw, h: lh, atlas });
      off[atlas] += lw;
    }
    if (this.levels.length > MAX_PYR_LEVELS) throw new Error('near-field pyramid too deep');
    const aw = Math.max(off[0], off[1], 1);
    const ah = Math.max(this.levels[0]?.h ?? 1, 1);
    for (const a of this.atlas) a.dispose();
    this.atlas = [0, 1].map(
      () => new WebGLRenderTarget(aw, ah, { type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false }),
    );
    const lv = this.lvUniform.value;
    lv.fill(0);
    this.levels.forEach((l, i) => lv.set([l.xOff, l.w, l.h, l.atlas], i * 4));
    this.topUniform.value = this.levels.length;
  }

  /**
   * Build all levels. `level1` must be a material whose fragment shader writes, at level-1 texel p
   * (gl_FragCoord - uDstOff), the sum of nearClassify over slot texels 2p + {0,1}^2.
   */
  build(r: WebGLRenderer, level1: RawShaderMaterial): void {
    const l1 = this.levels[0];
    const dst0 = this.atlas[0];
    const d1 = level1.uniforms.uDstOff.value as number[];
    d1[0] = l1.xOff;
    d1[1] = 0;
    level1.uniformsNeedUpdate = true;
    dst0.viewport.set(l1.xOff, 0, l1.w, l1.h);
    this.mesh.material = level1;
    r.setRenderTarget(dst0);
    r.render(this.mesh, fsCamera);
    this.mesh.material = this.reduceMat;
    const u = this.reduceMat.uniforms;
    const us = u.uSrc.value as number[], ud = u.uDstOff.value as number[];
    for (let i = 1; i < this.levels.length; i++) {
      const src = this.levels[i - 1], dst = this.levels[i];
      u.tSrc.value = this.atlas[src.atlas].texture;
      us[0] = src.xOff; us[1] = src.w; us[2] = src.h; us[3] = 0;
      ud[0] = dst.xOff; ud[1] = 0;
      this.reduceMat.uniformsNeedUpdate = true;
      const rt = this.atlas[dst.atlas];
      rt.viewport.set(dst.xOff, 0, dst.w, dst.h);
      r.setRenderTarget(rt);
      r.render(this.mesh, fsCamera);
    }
    for (const a of this.atlas) a.viewport.set(0, 0, a.width, a.height);
  }

  /** The 1x1 top level (rgba = list totals): render target + pixel to read. */
  get topLocation(): { rt: WebGLRenderTarget; x: number } {
    const t = this.levels[this.levels.length - 1];
    return { rt: this.atlas[t.atlas], x: t.xOff };
  }

  dispose(): void {
    for (const a of this.atlas) a.dispose();
    this.reduceMat.dispose();
  }
}
