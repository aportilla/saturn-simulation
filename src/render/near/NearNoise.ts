// Periodic 3-D noise textures for the particle surfaces (one trilinear fetch per layer instead of hashed lattice
// evaluations), with analytic gradients, and their CPU samplers (NearRelief.ts mirrors the GLSL relief with them).
//
// tNearNoise: gradient noise, NOISE_N^3 texels, NOISE_P lattice cells per period: (value ~[-1,1], d/dx, d/dy, d/dz)
//   per lattice unit. GLSL: texture(tNearNoise, x / NOISE_P) for lattice coordinates x.
// tNearClast: cellular "clast" field, CLAST_N^3 texels, CLAST_P cells per period (8 texels per cell): one feature
//   point per cell (jittered, random weight omega), h(x) = max_i (omega_i - |x - p_i|^2) - the small-slope height of
//   a union of spheres centred at the feature points (domes with V-shaped creases where they meet, larger domes for
//   larger omega) - normalized to zero mean and unit standard deviation; (h, dh/dx, dh/dy, dh/dz) per lattice unit.
//   GLSL: texture(tNearClast, x / CLAST_P).
import { Data3DTexture, DataUtils, FloatType, HalfFloatType, LinearFilter, RedFormat, RepeatWrapping, RGBAFormat } from 'three';

export const NOISE_N = 64;
export const NOISE_P = 16;
export const CLAST_N = 64;
export const CLAST_P = 8;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function texture3D(data: Float32Array, N: number): Data3DTexture {
  const t = new Data3DTexture(data, N, N, N);
  t.format = RGBAFormat;
  t.type = FloatType;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = RepeatWrapping;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

const noiseCache = new Map<number, Float32Array>();
/** Gradient-noise texel data (RGBA, NOISE_N^3), deterministic per seed. */
export function nearNoiseData(seed = 4242): Float32Array {
  const hit = noiseCache.get(seed);
  if (hit) return hit;
  const P = NOISE_P, N = NOISE_N, S = N / P;
  const rnd = mulberry32(seed);
  const g = new Float32Array(P * P * P * 3);
  for (let i = 0; i < P * P * P; i++) {
    const z = 2 * rnd() - 1, ph = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
    g[i * 3] = r * Math.cos(ph); g[i * 3 + 1] = r * Math.sin(ph); g[i * 3 + 2] = z;
  }
  const G = (x: number, y: number, z: number) => (((z % P) * P + (y % P)) * P + (x % P)) * 3;
  const data = new Float32Array(N * N * N * 4);
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    // sample at texel centres
    const px = (i + 0.5) / S, py = (j + 0.5) / S, pz = (k + 0.5) / S;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    const wx = px - ix, wy = py - iy, wz = pz - iz;
    const u = (w: number) => w * w * w * (w * (w * 6 - 15) + 10);
    const du = (w: number) => 30 * w * w * (w * (w - 2) + 1);
    const ux = u(wx), uy = u(wy), uz = u(wz);
    const dux = du(wx), duy = du(wy), duz = du(wz);
    const corner = (cx: number, cy: number, cz: number) => {
      const o = G(ix + cx, iy + cy, iz + cz);
      const gx = g[o], gy = g[o + 1], gz = g[o + 2];
      return { v: gx * (wx - cx) + gy * (wy - cy) + gz * (wz - cz), gx, gy, gz };
    };
    const a = corner(0, 0, 0), b = corner(1, 0, 0), c = corner(0, 1, 0), d = corner(1, 1, 0);
    const e = corner(0, 0, 1), f = corner(1, 0, 1), h = corner(0, 1, 1), m = corner(1, 1, 1);
    const k1 = b.v - a.v, k2 = c.v - a.v, k3 = e.v - a.v, k4 = a.v - b.v - c.v + d.v, k5 = a.v - c.v - e.v + h.v, k6 = a.v - b.v - e.v + f.v;
    const k7 = -a.v + b.v + c.v - d.v + e.v - f.v - h.v + m.v;
    const v = a.v + k1 * ux + k2 * uy + k3 * uz + k4 * ux * uy + k5 * uy * uz + k6 * uz * ux + k7 * ux * uy * uz;
    const lerpG = (sel: 'gx' | 'gy' | 'gz') =>
      a[sel] + ux * (b[sel] - a[sel]) + uy * (c[sel] - a[sel]) + uz * (e[sel] - a[sel]) + ux * uy * (a[sel] - b[sel] - c[sel] + d[sel])
      + uy * uz * (a[sel] - c[sel] - e[sel] + h[sel]) + uz * ux * (a[sel] - b[sel] - e[sel] + f[sel])
      + ux * uy * uz * (-a[sel] + b[sel] + c[sel] - d[sel] + e[sel] - f[sel] - h[sel] + m[sel]);
    const dvx = lerpG('gx') + dux * (k1 + k4 * uy + k6 * uz + k7 * uy * uz);
    const dvy = lerpG('gy') + duy * (k2 + k5 * uz + k4 * ux + k7 * uz * ux);
    const dvz = lerpG('gz') + duz * (k3 + k6 * ux + k5 * uy + k7 * ux * uy);
    const q = ((k * N + j) * N + i) * 4;
    data[q] = v * 1.6; data[q + 1] = dvx * 1.6; data[q + 2] = dvy * 1.6; data[q + 3] = dvz * 1.6;
  }
  noiseCache.set(seed, data);
  return data;
}

export function buildNearNoise(seed = 4242): Data3DTexture {
  return texture3D(nearNoiseData(seed), NOISE_N);
}

const clastCache = new Map<number, Float32Array>();
/** Cellular clast-field texel data (RGBA, CLAST_N^3), deterministic per seed. */
export function nearClastData(seed = 777): Float32Array {
  const hit = clastCache.get(seed);
  if (hit) return hit;
  const P = CLAST_P, N = CLAST_N, S = N / P;
  const rnd = mulberry32(seed);
  // one feature point per cell: jitter in [0.1, 0.9] (the 3x3x3 neighbourhood then holds the maximum except in
  // rare configurations, where the error is a tiny crease), weight omega in [0, 0.3] (dome size variation)
  const pts = new Float32Array(P * P * P * 4);
  for (let i = 0; i < P * P * P; i++) {
    pts[i * 4] = 0.1 + 0.8 * rnd();
    pts[i * 4 + 1] = 0.1 + 0.8 * rnd();
    pts[i * 4 + 2] = 0.1 + 0.8 * rnd();
    pts[i * 4 + 3] = 0.3 * rnd();
  }
  const data = new Float32Array(N * N * N * 4);
  let sum = 0, sum2 = 0;
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const px = (i + 0.5) / S, py = (j + 0.5) / S, pz = (k + 0.5) / S;
    const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
    let best = -1e9, gx = 0, gy = 0, gz = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ox = cx + dx, oy = cy + dy, oz = cz + dz;
      const o = ((((oz % P) + P) % P) * P * P + (((oy % P) + P) % P) * P + (((ox % P) + P) % P)) * 4;
      const qx = ox + pts[o] - px, qy = oy + pts[o + 1] - py, qz = oz + pts[o + 2] - pz;
      const v = pts[o + 3] - (qx * qx + qy * qy + qz * qz);
      if (v > best) { best = v; gx = 2 * qx; gy = 2 * qy; gz = 2 * qz; }   // d/dx (omega - |x - p|^2) = 2 (p - x)
    }
    const q = ((k * N + j) * N + i) * 4;
    data[q] = best; data[q + 1] = gx; data[q + 2] = gy; data[q + 3] = gz;
    sum += best;
    sum2 += best * best;
  }
  const n = N * N * N, mean = sum / n, sd = Math.sqrt(Math.max(sum2 / n - mean * mean, 1e-12));
  for (let i = 0; i < n; i++) {
    data[i * 4] = (data[i * 4] - mean) / sd;
    data[i * 4 + 1] /= sd; data[i * 4 + 2] /= sd; data[i * 4 + 3] /= sd;
  }
  clastCache.set(seed, data);
  return data;
}

export function buildNearClasts(seed = 777): Data3DTexture {
  return texture3D(nearClastData(seed), CLAST_N);
}

/**
 * Value channel only, half float (R16F): the ray march and the shadow-outline profiles need no gradient, and an
 * R16F trilinear fetch moves 1/8 of the bytes of an RGBA32F one. Same texel grid, so it samples the same field.
 */
export function buildValueTexture(data: Float32Array, N: number): Data3DTexture {
  const v = new Uint16Array(N * N * N);
  for (let i = 0; i < v.length; i++) v[i] = DataUtils.toHalfFloat(data[i * 4]);
  const t = new Data3DTexture(v, N, N, N);
  t.format = RedFormat;
  t.type = HalfFloatType;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = RepeatWrapping;
  t.generateMipmaps = false;
  t.unpackAlignment = 2;
  t.needsUpdate = true;
  return t;
}

/**
 * Bound of |grad v| (per lattice unit) of the trilinearly interpolated value channel: every partial derivative is
 * an interpolation of neighbouring texel differences / spacing, so |grad| <= sqrt(3) x the largest of those
 * (the Lipschitz constant of the ray march's sphere tracing).
 */
export function gradientBound(data: Float32Array, N: number, P: number): number {
  let m = 0;
  const at = (i: number, j: number, k: number) => data[((((k % N) * N) + (j % N)) * N + (i % N)) * 4];
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const v = at(i, j, k);
    m = Math.max(m, Math.abs(at(i + 1, j, k) - v), Math.abs(at(i, j + 1, k) - v), Math.abs(at(i, j, k + 1) - v));
  }
  return Math.sqrt(3) * m * (N / P);
}

/** [min, max] of the value channel: exact bounds of any trilinear sample (shape bounds, NearRelief.ts). */
export function valueRange(data: Float32Array): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < data.length; i += 4) { lo = Math.min(lo, data[i]); hi = Math.max(hi, data[i]); }
  return [lo, hi];
}

/**
 * CPU mirror of texture(t, x / P) on a periodic N^3 RGBA texture with linear filtering and repeat wrapping:
 * writes (value, gradient) at lattice coordinates (x, y, z) into out[0..3].
 */
export function sampleTex3(data: Float32Array, N: number, P: number, x: number, y: number, z: number, out: Float64Array): void {
  const s = N / P;
  const u = x * s - 0.5, v = y * s - 0.5, w = z * s - 0.5;
  const i0 = Math.floor(u), j0 = Math.floor(v), k0 = Math.floor(w);
  const fx = u - i0, fy = v - j0, fz = w - k0;
  const m = (a: number) => ((a % N) + N) % N;
  const ia = m(i0), ib = m(i0 + 1), ja = m(j0), jb = m(j0 + 1), ka = m(k0), kb = m(k0 + 1);
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let c = 0; c < 8; c++) {
    const ii = c & 1 ? ib : ia, jj = c & 2 ? jb : ja, kk = c & 4 ? kb : ka;
    const wt = (c & 1 ? fx : 1 - fx) * (c & 2 ? fy : 1 - fy) * (c & 4 ? fz : 1 - fz);
    const q = ((kk * N + jj) * N + ii) * 4;
    out[0] += wt * data[q]; out[1] += wt * data[q + 1]; out[2] += wt * data[q + 2]; out[3] += wt * data[q + 3];
  }
}
