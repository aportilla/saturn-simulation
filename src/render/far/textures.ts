// Surface maps from public/data/textures/manifest.json (produced by the moons & sky data agent).
// Every map is equirectangular; per-map longitude conventions:
//   lon0Center: true  -> longitude 0 at the horizontal centre; false -> at the left edge;
//               number -> the longitude (deg, in the map's own direction) at the centre.
//   lonDirection: 'east' (east longitude increases to the right) | 'west' (west longitude increases to the right)
// North is at the top row. Maps are packed into one sRGB texture array (moons) / a 2-D texture (Saturn), and
// each map is normalised by its mean linear albedo so the photometric model keeps the calibrated geometric
// albedo (Iapetus: by the bright-terrain level instead, since its two hemispheres differ ~10x).
import {
  ClampToEdgeWrapping, DataArrayTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping,
  RGBAFormat, SRGBColorSpace, UnsignedByteType,
} from 'three';
import { dataUrl } from '../../core/assets';

export interface MapInfo {
  key: string;
  url: string;
  /** texture u of east longitude 0 */
  u0: number;
  /** +1: u increases with east longitude, -1: with west longitude */
  dir: number;
}
export interface MoonTextureSet {
  texture: DataArrayTexture;
  width: number;
  layers: Map<string, { layer: number; gain: number; u0: number; dir: number }>;
}
export interface SaturnTexture {
  texture: DataTexture;
  gain: [number, number, number];
  u0: number;
  dir: number;
}

function parseEntry(key: string, e: any, base: string): MapInfo | null {
  if (!e) return null;
  const file = typeof e === 'string' ? e : (e.file ?? e.path ?? e.url ?? e.src ?? e.image);
  if (typeof file !== 'string') return null;
  // absolute URLs as is; site-root-relative "data/..." paths (the data agent's convention) via dataUrl;
  // anything else relative to the manifest's directory
  const url = /^(https?:)?\//.test(file) ? file
    : /^data\//.test(file) ? dataUrl(file)
    : base + file.replace(/^\.\//, '');
  const lonDir = String(e.lonDirection ?? e.lon_direction ?? e.longitudeDirection ?? 'east').toLowerCase();
  const dir = lonDir.startsWith('w') ? -1 : 1;
  const c = e.lon0Center ?? e.lon0_center ?? e.lonCenter;
  let u0: number;
  if (typeof c === 'number') u0 = 0.5 - c / 360;        // map longitude c at u = 0.5
  else if (c === false) u0 = 0;
  else u0 = 0.5;                                         // default: 0 deg at the centre
  // u = u0 + dir * lonE / 2pi   (west longitude = -east longitude)
  if (typeof c === 'number' && dir < 0) u0 = 0.5 - c / 360;
  return { key: key.toLowerCase(), url, u0: ((u0 % 1) + 1) % 1, dir };
}

/** Parse the manifest into map infos keyed by lower-case body name. Accepts several plausible layouts. */
export async function loadManifest(): Promise<Map<string, MapInfo>> {
  const out = new Map<string, MapInfo>();
  const url = dataUrl('data/textures/manifest.json');
  let j: any;
  try {
    const res = await fetch(url);
    if (!res.ok) return out;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) return out;   // dev-server SPA fallback
    j = await res.json();
  } catch {
    return out;
  }
  const base = url.replace(/manifest\.json$/, '');
  const add = (key: string, e: any) => {
    const m = parseEntry(e?.key ?? e?.name ?? e?.body ?? key, e, base);
    if (m) out.set(m.key, m);
  };
  const walk = (o: any) => {
    if (!o) return;
    if (Array.isArray(o)) { for (const e of o) add(e?.key ?? e?.name ?? e?.body ?? '', e); return; }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'version' || k === 'notes' || k === 'source' || k === 'sources' || k === 'credits') continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && !('file' in v) && !('path' in v) && !('url' in v) && !('src' in v)) {
        walk(v);                 // nested group, e.g. { moons: { mimas: {...} } }
      } else if (Array.isArray(v)) {
        walk(v);
      } else add(k, v);
    }
  };
  walk(j.maps ?? j.textures ?? j.bodies ?? j);
  return out;
}

async function loadImage(url: string): Promise<ImageBitmap | HTMLImageElement> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const blob = await res.blob();
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob, { colorSpaceConversion: 'none' } as ImageBitmapOptions);
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = URL.createObjectURL(blob);
  });
}

function toPixels(img: ImageBitmap | HTMLImageElement, w: number, h: number): Uint8ClampedArray {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}

const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

function stats(px: Uint8ClampedArray, w: number, h: number): { mean: [number, number, number]; p90: number } {
  // area-weighted (cos latitude) mean of the linear values, plus the 90th percentile of linear luminance
  const m = [0, 0, 0];
  let ws = 0;
  const hist = new Float64Array(256);
  for (let y = 0; y < h; y += 2) {
    const wl = Math.cos(((y + 0.5) / h - 0.5) * Math.PI);
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const r = lin(px[i]), g = lin(px[i + 1]), b = lin(px[i + 2]);
      m[0] += r * wl; m[1] += g * wl; m[2] += b * wl;
      ws += wl;
      hist[Math.min(255, Math.round(Math.cbrt(0.2126 * r + 0.7152 * g + 0.0722 * b) * 255))] += wl;
    }
  }
  let acc = 0, p90 = 1;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= 0.9 * ws) { p90 = Math.pow(i / 255, 3); break; } }
  return { mean: [m[0] / ws, m[1] / ws, m[2] / ws], p90 };
}

export async function loadMoonTextures(maps: Map<string, MapInfo>, keys: string[], width = 2048): Promise<MoonTextureSet | null> {
  const wanted = keys.filter((k) => maps.has(k) && k !== 'saturn' && k !== 'titan');
  if (wanted.length === 0) return null;
  const h = width / 2;
  const loaded: { key: string; px: Uint8ClampedArray; info: MapInfo }[] = [];
  await Promise.all(wanted.map(async (k) => {
    const info = maps.get(k)!;
    try {
      const img = await loadImage(info.url);
      loaded.push({ key: k, px: toPixels(img, width, h), info });
      if ('close' in img) (img as ImageBitmap).close();
    } catch (e) {
      console.warn(`[FarField] texture ${k} failed`, e);
    }
  }));
  if (loaded.length === 0) return null;
  const data = new Uint8Array(width * h * 4 * loaded.length);
  const layers = new Map<string, { layer: number; gain: number; u0: number; dir: number }>();
  loaded.forEach((l, i) => {
    data.set(l.px, i * width * h * 4);
    const s = stats(l.px, width, h);
    const meanY = 0.2126 * s.mean[0] + 0.7152 * s.mean[1] + 0.0722 * s.mean[2];
    const gain = l.key === 'iapetus' ? 1 / Math.max(s.p90, 1e-3) : 1 / Math.max(meanY, 1e-3);
    layers.set(l.key, { layer: i, gain, u0: l.info.u0, dir: l.info.dir });
  });
  const tex = new DataArrayTexture(data, width, h, loaded.length);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return { texture: tex, width, layers };
}

export async function loadSaturnTexture(maps: Map<string, MapInfo>, targetMean: [number, number, number]): Promise<SaturnTexture | null> {
  const info = maps.get('saturn');
  if (!info) return null;
  try {
    const img = await loadImage(info.url);
    const w = Math.min(4096, (img as any).width ?? 4096);
    const h = Math.max(1, Math.round(w / 2));
    const px = toPixels(img, w, h);
    if ('close' in img) (img as ImageBitmap).close();
    const s = stats(px, w, h);
    const tex = new DataTexture(new Uint8Array(px.buffer.slice(0)), w, h, RGBAFormat, UnsignedByteType);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.wrapS = RepeatWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    const gain: [number, number, number] = [0, 1, 2].map((k) => targetMean[k] / Math.max(s.mean[k], 1e-3)) as [number, number, number];
    return { texture: tex, gain, u0: info.u0, dir: info.dir };
  } catch (e) {
    console.warn('[FarField] Saturn texture failed', e);
    return null;
  }
}
