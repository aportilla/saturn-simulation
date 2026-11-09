// Near-field contact resolution: removes the overlaps among the visibly resolved ring particles.
//
// The update pass (nearUpdate.glsl) places every particle on its own exact Hill-frame orbit (epicycle, vertical
// oscillation, wake and streamline displacement), independently of all others, so at the B-ring mid-plane
// (volume filling ~0.3-0.4) most large particles intersect a neighbour, and in A-ring wake cores even more. Real
// particles touch; they never interpenetrate. This step runs after the update pass and before compaction, the
// shadow map and the draw, and writes non-overlapping positions back into R0, so every consumer (the draw lists,
// the shadow-map casters, the astronaut's received shadows through ctx.nearShadow) sees the same positions.
//
// WHO (the contact set): present particles (R0 w != 0, drawn or not) with weight
//   w_i = smoothstep(rhoLo, rhoHi, a / (s * renderPixelAngle))        resolved: 5 -> 6 render px radius
//       x (1 - smoothstep(tauVisLo, tauVisHi, tau_los))                 not statistically occluded: tau 4 -> 5
//       x (1 - smoothstep(e1 - F, e1, out))                             near the view frustum (R0's coverage)
//       x smoothstep(1, 1.15, d / rho_cam)                              the camera outside the body
// An overlap is at most the smaller particle's diameter deep and typically ~0.3 of its radius, i.e. 1-1.5 px of
// silhouette at 3-5 px radius: at most marginally visible, so pairs are corrected with min(w_i, w_j); the fades make
// every correction continuous in time (a wider fade-in listed 50-70 % more B-ring particles - the search's cost - for
// the same residual, and at the packing limit more jumps in jammed clusters). tau_los: the update pass's own
// statistical-occlusion test (nearOcclusion.glsl nearLosTau, uniforms NearFieldPass.occlusionUniforms: the emptiest-gap
// bound first, then the line of sight's own self-gravity-wake density from the ring layer's wake clipmap,
// participation-aware) from the camera to the particle's near side, with the update pass's inputs mirrored per particle
// (ctLosTau below: its normal path tau, zone thickness and local mid-plane, at the drawn position), exact up to the fade's
// upper end; on only while the update pass culls (uCull > 0). The set follows what the update pass draws (its cull:
// nearLosTau > 5): an occluded particle is neither seen nor listed, so it neither jams nor pushes the visible ones; at
// tau 4-5 only e^-tau = 2-0.7 % of a particle is seen. out: the centre's distance outside the view frustum; e1 = rb + min(M a + F, mw): the frustum
// dilated by M = 4 x the largest semi-axis / a (two of the particle's own contact distances: a smaller particle
// yields to a larger one, so only particles about that close can push a visible one), fading out over F = half
// of it - but never beyond the coverage of R0 (the update pass keeps out-of-view particles within rb + mw, mw = the
// wake margin of ~3 wake wavelengths; with wakes off (mw = 0) the fade moves to [0, rb] at the view's edge).
// d / rho_cam: the camera's distance from the centre over the body's radial extent toward it - a body around the
// camera is not drawn (the camera is a ghost), so it must not push its neighbours out of an empty hollow around
// the camera (the last factor is applied when the list is materialized, where the shape is known).
//
// CONTACT DISTANCE: the sum of the two drawn base shapes' radial extents along the centre line n,
// rho_i(n) = a_i / sqrt(n^T M'_i n), M'_i = R_i diag(1 / shape_i^2) R_i^T (nearShape axes / a in the current
// principal-axis orientation, nearOrientation): exact for spheres (medium / low quality: rho = a) and for parallel
// identical ellipsoids, close otherwise, so elongated bodies cannot pass through each other end-on. The high-quality
// surface relief (+-~0.1 a about the base ellipsoid's mean surface, nearRelief) is left to interlock with the
// neighbour's dimples, as rubble surfaces do.
// SHAPE MIRROR (update when particle shapes / orientations change): MATERIALIZE_FRAG calls nearShape and
// nearOrientation (nearCommon.glsl) - shapes follow automatically; the largest base semi-axis / a, SHAPE_EXT_HIGH
// below (1.37 >= nearShape's 1.36), sizes the grid cells and the search reach (scripts/test/contact.mjs reads the value
// in use from the instance, `ext`); nearMaxExtent() (bounding radius incl. the relief) sets the frustum / occlusion
// margins.
//
// HOW (no compute shaders / atomics; everything is a deterministic function of this frame's analytic positions):
//   1. list: the near-field HistoPyramid (NearCompaction: the draw lists' atlases, rebuilt with the contact
//      classifier first) compacts the contact set; a pass materializes it into list textures (analytic position, R0
//      slot, signed a, weight, M'), in slot order (largest classes first: a truncated list loses the smallest).
//   2. ROUNDS (3) x:
//      a. hash grid of the round's start positions: one level per size class (octave from 1 mm); cell = the class's
//         largest diameter (2 x max semi-axis x aHi), or larger where the class is sparse (cbrt(cellFill / mid-plane
//         number density, the wake cores' compression 1 / gammaCore^s included): a search then scans few, mostly
//         occupied cells); 2^n buckets (>= 2 x the entries processed this frame; the clears and the routing pattern
//         cover only those rows) of 16 R32UI entries (list index + 1 in 21 bits, an 11-bit tag of the cell hash above)
//         in 4 x 4 texel blocks.
//         Filled by ONE point pass with stencil routing (Purcell et al. 2003): every list entry draws a 4 x 4 px
//         point over its bucket's block, whose stencil holds 15 - slot; the test passes at 15 and every fragment
//         increments, so the k-th entry of a bucket in primitive (= list) order lands in slot k - 1 - deterministic,
//         no atomics; a 17th entry is dropped (rare: the test counts it).
//      b. neighbour search: each particle scans its own level and every larger one (the cells within its extent +
//         the level's largest extent + the margin; an entry counts only if tag, cell and level match, so shared
//         buckets never count twice) and keeps the CT_NB = 8 candidates with the smallest normalized surface gap
//         g = (d - rho_i - rho_j) / (2 min(rho_i, rho_j)) below gapMargin = 0.5 (overlaps first; the margin admits
//         pairs the iterations can close), with their gaps at the round's start;
//      c. ITERATIONS / ROUNDS Jacobi iterations (48 in all) over the neighbour lists: per overlapping pair
//         (penetration delta = rho_i + rho_j - d > 0) the correction c = e x share x delta along n, with
//         e = min(w_i, w_j) x (1 - embedding fade) x listing weight; share = m_j / (m_i + m_j) (m ~ a^3) within a size
//         class, 1 for the smaller particle of a pair from different classes (small particles yield to boulders; the
//         larger one never lists the pair); x += omega sum c n / max(1, soft count), omega = 0.6 (pairs with
//         delta < 0.1 rho_min count delta / (0.1 rho_min): continuous). Embedding fade: a smaller particle lying
//         entirely inside a larger one (delta / rho_min 2 -> 2.5) is hidden and left alone - ejecting it would move
//         it by up to the larger radius into a cascade of new contacts that changes chaotically with the analytic
//         positions. Listing weight 1 - smoothstep(gapMargin / 2, gapMargin, g at the round's start): a pair enters
//         the list continuously.
//      Later rounds re-search after the moves (a boulder leaving its own overlap pushes into particles it did not
//      touch before).
//      Displacement bound: |x - x_analytic| <= clampK (4) x D_i, D_i = the largest pair correction of the particle in
//      the first iteration (its own initial overlaps), raised by contacts that appear later only up to yieldBound
//      (0.5) x a_i: nothing moves farther than overlaps require, and pushes cannot cascade far through a dense packing.
//   3. scatter: one point per moved list entry writes the final position back to its R0 texel. Drawn flags are
//      kept, except that a present particle whose displacement moved it into the view frustum (the update pass's
//      sphere test failed at the analytic position and passes now) and that is not statistically occluded there
//      (ctLosTau <= the update pass's uCull, its path tau capped by the radial profile's lowest) is drawn - as the
//      update pass would decide (count contract: every particle >= 1 px in view and not occluded is drawn).
// The medium (ring layer) is not touched: it is statistical. No state persists between frames, so time warp,
// reverse time, pausing (bit-identical frames) and re-anchoring need nothing special.
// IDLE: nothing runs when the camera is farther from the layer than the largest particles are resolved at; with an
// empty contact set (last read-back) only the list compaction runs, every 4th frame (particles enter the set through
// the weights' fades, from 0, so the few frames until the next read-back keep the result continuous).
// Regression check: scripts/test/contact.mjs (overlaps before / after, displacement bound, temporal smoothness,
// counts, cost).
import {
  AlwaysStencilFunc, BufferGeometry, EqualStencilFunc, FloatType, GLSL3, IncrementStencilOp, Mesh, NearestFilter, NoBlending,
  Points, RawShaderMaterial, RedIntegerFormat, ReplaceStencilOp, RGBAFormat, UnsignedIntType, WebGLRenderTarget,
  type IUniform, type WebGLRenderer,
} from 'three';
import { fullscreenGeometry, fsCamera, FS_VERT } from '../fullscreen';
import { LOD_CLASSES, type RingLod } from '../../rings/RingLod';
import type { RingProfile } from '../../rings/RingProfile';
import type { WakeField } from '../../rings/WakeField';
import type { FrameState } from '../../core/FrameState';
import { NEAR_PYR_GLSL, type NearCompaction } from './NearCompaction';
import nearOcclusion from './nearOcclusion.glsl?raw';

/** width of the contact list textures */
export const CT_W = 2048;
/** largest base-shape semi-axis / a at high particle quality (nearShape: <= 1.36; spheres below: 1) - the shape mirror */
export const SHAPE_EXT_HIGH = 1.37;
/** hash buckets: 4 x 4 texel blocks of an R32UI texture CT_W wide (512 buckets per block row): 16 entries each */
export const CT_SLOTS = 16;
const CT_BPR_LOG2 = 9;
/** neighbour-list texels per particle (4 entries each) and the list length */
const CT_NB_T = 2;
export const CT_NB = CT_NB_T * 4;
/** list capacity limit: a grid entry packs the list index + 1 into 21 bits */
export const CT_MAX = (1 << 21) - CT_W;
/** bucket limit: 4 texel rows per 512 buckets within the max texture height (16384) */
const CT_MAX_BUCKETS = 1 << 21;
const CT_MIN_ROWS = 32;

/** Hash grid: level, cell and bucket of a particle, entry packing (shared by the grid build and the search). */
const GRID_GLSL = /* glsl */ `
#define CT_W ${CT_W}
#define CT_NB ${CT_NB}
uniform float uCtInvCell[LOD_CLASSES];   // 1 / grid cell size of each level (m^-1)
uniform int uCtMask;                     // buckets - 1 (a power of two)
// grid level = size class (octave from 1 mm, sv_ringLod)
int ctLevel(float a) { return clamp(int(floor(log2(a * 1000.0))), 0, LOD_CLASSES - 1); }
ivec3 ctCell(vec3 p, int L) { return ivec3(floor(p * uCtInvCell[L])); }
uint ctCellHash(ivec3 c, int L) {
  return pcgHash(uint(c.x) * 73856093u ^ uint(c.y) * 19349663u ^ uint(c.z) * 83492791u ^ uint(L + 1) * 2654435761u);
}
// texel of the bucket's first entry: entries 0..15 fill its 4 x 4 block row by row
ivec2 ctBucket(uint h) {
  uint b = h & uint(uCtMask);
  return 4 * ivec2(int(b & ${(1 << CT_BPR_LOG2) - 1}u), int(b >> ${CT_BPR_LOG2}u));
}
// grid entry (R32UI): list index + 1 in the low 21 bits (0 = empty), an 11-bit tag of (level, cell) above, so that
// entries of other cells sharing the bucket are skipped without touching their data
uint ctTag(uint h) { return (h >> 21u) & 2047u; }
uint ctPack(int j, uint h) { return uint(j + 1) | (ctTag(h) << 21u); }
int ctEntryIndex(uint e) { return int(e & 0x1FFFFFu) - 1; }
ivec2 ctTexel(int j) { return ivec2(j % CT_W, j / CT_W); }
// n^T M' n for the symmetric M' stored as (-, -, M00, M11), (M22, M01, M02, M12)
float ctQuad(vec4 m, vec4 s, vec3 n) {
  return m.z * n.x * n.x + m.w * n.y * n.y + s.x * n.z * n.z + 2.0 * (s.y * n.x * n.y + s.z * n.x * n.z + s.w * n.y * n.z);
}
`;

/**
 * Line-of-sight optical depth to a particle at camera-relative p (SEF axes, bounding radius rb): the update pass's
 * statistical-occlusion test (nearUpdate.glsl; nearOcclusion.glsl nearLosTau, included before this: the emptiest-gap
 * bound, then the line of sight's own self-gravity-wake density from the ring layer's clipmap) with the update pass's
 * own inputs, mirrored at the particle: the normal path tau min(tau at the camera, the particle's tau_dyn x its 2-D
 * modulation (the modulation cache, else the texture) x streamline density, tau_dyn at the path's midpoint) x 0.8, its
 * zone's thickness H, heights above its local mid-plane (streamline zeta + vertical relief) - evaluated at its drawn
 * position for its guiding centre (the epicycle, streamline and wake displacements are metres to tens of metres; the
 * profile, the modulation's coarse octaves and the relief vary over >= 100 m) and without a propeller's own modulation
 * outside the cache and its relief. The inputs are mirrored so that the set follows what the update pass draws: the
 * radial profile's lowest tau_dyn in range x 0.8 (uCtVis.x) with heights above the camera's local mid-plane dropped
 * 2.5 % of the drawn particles >= 6 px at b-ring-inside (up to 100 px radius: the particle's own textured tau, ~15 % rms
 * below the profile in the B ring) and 4.9 % at the Mimas 5:3 bending wave (2.3 deg: the mid-plane 4 m lower 100 m
 * away); mirrored, 0.3 % / 1.3 % remain, at the cull's boundary (scripts/test/contact.mjs, coverage). tauMax caps the
 * path tau (the scatter's drawn flip: never hide a visible particle). Exact up to tauCap, only known to exceed it.
 */
const LOS_GLSL = /* glsl */ `
uniform float uCtTauCam;   // the update pass's uTauCam: tau_dyn at the camera's radius x its streamline density
float ctLosTau(vec3 p, float rb, float tauCap, float tauMax) {
  vec2 pxy = vec2(dot(p, uRingER), dot(p, uRingEPhi));
  float aL, dth;
  ringLocalPolar(vec3(uRingCamLocal.x - uRsCam.x + pxy.x, uRingCamLocal.y + pxy.y, 0.0), aL, dth);
  float Jp = 1.0, z0 = 0.0;
  if (uRsCam.w > 0.5) {
    vec3 sx = ringStreamXi(aL, dth, 0.0);
    Jp = sx.z;
    z0 = sx.y;
  } else if (uRrCamN.w > 0.5) {
    z0 = ringStructureRelief(aL, dth, 0.0).x;
  }
  RingSample rs = ringSampleLagrangian(aL, 0.0);
  vec2 mcw;
  float M = rsModCached(aL, uRingR0 * dth, mcw) ? mcw.x : ringStructureModNoPropellers(aL, dth, 0.0).x;
  RingSample rm = ringSampleLocal(vec3(uRingCamLocal.x + 0.5 * pxy.x, uRingCamLocal.y + 0.5 * pxy.y, 0.0), 0.0);
  float tauP = min(min(uCtTauCam, rs.tau * lodTauDyn(rs.tau) * (1.0 - rs.dust) * M * Jp),
                   rm.tau * lodTauDyn(rm.tau) * (1.0 - rm.dust)) * 0.8;
  float zc = uRingCamLocal.z - z0, z = p.z + uRingCamLocal.z - z0;
  float zt = z + clamp(zc - z, -rb, rb);
  return nearLosTau(uRingCamLocal.xy, pxy, rb, zc, zt, min(tauP, tauMax), rs.H, tauCap);
}`;

/** Contact-set classifier of an R0 slot (level 1 of the pyramid and its traversal). Requires nearCommon, nearOcclusion. */
const CLASSIFY_GLSL = /* glsl */ `
uniform sampler2D tR0;
uniform int uTexW;
uniform int uTexRows;
uniform int uClsRow0[LOD_CLASSES];
uniform int uClsRows[LOD_CLASSES];   // 0 for inactive classes
uniform int uClsSeed[LOD_CLASSES];
uniform vec4 uCtSel;   // (resolved: render-px radius fade-in lo, hi; occluded: line-of-sight tau fade-out lo, hi)
uniform vec4 uCtVis;   // (conservative normal path tau (the scatter's), -, frustum dilation M and its fade width F in units
                       //  of the particle radius)
uniform float uCtCull; // the update pass's statistical-occlusion cull threshold uCull (0: off - no occlusion test)
uniform float uCtMw;   // the update pass's wake margin mw (m): R0 holds a participating particle within rb + mw of the view
int nearClassOfRow(int row) {
  for (int k = 0; k < LOD_CLASSES; k++) {
    if (row >= uClsRow0[k] && row < uClsRow0[k] + uClsRows[k]) return k;
  }
  return -1;
}
${LOS_GLSL}
// weight of a present particle (class k, slot idx) of radius a at camera-relative p in the contact set (0: not in it)
float nearContactWeight(vec3 p, float a, int k, uint idx) {
  float s = max(length(p), 1e-4);
  float w = smoothstep(uCtSel.x, uCtSel.y, a / (s * uPixelAngle));
  if (w <= 0.0) return 0.0;
  // near the view frustum: dilated by M a (a particle can only push a visible one from within about two of its own
  // contact distances: a smaller particle yields to a larger one), fading out over F a, within R0's coverage. The
  // update pass keeps an out-of-view particle within rb of the view, + the wake margin mw if it follows the wakes
  // (participation p_k: the same hash) - so a particle that does not ends at the frustum edge itself, fading out
  // across it (it enters R0 there: continuous when the camera turns)
  float rb = nearMaxExtent() * a;
  vec3 v = uWorldToCam * p;
  float tx = uTanHalfFov * uAspect, ty = uTanHalfFov;
  float outD = max(max((abs(v.x) + v.z * tx) * inversesqrt(1.0 + tx * tx), (abs(v.y) + v.z * ty) * inversesqrt(1.0 + ty * ty)), v.z);
  bool part = uWakeOn > 0.5 && nearU(idx, uint(uClsSeed[k]), NS_PART) < lodClassP(k);
  float mw = part ? uCtMw : 0.0;
  float F = mw > 0.0 ? uCtVis.w * a : rb;
  float e1 = rb + min(uCtVis.z * a + F, mw);
  w *= 1.0 - smoothstep(e1 - min(F, e1), e1, outD);
  if (w <= 0.0 || uCtCull <= 0.0) return w;
  // statistical occlusion from the camera: the update pass's own test (nearOcclusion.glsl nearLosTau: the emptiest-gap
  // bound, then the line of sight's own self-gravity-wake density from the ring layer's clipmap; its inputs mirrored),
  // exact up to the fade's upper end
  return w * (1.0 - smoothstep(uCtSel.z, uCtSel.w, ctLosTau(p, rb, uCtSel.w, 1e30)));
}
vec4 nearClassify(ivec2 tc) {
  if (tc.x >= uTexW || tc.y >= uTexRows) return vec4(0.0);
  vec4 r0 = texelFetch(tR0, tc, 0);
  int k = nearClassOfRow(tc.y);
  if (r0.w == 0.0 || k < 0) return vec4(0.0);
  uint idx = uint((tc.y - uClsRow0[k]) * uTexW + tc.x);
  return vec4(nearContactWeight(r0.xyz, abs(r0.w), k, idx) > 0.0 ? 1.0 : 0.0, 0.0, 0.0, 0.0);
}
`;

const LEVEL1_FRAG = /* glsl */ `
uniform ivec2 uDstOff;
layout(location = 0) out vec4 o;
void main() {
  ivec2 p = (ivec2(gl_FragCoord.xy) - uDstOff) * 2;
  o = nearClassify(p) + nearClassify(p + ivec2(1, 0)) + nearClassify(p + ivec2(0, 1)) + nearClassify(p + ivec2(1, 1));
}`;

/** List texel j <- the j-th contact particle: (analytic position, R0 texel index), (signed a, weight, M'00, M'11), (M'22, M'01, M'02, M'12). */
const MATERIALIZE_FRAG = /* glsl */ `
uniform float uClsSpinW[LOD_CLASSES];
uniform int uCtN;   // entries to fill (the draw range)
layout(location = 0) out vec4 oP;
layout(location = 1) out vec4 oM;
layout(location = 2) out vec4 oS;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int j = c.y * CT_W + c.x;
  oP = vec4(0.0); oM = vec4(0.0); oS = vec4(0.0);
  ivec2 tc;
  if (j >= uCtN || !nearListFetch(0, j, tc)) return;
  vec4 r0 = texelFetch(tR0, tc, 0);
  int k = nearClassOfRow(tc.y);
  float a = abs(r0.w);
  uint idx = uint((tc.y - uClsRow0[k]) * uTexW + tc.x), seed = uint(uClsSeed[k]);
  // contact shape = the drawn base shape (axes / a) in its current orientation: M' = R diag(1 / shape^2) R^T
  vec3 sh = nearShape(idx, seed, a);
  vec4 q = nearOrientation(idx, seed, a, uClsSpinW[k]);
  vec3 ex = nearQRot(q, vec3(1.0, 0.0, 0.0)), ey = nearQRot(q, vec3(0.0, 1.0, 0.0)), ez = nearQRot(q, vec3(0.0, 0.0, 1.0));
  vec3 iv = 1.0 / (sh * sh);
  mat3 M = iv.x * outerProduct(ex, ex) + iv.y * outerProduct(ey, ey) + iv.z * outerProduct(ez, ez);
  // a body around the camera is not drawn (nearDraw discards it: the camera is a ghost), so it takes no part in
  // contacts - an invisible body must not visibly push its neighbours out of a hollow around the camera; fading
  // out as the camera crosses its surface (its radial extent toward the camera, relief included)
  float dc = length(r0.xyz);
  vec3 nc = dc > 0.0 ? r0.xyz / dc : vec3(0.0, 0.0, 1.0);
  float wc = smoothstep(1.0, 1.15, dc * sqrt(dot(nc, M * nc)) / a);
  oP = vec4(r0.xyz, float(tc.y * uTexW + tc.x));
  oM = vec4(r0.w, nearContactWeight(r0.xyz, a, k, idx) * wc, M[0][0], M[1][1]);
  oS = vec4(M[2][2], M[0][1], M[0][2], M[1][2]);
}`;

/**
 * Grid build: one 4 x 4 px point per list entry over its bucket's block. Stencil routing (Purcell et al. 2003): the
 * stencil of every block holds 15 - slot (slot = (x & 3) + 4 (y & 3), written as 4 bit planes); the test passes at 15
 * and every fragment increments (saturating), so the k-th particle that reaches a bucket (primitive order = list
 * index order: deterministic) lands in slot k - 1 and the 17th and later are dropped (the test counts them).
 * (A blitted pristine stencil would save the 4 pattern passes, but on ANGLE/Metal a stencil blitFramebuffer leaves
 * the following stencil-tested draws without any output.)
 */
const GRID_VS = /* glsl */ `
uniform sampler2D tCP;      // the round's start positions (xyz)
uniform sampler2D tCM;      // (signed a, ...)
uniform ivec2 uGSize;       // grid texture size (px)
flat out uint vE;
void main() {
  gl_PointSize = 4.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  int j = gl_VertexID;
  ivec2 tj = ctTexel(j);
  float a = abs(texelFetch(tCM, tj, 0).x);
  if (a == 0.0) return;
  int L = ctLevel(a);
  uint h = ctCellHash(ctCell(texelFetch(tCP, tj, 0).xyz, L), L);
  vE = ctPack(j, h);
  gl_Position = vec4((vec2(ctBucket(h)) + 2.0) / vec2(uGSize) * 2.0 - 1.0, 0.0, 1.0);
}`;
const GRID_FS = /* glsl */ `
precision highp float;
precision highp int;
flat in uint vE;
layout(location = 0) out uvec4 o;
void main() { o = uvec4(vE, 0u, 0u, 0u); }`;

/** Routing pattern, bit plane uBit (stencil write mask 1 << uBit, REPLACE with 0xff): kept where 15 - slot has the bit. */
const STENCIL_BITS_FS = /* glsl */ `
precision highp float;
precision highp int;
uniform int uBit;
layout(location = 0) out uvec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) & 3;
  if ((((15 - p.x - 4 * p.y) >> uBit) & 1) == 0) discard;
  o = uvec4(0u);
}`;

/** Neighbour search: the CT_NB candidates with the smallest surface gap (list indices + 1, 0 = none). */
const SEARCH_FRAG = /* glsl */ `
precision highp usampler2D;
uniform sampler2D tCP;    // the round's start positions (xyz)
uniform sampler2D tCM;    // (signed a, weight, M'00, M'11)
uniform sampler2D tCS;    // (M'22, M'01, M'02, M'12)
uniform usampler2D tG;    // hash grid (4 x 4 entry blocks)
uniform vec4 uCtSr;       // (gap margin / contact distance, largest semi-axis / a, -, -)
uniform ivec2 uCtLv;      // grid levels present (lowest, highest)
uniform float uCtAHi[LOD_CLASSES];   // largest radius of each level (m)
layout(location = 0) out vec4 oN0;
layout(location = 1) out vec4 oN1;
layout(location = 2) out vec4 oG0;   // their surface gaps (units of the smaller diameter) at the round's start
layout(location = 3) out vec4 oG1;

int gI;
vec3 gX;
float gAi, gEi;
vec4 gMa, gSa;
// kept candidates in registers (no dynamically indexed local arrays): list index + 1 (0 = free) and the gap of
// each; a free slot has gap +inf, so a new candidate replaces the largest gap whenever it is smaller
vec4 nbJ0, nbJ1, nbG0, nbG1;

void ctKeep(int j, float g) {
  float m0 = max(max(nbG0.x, nbG0.y), max(nbG0.z, nbG0.w)), m1 = max(max(nbG1.x, nbG1.y), max(nbG1.z, nbG1.w));
  float m = max(m0, m1);
  if (g >= m) return;
  float v = float(j + 1);
  if (m0 >= m1) {
    if (nbG0.x == m) { nbG0.x = g; nbJ0.x = v; } else if (nbG0.y == m) { nbG0.y = g; nbJ0.y = v; }
    else if (nbG0.z == m) { nbG0.z = g; nbJ0.z = v; } else { nbG0.w = g; nbJ0.w = v; }
  } else {
    if (nbG1.x == m) { nbG1.x = g; nbJ1.x = v; } else if (nbG1.y == m) { nbG1.y = g; nbJ1.y = v; }
    else if (nbG1.z == m) { nbG1.z = g; nbJ1.z = v; } else { nbG1.w = g; nbJ1.w = v; }
  }
}
void ctCand(int j, int L, ivec3 cell, float reach) {
  if (j == gI) return;
  ivec2 tj = ctTexel(j);
  vec3 xj = texelFetch(tCP, tj, 0).xyz;
  // the entry belongs to this cell (a shared bucket is scanned once per cell, the entry counted in its own)
  if (ctCell(xj, L) != cell) return;
  vec3 dv = gX - xj;
  float d2 = dot(dv, dv);
  if (d2 >= reach * reach) return;
  vec4 Mj = texelFetch(tCM, tj, 0), Sj = texelFetch(tCS, tj, 0);
  if (ctLevel(abs(Mj.x)) != L) return;
  float d = sqrt(d2);
  vec3 n = d > 1e-6 * gAi ? dv / d : vec3(0.0, 0.0, gI < j ? 1.0 : -1.0);
  float ri = gAi * inversesqrt(ctQuad(gMa, gSa, n)), rj = abs(Mj.x) * inversesqrt(ctQuad(Mj, Sj, n));
  // candidates: overlaps, and gaps the smaller particle can close within the round (margin x its diameter)
  float g = (d - ri - rj) / (2.0 * min(ri, rj));
  if (g < uCtSr.x) ctKeep(j, g);
}
uint ctEntry(int m, ivec2 bt) { return texelFetch(tG, bt + ivec2(m & 3, m >> 2), 0).r; }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  oN0 = vec4(0.0);
  oN1 = vec4(0.0);
  oG0 = vec4(1e30);
  oG1 = vec4(1e30);
  gMa = texelFetch(tCM, c, 0);
  if (gMa.x == 0.0) return;
  gSa = texelFetch(tCS, c, 0);
  gI = c.y * CT_W + c.x;
  gAi = abs(gMa.x);
  gEi = uCtSr.y * gAi;
  gX = texelFetch(tCP, c, 0).xyz;
  nbJ0 = vec4(0.0);
  nbJ1 = vec4(0.0);
  nbG0 = vec4(1e30);
  nbG1 = vec4(1e30);
  for (int L = ctLevel(gAi); L <= uCtLv.y; L++) {
    // every particle of level L whose surface is within the margin: centre within the two extents + margin
    float eL = uCtSr.y * uCtAHi[L];
    float reach = gEi + eL + 2.0 * uCtSr.x * min(gEi, eL);
    float ic = uCtInvCell[L];
    ivec3 lo = ivec3(floor((gX - reach) * ic)), hi = ivec3(floor((gX + reach) * ic));
    for (int iz = lo.z; iz <= hi.z; iz++)
      for (int iy = lo.y; iy <= hi.y; iy++)
        for (int ix = lo.x; ix <= hi.x; ix++) {
          ivec3 cell = ivec3(ix, iy, iz);
          uint h = ctCellHash(cell, L), tag = ctTag(h);
          ivec2 bt = ctBucket(h);
          for (int m = 0; m < ${CT_SLOTS}; m++) {
            uint e = ctEntry(m, bt);
            if (e == 0u) break;
            if ((e >> 21u) == tag) ctCand(ctEntryIndex(e), L, cell, reach);   // (else: another cell's entry)
          }
        }
  }
  oN0 = nbJ0;
  oN1 = nbJ1;
  oG0 = nbG0;
  oG1 = nbG1;
}`;

/** One Jacobi iteration over the neighbour lists. Output: (position, displacement bound D_i). */
const ITERATE_FRAG = /* glsl */ `
uniform sampler2D tCP;    // input positions (xyz, D_i)
uniform sampler2D tCP0;   // analytic positions (xyz, R0 slot)
uniform sampler2D tCM;    // (signed a, weight, M'00, M'11)
uniform sampler2D tCS;    // (M'22, M'01, M'02, M'12)
uniform sampler2D tCN0;   // neighbour lists
uniform sampler2D tCN1;
uniform sampler2D tCG0;   // their gaps at the round's start
uniform sampler2D tCG1;
uniform vec4 uCtIt;       // (omega, clamp factor x D_i, gap margin, 1 = the frame's first iteration)
uniform vec3 uCtEmb;      // embedding fade (units of the smaller radius): (start, end); yield bound (units of a)
layout(location = 0) out vec4 oP;
int gI, gLi;
vec3 gX, gX0, gAcc;
float gAi, gAi3, gCnt, gDmax, gEmb;
vec4 gMi, gSi;
// one neighbour-list slot (list index + 1, 0 = empty; g0: its gap at the round's start): accumulate the pair's
// correction if it overlaps
void ctPair(float v, float g0) {
  if (v == 0.0) return;
  int j = int(v) - 1;
  ivec2 tj = ctTexel(j);
  vec3 xj = texelFetch(tCP, tj, 0).xyz;
  vec4 Mj = texelFetch(tCM, tj, 0), Sj = texelFetch(tCS, tj, 0);
  vec3 dv = gX - xj;
  float d = length(dv);
  vec3 n = d > 1e-6 * gAi ? dv / d : vec3(0.0, 0.0, gI < j ? 1.0 : -1.0);
  float aj = abs(Mj.x);
  float ri = gAi * inversesqrt(ctQuad(gMi, gSi, n)), rj = aj * inversesqrt(ctQuad(Mj, Sj, n));
  float delta = ri + rj - d;
  if (delta <= 0.0) return;
  // the smaller particle lies entirely inside the larger one (delta >= its diameter along n): it is hidden, so the
  // pair is left alone (fading over 2 -> 2.5 smaller radii) - ejecting it would move it by up to the larger one's
  // radius into a cascade of new contacts that changes chaotically with the analytic positions. (Judged at the
  // current positions: deciding it at the analytic ones exposes hidden particles whose host moves away, and did not
  // reduce the jumps - measured.)
  float rmin = min(ri, rj);
  float emb = smoothstep(uCtEmb.x, uCtEmb.y, delta / rmin);
  if (ri <= rj) gEmb = max(gEmb, emb);
  // a pair listed near the search margin fades in (a pair just beyond it was not listed: no step in between)
  float lw = 1.0 - smoothstep(0.5 * uCtIt.z, uCtIt.z, g0);
  // share: mass-weighted within a size class, all of it for the smaller particle of a pair from different classes
  float e = min(gMi.y, Mj.y) * (1.0 - emb) * lw;
  float aj3 = aj * aj * aj;
  float cc = e * delta * (ctLevel(aj) > gLi ? 1.0 : aj3 / (gAi3 + aj3));
  gAcc += cc * n;
  // soft contact count (continuous: shallow overlaps count in proportion)
  gCnt += e * min(1.0, delta / (0.1 * rmin));
  gDmax = max(gDmax, cc);
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  gMi = texelFetch(tCM, c, 0);
  oP = vec4(0.0);
  if (gMi.x == 0.0) return;
  vec4 P = texelFetch(tCP, c, 0);
  gSi = texelFetch(tCS, c, 0);
  gI = c.y * CT_W + c.x;
  gAi = abs(gMi.x);
  gAi3 = gAi * gAi * gAi;
  gLi = ctLevel(gAi);
  gX = P.xyz;
  gX0 = texelFetch(tCP0, c, 0).xyz;
  gAcc = vec3(0.0);
  gCnt = 0.0;
  gDmax = 0.0;
  gEmb = 0.0;
  vec4 n0 = texelFetch(tCN0, c, 0), n1 = texelFetch(tCN1, c, 0), g0 = texelFetch(tCG0, c, 0), g1 = texelFetch(tCG1, c, 0);
  ctPair(n0.x, g0.x); ctPair(n0.y, g0.y); ctPair(n0.z, g0.z); ctPair(n0.w, g0.w);
  ctPair(n1.x, g1.x); ctPair(n1.y, g1.y); ctPair(n1.z, g1.z); ctPair(n1.w, g1.w);
  // displacement bound D_i: the particle's own initial overlap, raised by contacts that appear later (a neighbour pushed
  // into it) only up to uCtEmb.z x its radius, so that pushes cannot cascade far through a dense packing (where the
  // outcome would change chaotically with the analytic positions)
  float D = uCtIt.w > 0.5 ? gDmax : max(P.w, min(gDmax, uCtEmb.z * gAi));
  // over-relaxed average of the pair corrections (Jacobi with constraint averaging); a particle hidden inside a larger
  // one stays where it is
  vec3 x = gX + (uCtIt.x * (1.0 - gEmb)) * gAcc / max(1.0, gCnt);
  // displacement bound: no farther from the analytic position than the overlaps require
  vec3 t = x - gX0;
  float tl = length(t), lim = uCtIt.y * D;
  if (tl > lim) x = gX0 + t * (lim / tl);
  oP = vec4(x, D);
}`;

/** Write the resolved positions back to R0 (one point per moved list entry). Requires nearCommon, nearOcclusion. */
const SCATTER_VS = /* glsl */ `
uniform sampler2D tCP;    // final positions (xyz)
uniform sampler2D tCP0;   // analytic positions (xyz, R0 texel index)
uniform sampler2D tCM;    // (signed a, ...)
uniform ivec2 uR0Size;    // R0 (width, rows)
uniform vec4 uCtVis;      // (conservative normal path tau, -, -, -): as the contact set
uniform float uCtCull;    // the update pass's statistical-occlusion cull threshold uCull (0: off)
flat out vec4 vP;
${LOS_GLSL}
bool ctInView(vec3 p, float rb) {
  vec3 v = uWorldToCam * p;
  float w = -v.z, tx = uTanHalfFov * uAspect, ty = uTanHalfFov;
  return !(w < -rb || abs(v.x) > w * tx + rb * sqrt(1.0 + tx * tx) || abs(v.y) > w * ty + rb * sqrt(1.0 + ty * ty));
}
// the update pass's statistical-occlusion cull at p (nearLosTau > uCull: present but not drawn), its path tau capped by
// the conservative one of the radial profile (uCtVis.x) - it never hides a particle the update pass would draw
bool ctOccluded(vec3 p, float rb) {
  return uCtCull > 0.0 && ctLosTau(p, rb, uCtCull, uCtVis.x) > uCtCull;
}
void main() {
  gl_PointSize = 1.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  ivec2 c = ctTexel(gl_VertexID);
  float w = texelFetch(tCM, c, 0).x;
  if (w == 0.0) return;
  vec4 P0 = texelFetch(tCP0, c, 0);
  vec3 x = texelFetch(tCP, c, 0).xyz;
  if (x == P0.xyz) return;
  // count contract: a present particle that the displacement moved into the view frustum is drawn - as the update pass
  // decides: in view and not statistically occluded (its sphere test failed at the analytic position, so it never
  // tested the occlusion there; a particle it culled as occluded in view stays culled)
  if (w < 0.0) {
    float rb = nearMaxExtent() * abs(w);
    if (!ctInView(P0.xyz, rb) && ctInView(x, rb) && !ctOccluded(x, rb)) w = -w;
  }
  vP = vec4(x, w);
  // (an exact integer below 2^24; adding 0.5 would round to even above 2^23)
  int slot = int(P0.w);
  vec2 tc = vec2(float(slot % uR0Size.x), float(slot / uR0Size.x));
  gl_Position = vec4((tc + 0.5) / vec2(uR0Size) * 2.0 - 1.0, 0.0, 1.0);
}`;
const SCATTER_FS = /* glsl */ `
precision highp float;
flat in vec4 vP;
layout(location = 0) out vec4 o;
void main() { o = vP; }`;

/** header of the grid / search / iteration shaders (no shared ring uniforms: only the hash of sv_common) */
const MIN_HEADER = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
#include <sv_common>
#define LOD_CLASSES ${LOD_CLASSES}
`;

function floatRT(w: number, h: number, count = 1, depthBuffer = false): WebGLRenderTarget {
  return new WebGLRenderTarget(w, h, {
    type: FloatType, format: RGBAFormat, count, minFilter: NearestFilter, magFilter: NearestFilter,
    depthBuffer, stencilBuffer: false, generateMipmaps: false,
  });
}

/** Everything NearContact.run needs from the near-field pass for one frame. */
export interface NearContactFrame {
  renderer: WebGLRenderer;
  frame: FrameState;
  lod: RingLod;
  profile: RingProfile;
  wakes: WakeField;
  /** the update pass's uTauCam: tau at the camera's Lagrangian radius x its streamline density J */
  tauCam: number;
  r0RT: WebGLRenderTarget;
  texRows: number;
  /** per class: active this frame (its R0 rows were written by the update pass) */
  active: boolean[];
  /** 0 low, 1 medium, 2 high particle quality (contact shape: ellipsoids at high quality) */
  quality: number;
  /** the R0 slot layout changed (reallocation): the read-back list size is stale */
  layoutChanged: boolean;
  /** the update pass's statistical-occlusion cull threshold uCull (0: off) */
  cull: number;
}

export class NearContact {
  enabled = true;
  /** neighbour-search rounds (each: hash grid + search) and Jacobi iterations in all (iterations are cheap next to a
   *  search: 24 damped ones instead of 12 undamped resolve a quarter more of the jammed clusters' overlaps, measured) */
  rounds = 3;
  iterations = 48;
  /** relaxation factor of the averaged pair corrections (damped: over-relaxation amplifies the sensitivity to the input;
   *  at the B ring's packing limit 48 x 0.6 resolves a third more of the visible overlaps than 24 x 0.7 with fewer jumps
   *  per frame, measured: scripts/test/README.md, contact) */
  omega = 0.6;
  /** displacement bound: |x - x_analytic| <= clampK x the largest pair correction the particle has needed */
  clampK = 4;
  /** neighbour candidates: surface gap below gapMargin x the smaller particle's diameter (fading in from half of it) */
  gapMargin = 0.5;
  /** a pair whose smaller particle lies inside the larger one is left alone: fade over penetration / smaller radius */
  embedFade: [number, number] = [2, 2.5];
  /** contacts that appear during the iterations raise a particle's displacement bound by at most this x its radius */
  yieldBound = 0.5;
  /** target mean fill of a grid cell at the densest mid-plane (sparse classes get cells larger than their diameter) */
  cellFill = 0.5;
  /** contact set: render-px radius fade-in (lo, hi) and line-of-sight tau fade-out (lo, hi). (Below 5 px an overlap,
   *  ~0.3 of the smaller radius, is <= 1.5 px; 4 -> 6 px listed 50 % more B-ring particles at the packing limit - the
   *  search's cost - for the same residual and more jumps in jammed clusters, 3 -> 6 px 70 % more before; measured) */
  rhoLo = 5;
  rhoHi = 6;
  tauVisLo = 4;
  tauVisHi = 5;
  /** statistical occlusion test on/off (debugging) */
  occlusion = true;
  /** debugging / profiling: stop after 1 the list compaction, 2 the materialization, 3 the first grid, 4 the first search */
  stage = 0;
  /** fit the hash grid and the processed range to the list (false: the whole allocation, as before Nov 2026; profiling) */
  gridFit = true;

  /** last read-back contact-set size (entries in the list, before truncation to the capacity) */
  count = 0;
  /** entries processed this frame (draw range) and the list capacity; hash buckets and their capacity */
  drawn = 0;
  cap = 0;
  buckets = 0;
  /** hash buckets used this frame (a power of two <= buckets: twice the entries processed) */
  bucketsUsed = 0;
  /** largest base-shape semi-axis / a used this frame (SHAPE_EXT_HIGH at high quality, 1 otherwise) */
  ext = 1;
  /** wake-field bounds used this frame (tests: 0 < wakeMin <= 1 <= wakeCore) and the conservative path tau */
  readonly bounds = { wakeMin: 1, wakeCore: 1, tauPath: 0 };
  readonly slotsPerBucket = CT_SLOTS;
  /** whether the contact step ran this frame, and why not ('' = disabled or no active class) */
  ran = false;
  idle = '';
  /** target holding the last run's result (tests / debugging): (final position, bound D_i) */
  outRT: WebGLRenderTarget | null = null;

  private readonly pyr: NearCompaction;
  private readonly l1Mat: RawShaderMaterial;
  private readonly matMat: RawShaderMaterial;
  private readonly gridMat: RawShaderMaterial;
  private readonly stBitsMat: RawShaderMaterial;
  private readonly srMat: RawShaderMaterial;
  private readonly itMat: RawShaderMaterial;
  private readonly scMat: RawShaderMaterial;
  private readonly fs: Mesh;
  private readonly gridPts: Points;
  private readonly scPts: Points;
  private cRT: WebGLRenderTarget | null = null;
  private pRT: WebGLRenderTarget[] = [];
  private nRT: WebGLRenderTarget | null = null;
  /** hash grid: R32UI entries in 4 x 4 blocks + the routing stencil */
  private gRT: WebGLRenderTarget | null = null;
  private readback: { pbo: WebGLBuffer; fence: WebGLSync } | null = null;
  private readonly readBuf = new Float32Array(4);
  private stale = true;
  private frameNo = 0;
  private readonly zero4 = new Uint32Array(4);
  // shared uniform objects
  private readonly selU = { value: [5, 6, 4, 5] };
  private readonly visU = { value: [0, 10, 10, 10] };
  private readonly mwU = { value: 0 };
  private readonly invCellU = { value: new Float32Array(LOD_CLASSES) };
  private readonly aHiU = { value: new Float32Array(LOD_CLASSES) };
  private readonly maskU = { value: 0 };
  private readonly lvU = { value: [0, 0] };
  private readonly cullU = { value: 0 };
  private readonly tauCamU = { value: 0 };

  /**
   * common: the near-field GLSL prelude (SV_HEADER_ALL + nearCommon + NEAR_SHADOW_COMMON); shared: the uniforms it
   * needs (shared + near-field ones); tables: tR0 and the class tables (uTexW, uTexRows, uClsRow0/Rows/Seed);
   * spinW: uClsSpinW; pyr: the near field's pyramid (its atlases are reused before the draw lists are built);
   * occlusion: the statistical-occlusion bound's uniforms (NearFieldPass.occlusionUniforms, nearOcclusion.glsl: the same
   * objects the update pass reads, updated every frame before it).
   */
  constructor(common: string, shared: Record<string, IUniform>, tables: Record<string, IUniform>, spinW: IUniform, pyr: NearCompaction,
    occlusion: Record<string, IUniform>) {
    this.pyr = pyr;
    const sel = { uCtSel: this.selU, uCtVis: this.visU, uCtMw: this.mwU, uCtTauCam: this.tauCamU, uCtCull: this.cullU };
    const grid = { uCtInvCell: this.invCellU, uCtMask: this.maskU };
    const fsMat = (fragmentShader: string, uniforms: Record<string, IUniform>) => new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: FS_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: NoBlending,
    });
    const classify = common + nearOcclusion + GRID_GLSL + CLASSIFY_GLSL;
    this.l1Mat = fsMat(classify + LEVEL1_FRAG, { ...shared, ...tables, ...sel, ...occlusion, uDstOff: { value: [0, 0] } });
    this.matMat = fsMat(classify + NEAR_PYR_GLSL + MATERIALIZE_FRAG, {
      ...shared, ...tables, ...sel, ...occlusion, ...grid, ...pyr.uniforms(), uClsSpinW: spinW, uCtN: { value: 0 },
    });
    const list = () => ({ tCP: { value: null }, tCM: { value: null }, tCS: { value: null } });
    this.srMat = fsMat(MIN_HEADER + GRID_GLSL + SEARCH_FRAG, {
      ...grid, ...list(), tG: { value: null }, uCtSr: { value: [0.5, 1, 0, 0] }, uCtLv: this.lvU, uCtAHi: this.aHiU,
    });
    this.itMat = fsMat(MIN_HEADER + GRID_GLSL + ITERATE_FRAG, {
      ...grid, ...list(), tCP0: { value: null }, tCN0: { value: null }, tCN1: { value: null }, tCG0: { value: null }, tCG1: { value: null },
      uCtIt: { value: [0.6, 4, 0.5, 1] }, uCtEmb: { value: [2, 2.5, 0.5] },
    });
    // stencil routing: test == 15, every fragment increments (the written texel leaves 15, the next one reaches it)
    this.gridMat = new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: MIN_HEADER + GRID_GLSL + GRID_VS, fragmentShader: GRID_FS,
      uniforms: { ...grid, tCP: { value: null }, tCM: { value: null }, uGSize: { value: [CT_W, 1] } },
      depthTest: false, depthWrite: false, blending: NoBlending,
      stencilWrite: true, stencilFunc: EqualStencilFunc, stencilRef: 15, stencilFuncMask: 0xff, stencilWriteMask: 0xff,
      stencilFail: IncrementStencilOp, stencilZFail: IncrementStencilOp, stencilZPass: IncrementStencilOp,
    });
    this.stBitsMat = new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: FS_VERT, fragmentShader: STENCIL_BITS_FS, uniforms: { uBit: { value: 0 } },
      depthTest: false, depthWrite: false, colorWrite: false, blending: NoBlending,
      stencilWrite: true, stencilFunc: AlwaysStencilFunc, stencilRef: 0xff, stencilWriteMask: 1, stencilZPass: ReplaceStencilOp,
    });
    this.scMat = new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: common + nearOcclusion + GRID_GLSL + SCATTER_VS, fragmentShader: SCATTER_FS,
      uniforms: {
        ...shared, ...occlusion, tCP: { value: null }, tCP0: { value: null }, tCM: { value: null }, uR0Size: { value: [CT_W, 1] },
        uCtVis: this.visU, uCtCull: this.cullU, uCtTauCam: this.tauCamU,
      },
      depthTest: false, depthWrite: false, blending: NoBlending,
    });
    this.fs = new Mesh(fullscreenGeometry(), this.itMat);
    this.fs.frustumCulled = false;
    const g1 = new BufferGeometry();
    g1.setDrawRange(0, 0);
    this.gridPts = new Points(g1, this.gridMat);
    this.gridPts.frustumCulled = false;
    const g2 = new BufferGeometry();
    g2.setDrawRange(0, 0);
    this.scPts = new Points(g2, this.scMat);
    this.scPts.frustumCulled = false;
  }

  /** (Re)allocate the list and grid textures for `cap` entries. */
  private allocate(r: WebGLRenderer, cap: number): void {
    const rows = Math.max(CT_MIN_ROWS, Math.ceil(cap / CT_W));
    this.cap = rows * CT_W;
    this.cRT?.dispose();
    this.nRT?.dispose();
    this.gRT?.dispose();
    for (const t of this.pRT) t.dispose();
    this.cRT = floatRT(CT_W, rows, 3);
    this.pRT = [floatRT(CT_W, rows), floatRT(CT_W, rows)];
    this.nRT = floatRT(CT_W, rows, 2 * CT_NB_T);   // neighbour indices + their round-start gaps
    // buckets: the next power of two >= twice the capacity (mean fill <= 0.5 of 16 entries, clustered cells included;
    // R32UI, 4 bytes per entry: a compact table for the random access of the search)
    let b = 1 << 16;
    while (b < 2 * this.cap && b < CT_MAX_BUCKETS) b *= 2;
    this.buckets = b;
    this.maskU.value = b - 1;
    const gRows = (b >> CT_BPR_LOG2) * 4;
    // (depth + stencil: three.js attaches DEPTH24_STENCIL8; the depth is unused)
    this.gRT = new WebGLRenderTarget(CT_W, gRows, {
      type: UnsignedIntType, format: RedIntegerFormat, internalFormat: 'R32UI',
      minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true, stencilBuffer: true, generateMipmaps: false,
    });
    // cleared now: three.js binds a float placeholder for a target never rendered to, and the unsigned sampler of the
    // search on it drops the draw (GL_INVALID_OPERATION)
    const gl = r.getContext() as WebGL2RenderingContext;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.gRT);
    r.state.buffers.color.setMask(true);
    gl.clearBufferuiv(gl.COLOR, 0, this.zero4);
    r.setRenderTarget(prev);
    (this.gridMat.uniforms.uGSize.value as number[])[0] = CT_W;
    (this.gridMat.uniforms.uGSize.value as number[])[1] = gRows;
    this.srMat.uniforms.tG.value = this.gRT.texture;
    const c = this.cRT.textures;
    for (const mat of [this.gridMat, this.srMat, this.itMat, this.scMat]) mat.uniforms.tCM.value = c[1];
    for (const mat of [this.srMat, this.itMat]) mat.uniforms.tCS.value = c[2];
    this.itMat.uniforms.tCP0.value = c[0];
    this.scMat.uniforms.tCP0.value = c[0];
    this.itMat.uniforms.tCN0.value = this.nRT.textures[0];
    this.itMat.uniforms.tCN1.value = this.nRT.textures[1];
    this.itMat.uniforms.tCG0.value = this.nRT.textures[2];
    this.itMat.uniforms.tCG1.value = this.nRT.textures[3];
    this.stale = true;
  }

  /**
   * Resolve the contacts of this frame's R0 (after the update pass, before the compaction of the draw lists).
   * Returns false if nothing ran.
   */
  run(fr: NearContactFrame): boolean {
    this.ran = false;
    this.idle = '';
    this.frameNo++;
    if (!this.enabled || this.pyr.levels.length === 0) return false;
    const { renderer: r, lod, frame: f } = fr;
    if (fr.layoutChanged) this.stale = true;
    // levels present (classes active this frame) and the grid geometry
    const ext = fr.quality > 1.5 ? SHAPE_EXT_HIGH : 1.0;   // largest base-shape semi-axis / a
    this.ext = ext;
    let lo = -1, hi = -1, aMax = 0;
    // wake-field density bounds (mirrors of wakes.glsl through the WakeField's CPU state): the floor = wakeMinDensity()
    // (the update pass's culling bound), the cores = 1 / gammaCore^strength (the map's compression, sec. 10.11)
    const wk = fr.wakes.uniforms;
    const wakeOn = (wk.uWakeOn.value as number) > 0.5;
    const wMin = wakeOn ? (wk.uWakeBounds.value as { x: number }).x : 1;
    const wCore = wakeOn ? Math.pow(fr.wakes.shape.gamma, -fr.wakes.strength) : 1;
    this.bounds.wakeMin = wMin;
    this.bounds.wakeCore = wCore;
    // (densest column: the max tau of the class boxes x the wake cores' compression)
    const tauDense = Math.max(lod.tau, lod.tauBoxMax) * wCore;
    for (let k = 0; k < LOD_CLASSES; k++) {
      // grid cell of level k: the class's largest diameter, or larger where the class is sparse (mid-plane number
      // density n: cells of ~0.5 particles), so that a search scans few, mostly occupied cells
      const aHi = Math.max(lod.aHi[k], 1e-3 * 2 ** (k + 1));
      const nMid = (tauDense * lod.nPerTau[k]) / (2.5066 * lod.sigZ(k));
      const cell = Math.max(2 * ext * aHi, nMid > 0 ? Math.cbrt(this.cellFill / nMid) : 0);
      this.aHiU.value[k] = aHi;
      this.invCellU.value[k] = 1 / Math.min(cell, 64 * ext * aHi);
      if (!fr.active[k] || lod.slots[k] <= 0) continue;
      if (lo < 0) lo = k;
      hi = k;
      aMax = Math.max(aMax, aHi);
    }
    if (lo < 0) return false;
    this.lvU.value[0] = lo;
    this.lvU.value[1] = hi;
    // contact-set selection; the farthest a contact particle can be: the largest radius at rhoLo render px
    const reach = Math.min(aMax / (this.rhoLo * f.pixelAngle), 20_000);
    // nothing can be resolved: the camera is farther from the layer (about its local mid-plane, which the vertical
    // relief may tilt across the reach: x2) than the largest particles are resolved at
    if (Math.abs(f.ring.camLocal.z - f.ring.zMid) - (1.6 * lod.H + 0.5) > 2 * reach) { this.idle = 'nothing resolvable'; return false; }
    const sel = this.selU.value;
    sel[0] = this.rhoLo; sel[1] = this.rhoHi; sel[2] = this.tauVisLo; sel[3] = this.tauVisHi;
    this.mwU.value = wakeOn ? (wk.uWakeTile.value as number) / 6 : 0;   // nearUpdate.glsl's out-of-view margin
    // statistical occlusion: on with the update pass's cull (its threshold uCull; ctLosTau mirrors its inputs per
    // particle). The scatter's drawn flip caps the path tau by a conservative one: the lowest tau_dyn within the contact
    // range (the camera's incl. its streamline density) x 0.8, without the 2-D modulation. No wake floor: nearLosTau
    // applies the wakes itself (the emptiest gap, then the path's own density)
    const occl = this.occlusion && fr.cull > 0;
    let tauPath = 0;
    if (occl) {
      const rKm = (f.ring.r0 + f.ring.camLocal.x) / 1000, hw = reach / 1000 + 1;
      let tmin = fr.tauCam;
      for (let x = -hw; x <= hw + 1e-9; x += 0.25) {
        const l = fr.profile.local((rKm + x) * 1000);
        // the particle population's optical depth tau_dyn (lodTauDyn), as the update pass's cull
        tmin = Math.min(tmin, l.tau * lod.tauDynFactor(l.tau) * (1 - l.dust));
      }
      tauPath = Number.isFinite(tmin) ? tmin * 0.8 : 0;
    }
    this.bounds.tauPath = tauPath;
    this.cullU.value = occl ? fr.cull : 0;
    this.tauCamU.value = fr.tauCam;
    // frustum dilation per particle (units of its radius): two of its own contact distances, + a fade of one
    const vis = this.visU.value;
    vis[0] = tauPath; vis[1] = 0; vis[2] = 4 * ext; vis[3] = 2 * ext;
    // capacity: grow when the read-back size approaches it
    if (!this.cRT || (this.count > 0.85 * this.cap && this.cap < CT_MAX)) {
      this.allocate(r, Math.min(CT_MAX, Math.max(this.cap, Math.ceil(this.count * 1.5), CT_MIN_ROWS * CT_W)));
    }
    // an empty contact set (last read-back): only the list compaction runs, every 4th frame, to notice particles
    // entering it - they enter through the weights' fades (from 0), so a few frames' delay keeps the result continuous;
    // otherwise the step would be the identity on R0 anyway
    const empty = !this.stale && this.count === 0;
    if (empty && this.frameNo % 4 !== 0) { this.idle = 'empty set'; return false; }
    // entries processed: the read-back size + a margin for growth until the next read-back (whole rows)
    const n = this.stale ? this.cap : Math.min(this.cap, this.gridFit
      ? Math.ceil((1.5 * this.count + 8192) / CT_W) * CT_W
      : Math.max(16384, Math.ceil(1.5 * this.count + 16384)));
    const rows = Math.ceil(n / CT_W);
    this.drawn = n;
    // hash buckets this frame: the next power of two >= 2 n (mean fill <= 0.5 of 16 entries), within the allocation;
    // the grid's clears and routing pattern cover only their rows (the fixed cost of a small list)
    let bf = this.gridFit ? 4096 : this.buckets;
    while (bf < 2 * n && bf < this.buckets) bf *= 2;
    this.bucketsUsed = bf;
    this.maskU.value = bf - 1;
    const gRows = (bf >> CT_BPR_LOG2) * 4;

    // 1. compaction of the contact set (the near field's pyramid, before the draw lists are built from it)
    this.l1Mat.uniformsNeedUpdate = true;
    this.pyr.build(r, this.l1Mat);
    this.readCount(r);
    if (this.stage === 1) return false;
    if (empty) { this.idle = 'empty set'; return false; }
    // materialize the list
    const mu = this.matMat.uniforms;
    mu.tPyrA.value = this.pyr.atlas[0].texture;
    mu.tPyrB.value = this.pyr.atlas[1].texture;
    mu.uCtN.value = n;
    this.matMat.uniformsNeedUpdate = true;
    const cRT = this.cRT!;
    this.pass(r, this.matMat, cRT, rows);
    if (this.stage === 2) return false;

    // 2. rounds: hash grid + neighbour search of the round's start positions, then Jacobi iterations
    const gu = this.gridMat.uniforms, su = this.srMat.uniforms, iu = this.itMat.uniforms;
    (su.uCtSr.value as number[])[0] = this.gapMargin;
    (su.uCtSr.value as number[])[1] = ext;
    const it = iu.uCtIt.value as number[];
    it[0] = this.omega;
    it[1] = this.clampK;
    it[2] = this.gapMargin;
    (iu.uCtEmb.value as number[])[0] = this.embedFade[0];
    (iu.uCtEmb.value as number[])[1] = this.embedFade[1];
    (iu.uCtEmb.value as number[])[2] = this.yieldBound;
    (this.gridPts.geometry as BufferGeometry).setDrawRange(0, n);
    (gu.uGSize.value as number[])[1] = gRows;
    const gl = r.getContext() as WebGL2RenderingContext;
    const g = this.gRT!;
    let src = cRT.textures[0];
    const rounds = Math.max(1, Math.round(this.rounds));
    const iters = Math.max(rounds, Math.round(this.iterations));
    let done = 0, out = 0;
    for (let rd = 0; rd < rounds; rd++) {
      // hash grid of the round's start positions: entries and stencil cleared, the routing pattern (15 - slot) drawn
      // as 4 bit planes, then one routed point pass - all within this frame's bucket rows (viewport + scissor: the
      // clears obey the scissor, the draws the viewport)
      g.viewport.set(0, 0, CT_W, gRows);
      g.scissor.set(0, 0, CT_W, gRows);
      g.scissorTest = true;
      r.setRenderTarget(g);
      r.state.buffers.color.setMask(true);
      gl.clearBufferuiv(gl.COLOR, 0, this.zero4);
      r.clear(false, false, true);
      this.fs.material = this.stBitsMat;
      for (let bit = 0; bit < 4; bit++) {
        this.stBitsMat.uniforms.uBit.value = bit;
        this.stBitsMat.stencilWriteMask = 1 << bit;
        this.stBitsMat.uniformsNeedUpdate = true;
        r.render(this.fs, fsCamera);
      }
      gu.tCP.value = src;
      this.gridMat.uniformsNeedUpdate = true;
      r.render(this.gridPts, fsCamera);
      g.viewport.set(0, 0, CT_W, g.height);
      g.scissor.set(0, 0, CT_W, g.height);
      g.scissorTest = false;
      if (this.stage === 3) return false;
      su.tCP.value = src;
      this.srMat.uniformsNeedUpdate = true;
      this.pass(r, this.srMat, this.nRT!, rows);
      if (this.stage === 4) return false;
      const nIt = Math.round((iters * (rd + 1)) / rounds) - done;
      for (let i = 0; i < nIt; i++) {
        const dst = this.pRT[out];
        iu.tCP.value = src;
        it[3] = done === 0 ? 1 : 0;
        this.itMat.uniformsNeedUpdate = true;
        this.pass(r, this.itMat, dst, rows);
        src = dst.texture;
        this.outRT = dst;
        out = 1 - out;
        done++;
      }
    }

    // 3. scatter the resolved positions back into R0
    const scu = this.scMat.uniforms;
    scu.tCP.value = src;
    (scu.uR0Size.value as number[])[1] = fr.texRows;
    this.scMat.uniformsNeedUpdate = true;
    (this.scPts.geometry as BufferGeometry).setDrawRange(0, n);
    r.setRenderTarget(fr.r0RT);
    r.render(this.scPts, fsCamera);
    this.ran = true;
    return true;
  }

  /** fullscreen pass over the first `rows` rows of a target */
  private pass(r: WebGLRenderer, mat: RawShaderMaterial, rt: WebGLRenderTarget, rows: number): void {
    this.fs.material = mat;
    rt.viewport.set(0, 0, CT_W, rows);
    r.setRenderTarget(rt);
    r.render(this.fs, fsCamera);
    rt.viewport.set(0, 0, CT_W, rt.height);
  }

  /** list target (tests / debugging): [0] (analytic position, R0 texel), [1] (signed a, weight, M'00, M'11), [2] (M'22, M'01, M'02, M'12) */
  get listTarget(): WebGLRenderTarget | null { return this.cRT; }
  /** neighbour lists of the last round (tests / debugging): 2 attachments of 4 list indices + 1 */
  get neighbourTarget(): WebGLRenderTarget | null { return this.nRT; }

  /** async read-back of the contact-set size from the pyramid's top (every 4th frame) */
  private readCount(r: WebGLRenderer): void {
    const gl = r.getContext() as WebGL2RenderingContext;
    const rb = this.readback;
    if (rb) {
      if (gl.getSyncParameter(rb.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return;
      gl.deleteSync(rb.fence);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, rb.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.readBuf);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(rb.pbo);
      this.readback = null;
      this.count = this.readBuf[0];
      this.stale = false;
      return;
    }
    if (this.frameNo % 4 !== 0 && !this.stale) return;
    const top = this.pyr.topLocation;
    const pbo = gl.createBuffer();
    if (!pbo) return;
    r.setRenderTarget(top.rt);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
    gl.readPixels(top.x, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (fence) this.readback = { pbo, fence };
  }

  stats(): string {
    if (!this.enabled) return 'off';
    if (!this.ran) return this.idle ? `idle (${this.idle})` : 'idle';
    const over = this.count > this.cap ? ` — ${fmtK(this.count - this.cap)} smallest unresolved (list cap ${fmtK(this.cap)})` : '';
    return `${fmtK(this.count)} particles, ${this.rounds} searches, ${this.iterations} iterations${over}`;
  }

  dispose(): void {
    this.cRT?.dispose();
    this.nRT?.dispose();
    this.gRT?.dispose();
    for (const t of this.pRT) t.dispose();
    for (const m of [this.l1Mat, this.matMat, this.gridMat, this.stBitsMat, this.srMat, this.itMat, this.scMat]) m.dispose();
  }
}

function fmtK(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
}
