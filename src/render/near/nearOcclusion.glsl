// ===== near-field statistical occlusion: the line-of-sight optical depth bound ==================================
// Shared by the near-field update pass's cull (nearUpdate.glsl: a particle with nearLosTau(...) > uCull is present but
// not drawn) and meant for the contact step's contact set (NearContact: its "not statistically occluded" fade), so the
// two never disagree. Requires SV_HEADER_ALL (sv_ringLod: ringLayerTauBeyond, ringLayerProfile, ringColumnCentroid;
// sv_wakes: wakeMinDensity). Uniforms: NearFieldPass.occlusionUniforms (one shared object set, updated every frame
// before the update pass): the ring layer's wake-density clipmap (WakeClipmap.ts, shared as ctx.wakeClip) as rendered
// so far this frame -- its level states describe the texture's content until the ring layer refreshes levels later in
// the frame.
//
//   float nearLosTau(c, pxy, rb, zc, zt, tauP, H, tauCap)
//     slab model of the layer (sv_ringLod's vertical profile, thickness H) between the camera (local horizontal
//     position c, height zc) and the particle's near side (horizontal offset pxy from the camera, bounding radius rb:
//     horizontal distance |pxy| - rb; height zt), with tauP = the caller's normal optical depth along the path (the
//     lowest of a few samples x the 0.8 margin). Heights relative to the local mid-plane the caller chooses (the update
//     pass: the particle's). Returns
//       tSlab * wakeMinDensity()                 the emptiest-gap bound (tSlab = the path's slab optical depth at unit
//                                                wake density), when it already exceeds tauCap, when no clipmap level
//                                                covers the path, or when even a mean density NF_CULL_WMAX along the
//                                                path would stay <= tauCap;
//       max(that, tSlab * <W>_path)              otherwise: <W>_path = the line of sight's own self-gravity-wake
//                                                density, averaged at NF_CULL_NODES >= n >= 4 nodes stratified in the
//                                                slab's column between the two heights (equal optical-depth shares, at
//                                                the slices' centroids; uniform in distance for a nearly horizontal path)
//                                                spaced <= the wake spacing / 8, read from the clipmap level that covers
//                                                the particle (box-filtered texels >= half the node spacing: the line
//                                                average). The summation stops once the partial sum exceeds tauCap (every
//                                                node adds a non-negative share), so the value is exact up to tauCap and
//                                                only known to exceed it beyond.
//     Gaps let the eye see far along them only: the emptiest-gap bound alone (wakeMinDensity = 0.8 gammaGap^s, 0.055 in
//     the B ring) almost never culled since the Nov 2026 wake retune; the path's own density culls what the medium itself
//     would hide (b-ring-inside: 1.09 M -> 0.10 M particles drawn, the image unchanged to 0.1 %).
#define NF_WC_LEVELS 6
uniform sampler2D uNfWc;             // R16F atlas, NF_WC_LEVELS levels of N x N stacked vertically (box-filtered W)
uniform vec4 uNfWcLev[NF_WC_LEVELS]; // per level: (centre x, centre y, texel (m), usable), local frame
uniform int uNfWcLevels;             // levels in use (0: none -- the emptiest-gap bound alone, wakeDensity itself)
uniform vec4 uNfWcInfo;              // (N, node spacing along the line of sight: wake spacing / 8 (m), 1 = the cull's
                                     // path test is on, -)
#define NF_CULL_NODES 24
#define NF_CULL_WMAX 1.5

// The clipmap level for a line of sight ending at local horizontal position xy: the finest usable level covering xy
// whose texel is at least half the node spacing sp (its box filter ~ the line average between nodes), else the coarsest
// covering one; -1 if none. The levels are squares around (within 1/16 of their coverage of) the camera, so the level
// covering the far end covers the whole straight path.
int nfWakeClipLevel(vec2 xy, float sp) {
  float halfN = 0.5 * uNfWcInfo.x - 2.0;
  int kk = -1;
  for (int k = 0; k < NF_WC_LEVELS; k++) {
    if (k >= uNfWcLevels) break;
    vec4 L = uNfWcLev[k];
    if (L.w < 0.5) continue;
    vec2 q = (xy - L.xy) / L.z;
    if (max(abs(q.x), abs(q.y)) >= halfN) continue;
    kk = k;
    if (L.z >= 0.5 * sp) break;
  }
  return kk;
}
// wake density of level k at local horizontal position xy (clamped into the level)
float nfWakeClipAt(int k, vec2 xy) {
  vec4 L = uNfWcLev[k];
  float halfN = 0.5 * uNfWcInfo.x - 2.0;
  vec2 q = clamp((xy - L.xy) / L.z, vec2(-halfN), vec2(halfN));
  vec2 uv = (q + 0.5 * uNfWcInfo.x) / uNfWcInfo.x;
  uv.y = (uv.y + float(k)) / float(NF_WC_LEVELS);
  return textureLod(uNfWc, uv, 0.0).r;
}

// tSlab x the mean wake density along the line of sight (see the header), summed until it exceeds tauCap; -1 where no
// clipmap level covers the path. dir: unit horizontal direction, d: horizontal distance, qc / qt: column fractions above
// zc / zt (slanted paths), flatP: nearly horizontal path.
float nfPathWakeTau(vec2 c, vec2 dir, float d, float zc, float zt, float qc, float qt, float H, bool flatP, float tSlab, float tauCap) {
  float sp = uNfWcInfo.y;
  int kw = nfWakeClipLevel(c + dir * d, sp);
  if (kw < 0) return -1.0;
  float ext = d;
  if (!flatP) {
    // horizontal extent of the 5 % .. 95 % part of the column between the two heights
    float q5 = mix(qc, qt, 0.05), q95 = mix(qc, qt, 0.95);
    float h5 = ringColumnCentroid(max(q5 - 0.01, 0.0), min(q5 + 0.01, 1.0)) * H;
    float h95 = ringColumnCentroid(max(q95 - 0.01, 0.0), min(q95 + 0.01, 1.0)) * H;
    ext = abs(h5 - h95) / abs(zc - zt) * d;
  }
  // nodes in batches of 4 (n a multiple of 4; the four fetches of a batch are independent)
  int n = 4 * int(clamp(ceil(ext / (4.0 * sp)), 1.0, float(NF_CULL_NODES / 4)));
  float fn = float(n), wn = tSlab / fn;
  float acc = 0.0;
  for (int j0 = 0; j0 < NF_CULL_NODES; j0 += 4) {
    if (j0 >= n) break;
    vec4 f;
    for (int i = 0; i < 4; i++) {
      float j = float(j0 + i);
      if (flatP) f[i] = (j + 0.5) / fn;
      else {
        float qa = mix(qc, qt, j / fn), qb = mix(qc, qt, (j + 1.0) / fn);
        f[i] = clamp((zc - ringColumnCentroid(min(qa, qb), max(qa, qb)) * H) / (zc - zt), 0.0, 1.0);
      }
    }
    f *= d;
    acc += nfWakeClipAt(kw, c + dir * f.x) + nfWakeClipAt(kw, c + dir * f.y) + nfWakeClipAt(kw, c + dir * f.z) + nfWakeClipAt(kw, c + dir * f.w);
    if (acc * wn > tauCap) break;
  }
  return acc * wn;
}

// Self-gravity-wake density for a particle's sun-path nodes (nearDraw.vert.glsl): the clipmap level the medium's march
// would read at the particle (rlWakeLevel: the finest valid level covering it whose texels are at least its display
// pixel footprint fp / 1.5), so particles and medium see the same sun-path field where they hand over; the shared
// wakeDensity itself outside the clipmap. Returns the level (-1: none) for nfWakeAtLevel.
int nfWakeLevelFor(vec2 xy, float fp) {
  float halfN = 0.5 * uNfWcInfo.x - 2.0;
  for (int k = 0; k < NF_WC_LEVELS; k++) {
    if (k >= uNfWcLevels) break;
    vec4 L = uNfWcLev[k];
    if (L.w < 0.5 || L.z * 1.5 < fp) continue;
    vec2 q = (xy - L.xy) / L.z;
    if (max(abs(q.x), abs(q.y)) < halfN) return k;
  }
  return -1;
}
float nfWakeAtLevel(int k, vec2 xy) { return k >= 0 ? nfWakeClipAt(k, xy) : wakeDensity(xy); }

float nearLosTau(vec2 c, vec2 pxy, float rb, float zc, float zt, float tauP, float H, float tauCap) {
  float lp = length(pxy);
  float d = max(lp - rb, 0.0);
  // slab optical depth of the path at unit wake density (ringLayerSegmentTau, keeping its column fractions)
  float dz = zt - zc, L = sqrt(d * d + dz * dz);
  bool flatP = abs(dz) < 0.04 * H + 1e-3;
  float qc = 0.0, qt = 0.0, tSlab;
  if (flatP) tSlab = tauP * ringLayerProfile(0.5 * (zc + zt), H) * L;
  else {
    qc = ringLayerTauBeyond(zc, 1.0, H, 1.0);
    qt = ringLayerTauBeyond(zt, 1.0, H, 1.0);
    tSlab = tauP * abs(qc - qt) * L / abs(dz);
  }
  float tl = tSlab * wakeMinDensity();
  if (tl > tauCap || uNfWcLevels <= 0 || uNfWcInfo.z < 0.5 || tSlab * NF_CULL_WMAX <= tauCap) return tl;
  return max(tl, nfPathWakeTau(c, lp > 1e-6 ? pxy / lp : vec2(1.0, 0.0), d, zc, zt, qc, qt, H, flatP, tSlab, tauCap));
}
