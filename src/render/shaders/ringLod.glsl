// ===== sv_ringLod ===========================================================================
// Near-field LOD contract shared by the particle renderer and the ring-layer (medium) renderer.
// Mirrors src/rings/RingLod.ts — keep the two in sync. Requires sv_common.
#ifndef SV_RING_LOD
#define SV_RING_LOD

#define LOD_CLASSES 14
#define LOD_RHO_FULL 0.5                   // display-px radius from which every particle is drawn (1 px across)
#define LOD_RHO_LO 0.4                     // below this display-px radius: medium only (handover band)
uniform float uLodActive;                  // 1 when discrete near-field particles are being drawn
uniform float uLodTauFrac[LOD_CLASSES];    // share of the local optical depth carried by class k
uniform float uLodAEff[LOD_CLASSES];       // cross-section-weighted rms radius of class k (m)
uniform float uLodSigZ[LOD_CLASSES];       // vertical std-dev of class k as a fraction of H
uniform float uLodBox[LOD_CLASSES];        // max 3-D distance (m) at which class-k particles exist
uniform float uLodPixelAngle;              // DISPLAY (canvas) pixel angle (rad): the count contract's unit
uniform float uLodCullTau;                 // optical depth beyond which particles may be culled
uniform float uLodH;                       // layer thickness at the frame anchor (m)
uniform float uLodTau;                     // optical depth at the frame anchor
uniform float uLodTauSub;                  // share of tau in particles below the smallest class (never drawn)
uniform float uLodSigZSub;                 // vertical std-dev of that sub-class layer as a fraction of H
uniform vec2 uLodARange[LOD_CLASSES];      // radius range (aLo, aHi) of class k (m)
uniform float uLodQ;                       // power-law index q of the size distribution dN/da ~ a^-q
// size rules (src/rings/ringDynamics.ts, RingLod.ts; docs/ring-physics.md 10.12), vec4-packed per class k = 4i + c
uniform vec4 uLodClassP[4];                // participation p_k in the self-gravity wakes (mixture: share following them)
uniform vec4 uLodClassF[4];                // share f_k in the spin-aligned population
uniform vec4 uLodAniso[5];                 // aligned population: G(mu_i), i = 0..8 (mu_i = i / 8), then T(mu_i)
uniform vec4 uLodTidal;                    // (tidally locked share of the aligned population, pbar of the column,
                                           //  aligned share of the column, 1 / g1 = tau_iso / tau_profile at the anchor)
uniform vec4 uLodPack;                     // packing ceiling: (participating / other particles' mid-plane filling per
                                           //  unit tau_dyn, density cap, 1 if it can bind)
uniform float uLodSlabK;                   // slab half-thickness / H (4 sigma of the thickest class, packing included)
uniform vec4 uLodTauDyn[8];                // tau_dyn / tau_profile of the anchor's zone at LOD_DYN_N log-spaced tau
#define LOD_DYN_N 32
#define LOD_DYN_LO 0.005
#define LOD_DYN_HI 20.0
#define LOD_ANISO_N 9
#define LOD_PACK_MAX 0.65

float lodClassP(int k) { return uLodClassP[k >> 2][k & 3]; }
float lodClassF(int k) { return uLodClassF[k >> 2][k & 3]; }
float lodTabAniso(int i) { return uLodAniso[i >> 2][i & 3]; }
// Class k of a particle of radius a (m): the octave [A0 2^k, A0 2^(k+1)) (the top class absorbs larger radii).
int lodClassOf(float a) { return clamp(int(floor(log2(max(a, 1e-6) * 1000.0))), 0, LOD_CLASSES - 1); }
// g - 1 of the spin-aligned population along the unit direction d (SEF): its mean projected area relative to the
// isotropic one is 1 + G(mu) (+ tidal share x T(mu) cos 2psi, psi from the radial direction); class k: 1 + f_k (g - 1)
float lodAniso(vec3 d) {
  float x = clamp(abs(d.z), 0.0, 1.0) * float(LOD_ANISO_N - 1);
  int i = min(int(x), LOD_ANISO_N - 2);
  float f = x - float(i);
  float G = mix(lodTabAniso(i), lodTabAniso(i + 1), f);
  if (uLodTidal.x <= 0.0) return G;
  float T = mix(lodTabAniso(LOD_ANISO_N + i), lodTabAniso(LOD_ANISO_N + i + 1), f);
  vec2 h = vec2(dot(d, uRingER), dot(d, uRingEPhi));
  float hh = dot(h, h);
  return G + uLodTidal.x * T * (hh > 1e-12 ? (h.x * h.x - h.y * h.y) / hh : 0.0);
}
// tau_dyn / tau_profile of the anchor's zone at photometric tau (the particle population's optical depth: presence,
// lighting columns; the medium reads the profile's per-radius values from the same function)
float lodTauDyn(float tau) {
  float x = clamp(log(max(tau, LOD_DYN_LO) / LOD_DYN_LO) / log(LOD_DYN_HI / LOD_DYN_LO), 0.0, 1.0) * float(LOD_DYN_N - 1);
  int i = min(int(x), LOD_DYN_N - 2);
  float f = x - float(i);
  return mix(uLodTauDyn[i >> 2][i & 3], uLodTauDyn[(i + 1) >> 2][(i + 1) & 3], f);
}
// Packing ceiling: vertical thickening of the participating particles where the mid-plane filling would exceed 0.65,
// at particle optical depth tauDyn (incl. any density factor of the structure) and wake density D (capped)
float lodPackM(float tauDyn, float D) {
  if (uLodPack.w < 0.5) return 1.0;
  return max(1.0, tauDyn * uLodPack.x * min(D, uLodPack.z) / max(LOD_PACK_MAX - tauDyn * uLodPack.y, 0.1 * LOD_PACK_MAX));
}

// 0 beyond the class's instantiated box (horizontal half-size around the camera); only below 1 where it matters
// if the slot cap clipped the box
float lodWindow(int k, float R) {
  float D = uLodBox[k];
  return D > 0.0 ? 1.0 - smoothstep(0.9 * D, D, R) : 0.0;
}
// Apparent radius (display px) of a particle of radius a (m) at 3-D camera distance s (m).
float lodRho(float a, float s) { return a / (max(s, 1e-4) * uLodPixelAngle); }
// Int_x0^x1 a^e da
float lodPowInt(float x0, float x1, float e) {
  if (x1 <= x0) return 0.0;
  float e1 = e + 1.0;
  return abs(e1) < 1e-4 ? log(x1 / x0) : (pow(x1, e1) - pow(x0, e1)) / e1;
}
// Share of class k's optical depth whose particles are carried at 3-D distance s: the cross-section-weighted
// (a^(2-q)) mean over the class's radii of smoothstep(LOD_RHO_LO, LOD_RHO_FULL, rho(a, s)). Exact: closed form
// above the band, 3-point Gauss-Legendre across it (smooth integrand, relative error ~1e-6).
float lodClassCarry(int k, float s) {
  vec2 r = uLodARange[k];
  float X = max(s, 1e-4) * uLodPixelAngle;   // radius that is 1 display px at s
  float b0 = LOD_RHO_LO * X, b1 = LOD_RHO_FULL * X;
  if (r.y <= b0) return 0.0;
  if (r.x >= b1) return 1.0;
  float e = 2.0 - uLodQ;
  float c = lodPowInt(max(r.x, b1), r.y, e);
  float x0 = max(r.x, b0), x1 = min(r.y, b1);
  if (x1 > x0) {
    float m = 0.5 * (x0 + x1), h = 0.5 * (x1 - x0), g = 0.7745966692 * h;
    c += h * (0.5555555556 * (pow(m - g, e) * smoothstep(b0, b1, m - g) + pow(m + g, e) * smoothstep(b0, b1, m + g)) +
              0.8888888889 * pow(m, e) * smoothstep(b0, b1, m));
  }
  return clamp(c / max(lodPowInt(r.x, r.y, e), 1e-30), 0.0, 1.0);
}
// Draw probability of ONE near-field particle of radius a (m), class k, at 3-D distance s (m) and height dz (m)
// relative to the camera: 1 for every particle >= 1 display px across, fading to 0 over the handover band
// (0.5 -> 0.4 px), 0 beyond the class's instantiated box.
float lodCarryParticle(float a, int k, float s, float dz) {
  float R = sqrt(max(s * s - dz * dz, 0.0));
  return smoothstep(LOD_RHO_LO, LOD_RHO_FULL, lodRho(a, s)) * lodWindow(k, R) * uLodActive;
}
// Share of class k's optical depth that the near field carries at 3-D distance s (m) and height dz (m) relative
// to the camera - what the medium must leave out: exactly the cross-section-weighted mean of lodCarryParticle
// over the class's radii. (`a` is not used; kept for signature stability - callers pass uLodAEff[k].)
float lodCarry(float a, int k, float s, float dz) {
  float R = sqrt(max(s * s - dz * dz, 0.0));
  return lodClassCarry(k, s) * lodWindow(k, R) * uLodActive;
}
float lodGaussPdf(float z, float sig) { return exp(-0.5 * z * z / (sig * sig)) / (2.50662827 * sig); }
float lodGaussQ(float z, float sig) { return 0.5 * (1.0 - erfApprox(z / (1.41421356 * sig))); }

// Extinction coefficients (1/m) at height z (m, from the ring midplane) in a ring patch with normal
// optical depth tau, full thickness H and wake density factor W (mean 1), at 3-D distance s (m) from the
// camera. sigTot: all particles. sigUnres: only the part NOT carried by discrete near-field particles.
// Heights relative to the local mid-plane (vertical relief): the camera's is uRingCamLocal.z - uRsCam.y.
void ringExtinction(float s, float z, float tau, float H, float W, out float sigTot, out float sigUnres) {
  float tot = 0.0, res = 0.0;
  float zc = uRingCamLocal.z - uRsCam.y;
  for (int k = 0; k < LOD_CLASSES; k++) {
    float w = uLodTauFrac[k];
    if (w <= 0.0) continue;
    float g = w * lodGaussPdf(z, max(uLodSigZ[k] * H, 0.02));
    tot += g;
    res += g * lodCarry(uLodAEff[k], k, s, z - zc);
  }
  // sub-class particles (a < 1 mm): always part of the medium
  if (uLodTauSub > 0.0) tot += uLodTauSub * lodGaussPdf(z, max(uLodSigZSub * H, 0.02));
  if (tot <= 0.0) {
    // no macroscopic size distribution at the anchor: single Gaussian layer, nothing resolved
    tot = lodGaussPdf(z, max(0.3 * H, 0.02));
    res = 0.0;
  }
  sigTot = tau * W * tot;
  sigUnres = max(sigTot - tau * W * res, 0.0);
}

// Normal optical depth of the part of the layer beyond height z, toward +z (dirSign > 0) or -z (< 0).
// Sunlight reaching a point at height z on the lit side is attenuated by exp(-ringLayerTauBeyond/|mu0|).
float ringLayerTauBeyond(float z, float tau, float H, float dirSign) {
  float f = 0.0, wsum = 0.0;
  for (int k = 0; k < LOD_CLASSES; k++) {
    float w = uLodTauFrac[k];
    if (w <= 0.0) continue;
    f += w * lodGaussQ(dirSign * z, max(uLodSigZ[k] * H, 0.02));
    wsum += w;
  }
  if (uLodTauSub > 0.0) {
    f += uLodTauSub * lodGaussQ(dirSign * z, max(uLodSigZSub * H, 0.02));
    wsum += uLodTauSub;
  }
  if (wsum <= 0.0) f = lodGaussQ(dirSign * z, max(0.3 * H, 0.02));
  return tau * f;
}

// Half-thickness (m) of the slab that contains essentially all particles (4 sigma of the thickest class, thickened
// by the packing ceiling up to its density cap; RingLod.slabHalfFor).
float ringSlabHalfThickness(float H) { return uLodSlabK * H + 0.5; }

// Channels of the vertical structure (per unit optical depth, densities in units of 1/H: the ring layer's LUT) at height
// z (m) and 3-D camera distance s (m), heights relative to the camera dz, for a layer of thickness H. Per class k (tau
// share w_k, Gaussian pdf_k (density x H) / column fraction above Q_k, carried share c_k = lodCarry, participation p_k,
// aligned share f_k) and the sub-class particles (never drawn, not participating, random):
//   Bp = (RP = sum w p pdf, UP = sum w p pdf (1 - c), QP = sum w p Q, UFP = sum w f p pdf (1 - c))   participating
//   Bt = (R = sum w pdf,    U = sum w pdf (1 - c),    Q = sum w Q,    UF = sum w f pdf (1 - c))      all particles
//   Bs = (QS = sum w (1 + f Gs) Q, QSP = sum w (1 + f Gs) p Q, 0, 0)                                  along the Sun
// with Gs = lodAniso(sun direction). The medium's extinction along a view direction d of the unresolved part at wake
// density W is (tau / H) [U - UP + W UP + G(d) (UF - UFP + W UFP)]: exact for the mixture models (ringDynamics.ts). The
// packing ceiling thickens the participating part: its channels are read at z / m (densities / m).
void ringLodChannels(float s, float z, float dz, float H, float Gs, out vec4 Bp, out vec4 Bt, out vec4 Bs) {
  Bp = vec4(0.0); Bt = vec4(0.0); Bs = vec4(0.0);
  float wsum = 0.0;
  for (int k = 0; k < LOD_CLASSES; k++) {
    float w = uLodTauFrac[k];
    if (w <= 0.0) continue;
    float sig = max(uLodSigZ[k] * H, 0.02);
    float g = w * lodGaussPdf(z, sig) * H;
    float qa = w * lodGaussQ(z, sig);
    float un = g * (1.0 - lodCarry(uLodAEff[k], k, s, dz));
    float p = lodClassP(k), f = lodClassF(k), gs = 1.0 + f * Gs;
    Bp += p * vec4(g, un, qa, f * un);
    Bt += vec4(g, un, qa, f * un);
    Bs.xy += gs * qa * vec2(1.0, p);
    wsum += w;
  }
  if (uLodTauSub > 0.0) {
    float sig = max(uLodSigZSub * H, 0.02);
    float g = uLodTauSub * lodGaussPdf(z, sig) * H;
    float qa = uLodTauSub * lodGaussQ(z, sig);
    Bt.xyz += vec3(g, g, qa);
    Bs.x += qa;
    wsum += uLodTauSub;
  }
  if (wsum <= 0.0) {
    // no macroscopic size distribution at the anchor: one Gaussian layer, nothing resolved, no wakes
    float sig = max(0.3 * H, 0.02);
    float g = lodGaussPdf(z, sig) * H, qa = lodGaussQ(z, sig);
    Bt = vec4(g, g, qa, 0.0);
    Bs = vec4(qa, 0.0, 0.0, 0.0);
    return;
  }
  Bp.z /= wsum;
  Bt.z /= wsum;
  Bs.xy /= wsum;
}

// ---- helpers built on the same vertical model (added for the near field; usable by any pass)

// Normalized vertical profile g(z) (1/m, integrates to 1) of the particle layer of thickness H.
float ringLayerProfile(float z, float H) {
  float tot = 0.0, wsum = 0.0;
  for (int k = 0; k < LOD_CLASSES; k++) {
    float w = uLodTauFrac[k];
    if (w <= 0.0) continue;
    tot += w * lodGaussPdf(z, max(uLodSigZ[k] * H, 0.02));
    wsum += w;
  }
  if (uLodTauSub > 0.0) {
    tot += uLodTauSub * lodGaussPdf(z, max(uLodSigZSub * H, 0.02));
    wsum += uLodTauSub;
  }
  return wsum > 0.0 ? tot / wsum : lodGaussPdf(z, max(0.3 * H, 0.02));
}
// Normal optical depth of the layer between heights z1 and z2 (any order).
float ringLayerColumn(float z1, float z2, float tau, float H) {
  return abs(ringLayerTauBeyond(z1, tau, H, 1.0) - ringLayerTauBeyond(z2, tau, H, 1.0));
}
// Slab-model optical depth along a straight segment from height z1 to height z2 covering horizontal
// distance d (m), in a homogeneous patch of normal optical depth tau (times any density factor).
float ringLayerSegmentTau(float z1, float z2, float d, float tau, float H) {
  float dz = z2 - z1;
  float L = sqrt(d * d + dz * dz);
  if (abs(dz) < 0.04 * H + 1e-3) return tau * ringLayerProfile(0.5 * (z1 + z2), H) * L;
  return ringLayerColumn(z1, z2, tau, H) * L / abs(dz);
}

// ---- stratified quadrature along a slanted beam through the layer (mirror: RingLod.columnCentroidTable)
// uLodColC[j] = C(j / LOD_COLQ_N), C(Q) = Int_0^Q h(Q') dQ' (units of H), h(Q): height toward the beam beyond which
// the fraction Q of the column lies.
#define LOD_COLQ_N 64
#define LOD_SUN_NODES 6
uniform float uLodColC[LOD_COLQ_N + 1];
float lodColC(float Q) {
  float x = clamp(Q, 0.0, 1.0) * float(LOD_COLQ_N);
  int i = min(int(x), LOD_COLQ_N - 1);
  return mix(uLodColC[i], uLodColC[i + 1], x - float(i));
}
// Centroid height (units of H, toward the beam) of the column slice between column fractions qa < qb beyond it.
float ringColumnCentroid(float qa, float qb) { return (lodColC(qb) - lodColC(qa)) / max(qb - qa, 1e-6); }
// Rise (units of H, >= 0) above a point of node j of the LOD_SUN_NODES-point stratified quadrature of a quantity
// averaged over the column the sun's rays cross on their way to the point: the centroid of the j-th of
// LOD_SUN_NODES equal slices of that column. qs: column fraction on the sun's side of the point; hp: the point's
// height toward the sun (units of H). The self-gravity-wake density along the sun path is the mean of
// wakeDensity at the nodes (offset horizontally by the sun direction per unit rise): every pass must use these
// same nodes (medium march, near-field particles, astronaut), and enough of them -- the estimate's variance
// leaks into the mean through the convexity of exp(-tau Ws / mu0). Measured in the A ring at 8 deg sun elevation
// (I/F vs 24 nodes): 2 fixed nodes (the former scheme) +15-26 %; stratified nodes on the point field (particles):
// 4: +5-7 %, 6: +2.5-3.6 %, 8: +1.3-2.1 %, 12: +0.5-0.9 %; on the medium's clipmap (prefiltered): 6: < 1 %.
float ringSunNodeRise(int j, float qs, float hp) {
  float n = float(LOD_SUN_NODES);
  return max(ringColumnCentroid(qs * float(j) / n, qs * float(j + 1) / n) - hp, 0.0);
}

#endif
