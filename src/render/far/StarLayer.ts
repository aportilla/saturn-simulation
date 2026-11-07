// Star layer: every star is a GL point whose pixel-integrated Gaussian PSF carries exactly its irradiance
// (pixel radiance = E * w_pixel / Omega_pixel). Rendered additively into a float target that the far-field
// fullscreen pass composites into the sky (so Saturn / moons / the haze occult stars correctly).
//
// Data: src/sky/starCatalog.ts -> loadStarCatalog() (moons & sky data agent), loaded through
// import.meta.glob so a missing module is not an error; otherwise a procedural field with a realistic
// magnitude distribution (log10 N(<V) ~ 0.48 V + 0.74 over the sky) and galactic concentration.
// Irradiance convention: "solar-equivalent" W/m^2, E = 1361 W/m^2 * 10^(-0.4 (V + 26.74)) (V=0 -> 2.7e-8).
import {
  AddEquation, BufferAttribute, BufferGeometry, Color, CustomBlending, FloatType, GLSL3, NearestFilter, OneFactor,
  Points, RawShaderMaterial, RGBAFormat, Vector3, WebGLRenderTarget, type WebGLRenderer,
} from 'three';
import { raDecToSef } from '../../core/ephemeris';
import { DEG } from '../../core/constants';
import { fsCamera } from '../fullscreen';
import { FAR_PSF_GLSL } from './glsl/sky';

export interface StarData {
  count: number;
  dir: Float32Array;   // 3n unit SEF directions
  E: Float32Array;     // n irradiances at Saturn (W/m^2)
  rgb: Float32Array;   // 3n linear RGB, luminance-normalised (Y = 1)
  source: string;
}

const STAR_VERT = /* glsl */ `
precision highp float;
precision highp int;
#include <sv_common>
${FAR_PSF_GLSL}
in vec3 aDir;
in float aE;
in vec3 aRGB;
uniform float uExposure;
uniform float uCullLevel;
flat out vec3 vL;
flat out vec2 vC;
void main() {
  gl_PointSize = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vec3 v = uWorldToCam * aDir;
  if (v.z >= -1e-4) return;
  vec2 tp = v.xy / (-v.z);
  vec2 ndc = tp / vec2(uTanHalfFov * uAspect, uTanHalfFov);
  if (abs(ndc.x) > 1.03 || abs(ndc.y) > 1.03) return;
  float om = pixelSolidAngle(tp);
  float peak = aE * 0.35 / om;
  if (peak * uExposure < uCullLevel) return;
  vC = (ndc * 0.5 + 0.5) * uResolution;
  vL = aRGB * (aE / om);
  gl_PointSize = 7.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;
const STAR_FRAG = /* glsl */ `
precision highp float;
precision highp int;
#include <sv_common>
${FAR_PSF_GLSL}
flat in vec3 vL;
flat in vec2 vC;
layout(location = 0) out vec4 o;
void main() {
  float w = pixelGauss(gl_FragCoord.xy - vC, 0.6);
  o = vec4(vL * w, 0.0);
}`;

// ------------------------------------------------------------------------------------------ colours
/** Approximate solar-relative linear RGB (Y = 1) of a star with colour index B-V. */
export function bvToRgb(bv: number): [number, number, number] {
  const b = Math.min(Math.max(bv, -0.4), 2.0);
  const T = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62)); // Ballesteros (2012)
  const planck = (lnm: number, t: number) => {
    const l = lnm * 1e-9;
    return 1 / (l ** 5 * (Math.exp(1.438777e-2 / (l * t)) - 1));
  };
  const wl = [610, 545, 465];
  const c = wl.map((w) => planck(w, T) / planck(w, 5778));
  const Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] / Y, c[1] / Y, c[2] / Y];
}

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Procedural all-sky star field (fallback). */
export function proceduralStars(vMax = 9.0): StarData {
  const rnd = mulberry32(0x51a7);
  const nTot = Math.round(Math.pow(10, 0.48 * vMax + 0.74));
  // galactic frame in SEF
  const zg = raDecToSef(192.85948 * DEG, 27.12825 * DEG);
  const xg0 = raDecToSef(266.405 * DEG, -28.936 * DEG);
  const xg = xg0.clone().addScaledVector(zg, -xg0.dot(zg)).normalize();
  const yg = new Vector3().crossVectors(zg, xg);
  const dir = new Float32Array(nTot * 3);
  const E = new Float32Array(nTot);
  const rgb = new Float32Array(nTot * 3);
  const E0 = 1361 * Math.pow(10, -0.4 * 26.74);
  const lo = Math.pow(10, 0.48 * -1.5 + 0.74);
  for (let i = 0; i < nTot; i++) {
    // inverse CDF of N(<V) = 10^(0.48 V + 0.74), V >= -1.5
    const u = rnd();
    const Nv = lo + u * (nTot - lo);
    const V = (Math.log10(Nv) - 0.74) / 0.48;
    // galactic concentration increasing toward faint magnitudes
    const conc = 0.5 + 3.5 * Math.min(Math.max((V - 3) / 6, 0), 1);
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 50; k++) {
      z = rnd() * 2 - 1;
      const ph = rnd() * 2 * Math.PI;
      const r = Math.sqrt(1 - z * z);
      x = r * Math.cos(ph); y = r * Math.sin(ph);
      const b = Math.asin(z);
      const l = Math.atan2(y, x);
      const p = (1 + conc * Math.exp(-Math.abs(b) / 0.22) * (0.6 + 0.4 * Math.cos(l))) / (1 + conc);
      if (rnd() < p) break;
    }
    const d = new Vector3().addScaledVector(xg, x).addScaledVector(yg, y).addScaledVector(zg, z).normalize();
    dir[i * 3] = d.x; dir[i * 3 + 1] = d.y; dir[i * 3 + 2] = d.z;
    E[i] = E0 * Math.pow(10, -0.4 * V);
    // colour index: bright stars skew blue (B/A), faint toward G/K
    const g1 = rnd() + rnd() + rnd() - 1.5;
    const bv = Math.min(1.9, Math.max(-0.3, 0.45 + 0.15 * Math.min(V, 8) / 8 + 0.55 * g1));
    const c = bvToRgb(bv);
    rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
  }
  return { count: nTot, dir, E, rgb, source: `procedural (V<${vMax}, ${nTot})` };
}

/** Normalise whatever src/sky/starCatalog.ts returns into StarData (tolerant of field naming). */
function adaptCatalog(c: any): StarData | null {
  if (!c) return null;
  const pick = (...names: string[]) => { for (const n of names) if (c[n] !== undefined) return c[n]; return undefined; };
  const dir = pick('dir', 'dirs', 'directions', 'direction', 'positions', 'pos', 'xyz');
  const E = pick('irradiance', 'E', 'flux', 'irr', 'e');
  const col = pick('rgb', 'color', 'colors', 'colour', 'colours');
  let count = pick('count', 'n', 'length');
  if (!dir || !E) return null;
  const d = dir instanceof Float32Array ? dir : new Float32Array(dir);
  const e = E instanceof Float32Array ? E : new Float32Array(E);
  if (typeof count !== 'number') count = e.length;
  count = Math.min(count, e.length, Math.floor(d.length / 3));
  let rgb: Float32Array;
  if (col && col.length >= count * 3) {
    rgb = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = col[i * 3], g = col[i * 3 + 1], b = col[i * 3 + 2];
      const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const k = Y > 0 ? 1 / Y : 1;
      rgb[i * 3] = r * k; rgb[i * 3 + 1] = g * k; rgb[i * 3 + 2] = b * k;
    }
  } else {
    rgb = new Float32Array(count * 3).fill(1);
  }
  return { count, dir: d.subarray(0, count * 3), E: e.subarray(0, count), rgb, source: String(c.source ?? 'catalog') };
}

const catalogModules = import.meta.glob('../../sky/starCatalog.ts');

export async function loadStars(): Promise<StarData> {
  const loader = catalogModules['../../sky/starCatalog.ts'];
  if (loader) {
    try {
      const mod: any = await loader();
      const fn = mod.loadStarCatalog ?? mod.default;
      if (typeof fn === 'function') {
        const data = adaptCatalog(await fn());
        if (data && data.count > 0) return data;
      }
    } catch (e) {
      console.warn('[FarField] star catalog failed, using procedural stars', e);
    }
  }
  return proceduralStars();
}

export class StarLayer {
  readonly rt: WebGLRenderTarget;
  readonly material: RawShaderMaterial;
  private points: Points | null = null;
  count = 0;
  source = 'loading';

  constructor(shared: Record<string, { value: any }>, width: number, height: number) {
    this.rt = new WebGLRenderTarget(width, height, {
      type: FloatType, format: RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      minFilter: NearestFilter, magFilter: NearestFilter,
    });
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { ...shared, uExposure: { value: 0.25 }, uCullLevel: { value: 2e-4 } },
      blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor,
      blendEquationAlpha: AddEquation, blendSrcAlpha: OneFactor, blendDstAlpha: OneFactor,
      transparent: true, depthTest: false, depthWrite: false,
    });
  }

  setData(d: StarData): void {
    const g = new BufferGeometry();
    g.setAttribute('aDir', new BufferAttribute(d.dir, 3));
    g.setAttribute('aE', new BufferAttribute(d.E, 1));
    g.setAttribute('aRGB', new BufferAttribute(d.rgb, 3));
    // three needs a 'position' attribute to know the draw count
    g.setAttribute('position', new BufferAttribute(d.dir, 3));
    g.setDrawRange(0, d.count);
    if (this.points) this.points.geometry.dispose();
    this.points = new Points(g, this.material);
    this.points.frustumCulled = false;
    this.count = d.count;
    this.source = d.source;
  }

  resize(w: number, h: number): void {
    this.rt.setSize(w, h);
  }

  render(renderer: WebGLRenderer, exposure: number, enabled: boolean): void {
    renderer.setRenderTarget(this.rt);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearAlpha(0);
    const c = renderer.getClearColor(_tmpColor);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.setClearColor(c, prevAlpha);
    if (!enabled || !this.points) return;
    this.material.uniforms.uExposure.value = exposure;
    renderer.render(this.points, fsCamera);
  }

  dispose(): void {
    this.rt.dispose();
    this.material.dispose();
    this.points?.geometry.dispose();
  }
}

const _tmpColor = new Color();
