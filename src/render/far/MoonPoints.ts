// Sub-pixel moons as point sources of the correct total brightness.
//  1. flux pass (fragment shader, fully parallel): a 256 x 32 float target, texel (k, i) = the radiance of
//     disk sample k of moon i times its solid angle, i.e. the moon's bounding disk is integrated with 64
//     sunflower-sampled rays (256 for measured shapes, whose irregular silhouettes fill less of the disk: the
//     sampling error of the hit fraction stays ~<5%) through the SAME surface shading as the resolved renderer
//     (albedo map / procedural surface, measured shape, photometry and phase, Saturn / ring / moon / self
//     shadows, Saturnshine, Titan's haze);
//  2. one GL point per moon: the vertex shader sums its row (irradiance at the camera), applies the main-ring
//     transmission when the moon lies beyond the ring plane, and the fragment shader spreads it with a
//     pixel-integrated Gaussian PSF (pixel radiance = E w / Omega_pix).
// Rendered after the ring layer into hdrRT (late HDR hook), with an occlusion test against sceneRT.a (Saturn,
// resolved moons, near-field particles). Cross-fades with the resolved rendering between 1.0 and 2.5 px
// apparent radius (weights in uMoonRing[i].w).
import {
  AddEquation, BufferAttribute, BufferGeometry, CustomBlending, FloatType, GLSL3, NearestFilter, OneFactor, Points,
  RawShaderMaterial, RGBAFormat, WebGLRenderTarget, ZeroFactor, type Texture, type WebGLRenderer,
} from 'three';
import { MAX_MOONS } from '../../core/constants';
import { FullscreenPass, fsCamera } from '../fullscreen';
import { FAR_HEADER } from './glsl/header';
import { FAR_NOISE_GLSL } from './glsl/noise';
import { FAR_SATURN_GLSL } from './glsl/saturn';
import { FAR_MOONS_GLSL } from './glsl/moons';
import { FAR_PSF_GLSL } from './glsl/sky';

const NS = 64;          // disk samples per moon (ellipsoids, Titan)
const NS_SHAPE = 256;   // measured shapes; the flux target is NS_SHAPE wide, unused texels are 0

const FLUX_FRAG = /* glsl */ `
${FAR_HEADER}
${FAR_NOISE_GLSL}
${FAR_PSF_GLSL}
${FAR_SATURN_GLSL}
${FAR_MOONS_GLSL}
layout(location = 0) out vec4 o;
void main() {
  gAAPix = 1e-12;
  int k = int(gl_FragCoord.x);
  int i = int(gl_FragCoord.y);
  o = vec4(0.0);
  if (i >= uMoonCount || uMoonRing[i].w >= 0.999) return;
  bool shaped = uMoonShape[i].x >= 0.0;
  int ns = shaped ? ${NS_SHAPE} : ${NS};
  if (k >= ns) return;
  vec3 c = uMoonPosR[i].xyz;
  float d = length(c);
  if (dot(uWorldToCam * c, vec3(0.0, 0.0, -1.0)) <= 0.0) return;
  int mat = int(uMoonRadii[i].w + 0.5);
  vec3 R = uMoonRadii[i].xyz;
  // bounding radius: the disk sampled must contain the whole silhouette (measured shapes: rMax, incl. ridges)
  float Rb = mat == MAT_TITAN ? R.x + TI_HTOP : (shaped ? uMoonShape[i].y : max(R.x, max(R.y, R.z)));
  vec3 cn = c / d;
  vec3 e1 = normalize(cross(cn, abs(cn.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(cn, e1);
  float rr = Rb * sqrt((float(k) + 0.5) / float(ns));
  float an = float(k) * 2.39996323;
  vec3 dir = normalize(c + e1 * (rr * cos(an)) + e2 * (rr * sin(an)));
  MoonTrace m = traceMoon(i, dir);
  o = vec4(m.L * (PI * Rb * Rb / float(ns)) / (d * d), 1.0);
}`;

const VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
#include <sv_common>
#include <sv_saturn>
#include <sv_ringProfile>
#include <sv_lighting>
${FAR_PSF_GLSL}
uniform vec4 uMoonRadii[MAX_MOONS];
uniform vec4 uMoonRing[MAX_MOONS];
uniform vec4 uMoonShape[MAX_MOONS];
uniform sampler2D tFlux;
uniform float uExposure;
in float aIndex;
flat out vec3 vL;
flat out vec2 vC;
flat out float vSig;
flat out float vDist;
flat out float vRb;
void main() {
  gl_PointSize = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  int i = int(aIndex + 0.5);
  if (i >= uMoonCount) return;
  float wPt = 1.0 - uMoonRing[i].w;
  if (wPt <= 1e-3) return;
  vec3 c = uMoonPosR[i].xyz;
  float d = length(c);
  vec3 v = uWorldToCam * c;
  if (v.z >= 0.0) return;
  vec2 tp = v.xy / (-v.z);
  vec2 ndc = tp / vec2(uTanHalfFov * uAspect, uTanHalfFov);
  if (abs(ndc.x) > 1.05 || abs(ndc.y) > 1.05) return;
  vec3 E = vec3(0.0);
  int ns = uMoonShape[i].x >= 0.0 ? ${NS_SHAPE} : ${NS};
  for (int k = 0; k < ${NS_SHAPE}; k++) {
    if (k >= ns) break;
    E += texelFetch(tFlux, ivec2(k, i), 0).rgb;
  }
  // main-ring transmission if the line of sight crosses the ring plane before the moon
  vec3 cn = c / d;
  if (abs(cn.z) > 1e-6) {
    float tc = -uCamPos.z / cn.z;
    if (tc > 0.0 && tc < d) {
      float r = length((cn * tc).xy + uCamPos.xy);
      float fp = tc * uPixelAngle / max(abs(cn.z), 0.02);
      E *= exp(-ringSample(r, fp).tau / abs(cn.z));
    }
  }
  E *= wPt;
  vec3 R = uMoonRadii[i].xyz;
  float Rb = int(uMoonRadii[i].w + 0.5) == 6 ? R.x + 900e3 : (uMoonShape[i].x >= 0.0 ? uMoonShape[i].y : max(R.x, max(R.y, R.z)));
  float om = pixelSolidAngle(tp);
  float thPx = Rb / d / uPixelAngle;
  vSig = sqrt(0.36 + 0.25 * thPx * thPx);
  float peak = luminance(E) / om / (6.2832 * vSig * vSig);
  if (peak * uExposure < 1e-5) return;
  vL = E / om;
  vC = (ndc * 0.5 + 0.5) * uResolution;
  vDist = d;
  vRb = Rb;
  gl_PointSize = 2.0 * ceil(3.0 * vSig + 1.0) + 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
#include <sv_common>
${FAR_PSF_GLSL}
uniform sampler2D tSceneDist;
flat in vec3 vL;
flat in vec2 vC;
flat in float vSig;
flat in float vDist;
flat in float vRb;
layout(location = 0) out vec4 o;
void main() {
  float sd = texelFetch(tSceneDist, ivec2(gl_FragCoord.xy), 0).a;
  if (sd < vDist - 2.0 * vRb) discard;
  o = vec4(vL * pixelGauss(gl_FragCoord.xy - vC, vSig), 0.0);
}`;

export class MoonPoints {
  readonly material: RawShaderMaterial;
  private points: Points;
  private fluxRT: WebGLRenderTarget;
  private flux: FullscreenPass;

  constructor(uniforms: Record<string, { value: any }>) {
    this.fluxRT = new WebGLRenderTarget(NS_SHAPE, MAX_MOONS, {
      type: FloatType, format: RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      minFilter: NearestFilter, magFilter: NearestFilter,
    });
    this.flux = new FullscreenPass({ fragmentShader: FLUX_FRAG, uniforms: { ...uniforms } });
    const g = new BufferGeometry();
    const idx = new Float32Array(MAX_MOONS);
    for (let i = 0; i < MAX_MOONS; i++) idx[i] = i;
    g.setAttribute('aIndex', new BufferAttribute(idx, 1));
    g.setAttribute('position', new BufferAttribute(new Float32Array(MAX_MOONS * 3), 3));
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...uniforms, uExposure: { value: 0.25 }, tSceneDist: { value: null }, tFlux: { value: this.fluxRT.texture } },
      blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor,
      blendEquationAlpha: AddEquation, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor,
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.points = new Points(g, this.material);
    this.points.frustumCulled = false;
  }

  /** Disk-integrate the moons (call before the ring layer or any time after the moon uniforms are set). */
  integrate(renderer: WebGLRenderer): void {
    this.flux.render(renderer, this.fluxRT);
  }

  render(renderer: WebGLRenderer, target: WebGLRenderTarget, sceneDist: Texture, exposure: number): void {
    const u = this.material.uniforms;
    u.tSceneDist.value = sceneDist;
    u.uExposure.value = exposure;
    renderer.setRenderTarget(target);
    renderer.render(this.points, fsCamera);
  }

  dispose(): void {
    this.material.dispose();
    this.points.geometry.dispose();
    this.fluxRT.dispose();
    this.flux.dispose();
  }
}
