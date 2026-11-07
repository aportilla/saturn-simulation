// Post-processing: the "camera".
//   0. late HDR hooks (sub-pixel moons as point sources, drawn after the ring layer; see far/lateHooks.ts)
//   1. auto exposure: highlight-weighted metering like a camera spot/highlight meter — per-cell peak
//      luminance from a max pyramid (robust to point sources), Sun excluded; exposure = key / metered,
//      adapted smoothly in log space (time constant 0.5 s). Range wide enough that the starfield becomes
//      visible when nothing sunlit is in view. When lit material fills most of the frame (inside the rings,
//      cloud tops) the meter blends to the 90th percentile of the lit pixels, letting glints clip <= 32x.
//   2. glare: an energy-conserving veiling-glare PSF — a fraction eta (0.6 %) of every pixel's light is
//      spread with a power-law-like kernel (~theta^-2.8, sum of Gaussians from a 7-level pyramid; core kept
//      sharp), so the Sun gets a bright core and a wide faint halo while ordinary scenes are barely affected.
//   3. ACES (Narkowicz fit) tone mapping, sRGB encoding, dither.
import {
  FloatType, HalfFloatType, LinearFilter, NearestFilter, RGBAFormat, Vector2, Vector3, WebGLRenderTarget,
} from 'three';
import type { FrameState } from '../core/FrameState';
import type { PipelineContext, RenderPass } from './Pipeline';
import { FullscreenPass } from './fullscreen';
import { runLateHdrHooks } from './far/lateHooks';

export const BASE_EXPOSURE = 0.25;// display-linear per W m^-2 sr^-1 at EV 0 (sunlit albedo-0.5 surface ~ 0.6)
const GLARE_LEVELS = 7;
/** fraction of the light scattered into the glare halo at bloom = 1 */
const GLARE_ETA = 0.006;
/** per-level energy ratio (power-law PSF ~ theta^-beta: 2^(2-beta) per octave, beta = 2.8) */
const GLARE_RATIO = Math.pow(2, 2 - 2.8);
/** luminance above which a pixel is considered the solar disk (excluded from metering) */
const SUN_EXCLUDE = 300;
/** luminance (W m^-2 sr^-1) below which a pixel counts as empty sky for the scene-average meter (the Milky
 *  Way is ~3e-6; anything lit by the Sun, Saturnshine or ringshine is far above this) */
const L_SKY = 1e-4;
/** scene meter: this percentile of the lit pixels lands at key / GEO_K (brighter areas covering more than
 *  ~10% of the frame are protected like by a camera's matrix meter; a few glints may clip) */
const GEO_PERCENTILE = 0.9;
const GEO_K = 2.0;
/** how far (x) highlights may clip when a frame-filling scene is metered on its average */
const GEO_MAX_GAIN = 32.0;

const LUM2_FRAG = /* glsl */ `
precision highp float; precision highp sampler2D;
uniform sampler2D tSrc;
uniform vec2 uSrcSize;
uniform vec3 uSunPx;     // projected solar disk: centre (px, full resolution), exclusion radius (px; <0: off)
layout(location = 0) out vec4 o;
void main() {
  // max luminance (clamped) of the 2x2 source block; the solar disk and the wings of its sub-pixel PSF
  // (known analytically: a disk around the projected Sun) and any pixel brighter than SUN_EXCLUDE are excluded
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  if (uSunPx.z > 0.0 && distance(vec2(p) + 1.0, uSunPx.xy) < uSunPx.z) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  ivec2 mx = ivec2(uSrcSize) - 1;
  float m = 0.0;
  bool sun = false;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec3 c = texelFetch(tSrc, min(p + ivec2(i, j), mx), 0).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    if (!(l < ${SUN_EXCLUDE}.0)) sun = true;   // solar disk (or NaN)
    else m = max(m, min(l, 30.0));
  }
  o = vec4(sun ? 0.0 : m, 0.0, 0.0, 1.0);
}`;
const CELL_FRAG = /* glsl */ `
precision highp float; precision highp sampler2D;
uniform sampler2D tSrc;
uniform vec2 uSrcSize;
layout(location = 0) out vec4 o;
void main() {
  // per-cell (1/4096 of the screen): r = peak luminance, g = 5th-highest 2x2-pooled value ("extended"
  // brightness: a star's PSF touches at most 4 pooled texels, anything larger than ~6 px fills more)
  vec2 cell = uSrcSize / 64.0;
  ivec2 a = ivec2(floor((gl_FragCoord.xy - 0.5) * cell));
  ivec2 b = ivec2(ceil((gl_FragCoord.xy + 0.5) * cell)) - 1;
  int stride = max(1, int(ceil(cell.x / 24.0)));
  ivec2 mx = ivec2(uSrcSize) - 1;
  float t0 = 0.0, t1 = 0.0, t2 = 0.0, t3 = 0.0, t4 = 0.0;   // top-5, descending
  for (int j = 0; j < 24; j++) {
    int y = a.y + j * stride;
    if (y > b.y) break;
    for (int i = 0; i < 24; i++) {
      int x = a.x + i * stride;
      if (x > b.x) break;
      float v = texelFetch(tSrc, clamp(ivec2(x, y), ivec2(0), mx), 0).r;
      if (v > t4) {
        t4 = v;
        if (t4 > t3) { float s = t3; t3 = t4; t4 = s; }
        if (t3 > t2) { float s = t2; t2 = t3; t3 = s; }
        if (t2 > t1) { float s = t1; t1 = t2; t2 = s; }
        if (t1 > t0) { float s = t0; t0 = t1; t1 = s; }
      }
    }
  }
  o = vec4(t0, t4, 0.0, 1.0);
}`;
const AVG4_FRAG = /* glsl */ `
precision highp float; precision highp sampler2D;
uniform sampler2D tSrc;
layout(location = 0) out vec4 o;
void main() {
  // r: mean of the 4x4 cells' extended brightness (region), g: their max (extended highlight),
  // b: max cell peak (point-source highlight)
  ivec2 p = ivec2(gl_FragCoord.xy) * 4;
  float s = 0.0, m = 0.0, pk = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 v = texelFetch(tSrc, p + ivec2(i, j), 0).rg;
    s += v.g;
    m = max(m, v.g);
    pk = max(pk, v.r);
  }
  o = vec4(s / 16.0, m, pk, 1.0);
}`;
const GEO_FRAG = /* glsl */ `
precision highp float; precision highp sampler2D;
uniform sampler2D tSrc;
uniform vec2 uSrcSize;
layout(location = 0) out vec4 o;
void main() {
  // 90th-percentile luminance of the lit, non-sky part of the frame (half-stop histogram of a 64x64 grid
  // over the 2x2-max image; the solar disk reads 0 there) and the fraction of the frame it covers
  float hist[40];
  for (int b = 0; b < 40; b++) hist[b] = 0.0;
  float n = 0.0;
  for (int j = 0; j < 64; j++) for (int i = 0; i < 64; i++) {
    ivec2 p = ivec2((vec2(float(i), float(j)) + 0.5) * uSrcSize / 64.0);
    float l = texelFetch(tSrc, p, 0).r;
    if (l > ${L_SKY.toExponential()}) {
      n += 1.0;
      hist[clamp(int(floor((log2(l) + 14.0) * 2.0)), 0, 39)] += 1.0;
    }
  }
  float acc = 0.0, p = 0.0;
  for (int b = 0; b < 40; b++) {
    acc += hist[b];
    if (acc >= ${GEO_PERCENTILE.toFixed(2)} * n) { p = exp2(float(b) * 0.5 - 13.75); break; }
  }
  o = vec4(n > 0.0 ? p : 0.0, n / 4096.0, 0.0, 1.0);
}`;
const MAX_ALL_FRAG = /* glsl */ `
precision highp float; precision highp sampler2D;
uniform sampler2D tSrc;
uniform sampler2D tGeo;
layout(location = 0) out vec4 o;
void main() {
  // metered luminance: halfway between the brightest region and the brightest extended highlight; isolated
  // point sources (stars, distant moons) may exceed the key by at most 64x (they saturate, as on a real
  // dark-sky exposure)
  float mr = 0.0, mg = 0.0, mb = 0.0;
  for (int j = 0; j < 16; j++) for (int i = 0; i < 16; i++) {
    vec3 v = texelFetch(tSrc, ivec2(i, j), 0).rgb;
    mr = max(mr, v.r);
    mg = max(mg, v.g);
    mb = max(mb, v.b);
  }
  float mh = max(0.5 * (mr + mg), mb / 64.0);
  // Frame-filling scenes (inside the ring layer, cloud tops, eclipse): meter on the 90th percentile of the
  // lit part of the frame instead, letting small highlights clip by up to GEO_MAX_GAIN - otherwise a few
  // sunlit glints would set the exposure and leave the rest black, unlike any eye or camera. Small bright
  // bodies on black sky (coverage < 35%) keep the highlight meter.
  vec2 geo = texelFetch(tGeo, ivec2(0), 0).rg;
  float w = smoothstep(0.35, 0.85, geo.y);
  float m = mh;
  if (w > 0.0 && geo.x > 0.0 && mh > 0.0) {
    float ma = clamp(${GEO_K.toFixed(1)} * geo.x, mh / ${GEO_MAX_GAIN.toFixed(1)}, mh);
    m = exp(mix(log(mh), log(ma), w));
  }
  o = vec4(m, 0.0, 0.0, 1.0);
}`;
const ADAPT_FRAG = /* glsl */ `
precision highp float; precision highp sampler2D;
uniform sampler2D tPrev;
uniform sampler2D tMax;
uniform float uDt;
uniform float uKey;
uniform float uEV;
uniform float uMinE;
uniform float uMaxE;
uniform float uManual;
uniform float uManualE;
uniform float uReset;
uniform float uTau;
layout(location = 0) out vec4 o;
void main() {
  float Lmax = texelFetch(tMax, ivec2(0), 0).r;
  float target = clamp(uKey / max(Lmax, 1e-12), uMinE, uMaxE) * exp2(uEV);
  float prev = texelFetch(tPrev, ivec2(0), 0).r;
  if (!(prev > 0.0) || uReset > 0.5) prev = target;
  float k = 1.0 - exp(-max(uDt, 0.0) / uTau);
  float e = exp(mix(log(prev), log(target), k));
  if (uManual > 0.5) e = uManualE;
  o = vec4(e, Lmax, 0.0, 1.0);
}`;
// 13-tap anti-aliased downsample (weights sum to 1: energy preserving); sanitises the input
// The pyramid lives in half-float targets in "exposed" units / GLARE_SCALE (level 0 applies the exposure).
const DOWN_FRAG = /* glsl */ `
precision highp float; precision highp sampler2D;
uniform sampler2D tSrc;
uniform sampler2D tExp;
uniform float uFirst;
uniform vec2 uTexel; // source texel size
in vec2 vUv;
layout(location = 0) out vec4 o;
vec3 s(vec2 d) {
  vec3 c = texture(tSrc, vUv + d * uTexel).rgb;
  return clamp(c, vec3(0.0), vec3(1e12));
}
void main() {
  vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
  vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
  vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
  vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
  vec3 r = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (uFirst > 0.5) r *= texelFetch(tExp, ivec2(0), 0).r * ${1 / 64};
  o = vec4(min(r, vec3(6e4)), 1.0);
}`;
// acc_l = tent(acc_{l+1}) + w_l * down_l   (no blending needed)
const UP_FRAG = /* glsl */ `
precision highp float; precision highp sampler2D;
uniform sampler2D tCoarse;
uniform sampler2D tLevel;
uniform vec2 uTexel; // coarse texel size
uniform float uWeight;
uniform float uHasCoarse;
in vec2 vUv;
layout(location = 0) out vec4 o;
vec3 s(vec2 d) { return texture(tCoarse, vUv + d * uTexel).rgb; }
void main() {
  vec3 r = vec3(0.0);
  if (uHasCoarse > 0.5) {
    r = s(vec2(0)) * 4.0 + (s(vec2(-1, 0)) + s(vec2(1, 0)) + s(vec2(0, -1)) + s(vec2(0, 1))) * 2.0
      + s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1));
    r /= 16.0;
  }
  r += uWeight * texture(tLevel, vUv).rgb;
  o = vec4(r, 1.0);
}`;
const FINAL_FRAG = /* glsl */ `
precision highp float; precision highp sampler2D;
uniform sampler2D tHdr;
uniform sampler2D tGlare;
uniform sampler2D tExp;
uniform float uCore;     // 1 - eta
uniform float uGlareOn;
uniform vec2 uGlareTexel;
in vec2 vUv;
layout(location = 0) out vec4 o;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float h12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 g(vec2 d) { return texture(tGlare, vUv + d * uGlareTexel).rgb; }
void main() {
  float e = texelFetch(tExp, ivec2(0), 0).r;
  vec3 c = clamp(texture(tHdr, vUv).rgb, vec3(0.0), vec3(1e12)) * e;
  // acc[0] is already tent-filtered (one bilinear tap) and in exposed units / 64
  if (uGlareOn > 0.5) c = c * uCore + g(vec2(0)) * 64.0;
  c = toSRGB(aces(c));
  c += (h12(gl_FragCoord.xy) - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;

function rt(w: number, h: number, linear: boolean, half = false) {
  return new WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: half ? HalfFloatType : FloatType, format: RGBAFormat, depthBuffer: false, stencilBuffer: false,
    generateMipmaps: false, minFilter: linear ? LinearFilter : NearestFilter, magFilter: linear ? LinearFilter : NearestFilter,
  });
}

export class PostPass implements RenderPass {
  readonly name = 'post';
  enabled = true;
  /** most recent exposure value read back from the GPU (multiplier on radiance) */
  exposure = BASE_EXPOSURE;
  /** brightest metered region luminance (W m^-2 sr^-1) */
  meteredLuminance = 0;
  /** adaptation time constant (s) */
  adaptTau = 0.5;
  private lum2!: FullscreenPass;
  private cell!: FullscreenPass;
  private avg4!: FullscreenPass;
  private maxAll!: FullscreenPass;
  private geo!: FullscreenPass;
  private geoRT = rt(1, 1, false);
  private adapt!: FullscreenPass;
  private down!: FullscreenPass;
  private up!: FullscreenPass;
  private final!: FullscreenPass;
  private lum2RT = rt(1, 1, false);
  private lumRT = rt(64, 64, false);
  private lum16RT = rt(16, 16, false);
  private maxRT = rt(1, 1, false);
  private adaptRT = [rt(1, 1, false), rt(1, 1, false)];
  private downRT: WebGLRenderTarget[] = [];
  private accRT: WebGLRenderTarget[] = [];
  private ping = 0;
  private frameCount = 0;
  private readBuf = new Float32Array(4);
  private readPending = false;
  private resetExposure = true;
  private sunCam = new Vector3();

  init(ctx: PipelineContext): void {
    const gl = ctx.renderer.getContext() as WebGL2RenderingContext;
    gl.getExtension('EXT_float_blend');
    gl.getExtension('OES_texture_float_linear');
    this.lum2 = new FullscreenPass({
      fragmentShader: LUM2_FRAG,
      uniforms: { tSrc: { value: null }, uSrcSize: { value: new Vector2() }, uSunPx: { value: new Vector3(0, 0, -1) } },
    });
    this.cell = new FullscreenPass({ fragmentShader: CELL_FRAG, uniforms: { tSrc: { value: null }, uSrcSize: { value: new Vector2() } } });
    this.avg4 = new FullscreenPass({ fragmentShader: AVG4_FRAG, uniforms: { tSrc: { value: null } } });
    this.geo = new FullscreenPass({ fragmentShader: GEO_FRAG, uniforms: { tSrc: { value: null }, uSrcSize: { value: new Vector2() } } });
    this.maxAll = new FullscreenPass({ fragmentShader: MAX_ALL_FRAG, uniforms: { tSrc: { value: null }, tGeo: { value: null } } });
    this.adapt = new FullscreenPass({
      fragmentShader: ADAPT_FRAG,
      uniforms: {
        tPrev: { value: null }, tMax: { value: null }, uDt: { value: 0 }, uKey: { value: 0.6 }, uEV: { value: 0 },
        uMinE: { value: 1e-3 }, uMaxE: { value: 2e4 }, uManual: { value: 0 }, uManualE: { value: BASE_EXPOSURE },
        uReset: { value: 1 }, uTau: { value: this.adaptTau },
      },
    });
    this.down = new FullscreenPass({
      fragmentShader: DOWN_FRAG,
      uniforms: { tSrc: { value: null }, tExp: { value: null }, uFirst: { value: 0 }, uTexel: { value: new Vector2() } },
    });
    this.up = new FullscreenPass({
      fragmentShader: UP_FRAG,
      uniforms: { tCoarse: { value: null }, tLevel: { value: null }, uTexel: { value: new Vector2() }, uWeight: { value: 0 }, uHasCoarse: { value: 0 } },
    });
    this.final = new FullscreenPass({
      fragmentShader: FINAL_FRAG,
      uniforms: {
        tHdr: { value: null }, tGlare: { value: null }, tExp: { value: null }, uCore: { value: 1 }, uGlareOn: { value: 1 },
        uGlareTexel: { value: new Vector2() },
      },
    });
    this.resize(ctx);
  }

  resize(ctx: PipelineContext): void {
    for (const b of this.downRT) b.dispose();
    for (const b of this.accRT) b.dispose();
    this.downRT = [];
    this.accRT = [];
    let w = ctx.width >> 1, h = ctx.height >> 1;
    for (let i = 0; i < GLARE_LEVELS; i++) {
      this.downRT.push(rt(w, h, true, true));
      this.accRT.push(rt(w, h, true, true));
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    this.lum2RT.setSize(Math.max(1, Math.ceil(ctx.width / 2)), Math.max(1, Math.ceil(ctx.height / 2)));
  }

  /** Force the auto-exposure to snap to its target next frame (e.g. after a camera jump). */
  snapExposure(): void {
    this.resetExposure = true;
  }

  render(f: FrameState, ctx: PipelineContext): void {
    const r = ctx.renderer;
    runLateHdrHooks(f, ctx);
    const src = ctx.hdrRT.texture;
    // --- metering
    const l2 = this.lum2.material.uniforms;
    l2.tSrc.value = src;
    (l2.uSrcSize.value as Vector2).set(ctx.width, ctx.height);
    // projected Sun (excluded from metering together with the wings of its pixel PSF)
    const sp = l2.uSunPx.value as Vector3;
    this.sunCam.copy(f.sunDir).applyMatrix3(f.worldToCam);
    if (this.sunCam.z < 0) {
      const th = Math.tan(f.fovY / 2);
      const nx = this.sunCam.x / -this.sunCam.z / (th * f.aspect);
      const ny = this.sunCam.y / -this.sunCam.z / th;
      sp.set((nx * 0.5 + 0.5) * ctx.width, (ny * 0.5 + 0.5) * ctx.height, f.sunAngularRadius / f.pixelAngle + 4.5);
    } else sp.z = -1;
    this.lum2.render(r, this.lum2RT);
    const cu = this.cell.material.uniforms;
    cu.tSrc.value = this.lum2RT.texture;
    (cu.uSrcSize.value as Vector2).set(this.lum2RT.width, this.lum2RT.height);
    this.cell.render(r, this.lumRT);
    this.avg4.material.uniforms.tSrc.value = this.lumRT.texture;
    this.avg4.render(r, this.lum16RT);
    const gu = this.geo.material.uniforms;
    gu.tSrc.value = this.lum2RT.texture;
    (gu.uSrcSize.value as Vector2).set(this.lum2RT.width, this.lum2RT.height);
    this.geo.render(r, this.geoRT);
    this.maxAll.material.uniforms.tSrc.value = this.lum16RT.texture;
    this.maxAll.material.uniforms.tGeo.value = this.geoRT.texture;
    this.maxAll.render(r, this.maxRT);
    const prev = this.adaptRT[this.ping];
    const next = this.adaptRT[1 - this.ping];
    const au = this.adapt.material.uniforms;
    au.tPrev.value = prev.texture;
    au.tMax.value = this.maxRT.texture;
    au.uDt.value = Math.min(f.dtReal, 0.5);
    au.uTau.value = this.adaptTau;
    const s = f.settings;
    au.uManual.value = s.exposureMode === 'manual' ? 1 : 0;
    au.uManualE.value = BASE_EXPOSURE * Math.pow(2, s.exposureEV);
    au.uEV.value = s.exposureMode === 'auto' ? s.exposureEV : 0;
    au.uReset.value = this.resetExposure ? 1 : 0;
    this.resetExposure = false;
    this.adapt.render(r, next);
    this.ping = 1 - this.ping;
    // --- glare pyramid
    const glareOn = s.bloom > 0;
    if (glareOn) {
      const du = this.down.material.uniforms;
      du.tExp.value = next.texture;
      for (let i = 0; i < GLARE_LEVELS; i++) {
        const srcT = i === 0 ? ctx.hdrRT : this.downRT[i - 1];
        du.tSrc.value = srcT.texture;
        du.uFirst.value = i === 0 ? 1 : 0;
        (du.uTexel.value as Vector2).set(1 / srcT.width, 1 / srcT.height);
        this.down.render(r, this.downRT[i]);
      }
      // per-level weights: geometric (power-law PSF), normalised to eta
      const eta = Math.min(0.2, GLARE_ETA * s.bloom);
      let wsum = 0;
      for (let i = 0; i < GLARE_LEVELS; i++) wsum += Math.pow(GLARE_RATIO, i);
      const uu = this.up.material.uniforms;
      for (let i = GLARE_LEVELS - 1; i >= 0; i--) {
        uu.tLevel.value = this.downRT[i].texture;
        uu.uWeight.value = (eta * Math.pow(GLARE_RATIO, i)) / wsum;
        uu.uHasCoarse.value = i < GLARE_LEVELS - 1 ? 1 : 0;
        if (i < GLARE_LEVELS - 1) {
          uu.tCoarse.value = this.accRT[i + 1].texture;
          (uu.uTexel.value as Vector2).set(1 / this.accRT[i + 1].width, 1 / this.accRT[i + 1].height);
        } else {
          uu.tCoarse.value = this.downRT[i].texture;
        }
        this.up.render(r, this.accRT[i]);
      }
      this.final.material.uniforms.uCore.value = 1 - eta;
    }
    // --- final
    const fu = this.final.material.uniforms;
    fu.tHdr.value = src;
    fu.tGlare.value = this.accRT[0].texture;
    (fu.uGlareTexel.value as Vector2).set(1 / this.accRT[0].width, 1 / this.accRT[0].height);
    fu.tExp.value = next.texture;
    fu.uGlareOn.value = glareOn ? 1 : 0;
    if (!glareOn) fu.uCore.value = 1;
    this.final.render(r, null);
    // asynchronous exposure readback (no pipeline stall)
    if (!this.readPending && this.frameCount++ % 4 === 0) {
      this.readPending = true;
      r.readRenderTargetPixelsAsync(next, 0, 0, 1, 1, this.readBuf)
        .then(() => {
          if (this.readBuf[0] > 0) {
            this.exposure = this.readBuf[0];
            this.meteredLuminance = this.readBuf[1];
          }
        })
        .catch(() => { /* context lost etc. */ })
        .finally(() => { this.readPending = false; });
    }
    f.exposure = this.exposure;
  }

  stats(): Record<string, string | number> {
    return {
      exposure: this.exposure.toExponential(2),
      EV: (Math.log2(this.exposure / BASE_EXPOSURE)).toFixed(1),
      metered: this.meteredLuminance.toExponential(2),
    };
  }
}
