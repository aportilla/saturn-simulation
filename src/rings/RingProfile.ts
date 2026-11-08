// Radial profile of the main rings (D ring .. Roche Division) on a fine regular grid, plus GPU textures.
//
// Optical depth: real Cassini occultation data if present at public/data/rings/tau_main.{json,f32}
// (see docs/ARCHITECTURE.md "Data formats"), otherwise a procedural model built from RING_FEATURES.
// Other per-radius quantities (thickness, surface density, albedo, wake strength, dust fraction,
// size distribution) come from the zone table in ringRegions.ts.
//
// GPU layout: two RGBA32F textures of width TEX_W holding a 1-D mip pyramid, all levels concatenated:
//   texA = (tauEff, H [m], Sigma [kg/m^2], wake)     texB = (albedoR, albedoG, albedoB, dust)
// Level 0 is the native grid. Level L sample j averages level-0 samples [j*2^L, (j+1)*2^L) and is centered
// at r = rMin + (j*2^L + (2^L-1)/2) * dr0. tauEff of coarse levels preserves the mean transmission at
// mu = MU_REF: tauEff = -MU_REF * ln(mean(exp(-tau/MU_REF))) (radial prefiltering for distant views).
import { DataTexture, FloatType, NearestFilter, RGBAFormat, ClampToEdgeWrapping } from 'three';
import { RING_FEATURES, RING_ZONES, zoneParamsAtKm, describeRadiusKm, type RingZone, type ZoneParams } from './ringRegions';
import { EDGE_FEATURES, snapshotDisplacement } from './ringModes';
import { dataUrl } from '../core/assets';

export const PROFILE_R_MIN_KM = 66_000;
export const PROFILE_R_MAX_KM = 139_500;
export const PROFILE_DR_KM = 0.25;
export const TEX_W = 4096;
export const MU_REF = 0.5;
export const MAX_LEVELS = 16;

export interface RingLocal {
  rKm: number;
  tau: number;
  H: number;
  sigma: number;
  wake: number;
  dust: number;
  albedo: [number, number, number];
  q: number;
  aMin: number;
  aMax: number;
  macroscopic: boolean;
  zone: RingZone | null;
  description: string;
}

// ------------------------------------------------------------------ deterministic noise
function hash1(i: number): number {
  let h = (i | 0) * 374761393 + 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}
function vnoise(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}
function fbm(x: number, oct = 5): number {
  let a = 0.5, s = 0, n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * (vnoise(x) * 2 - 1);
    n += a;
    x *= 2.03;
    a *= 0.55;
  }
  return s / n;
}
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const box = (r: number, c: number, w: number, edge = 0.5) => smooth(c - w / 2 - edge, c - w / 2 + edge, r) * (1 - smooth(c + w / 2 - edge, c + w / 2 + edge, r));

/**
 * Surface mass density (kg/m^2). Density-wave measurements show tau is a poor proxy for Sigma inside the
 * B and C rings, so the zone table supplies an affine model (docs/ring-physics.md):
 *   Sigma = sigma0 * smooth(0.002, 0.02, tau) + sigmaSlope * tau
 * (zones without sigma0 get sigma0 = 0, sigmaSlope = sigmaPerTau: the proportional model).
 */
function sigmaModel(zp: ZoneParams, tau: number): number {
  return zp.sigma0 * smooth(0.002, 0.02, tau) + zp.sigmaSlope * tau;
}

/** Procedural normal optical depth (fallback when no occultation data is available). */
export function proceduralTauKm(r: number): number {
  let tau = 0;
  if (r > 136_774) {
    // Roche Division: faint dusty sheet (tau ~ 1e-4) between the A ring and the F ring
    return r < 139_380 ? 1e-4 * (1 + 0.5 * fbm(r / 200)) : 0;
  } else if (r < 66_900) {
    tau = 0;
  } else if (r < 74_490) {
    tau = 2e-4 + 1e-3 * Math.max(0, fbm(r / 300));
  } else if (r < 91_983) {
    // C ring background with gentle undulations; ramp toward the B ring
    tau = 0.07 + 0.03 * fbm(r / 400) + 0.015 * fbm(r / 30);
    tau += 0.18 * smooth(90_600, 91_983, r);
  } else if (r < 117_516) {
    // B ring: irregular structure on 100 km scales; very opaque core B3
    let base: number;
    if (r < 99_000) base = 1.0 + 0.6 * smooth(92_000, 99_000, r);
    else if (r < 104_500) base = 2.4;
    else if (r < 110_000) base = 4.6;
    else base = 2.6;
    const irr = r < 99_000 ? 0.25 : 0.45;
    tau = base * (1 + irr * fbm(r / 150) + 0.15 * fbm(r / 15));
    tau = Math.max(0.6, tau);
  } else if (r < 122_053) {
    tau = 0.09 + 0.04 * fbm(r / 120);
    tau += 0.4 * smooth(120_700, 122_053, r);
  } else {
    // A ring
    if (r < 127_000) tau = 0.55 + 0.45 * smooth(122_053, 123_200, r);
    else tau = 0.62 - 0.12 * smooth(127_000, 136_500, r);
    tau *= 1 + 0.08 * fbm(r / 80) + 0.05 * fbm(r / 8);
  }
  // features
  for (const f of RING_FEATURES) {
    if (Math.abs(r - f.rKm) > f.widthKm + 50) continue;
    if (f.type === 'gap') {
      tau *= 1 - 0.995 * box(r, f.rKm, f.widthKm, Math.min(2, f.widthKm * 0.05));
    } else if ((f.type === 'ringlet' || f.type === 'plateau') && f.tau !== undefined) {
      const w = box(r, f.rKm, f.widthKm, Math.min(3, f.widthKm * 0.05));
      tau = tau * (1 - w) + f.tau * w * (1 + 0.1 * fbm(r / 5));
    } else if (f.type === 'densityWave') {
      const x = r - f.rKm;
      if (x > 0 && x < f.widthKm * 2) {
        const env = Math.exp(-x / (f.widthKm * 0.7)) * smooth(0, 3, x);
        const k = (2 * Math.PI) / Math.max(1.0, 12 - x * 0.15);
        tau *= 1 + 0.5 * env * Math.sin(k * x);
      }
    }
  }
  // sharp outer edges
  if (r > 117_516 && r < 117_520) tau *= 1 - smooth(117_516, 117_518, r);
  return Math.max(0, tau);
}

// ------------------------------------------------------------------ data loading
interface TauData {
  r0Km: number;
  drKm: number;
  tau: Float32Array;
  source: string;
}

async function loadTauData(base = dataUrl('data/rings/tau_main')): Promise<TauData | null> {
  try {
    // note: the dev server answers unknown paths with index.html (200), so validate content
    const mres = await fetch(base + '.json');
    if (!mres.ok || !(mres.headers.get('content-type') ?? '').includes('json')) return null;
    const meta = await mres.json();
    const bres = await fetch(base + '.f32');
    if (!bres.ok || (bres.headers.get('content-type') ?? '').includes('html')) return null;
    const buf = await bres.arrayBuffer();
    if (buf.byteLength % 4 !== 0) return null;
    const tau = new Float32Array(buf);
    if (tau.length !== meta.n || !(meta.dr_km > 0)) {
      console.warn(`[RingProfile] tau_main.f32 length ${tau.length} != meta.n ${meta.n}; ignoring data`);
      return null;
    }
    return { r0Km: meta.r0_km, drKm: meta.dr_km, tau, source: meta.source ?? 'data' };
  } catch (e) {
    console.warn('[RingProfile] no occultation data, using procedural profile', e);
    return null;
  }
}

// ------------------------------------------------------------------ profile
export class RingProfile {
  readonly rMinKm = PROFILE_R_MIN_KM;
  readonly drKm = PROFILE_DR_KM;
  readonly n: number;
  readonly tau: Float32Array;
  readonly H: Float32Array;
  readonly sigma: Float32Array;
  readonly wake: Float32Array;
  readonly dust: Float32Array;
  readonly albedo: Float32Array; // rgb interleaved
  source = 'procedural';

  texA: DataTexture | null = null;
  texB: DataTexture | null = null;
  levelOffsets: number[] = [];
  levelCounts: number[] = [];

  private constructor(n: number) {
    this.n = n;
    this.tau = new Float32Array(n);
    this.H = new Float32Array(n);
    this.sigma = new Float32Array(n);
    this.wake = new Float32Array(n);
    this.dust = new Float32Array(n);
    this.albedo = new Float32Array(n * 3);
  }

  static async load(): Promise<RingProfile> {
    const n = Math.floor((PROFILE_R_MAX_KM - PROFILE_R_MIN_KM) / PROFILE_DR_KM) + 1;
    const p = new RingProfile(n);
    const data = await loadTauData();
    if (data) p.source = data.source;
    // Where real data is unreliable (D ring, dusty gaps: tau below detection) blend in procedural values.
    for (let i = 0; i < n; i++) {
      const r = PROFILE_R_MIN_KM + i * PROFILE_DR_KM;
      let tau = proceduralTauKm(r);
      if (data) {
        const fi = (r - data.r0Km) / data.drKm;
        const i0 = Math.floor(fi);
        if (i0 >= 0 && i0 + 1 < data.tau.length) {
          const f = fi - i0;
          const a = data.tau[i0], b = data.tau[i0 + 1];
          if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0) {
            const d = a * (1 - f) + b * f;
            // keep procedural dust floor inside gaps / D ring where data are at noise level
            tau = r < 74_490 ? Math.max(d, tau) : d;
          }
        }
      }
      p.tau[i] = tau;
    }
    if (data) p.deprojectSnapshot();
    p.fillDerived();
    p.buildTextures();
    console.info(`[RingProfile] ${n} samples @ ${PROFILE_DR_KM} km, source: ${p.source}`);
    return p;
  }

  /**
   * The occultation is a snapshot (RSS Rev 7 egress, 2005-123): eccentric edges with normal modes (EDGE_FEATURES,
   * ringModes.ts) were caught displaced at its longitude. The renderer's profile is LAGRANGIAN (sv_ringStructure moves
   * the streamlines back with the live modes), so around each feature the snapshot is de-projected:
   *   tau0(a') = tau_snap(a' + xi_s(a')) (1 + dxi_s/da')      (surface density conserved)
   * with xi_s the feature's displacement field at the snapshot (scaled to the measured snapshot edge).
   */
  private deprojectSnapshot(): void {
    const snap = Float32Array.from(this.tau);
    const at = (rKm: number) => {
      const fi = (rKm - PROFILE_R_MIN_KM) / PROFILE_DR_KM;
      const i0 = Math.floor(fi);
      if (i0 < 0 || i0 + 1 >= this.n) return 0;
      const f = fi - i0;
      return snap[i0] * (1 - f) + snap[i0 + 1] * f;
    };
    const s = [0, 0];
    for (const ft of EDGE_FEATURES) {
      // the feature's zone in a': material side out to `reach`, gap side out to `gap`
      const loKm = (ft.material < 0 ? ft.aEdge - ft.reach : ft.aEdge - ft.gap) / 1000;
      const hiKm = (ft.material < 0 ? ft.aEdge + ft.gap : ft.aEdge + ft.reach) / 1000;
      const i0 = Math.max(0, Math.floor((loKm - PROFILE_R_MIN_KM) / PROFILE_DR_KM));
      const i1 = Math.min(this.n - 1, Math.ceil((hiKm - PROFILE_R_MIN_KM) / PROFILE_DR_KM));
      for (let i = i0; i <= i1; i++) {
        const aKm = PROFILE_R_MIN_KM + i * PROFILE_DR_KM;
        snapshotDisplacement(ft, aKm * 1000, s);
        this.tau[i] = Math.max(0, at(aKm + s[0] / 1000) * (1 + s[1]));
      }
    }
    this.source += ' (eccentric edges de-projected to mean radii: src/rings/ringModes.ts)';
  }

  private fillDerived(): void {
    for (let i = 0; i < this.n; i++) {
      const r = PROFILE_R_MIN_KM + i * PROFILE_DR_KM;
      const zp = zoneParamsAtKm(r);
      const tau = this.tau[i];
      this.H[i] = zp.H;
      this.sigma[i] = sigmaModel(zp, tau);
      // wakes need a dense, massive ring: fade out at low optical depth
      this.wake[i] = zp.wake * smooth(0.15, 0.4, tau);
      // in gaps of macroscopic zones the residual material is dust
      this.dust[i] = zp.macroscopic ? Math.max(zp.dust, 1 - smooth(0.002, 0.02, tau)) : 1;
      this.albedo[i * 3] = zp.albedo[0];
      this.albedo[i * 3 + 1] = zp.albedo[1];
      this.albedo[i * 3 + 2] = zp.albedo[2];
    }
  }

  private buildTextures(): void {
    // level 0 arrays
    const levels: { meanT: Float32Array; H: Float32Array; S: Float32Array; W: Float32Array; A: Float32Array; D: Float32Array; n: number }[] = [];
    const n0 = this.n;
    const meanT0 = new Float32Array(n0);
    for (let i = 0; i < n0; i++) meanT0[i] = Math.exp(-this.tau[i] / MU_REF);
    levels.push({ meanT: meanT0, H: this.H, S: this.sigma, W: this.wake, A: this.albedo, D: this.dust, n: n0 });
    while (levels.length < MAX_LEVELS && levels[levels.length - 1].n > 64) {
      const p = levels[levels.length - 1];
      const n = Math.ceil(p.n / 2);
      const L = { meanT: new Float32Array(n), H: new Float32Array(n), S: new Float32Array(n), W: new Float32Array(n), A: new Float32Array(n * 3), D: new Float32Array(n), n };
      for (let j = 0; j < n; j++) {
        const a = 2 * j, b = Math.min(2 * j + 1, p.n - 1);
        L.meanT[j] = 0.5 * (p.meanT[a] + p.meanT[b]);
        L.H[j] = 0.5 * (p.H[a] + p.H[b]);
        L.S[j] = 0.5 * (p.S[a] + p.S[b]);
        L.W[j] = 0.5 * (p.W[a] + p.W[b]);
        L.D[j] = 0.5 * (p.D[a] + p.D[b]);
        // albedo weighted by particle coverage (1 - T)
        const wa = 1 - p.meanT[a] + 1e-6, wb = 1 - p.meanT[b] + 1e-6;
        for (let c = 0; c < 3; c++) L.A[j * 3 + c] = (p.A[a * 3 + c] * wa + p.A[b * 3 + c] * wb) / (wa + wb);
      }
      levels.push(L);
    }
    let total = 0;
    this.levelOffsets = [];
    this.levelCounts = [];
    for (const L of levels) {
      this.levelOffsets.push(total);
      this.levelCounts.push(L.n);
      total += L.n;
    }
    const h = Math.ceil(total / TEX_W);
    const da = new Float32Array(TEX_W * h * 4);
    const db = new Float32Array(TEX_W * h * 4);
    levels.forEach((L, li) => {
      const off = this.levelOffsets[li];
      for (let j = 0; j < L.n; j++) {
        const k = (off + j) * 4;
        const T = Math.max(L.meanT[j], 1e-30);
        da[k] = li === 0 ? this.tau[j] : -MU_REF * Math.log(T);
        da[k + 1] = L.H[j];
        da[k + 2] = L.S[j];
        da[k + 3] = L.W[j];
        db[k] = L.A[j * 3];
        db[k + 1] = L.A[j * 3 + 1];
        db[k + 2] = L.A[j * 3 + 2];
        db[k + 3] = L.D[j];
      }
    });
    const mk = (d: Float32Array) => {
      const t = new DataTexture(d, TEX_W, h, RGBAFormat, FloatType);
      t.minFilter = NearestFilter;
      t.magFilter = NearestFilter;
      t.wrapS = ClampToEdgeWrapping;
      t.wrapT = ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    this.texA = mk(da);
    this.texB = mk(db);
  }

  /** Linear-interpolated level-0 tau at radius rKm (0 outside the profile). */
  tauAtKm(rKm: number): number {
    const fi = (rKm - PROFILE_R_MIN_KM) / PROFILE_DR_KM;
    const i0 = Math.floor(fi);
    if (i0 < 0 || i0 + 1 >= this.n) return 0;
    const f = fi - i0;
    return this.tau[i0] * (1 - f) + this.tau[i0 + 1] * f;
  }

  /** Max tau over [rKm - halfWidthKm, rKm + halfWidthKm] */
  maxTauKm(rKm: number, halfWidthKm: number): number {
    const i0 = Math.max(0, Math.floor((rKm - halfWidthKm - PROFILE_R_MIN_KM) / PROFILE_DR_KM));
    const i1 = Math.min(this.n - 1, Math.ceil((rKm + halfWidthKm - PROFILE_R_MIN_KM) / PROFILE_DR_KM));
    let m = 0;
    for (let i = i0; i <= i1; i++) m = Math.max(m, this.tau[i]);
    return m;
  }

  /** Full local physical description at radius r (meters). */
  local(rMeters: number): RingLocal {
    const rKm = rMeters / 1000;
    const zp = zoneParamsAtKm(rKm);
    const tau = this.tauAtKm(rKm);
    return {
      rKm,
      tau,
      H: zp.H,
      sigma: sigmaModel(zp, tau),
      wake: zp.wake * smooth(0.15, 0.4, tau),
      dust: zp.macroscopic ? Math.max(zp.dust, 1 - smooth(0.002, 0.02, tau)) : 1,
      albedo: zp.albedo,
      q: zp.q,
      aMin: zp.aMin,
      aMax: zp.aMax,
      macroscopic: zp.macroscopic && tau > 0.002,
      zone: zp.zone,
      description: describeRadiusKm(rKm),
    };
  }

  /** Uniform values for src/render/shaders/ringProfile.glsl */
  uniformValues() {
    const offs = new Int32Array(MAX_LEVELS);
    const cnts = new Int32Array(MAX_LEVELS);
    this.levelOffsets.forEach((o, i) => (offs[i] = o));
    this.levelCounts.forEach((c, i) => (cnts[i] = c));
    return {
      uRingTexA: this.texA,
      uRingTexB: this.texB,
      uRingTexW: TEX_W,
      uRingRMin: PROFILE_R_MIN_KM * 1000,
      uRingDr0: PROFILE_DR_KM * 1000,
      uRingLevels: this.levelOffsets.length,
      uRingLevelOff: offs,
      uRingLevelN: cnts,
    };
  }
}

export { RING_ZONES };
