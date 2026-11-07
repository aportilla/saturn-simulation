// ===== sv_ringLod ===========================================================================
// Near-field LOD contract shared by the particle renderer and the ring-layer (medium) renderer.
// Mirrors src/rings/RingLod.ts — keep the two in sync. Requires sv_common.
#ifndef SV_RING_LOD
#define SV_RING_LOD

#define LOD_CLASSES 10
uniform float uLodActive;                  // 1 when discrete near-field particles are being drawn
uniform float uLodTauFrac[LOD_CLASSES];    // share of the local optical depth carried by class k
uniform float uLodAEff[LOD_CLASSES];       // cross-section-weighted rms radius of class k (m)
uniform float uLodSigZ[LOD_CLASSES];       // vertical std-dev of class k as a fraction of H
uniform float uLodBox[LOD_CLASSES];        // max 3-D distance (m) at which class-k particles exist
uniform float uLodRhoMin;                  // minimum drawn apparent radius (px)
uniform float uLodCullTau;                 // optical depth beyond which particles may be culled
uniform float uLodH;                       // layer thickness at the frame anchor (m)
uniform float uLodTau;                     // optical depth at the frame anchor
uniform float uLodTauSub;                  // share of tau in particles below the smallest class (never drawn)
uniform float uLodSigZSub;                 // vertical std-dev of that sub-class layer as a fraction of H

float lodWindow(int k, float s) {
  float D = uLodBox[k];
  return 1.0 - smoothstep(0.75 * D, D, s);
}
// Probability that a particle of radius a (m), class k, at 3-D camera distance s (m) is drawn discretely.
float lodDrawProb(float a, int k, float s) {
  float rho = a / (max(s, 1e-4) * uPixelAngle);
  float x = rho / uLodRhoMin;
  return clamp(x * x, 0.0, 1.0) * lodWindow(k, s) * uLodActive;
}
float lodGaussPdf(float z, float sig) { return exp(-0.5 * z * z / (sig * sig)) / (2.50662827 * sig); }
float lodGaussQ(float z, float sig) { return 0.5 * (1.0 - erfApprox(z / (1.41421356 * sig))); }

// Extinction coefficients (1/m) at height z (m, from the ring midplane) in a ring patch with normal
// optical depth tau, full thickness H and wake density factor W (mean 1), at 3-D distance s (m) from the
// camera. sigTot: all particles. sigUnres: only the part NOT drawn as discrete particles.
void ringExtinction(float s, float z, float tau, float H, float W, out float sigTot, out float sigUnres) {
  float tot = 0.0, res = 0.0;
  for (int k = 0; k < LOD_CLASSES; k++) {
    float w = uLodTauFrac[k];
    if (w <= 0.0) continue;
    float g = w * lodGaussPdf(z, max(uLodSigZ[k] * H, 0.02));
    tot += g;
    res += g * lodDrawProb(uLodAEff[k], k, s);
  }
  // sub-class particles (a < 1 cm): always part of the medium
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
