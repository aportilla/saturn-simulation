// Measured shapes of Saturn's small inner moons (Pan, Daphnis, Atlas, Prometheus, Pandora, Epimetheus, Janus):
// star-shaped radius maps r(lat, lonE) resampled from the Cassini ISS plate models of P. C. Thomas, J. Joseph &
// T. Ansty (2018), "Saturn Small Moon Shape Models V1.0", NASA PDS Small Bodies Node, doi:10.26033/ewy3-jy61, by
// scripts/data/moons/build_shapes.mjs (public/data/moons/shapes.{json,u16}; format in docs/data-sources.md).
// Body frame as src/moons/types.ts - the plate models use the same axes: +x = prime meridian (Saturn-facing),
// +z = north spin pole, +y = 90E (trailing side).
//
// The map is interpolated bilinearly in (lon, lat); radiusAlong() is exactly the function the far-field shader
// ray-marches (render/far/glsl/moons.ts, shapeFetch), so camera clearances and the rendered surface agree.
import type { Vector3 } from 'three';
import type { MoonState } from '../core/FrameState';
import { dataUrl } from '../core/assets';

export interface MoonShapeGrid {
  /** columns (east longitude -180 + i*step, periodic) */
  width: number;
  /** rows (latitude -90 + j*step; row 0 = south pole, both pole rows constant) */
  height: number;
  /** grid step (rad) */
  step: number;
}

export interface MoonShapeInfo {
  /** volume-equivalent radius of the plate model (m) */
  meanRadius: number;
  volume: number;
  /** stated model radius uncertainty (km, text from the PDS documentation) */
  uncertaintyKm: string | null;
  /** best-fit axis-aligned ellipsoid of the model (m), for comparison with MoonState.radii */
  ellipsoid: [number, number, number];
}

export class MoonShape {
  /** largest / smallest radius of the interpolated map (m): bounding and inner sphere */
  readonly rMax: number;
  readonly rMin: number;
  /**
   * Step factor of a sphere-traced march on F(p) = |p| - r(p/|p|): F is Lipschitz with constant
   * sqrt(1 + (L/r_min)^2) outside the inner sphere (L = max arc-length slope of the map), so a step of
   * F * marchStep never crosses the surface.
   */
  readonly marchStep: number;

  constructor(
    readonly key: string,
    readonly grid: MoonShapeGrid,
    /** radius map (m), row-major, row 0 = south pole */
    readonly r: Float32Array,
    slopeOverRmin: number,
    readonly info: MoonShapeInfo,
  ) {
    let lo = Infinity, hi = 0;
    for (let k = 0; k < r.length; k++) { lo = Math.min(lo, r[k]); hi = Math.max(hi, r[k]); }
    this.rMax = hi;
    this.rMin = lo;
    this.marchStep = 1 / Math.sqrt(1 + slopeOverRmin * slopeOverRmin);
  }

  /** Surface radius (m) along a body-frame direction (any length). */
  radiusAlong(x: number, y: number, z: number): number {
    const { width: W, height: H, step } = this.grid;
    const rxy = Math.hypot(x, y);
    const lon = rxy > 0 ? Math.atan2(y, x) : 0;
    const lat = Math.atan2(z, rxy);
    const u = (lon + Math.PI) / step;
    const v = Math.min(H - 1, Math.max(0, (lat + 0.5 * Math.PI) / step));
    const i0f = Math.floor(u), fx = u - i0f;
    const i0 = ((i0f % W) + W) % W, i1 = (i0 + 1) % W;
    const j0 = Math.min(H - 2, Math.floor(v)), fy = v - j0;
    const r = this.r;
    const a = r[j0 * W + i0] + (r[j0 * W + i1] - r[j0 * W + i0]) * fx;
    const b = r[(j0 + 1) * W + i0] + (r[(j0 + 1) * W + i1] - r[(j0 + 1) * W + i0]) * fx;
    return a + (b - a) * fy;
  }

  /**
   * Tangential gradient of r (m per radian of arc, body xyz) at every grid node, by central differences (pole
   * nodes: planar fit to the adjacent ring). Interpolated bilinearly on the GPU it gives continuous normals
   * n = normalize(u - grad r / r) over the C0 bilinear surface. Two fields, for the northern (lat >= 0) and the
   * southern samples: they differ only on the equator row where the map has a crease - the ridge crests of Pan,
   * Atlas and Daphnis are a vertex chain exactly on the equator - where each takes the one-sided slope of its own
   * flank, so the crest stays sharp instead of being averaged over +-1 grid step.
   */
  gradientFields(): { north: Float32Array; south: Float32Array } {
    const north = this.centralGradient();
    const south = north.slice();
    const { width: W, height: H, step } = this.grid;
    const r = this.r;
    const je = (H - 1) / 2;
    if (Number.isInteger(je)) {
      const CREASE = (20 * Math.PI) / 180;
      for (let i = 0; i < W; i++) {
        const k = je * W + i, rc = r[k];
        const sN = (r[k + W] - rc) / step, sS = (rc - r[k - W]) / step;   // d r / d lat on either side
        if (Math.abs(Math.atan(-sN / rc) + Math.atan(sS / rc)) < CREASE) continue;
        const dLon = (r[je * W + ((i + 1) % W)] - r[je * W + ((i + W - 1) % W)]) / (2 * step);
        const lon = -Math.PI + i * step, so = Math.sin(lon), co = Math.cos(lon);
        // equator: e_lat = (0, 0, 1), e_lon = (-sin lon, cos lon, 0)
        north[3 * k] = -so * dLon; north[3 * k + 1] = co * dLon; north[3 * k + 2] = sN;
        south[3 * k] = -so * dLon; south[3 * k + 1] = co * dLon; south[3 * k + 2] = sS;
      }
    }
    return { north, south };
  }

  private centralGradient(): Float32Array {
    const { width: W, height: H, step } = this.grid;
    const r = this.r;
    const g = new Float32Array(W * H * 3);
    for (const [j, ring] of [[0, 1], [H - 1, H - 2]]) {
      const rp = r[j * W];
      let gx = 0, gy = 0;
      for (let i = 0; i < W; i++) {
        const lon = -Math.PI + i * step;
        const dr = r[ring * W + i] - rp;
        gx += dr * Math.cos(lon); gy += dr * Math.sin(lon);
      }
      gx *= 2 / (W * step); gy *= 2 / (W * step);
      for (let i = 0; i < W; i++) { g[3 * (j * W + i)] = gx; g[3 * (j * W + i) + 1] = gy; g[3 * (j * W + i) + 2] = 0; }
    }
    for (let j = 1; j < H - 1; j++) {
      const lat = -0.5 * Math.PI + j * step, sl = Math.sin(lat), cl = Math.cos(lat);
      for (let i = 0; i < W; i++) {
        const lon = -Math.PI + i * step, so = Math.sin(lon), co = Math.cos(lon);
        const dLat = (r[(j + 1) * W + i] - r[(j - 1) * W + i]) / (2 * step);
        const dLon = (r[j * W + ((i + 1) % W)] - r[j * W + ((i + W - 1) % W)]) / (2 * step * cl);
        const k = 3 * (j * W + i);
        // e_lat = (-sin lat cos lon, -sin lat sin lon, cos lat), e_lon = (-sin lon, cos lon, 0)
        g[k] = -sl * co * dLat - so * dLon;
        g[k + 1] = -sl * so * dLat + co * dLon;
        g[k + 2] = cl * dLat;
      }
    }
    return g;
  }
}

/** Surface radius (m) of a moon along a body-frame direction: the measured shape if loaded, else its ellipsoid. */
export function moonSurfaceRadius(m: MoonState, d: Vector3): number {
  if (m.shape) return m.shape.radiusAlong(d.x, d.y, d.z);
  const r = m.radii, l = Math.hypot(d.x, d.y, d.z) || 1;
  const x = d.x / (l * r.x), y = d.y / (l * r.y), z = d.z / (l * r.z);
  return 1 / Math.sqrt(x * x + y * y + z * z);
}

interface ShapesJson {
  format: string;
  file: string;
  bytes: number;
  grid: { width: number; height: number; stepDeg: number; lonStartDeg: number; latStartDeg: number };
  moons: Record<string, {
    offset: number; count: number; scaleKm: number; slopeOverRmin: number; meanRadiusKm: number; volumeKm3: number;
    uncertaintyKm: string | null; ellipsoidFitKm: [number, number, number];
  }>;
}

async function fetchChecked(url: string, kind: 'json' | 'binary'): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // the dev server answers missing files with index.html (status 200)
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) throw new Error(`${url}: got HTML (file missing?)`);
  if (kind === 'json' && ct && !ct.includes('json')) throw new Error(`${url}: unexpected content-type ${ct}`);
  return res;
}

/**
 * Load the measured shape maps (keyed by lower-case moon name). Resolves to an empty map (with a console warning)
 * when the files are missing or malformed - the renderer and cameras then fall back to the triaxial ellipsoids.
 */
export async function loadMoonShapes(): Promise<Map<string, MoonShape>> {
  const out = new Map<string, MoonShape>();
  try {
    const j = (await (await fetchChecked(dataUrl('data/moons/shapes.json'), 'json')).json()) as ShapesJson;
    const g = j.grid;
    if (!(g?.width > 1 && g?.height > 2) || g.lonStartDeg !== -180 || g.latStartDeg !== -90
      || Math.abs(g.stepDeg * (g.height - 1) - 180) > 1e-9 || Math.abs(g.stepDeg * g.width - 360) > 1e-9) {
      throw new Error('shapes.json: unsupported grid');
    }
    const buf = await (await fetchChecked(dataUrl(j.file), 'binary')).arrayBuffer();
    if (buf.byteLength !== j.bytes || buf.byteLength % 2 !== 0) throw new Error(`${j.file}: ${buf.byteLength} bytes, expected ${j.bytes}`);
    const dv = new DataView(buf);
    const grid: MoonShapeGrid = { width: g.width, height: g.height, step: (g.stepDeg * Math.PI) / 180 };
    const n = g.width * g.height;
    for (const [key, e] of Object.entries(j.moons)) {
      if (e.count !== n || (e.offset + n) * 2 > buf.byteLength) throw new Error(`shapes.json: bad extent for ${key}`);
      const r = new Float32Array(n);
      const s = e.scaleKm * 1e3;
      for (let k = 0; k < n; k++) r[k] = dv.getUint16(2 * (e.offset + k), true) * s;
      out.set(key.toLowerCase(), new MoonShape(key.toLowerCase(), grid, r, e.slopeOverRmin, {
        meanRadius: e.meanRadiusKm * 1e3,
        volume: e.volumeKm3 * 1e9,
        uncertaintyKm: e.uncertaintyKm,
        ellipsoid: [e.ellipsoidFitKm[0] * 1e3, e.ellipsoidFitKm[1] * 1e3, e.ellipsoidFitKm[2] * 1e3],
      }));
    }
  } catch (e) {
    console.warn('[moons] measured shape maps unavailable, small moons drawn as ellipsoids:', e);
    out.clear();
  }
  return out;
}
