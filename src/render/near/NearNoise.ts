// Periodic 3-D gradient noise with analytic gradient, precomputed into a texture for the particle surfaces
// (one trilinear fetch per octave instead of 8 hashed lattice gradients).
// Texture: RGBA32F, N^3 texels, P lattice cells per period (N/P samples per cell): (value ~[-1,1], d/dx, d/dy, d/dz)
// with derivatives per lattice unit. GLSL: texture(tNearNoise, x / P) for lattice coordinates x.
import { Data3DTexture, FloatType, LinearFilter, RepeatWrapping, RGBAFormat } from 'three';

export const NOISE_N = 64;
export const NOISE_P = 16;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildNearNoise(seed = 4242): Data3DTexture {
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
