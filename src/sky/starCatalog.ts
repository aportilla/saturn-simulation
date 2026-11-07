// Real starfield: Yale Bright Star Catalogue (BSC5, public domain), 9096 stars, complete to V ~ 6.5
// (faintest entry 7.96). Built by scripts/data/stars/build_stars.mjs; format in docs/data-sources.md.
//
// Photometric calibration (consistent with the renderer's sunlight, whose total irradiance is
// SOLAR_IRRADIANCE_1AU at V_sun = SUN_APPARENT_MAG_1AU):
//   irradiance[i] = SOLAR_IRRADIANCE_1AU * 10^(-0.4 (V - V_sun))   [W/m^2, "V-band-equivalent"]
//                 = 2.73e-8 W/m^2 * 10^(-0.4 V)
// i.e. the total irradiance a source with the solar spectrum would have to produce the star's V-band flux.
// Stars are effectively at infinite distance: the value at Saturn equals the value at Earth (no extinction;
// the 9.5 AU parallax shifts even alpha Cen by < 8 arcsec).
// Colour: blackbody at T_eff(B-V) (Ballesteros 2012), CIE 1931 -> linear sRGB, divided channel-wise by the
// RGB of a solar-colour star (B-V = 0.653) so that sunlight is white, normalised to unit luminance (so
// irradiance x color keeps the V-band brightness).
import { dataUrl } from '../core/assets';
import { SOLAR_IRRADIANCE_1AU, SUN_APPARENT_MAG_1AU } from '../core/constants';
import { ICRF_TO_SEF } from '../core/ephemeris';

export interface StarCatalog {
  count: number;
  /** unit direction from the observer to the star, SEF, interleaved xyz */
  dir: Float32Array;
  /** V-band-equivalent irradiance at Saturn, W/m^2 */
  irradiance: Float32Array;
  /** linear-RGB tint, unit luminance, white = solar spectrum; interleaved rgb */
  color: Float32Array;
  /** Johnson V magnitude */
  vmag: Float32Array;
  /** Johnson B-V colour index */
  bv: Float32Array;
  /** faintest V in the catalogue */
  magLimit: number;
  /** V of completeness */
  completeTo: number;
  /** irradiance of a V = 0 star (W/m^2) */
  e0: number;
  /** Bayer/Flamsteed designations of stars brighter than V = 4 (index -> name) */
  names: Map<number, string>;
  epoch: string;
  source: string;
  license: string;
}

/** Irradiance (W/m^2) of a V = 0 star on the renderer's solar photometric scale. */
export const STAR_E0 = SOLAR_IRRADIANCE_1AU * Math.pow(10, -0.4 * (0 - SUN_APPARENT_MAG_1AU));

export function starIrradiance(vmag: number): number {
  return STAR_E0 * Math.pow(10, -0.4 * vmag);
}

// ---------------------------------------------------------------- colour (mirror of scripts/data/moons/colors.mjs)
function lobe(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
function bbRgb(T: number, out: number[]): number[] {
  let X = 0, Y = 0, Z = 0;
  const c2 = 1.4387769e7;
  for (let l = 380; l <= 780; l += 2) {
    const s = 1 / (Math.pow(l, 5) * (Math.exp(c2 / (l * T)) - 1));
    X += s * (1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2));
    Y += s * (0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1));
    Z += s * (1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8));
  }
  out[0] = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  out[1] = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  out[2] = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  return out;
}
/** Ballesteros (2012) effective temperature from B-V. */
export function teffFromBV(bv: number): number {
  const b = Math.max(-0.4, Math.min(2.0, bv));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}
const SUN_BV = 0.653;
let LUT: Float32Array | null = null;
const LUT_MIN = -0.4, LUT_STEP = 0.005, LUT_N = 481;
function lut(): Float32Array {
  if (LUT) return LUT;
  const sun = bbRgb(teffFromBV(SUN_BV), [0, 0, 0]);
  const c = [0, 0, 0];
  LUT = new Float32Array(LUT_N * 3);
  for (let i = 0; i < LUT_N; i++) {
    bbRgb(teffFromBV(LUT_MIN + i * LUT_STEP), c);
    const r = c[0] / sun[0], g = c[1] / sun[1], b = c[2] / sun[2];
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    LUT[3 * i] = Math.max(0, r / L); LUT[3 * i + 1] = Math.max(0, g / L); LUT[3 * i + 2] = Math.max(0, b / L);
  }
  return LUT;
}
/** Linear-RGB tint (unit luminance, Sun = white) for a B-V colour index. */
export function starColorFromBV(bv: number, out: Float32Array | number[] = [0, 0, 0], o = 0): Float32Array | number[] {
  const T = lut();
  const x = (Math.max(LUT_MIN, Math.min(2.0, bv)) - LUT_MIN) / LUT_STEP;
  const i = Math.min(LUT_N - 2, Math.floor(x));
  const u = x - i;
  for (let c = 0; c < 3; c++) out[o + c] = T[3 * i + c] * (1 - u) + T[3 * (i + 1) + c] * u;
  return out;
}

// ---------------------------------------------------------------- loader
interface StarsJson {
  format: string; count: number; recordBytes: number; epoch: string; magLimit: number; completeTo: number;
  source: string; license: string; named: [number, string][];
}

/** Load public/data/stars/stars.{json,bin}; resolves to null (with a warning) if unavailable. */
export async function loadStarCatalog(base = 'data/stars/stars'): Promise<StarCatalog | null> {
  try {
    const [jr, br] = await Promise.all([fetch(dataUrl(`${base}.json`)), fetch(dataUrl(`${base}.bin`))]);
    if (!jr.ok || !br.ok) throw new Error(`HTTP ${jr.status}/${br.status}`);
    const meta = (await jr.json()) as StarsJson;
    const dv = new DataView(await br.arrayBuffer());
    const n = meta.count;
    if (dv.byteLength < n * meta.recordBytes) throw new Error('truncated star file');
    const dir = new Float32Array(3 * n), irr = new Float32Array(n), col = new Float32Array(3 * n);
    const vmag = new Float32Array(n), bv = new Float32Array(n);
    const m = ICRF_TO_SEF.elements; // column-major
    for (let i = 0; i < n; i++) {
      const o = i * meta.recordBytes;
      const ra = dv.getFloat32(o, true), dec = dv.getFloat32(o + 4, true);
      const V = dv.getInt16(o + 8, true) / 1000, BV = dv.getInt16(o + 10, true) / 1000;
      const cd = Math.cos(dec);
      const x = cd * Math.cos(ra), y = cd * Math.sin(ra), z = Math.sin(dec);
      dir[3 * i] = m[0] * x + m[3] * y + m[6] * z;
      dir[3 * i + 1] = m[1] * x + m[4] * y + m[7] * z;
      dir[3 * i + 2] = m[2] * x + m[5] * y + m[8] * z;
      vmag[i] = V; bv[i] = BV;
      irr[i] = starIrradiance(V);
      starColorFromBV(BV, col, 3 * i);
    }
    return {
      count: n, dir, irradiance: irr, color: col, vmag, bv,
      magLimit: meta.magLimit, completeTo: meta.completeTo, e0: STAR_E0,
      names: new Map(meta.named), epoch: meta.epoch, source: meta.source, license: meta.license,
    };
  } catch (e) {
    console.warn('[stars] star catalogue unavailable:', e);
    return null;
  }
}
