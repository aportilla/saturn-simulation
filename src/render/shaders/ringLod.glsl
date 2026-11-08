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
void ringExtinction(float s, float z, float tau, float H, float W, out float sigTot, out float sigUnres) {
  float tot = 0.0, res = 0.0;
  for (int k = 0; k < LOD_CLASSES; k++) {
    float w = uLodTauFrac[k];
    if (w <= 0.0) continue;
    float g = w * lodGaussPdf(z, max(uLodSigZ[k] * H, 0.02));
    tot += g;
    res += g * lodCarry(uLodAEff[k], k, s, z - uRingCamLocal.z);
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

// Half-thickness (m) of the slab that contains essentially all particles (4 sigma of the thickest class).
float ringSlabHalfThickness(float H) { return 1.6 * H + 0.5; }

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

#endif
