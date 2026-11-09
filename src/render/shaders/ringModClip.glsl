// ===== sv_ringModClip ========================================================================
// Cache of the 2-D structure of sv_ringStructure that costs a propeller enumeration per lookup, around the camera: a
// clipmap of (M, self-gravity-wake strength factor) = ringStructureMod(aL, dth, fp).xz and of the propellers' relief
// (rsReliefPropellers: height, d/da', d/dS) with the sun's visibility after their relief shadows at the local mid-plane
// (rpReliefSunVis at z0 there), in Lagrangian polar coordinates (aL = a' - r0, S = r0 dth, m), rendered and refreshed
// by src/render/rings/ModClipmap.ts (owned by the Pipeline, before any pass renders). Included at the end of
// sv_ringStructure; a program that never calls these functions does not bind their samplers.
//
// Why: M (the sub-km texture's 12 noise lookups and the propellers' hash-grid enumeration) was evaluated per near-field
// particle slot for its presence, and the propellers' relief per present particle (its height) and per march step
// (height, slope, shadows); the candidates are a few % of the slots, scattered at random, so most SIMD groups paid for
// the full evaluation. One or two bilinear lookups here replace it.
//
// Level k: MC_NR x MC_NS texels of dr_k x (MC_ASPECT dr_k) (radial x azimuthal: the texture's and the propellers'
// structures are 5-10x longer along the orbit than across it), dr_k = d0 2^k, centred (snapped to its texels) on the
// camera's Lagrangian position, coverage +-MC_NR / 2 dr_k both ways, stacked vertically in one RGBA32F atlas: the
// modulation's levels (rows k MC_NS ..), then the relief's (rows (MC_LEVELS + k) MC_NS ..; built in the same render as
// the modulation's: the propellers enumerated once per texel). Texel values: prefiltered at the footprint fp = dr_k
// (rsTauModTexture / rsPropellersMod / rsReliefPropellers / rpReliefSunVis at that footprint): identical to the point
// values while dr_k <= ~5 m (every texture octave resolved: the finest, 15.6 m, fades only above fp = 5.2 m; the
// propellers' smallest lobes are >= 16 m wide, their relief's radial Gaussians >= 2.5 r_H), a mean-preserving smoothing
// of the sub-texel structure beyond. A point uses the finest valid level covering it and blends into the next coarser
// one over the outer 20 % of the level (continuous as points cross level boundaries).
//
//   bool rsModCached(aL, S, out vec2 mw)          (M, wake factor) from the cache; false where no valid level covers
//                                                   the point (then evaluate ringStructureMod directly)
//   bool rsModCachedFine(aL, S, fpMax, out mw)    the same, only from levels with texels <= fpMax (callers that need
//                                                   M at a footprint below the coarser levels' prefilter)
//   bool rsReliefPropCached(aL, S, fpMax, out zr)  the propellers' relief (height (m), d/da', d/dS) and the sun's
//                                                   visibility after their relief shadows on the local mid-plane there
//                                                   (.w), levels with texels <= fpMax; false: evaluate directly
//                                                   (rsReliefPropellers, rpReliefSunVis). The same levels as the
//                                                   modulation: true wherever rsModCachedFine is with the same fpMax.
#ifndef SV_RING_MOD_CLIP
#define SV_RING_MOD_CLIP

#define MC_LEVELS 9
uniform sampler2D uMcTex;          // RGBA32F atlas MC_NR x (2 MC_LEVELS MC_NS); LINEAR, CLAMP: levels of (M, wake factor,
                                   // -, -), then levels of (the propellers' relief height, d/da', d/dS, sun visibility)
uniform vec4 uMcLev[MC_LEVELS];    // per level: (centre aL [m], centre S [m], 1 / dr [1/m], usable 0 / 1)
uniform vec4 uMcInfo;              // (levels in use, MC_NR, MC_NS, MC_ASPECT); x = 0: no cache
uniform float uMcRelOn;            // 1: the relief half is read (0: rsReliefPropCached -> false; A/B tests)

// atlas uv of level k's texel offset q from its centre (the modulation's level; + MC_LEVELS: the relief's)
vec2 rsMcUv(int k, vec2 q) {
  return vec2((q.x + 0.5 * uMcInfo.y) / uMcInfo.y, (q.y + 0.5 * uMcInfo.z + float(k) * uMcInfo.z) / (uMcInfo.z * float(2 * MC_LEVELS)));
}
// the relief's uv for a modulation uv (rows shifted by MC_LEVELS levels: half the atlas)
vec2 rsMcRelUv(vec2 uv) { return vec2(uv.x, uv.y + 0.5); }
// level k's position of (aL, S): texels from the centre (radial, azimuthal) and the edge measure e (< 1: usable;
// keeps the bilinear footprint 1.5 texels inside the level)
vec3 rsMcPos(int k, float aL, float S) {
  vec4 L = uMcLev[k];
  float qr = (aL - L.x) * L.z, qs = (S - L.y) * L.z / uMcInfo.w;
  return vec3(qr, qs, max(abs(qr) / (0.5 * uMcInfo.y - 1.5), abs(qs) / (0.5 * uMcInfo.z - 1.5)));
}
// The finest usable level with texels <= fpMax covering (aL, S): its atlas uv (.xy) and, over its outer 20 %, the next
// coarser usable level covering the point (.zw) with the blend weight b toward it (0: none). false: no level.
bool rsMcSelect(float aL, float S, float fpMax, out vec4 uv, out float b) {
  uv = vec4(0.0);
  b = 0.0;
  int n = int(uMcInfo.x);
  for (int k = 0; k < MC_LEVELS; k++) {
    if (k >= n) break;
    if (uMcLev[k].w < 0.5) continue;
    if (1.0 / uMcLev[k].z > fpMax) break;
    vec3 p = rsMcPos(k, aL, S);
    if (p.z >= 1.0) continue;
    uv.xy = rsMcUv(k, p.xy);
    float bb = smoothstep(0.8, 1.0, p.z);
    if (bb > 0.0) {
      for (int j = k + 1; j < MC_LEVELS; j++) {
        if (j >= n || 1.0 / uMcLev[j].z > fpMax) break;
        if (uMcLev[j].w < 0.5) continue;
        vec3 q = rsMcPos(j, aL, S);
        if (q.z < 1.0) { uv.zw = rsMcUv(j, q.xy); b = bb; break; }
      }
    }
    return true;
  }
  return false;
}
bool rsModCachedFine(float aL, float S, float fpMax, out vec2 mw) {
  mw = vec2(1.0);
  vec4 uv;
  float b;
  if (!rsMcSelect(aL, S, fpMax, uv, b)) return false;
  mw = textureLod(uMcTex, uv.xy, 0.0).rg;
  if (b > 0.0) mw = mix(mw, textureLod(uMcTex, uv.zw, 0.0).rg, b);
  return true;
}
bool rsModCached(float aL, float S, out vec2 mw) { return rsModCachedFine(aL, S, 1e30, mw); }
bool rsReliefPropCached(float aL, float S, float fpMax, out vec4 zr) {
  zr = vec4(0.0, 0.0, 0.0, 1.0);
  vec4 uv;
  float b;
  if (uMcRelOn < 0.5 || !rsMcSelect(aL, S, fpMax, uv, b)) return false;
  zr = textureLod(uMcTex, rsMcRelUv(uv.xy), 0.0);
  if (b > 0.0) zr = mix(zr, textureLod(uMcTex, rsMcRelUv(uv.zw), 0.0), b);
  return true;
}

#endif
