// Ring-layer prefiltered radial pyramid, derived from the shared RingProfile (same level layout as the
// shared textures, so the shader reuses uRingLevelOff / uRingLevelN / uRingTexW).
//
// Why a second pyramid: the shared one stores a single effective optical depth per coarse sample that
// preserves the mean transmission at mu = 0.5. Brightness and transmission of a ring with unresolved
// radial structure depend on the slant path factor 1/m: <exp(-tau/m)> over the footprint. We store, per
// level, tau_eff(m) = -m ln <exp(-tau/m)> for m = 0.3^k, k = 0..4 (1 .. 0.0081), interpolated in log m.
// This makes transmission (m = mu), lit-side single scattering (m = 1/(1/mu + 1/mu0)) and unlit-side
// single scattering (difference of two transmissions) EXACT averages over the footprint at any
// viewing angle, including grazing ones.
//
// The optical depth is that of the particle population (docs/ring-physics.md 10.12): two halves stacked vertically
// (rows [0, h) and [h, 2h), same level layout) -- tau_dyn (RingProfile.tauDyn: the clumped medium with self-gravity
// wakes, whose mean normal transmission is the occultation's) and tau_iso (RingProfile.tauIso: without wakes; also the
// homogeneous layer of the two-stream multiple scattering). The shader selects the half (uRlTauHalf).
//
//   P0 = (tau_eff(m0), tau_eff(m1), tau_eff(m2), tau_eff(m3))
//   P1 = (tau_eff(m4), H [m], wake x pbar, D = volume filling factor)   (wake strength x the column's participation)
//   P2 = (albedo r, g, b, dust)          (albedo weighted by particle coverage, like the shared pyramid)
import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three';
import type { RingProfile } from '../../rings/RingProfile';
import { TEX_W } from '../../rings/RingProfile';

export const TAU_M = [1, 0.3, 0.09, 0.027, 0.0081];
/** bulk density of a (porous, icy) ring particle (kg/m^3), for the volume filling factor */
export const PARTICLE_DENSITY = 450;

export class TauPyramid {
  readonly texP0: DataTexture;
  readonly texP1: DataTexture;
  readonly texP2: DataTexture;
  /** spacing (m) of the coarsest level */
  readonly coarsestSpacing: number;
  readonly levels: number;
  /** texel offset of the second (tau_iso) half: rows h .. 2h - 1 */
  readonly halfOffset: number;

  constructor(profile: RingProfile) {
    const offs = profile.levelOffsets;
    const cnts = profile.levelCounts;
    const nL = offs.length;
    this.levels = nL;
    const total = offs[nL - 1] + cnts[nL - 1];
    const h = Math.ceil(total / TEX_W);
    this.halfOffset = h * TEX_W;
    const p0 = new Float32Array(TEX_W * 2 * h * 4);
    const p1 = new Float32Array(TEX_W * 2 * h * 4);
    const p2 = new Float32Array(TEX_W * h * 4);
    const NM = TAU_M.length;
    const n0 = profile.n;
    for (let half = 0; half < 2; half++) {
      const tauArr = half === 0 ? profile.tauDyn : profile.tauIso;
      const base = half * this.halfOffset;
      // level-0 working arrays (doubles)
      let lnT = new Float64Array(n0 * NM);
      let H = new Float64Array(n0);
      let W = new Float64Array(n0);
      let D = new Float64Array(n0);
      let Du = new Float64Array(n0);
      let A = new Float64Array(n0 * 3);
      let cw = new Float64Array(n0);
      for (let i = 0; i < n0; i++) {
        const tau = Math.max(0, tauArr[i]);
        for (let k = 0; k < NM; k++) lnT[i * NM + k] = -tau / TAU_M[k];
        H[i] = profile.H[i];
        W[i] = profile.wake[i] * profile.pbar[i];
        const hh = Math.max(profile.H[i], 0.1);
        D[i] = Math.min(0.4, profile.sigma[i] / (PARTICLE_DENSITY * hh));
        Du[i] = profile.dust[i];
        A[i * 3] = profile.albedo[i * 3];
        A[i * 3 + 1] = profile.albedo[i * 3 + 1];
        A[i * 3 + 2] = profile.albedo[i * 3 + 2];
        cw[i] = 1 - Math.exp(-Math.max(0, profile.tau[i]) / 0.3) + 1e-6;
      }
      let n = n0;
      for (let L = 0; L < nL; L++) {
        if (cnts[L] !== n) console.warn(`[TauPyramid] level ${L} count ${cnts[L]} != ${n}`);
        const off = offs[L];
        for (let j = 0; j < n; j++) {
          const t = (base + off + j) * 4;
          p0[t] = -TAU_M[0] * lnT[j * NM];
          p0[t + 1] = -TAU_M[1] * lnT[j * NM + 1];
          p0[t + 2] = -TAU_M[2] * lnT[j * NM + 2];
          p0[t + 3] = -TAU_M[3] * lnT[j * NM + 3];
          p1[t] = -TAU_M[4] * lnT[j * NM + 4];
          p1[t + 1] = H[j];
          p1[t + 2] = W[j];
          p1[t + 3] = D[j];
          if (half === 0) {
            const t2 = (off + j) * 4;
            p2[t2] = A[j * 3];
            p2[t2 + 1] = A[j * 3 + 1];
            p2[t2 + 2] = A[j * 3 + 2];
            p2[t2 + 3] = Du[j];
          }
        }
        if (L === nL - 1) break;
        // next level: pairs (2j, 2j+1)
        const m = Math.ceil(n / 2);
        const lnT2 = new Float64Array(m * NM);
        const H2 = new Float64Array(m), W2 = new Float64Array(m), D2 = new Float64Array(m), Du2 = new Float64Array(m);
        const A2 = new Float64Array(m * 3), cw2 = new Float64Array(m);
        for (let j = 0; j < m; j++) {
          const a = 2 * j, b = Math.min(2 * j + 1, n - 1);
          for (let k = 0; k < NM; k++) {
            const x = lnT[a * NM + k], y = lnT[b * NM + k];
            const mx = Math.max(x, y);
            lnT2[j * NM + k] = mx + Math.log(0.5 * (Math.exp(x - mx) + Math.exp(y - mx)));
          }
          H2[j] = 0.5 * (H[a] + H[b]);
          W2[j] = 0.5 * (W[a] + W[b]);
          D2[j] = 0.5 * (D[a] + D[b]);
          Du2[j] = 0.5 * (Du[a] + Du[b]);
          const wa = cw[a], wb = cw[b];
          for (let c = 0; c < 3; c++) A2[j * 3 + c] = (A[a * 3 + c] * wa + A[b * 3 + c] * wb) / (wa + wb);
          cw2[j] = 0.5 * (wa + wb);
        }
        lnT = lnT2; H = H2; W = W2; D = D2; Du = Du2; A = A2; cw = cw2;
        n = m;
      }
    }
    this.coarsestSpacing = profile.drKm * 1000 * 2 ** (nL - 1);
    const mk = (d: Float32Array, rows: number) => {
      const tx = new DataTexture(d, TEX_W, rows, RGBAFormat, FloatType);
      tx.minFilter = NearestFilter;
      tx.magFilter = NearestFilter;
      tx.wrapS = ClampToEdgeWrapping;
      tx.wrapT = ClampToEdgeWrapping;
      tx.generateMipmaps = false;
      tx.needsUpdate = true;
      return tx;
    };
    this.texP0 = mk(p0, 2 * h);
    this.texP1 = mk(p1, 2 * h);
    this.texP2 = mk(p2, h);
  }

  dispose(): void {
    this.texP0.dispose();
    this.texP1.dispose();
    this.texP2.dispose();
  }
}
