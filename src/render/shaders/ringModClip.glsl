// ===== sv_ringModClip ========================================================================
// Cache of the 2-D optical-depth modulation of sv_ringStructure around the camera: a clipmap of (M, self-gravity-wake
// strength factor) = ringStructureMod(aL, dth, fp).xz in Lagrangian polar coordinates (aL = a' - r0, S = r0 dth, m),
// rendered and refreshed by src/render/rings/ModClipmap.ts (owned by the Pipeline, before any pass renders). Included
// at the end of sv_ringStructure; a program that never calls rsModCached does not bind its sampler.
//
// Why: M (the sub-km texture's 12 noise lookups and the propellers' hash-grid enumeration) was evaluated per near-field
// particle slot for its presence; the candidates are a few % of the slots, scattered at random, so most SIMD groups
// paid for the full evaluation. One bilinear lookup here replaces it.
//
// Level k: MC_NR x MC_NS texels of dr_k x (MC_ASPECT dr_k) (radial x azimuthal: the texture's and the propellers'
// structures are 5-10x longer along the orbit than across it), dr_k = d0 2^k, centred (snapped to its texels) on the
// camera's Lagrangian position, coverage +-MC_NR / 2 dr_k both ways, stacked vertically in one RGBA32F atlas. Texel
// values: M and the wake factor prefiltered at the footprint fp = dr_k (rsTauModTexture / rsPropellersMod at that
// footprint): identical to the point values while dr_k <= ~5 m (every texture octave resolved: the finest, 15.6 m,
// fades only above fp = 5.2 m; the propellers' smallest lobes are >= 16 m wide), a mean-preserving smoothing of the
// sub-texel structure beyond. A point uses the finest valid level covering it and blends into the next coarser one
// over the outer 20 % of the level (continuous as points cross level boundaries).
//
//   bool rsModCached(aL, S, out vec2 mw)         (M, wake factor) from the cache; false where no valid level covers
//                                                  the point (then evaluate ringStructureMod directly)
//   bool rsModCachedFine(aL, S, fpMax, out mw)   the same, only from levels with texels <= fpMax (callers that need
//                                                  M at a footprint below the coarser levels' prefilter)
#ifndef SV_RING_MOD_CLIP
#define SV_RING_MOD_CLIP

#define MC_LEVELS 9
uniform sampler2D uMcTex;          // RGBA32F atlas MC_NR x (MC_NS * MC_LEVELS): (M, wake factor, -, -); LINEAR, CLAMP
uniform vec4 uMcLev[MC_LEVELS];    // per level: (centre aL [m], centre S [m], 1 / dr [1/m], usable 0 / 1)
uniform vec4 uMcInfo;              // (levels in use, MC_NR, MC_NS, MC_ASPECT); x = 0: no cache

// atlas uv of level k's texel offset q from its centre
vec2 rsMcUv(int k, vec2 q) {
  return vec2((q.x + 0.5 * uMcInfo.y) / uMcInfo.y, (q.y + 0.5 * uMcInfo.z + float(k) * uMcInfo.z) / (uMcInfo.z * float(MC_LEVELS)));
}
// level k's position of (aL, S): texels from the centre (radial, azimuthal) and the edge measure e (< 1: usable;
// keeps the bilinear footprint 1.5 texels inside the level)
vec3 rsMcPos(int k, float aL, float S) {
  vec4 L = uMcLev[k];
  float qr = (aL - L.x) * L.z, qs = (S - L.y) * L.z / uMcInfo.w;
  return vec3(qr, qs, max(abs(qr) / (0.5 * uMcInfo.y - 1.5), abs(qs) / (0.5 * uMcInfo.z - 1.5)));
}
// The finest usable level k0 with texels <= fpMax covering (aL, S) and, over its outer 20 %, the next coarser usable
// level k1 covering the point with the blend weight b toward it (0: none). false: no level.
bool rsMcSelect(float aL, float S, float fpMax, out int k0, out int k1, out float b) {
  k0 = 0;
  k1 = 0;
  b = 0.0;
  int n = int(uMcInfo.x);
  for (int k = 0; k < MC_LEVELS; k++) {
    if (k >= n) break;
    if (uMcLev[k].w < 0.5) continue;
    if (1.0 / uMcLev[k].z > fpMax) break;
    vec3 p = rsMcPos(k, aL, S);
    if (p.z >= 1.0) continue;
    k0 = k;
    float bb = smoothstep(0.8, 1.0, p.z);
    if (bb > 0.0) {
      for (int j = k + 1; j < MC_LEVELS; j++) {
        if (j >= n || 1.0 / uMcLev[j].z > fpMax) break;
        if (uMcLev[j].w < 0.5) continue;
        if (rsMcPos(j, aL, S).z < 1.0) { k1 = j; b = bb; break; }
      }
    }
    return true;
  }
  return false;
}
bool rsModCachedFine(float aL, float S, float fpMax, out vec2 mw) {
  mw = vec2(1.0);
  int k0, k1;
  float b;
  if (!rsMcSelect(aL, S, fpMax, k0, k1, b)) return false;
  mw = textureLod(uMcTex, rsMcUv(k0, rsMcPos(k0, aL, S).xy), 0.0).rg;
  if (b > 0.0) mw = mix(mw, textureLod(uMcTex, rsMcUv(k1, rsMcPos(k1, aL, S).xy), 0.0).rg, b);
  return true;
}
bool rsModCached(float aL, float S, out vec2 mw) { return rsModCachedFine(aL, S, 1e30, mw); }

#endif
