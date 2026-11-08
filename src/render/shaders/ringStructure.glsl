// ===== sv_ringStructure ======================================================================
// The 2-D (radius, azimuth, time) structure of the main rings. EVERY main-ring optical-depth lookup goes through
// this chunk (ring-layer sheet and march, near-field presence and culling, the astronaut's ring column, ...); the
// radial profile of sv_ringProfile is the Lagrangian profile tau0(a') it maps.
// Requires sv_common, sv_ringProfile, sv_ringRelief (relief sources). Uniforms: src/rings/RingStructure.ts (spread via
// SharedUniforms); CPU mirror and model description: src/rings/streamlines.ts, src/rings/relief.ts.
//
// Streamline model. Material is labelled by its Lagrangian (unperturbed) radius a'. At azimuth theta and time t the
// streamline sits at r = a' + xi(a', theta, t) and at height zeta(a', theta, t). The Eulerian optical depth is
//     tau(r, theta) = tau0(a') J M,   J = 1 / (dr/da')  (surface-density conservation: streamline crowding)
// a'(r, theta) by Newton iteration from a' = r (RS_NEWTON steps); dr/da' is floored at uRsJFloor (J <= 1/floor),
// which only binds where an inspection scale > 1 or the moonlet's eccentricity push the map toward streamline
// crossing (the table itself is limited to dr/da' >= ~0.4, scripts/data/rings/moonlet_response.mjs). A gap is
// empty by construction: no material streamline maps into it.
//
// Sources of xi / zeta: moonlets in gaps (Pan, Daphnis): the universal Hill-problem response table uRsTab at
// b = |a' - a_moon(t_conj)| / r_H and Hill time t = s / (1.5 b r_H) since conjunction (s = downstream arc); bicubic
// Hermite interpolation (exact float32 weights via texelFetch: hardware filtering would quantize the weights and
// make particles near the camera jitter by ~1 m). Normal modes of eccentric edges (src/rings/ringModes.ts: the
// B-ring outer edge), xi = -A g(u) cos(m (theta - varpi(t))), phases precomputed per frame at the frame origin.
//
// API (offsets keep float32 precise near the camera: dr = r - uRingR0 (ringDrFromLocal), dth = azimuth offset from
// the ring-frame origin, atan(l.y, uRingR0 + l.x); fp = radial pixel footprint (m), 0 = full resolution):
//   RingStream ringStream(dr, dth, fp)          Eulerian point -> Lagrangian offset .da (a' - r), density .J,
//                                               2-D modulation .tauMod (no height: cheaper)
//   RingStream ringStreamRelief(dr, dth, fp)    the same plus .zeta (mid-plane height, m) and .slope (dzeta/dr,
//                                               dzeta/(r dtheta)) -- the vertical-relief hook
//   vec3  ringStreamXi(aL, dth, fp)             forward map at the Lagrangian offset aL = a' - uRingR0: (xi, zeta,
//                                               J) (the near field displaces its particles, which carry a')
//   RingSample ringSampleStream(dr, dth, fp)    THE main-ring lookup: profile at a', tau and Sigma x J x tauMod
//   RingSample ringSampleLocal(l, fp)           the same for a local-frame point (ringLocalFromRel)
//   RingSample ringSampleLagrangian(aL, fp)     the unperturbed profile at a Lagrangian offset (precise index)
//   RingSample ringSampleIdxPrecise(I, sub, fp) profile at level-0 index I + sub (integer + small fraction)
//   float ringSunTransmissionStream(p, fp)      ringSunTransmission through the structure
//   bool  rsIdentityAt(dr)                      cheap test: no source can displace material near dr
//   void ringLocalPolar(l, out dr, out dth)
//   RingSample ringSampleLocalRelief(l, fp, out rel)   THE lookup + the local mid-plane there: rel = (zeta, slope, a' - r0)
// Relief and texture hooks:
//   ringStructureRelief(aL, dth, fp) -> vec3(height, dheight/da', dheight/dS), added to the moonlets' zeta: bending waves
//                                    and the 1983 corrugation (rsReliefWaves), B-ring-edge structures and S/2009 S1
//                                    (rsReliefSites) -- both sv_ringRelief, included before this chunk -- and propeller
//                                    relief (rsReliefPropellers, stub); fp = radial footprint (prefiltering)
//   ringStructureTauMod(aL, dth)  -> multiplicative 2-D optical-depth modulation (azimuthal fine texture,
//                                    propellers); must average to ~1 over azimuth
// Every consumer of the layer's vertical structure takes heights relative to the local mid-plane z0 = .zeta (the
// relief contract, docs/ARCHITECTURE.md); the ring frame itself stays in the SEF plane.
#ifndef SV_RING_STRUCTURE
#define SV_RING_STRUCTURE

#define RS_MOONLETS 2
#define RS_NEWTON 4
uniform sampler2D uRsTab;     // moonlet response: width nt, height 3 nb; groups K = b^2 xi / r_H, Wc, Ws (F, dF/dt, dF/db, d2F/dbdt)
uniform vec4 uRsTabT;         // (t0, dt, nt, 1 / dt)
uniform vec4 uRsTabB;         // (b_lo, d ln b, nb, b_in)
uniform vec4 uRsMl[3 * RS_MOONLETS]; // per moonlet: (a_g - r0, S0 = a_g wrap(phi0 - theta_m), r_H, amplitude),
                                     // (x_epi, x_epi' / kappa, Z cos psi, Z sin psi), (a_g, b_hi r_H, -, -)   [m]
uniform vec4 uRsCam;          // camera: (xi, zeta, J, 1 = a structure zone is within the near field's reach)
uniform float uRsOn;          // 0: identity map (no table / all amplitudes 0)
uniform float uRsJFloor;      // floor of dr/da'
uniform vec2 uRsIdx0;         // level-0 profile index of the ring-frame origin r0 split on the CPU: (integer, fraction)
// normal modes of eccentric edges (src/rings/ringModes.ts): xi = -A g(u) cos(phase + m dth), u = material (a' - a_e)
#define RS_MODES 8
#define RS_FEATURES 2
uniform vec4 uRsMode[RS_MODES];     // (A [m] (0 = unused), m (phi0 - varpi(t)) [rad], m, 1 / decay length [1/m])
uniform int uRsModeF[RS_MODES];     // feature of each mode
uniform vec4 uRsFeat[RS_FEATURES];  // (a_edge - r0 [m], material side (-1: inward of the edge), 1 / gap [1/m], reach [m])

struct RingStream {
  float da;       // a' - r (m)
  float J;        // surface-density factor 1 / max(dr/da', floor)
  float tauMod;   // multiplicative 2-D optical-depth modulation
  float zeta;     // mid-plane height of the material (m) (ringStreamRelief only)
  vec2 slope;     // (dzeta/dr, dzeta/(r dtheta)) (ringStreamRelief only)
  vec2 daGrad;    // (d da/dr, d da/(r dtheta)): linear extrapolation of da around this point (march cache)
};

// ---------------------------------------------------------------- hooks (later work packages)
// One stub per source so that independent work packages fill different functions (each may move its body into a
// chunk of its own; keep the names and signatures, or update the sums below and their documentation).
// Vertical relief sources at Lagrangian offset aL (m), azimuth offset dth, radial footprint fp (m): (height (m), d/da',
// d/dS) each.
vec3 rsReliefWaves(float aL, float dth, float fp) { return rrWaves(aL, dth, fp); }  // bending waves, 1983 corrugation (sv_ringRelief)
vec3 rsReliefSites(float aL, float dth, float fp) { return rrSites(aL, dth, fp); }  // B-ring-edge region A, S/2009 S1 (sv_ringRelief)
vec3 rsReliefPropellers(float aL, float dth) { return vec3(0.0); }  // propeller moonlets (texture / propeller package)
vec3 ringStructureRelief(float aL, float dth, float fp) {
  return rsReliefWaves(aL, dth, fp) + rsReliefSites(aL, dth, fp) + rsReliefPropellers(aL, dth);
}
// Multiplicative 2-D optical-depth modulation sources at Lagrangian offset aL and azimuth offset dth.
float rsTauModTexture(float aL, float dth) { return 1.0; }     // azimuthal fine texture (texture / propeller package)
float rsTauModPropellers(float aL, float dth) { return 1.0; }  // propeller partial gaps, moonlet wakes (same package)
float ringStructureTauMod(float aL, float dth) { return rsTauModTexture(aL, dth) * rsTauModPropellers(aL, dth); }

// ---------------------------------------------------------------- moonlet response table
// group g at (b, t): (F, dF/db, dF/dt); 0 outside the time range and beyond b_hi; b >= b_lo (caller clamps)
vec3 rsTab(int g, float b, float t) {
  float ft = (t - uRsTabT.x) * uRsTabT.w;
  int nb = int(uRsTabB.z);
  float lb = log(b / uRsTabB.x) / uRsTabB.y;
  if (!(ft >= 0.0 && ft < uRsTabT.z - 1.0) || !(lb < float(nb - 1))) return vec3(0.0);
  float fi = clamp(lb, 0.0, float(nb - 1) - 1e-4);
  int i = int(floor(fi));
  float b0 = uRsTabB.x * exp(float(i) * uRsTabB.y);
  float hb = b0 * (exp(uRsTabB.y) - 1.0);
  float u = clamp((b - b0) / hb, 0.0, 1.0);
  int j = int(floor(ft));
  float v = ft - float(j);
  float ht = uRsTabT.y;
  int row = g * nb + i;
  vec4 n00 = texelFetch(uRsTab, ivec2(j, row), 0), n01 = texelFetch(uRsTab, ivec2(j + 1, row), 0);
  vec4 n10 = texelFetch(uRsTab, ivec2(j, row + 1), 0), n11 = texelFetch(uRsTab, ivec2(j + 1, row + 1), 0);
  float v2 = v * v, v3 = v2 * v;
  vec4 hv = vec4(2.0 * v3 - 3.0 * v2 + 1.0, -2.0 * v3 + 3.0 * v2, (v3 - 2.0 * v2 + v) * ht, (v3 - v2) * ht);
  vec4 dv = vec4((6.0 * v2 - 6.0 * v) / ht, (-6.0 * v2 + 6.0 * v) / ht, 3.0 * v2 - 4.0 * v + 1.0, 3.0 * v2 - 2.0 * v);
  // per b-node: value and b-derivative interpolated in t, and their t-derivatives
  vec4 a0 = vec4(n00.x, n01.x, n00.y, n01.y), c0 = vec4(n00.z, n01.z, n00.w, n01.w);
  vec4 a1 = vec4(n10.x, n11.x, n10.y, n11.y), c1 = vec4(n10.z, n11.z, n10.w, n11.w);
  vec4 F = vec4(dot(hv, a0), dot(hv, a1), dot(hv, c0), dot(hv, c1));
  vec4 Ft = vec4(dot(dv, a0), dot(dv, a1), dot(dv, c0), dot(dv, c1));
  float u2 = u * u, u3 = u2 * u;
  vec4 hu = vec4(2.0 * u3 - 3.0 * u2 + 1.0, -2.0 * u3 + 3.0 * u2, (u3 - 2.0 * u2 + u) * hb, (u3 - u2) * hb);
  vec4 du = vec4((6.0 * u2 - 6.0 * u) / hb, (-6.0 * u2 + 6.0 * u) / hb, 3.0 * u2 - 4.0 * u + 1.0, 3.0 * u2 - 2.0 * u);
  return vec3(dot(hu, F), dot(du, F), dot(hu, Ft));
}

// One side (sgn = +1 outer, -1 inner) of moonlet k at guiding-centre offset bg (Hill radii, >= b_in) and arc S (m,
// prograde from the moonlet). Returns xi (m), dxi/da', dxi/dS in r.xyz; zeta, dzeta/da', dzeta/dS in z.xyz.
void rsMoonletSide(int k, float sgn, float bg, float S, float amp, bool wantZ, out vec3 r, out vec3 z) {
  vec4 P0 = uRsMl[3 * k], P1 = uRsMl[3 * k + 1];
  float rH = P0.z;
  float t = -sgn * S / (1.5 * bg * rH);
  float ct = cos(t), st = sin(t);
  // the moonlet's radius at the particle's conjunction (its own epicycle): a_g + dm
  float dm = P1.x * ct - P1.y * st;
  float dmdt = -P1.x * st - P1.y * ct;
  float b = bg - sgn * dm / rH;
  bool clamped = b < uRsTabB.x;
  b = max(b, uRsTabB.x);
  float dtda = -t * sgn / (bg * rH);
  float dtdS = -sgn / (1.5 * bg * rH);
  float dbda = clamped ? 0.0 : sgn / rH - sgn * dmdt * dtda / rH;
  float dbdS = clamped ? 0.0 : -sgn * dmdt * dtdS / rH;
  vec3 K = rsTab(0, b, t);
  float ib = 1.0 / b;
  float xib = K.y * ib * ib - 2.0 * K.x * ib * ib * ib;
  float xit = K.z * ib * ib;
  float s = sgn * rH * amp;
  r = s * vec3(K.x * ib * ib, xib * dbda + xit * dtda, xib * dbdS + xit * dtdS);
  z = vec3(0.0);
  if (wantZ) {
    vec3 Wc = rsTab(1, b, t), Ws = rsTab(2, b, t);
    // the moonlet's vertical phase at the particle's conjunction: psi_c = psi_now - t
    float zc = P1.z * ct + P1.w * st, zs = P1.w * ct - P1.z * st;
    float ib3 = ib * ib * ib;
    float zz = (zc * Wc.x - zs * Ws.x) * ib3;
    float zt = (zs * Wc.x + zc * Wc.z + zc * Ws.x - zs * Ws.z) * ib3;
    float zb = (zc * Wc.y - zs * Ws.y) * ib3 - 3.0 * zz * ib;
    z = amp * vec3(zz, zb * dbda + zt * dtda, zb * dbdS + zt * dtdS);
  }
}

// Moonlet k at Lagrangian offset aL = a' - r0 (m) and azimuth offset dth. r = (xi, dxi/da', dxi/dS), z = zeta terms.
void rsMoonlet(int k, float aL, float dth, float fp, bool wantZ, inout vec3 r, inout vec3 z) {
  vec4 P0 = uRsMl[3 * k], P2 = uRsMl[3 * k + 2];
  float rH = P0.z;
  float dag = aL - P0.x;
  if (P0.w == 0.0 || !(abs(dag) < P2.y)) return;
  // footprint fade: waves below the pixel footprint are prefiltered away (moonletFootprintFade)
  float amp = P0.w * (1.0 - smoothstep(0.3 * rH, 1.5 * rH, fp));
  if (amp == 0.0) return;
  float S = P0.y + P2.x * dth;
  float hc = PI * P2.x;   // half the circumference
  if (abs(S) > hc) S -= 2.0 * hc * floor(S / (2.0 * hc) + 0.5);
  float bg = abs(dag) / rH;
  vec3 rr, zz;
  if (bg >= uRsTabB.w) {
    rsMoonletSide(k, dag >= 0.0 ? 1.0 : -1.0, bg, S, amp, wantZ, rr, zz);
  } else {
    // inside the gap: linear across it between the two sides (keeps r(a') monotonic; no material here)
    vec3 ro, zo, ri, zi;
    rsMoonletSide(k, 1.0, uRsTabB.w, S, amp, wantZ, ro, zo);
    rsMoonletSide(k, -1.0, uRsTabB.w, S, amp, wantZ, ri, zi);
    float w = (dag / (uRsTabB.w * rH) + 1.0) * 0.5;
    float inv = 1.0 / (2.0 * uRsTabB.w * rH);
    rr = vec3(mix(ri.x, ro.x, w), (ro.x - ri.x) * inv, mix(ri.z, ro.z, w));
    zz = vec3(mix(zi.x, zo.x, w), (zo.x - zi.x) * inv, mix(zi.z, zo.z, w));
  }
  r += rr;
  z += zz;
}

// Normal modes of eccentric edges (ringModes.ts featureDisplacement): radial profile g(u) of a mode, u = distance into
// the material (u < 0: gap side, linear ramp to 0 over the gap); material side exp(-u/L), tapered over the last
// quarter of the feature's reach. Adds (xi, dxi/da', dxi/dS) to r.
void rsModes(float aL, float dth, inout vec3 r) {
  for (int k = 0; k < RS_MODES; k++) {
    vec4 M = uRsMode[k];
    if (M.x == 0.0) continue;
    vec4 F = uRsFeat[uRsModeF[k]];
    float u = F.y * (aL - F.x);
    float gapL = 1.0 / F.z;
    if (u < -gapL || u > F.w) continue;
    float g, gu;
    if (u < 0.0) {
      g = 1.0 + u * F.z;
      gu = F.z;
    } else {
      float e = exp(-u * M.w);
      float t0 = 0.75 * F.w;
      float tp = 1.0, dtp = 0.0;
      if (u > t0) {
        float x = min(1.0, (u - t0) / (F.w - t0));
        tp = 1.0 - x * x * (3.0 - 2.0 * x);
        dtp = x < 1.0 ? -6.0 * x * (1.0 - x) / (F.w - t0) : 0.0;
      }
      g = e * tp;
      gu = -e * tp * M.w + e * dtp;
    }
    float psi = M.y + M.z * dth;
    float c = cos(psi), s = sin(psi);
    r += vec3(-M.x * g * c, -M.x * gu * F.y * c, M.x * g * M.z * s / (uRingR0 + aL));
  }
}

// All sources at Lagrangian offset aL and azimuth offset dth: r = (xi, dxi/da', dxi/dS), z = (zeta, d/da', d/dS)
void rsEval(float aL, float dth, float fp, bool wantZ, out vec3 r, out vec3 z) {
  r = vec3(0.0);
  z = vec3(0.0);
  rsModes(aL, dth, r);
  for (int k = 0; k < RS_MOONLETS; k++) rsMoonlet(k, aL, dth, fp, wantZ, r, z);
  if (wantZ) z += ringStructureRelief(aL, dth, fp);
}

// true if no source can displace material near the Eulerian offset dr (cheap reject before the Newton iteration)
bool rsIdentityAt(float dr) {
  if (uRsOn < 0.5) return true;
  for (int k = 0; k < RS_MOONLETS; k++) {
    vec4 P0 = uRsMl[3 * k], P2 = uRsMl[3 * k + 2];
    if (P0.w != 0.0 && abs(dr - P0.x) < P2.y + 3.0 * P0.z * max(abs(P0.w), 1.0)) return false;
  }
  for (int f = 0; f < RS_FEATURES; f++) {
    vec4 F = uRsFeat[f];
    if (F.w > 0.0 && abs(dr - F.x) < F.w + 1.0 / F.z + 2.0e5) return false;   // + the largest edge excursion
  }
  return true;
}

RingStream rsInvert(float dr, float dth, float fp, bool wantZ) {
  RingStream st;
  st.da = 0.0; st.J = 1.0; st.tauMod = 1.0; st.zeta = 0.0; st.slope = vec2(0.0); st.daGrad = vec2(0.0);
  if (rsIdentityAt(dr)) {
    st.tauMod = ringStructureTauMod(dr, dth);
    if (wantZ) { vec3 h = ringStructureRelief(dr, dth, fp); st.zeta = h.x; st.slope = h.yz; }
    return st;
  }
  float x = dr;
  vec3 r, z;
  for (int it = 0; it < RS_NEWTON; it++) {
    rsEval(x, dth, fp, false, r, z);
    x -= (x + r.x - dr) / max(1.0 + r.y, 0.2);
  }
  rsEval(x, dth, fp, wantZ, r, z);
  st.da = x - dr;
  st.J = 1.0 / max(1.0 + r.y, uRsJFloor);
  st.tauMod = ringStructureTauMod(x, dth);
  // a'(r, S): da'/dr = J, da'/dS = -J dxi/dS  ->  gradient of da = a' - r
  st.daGrad = vec2(st.J - 1.0, -st.J * r.z);
  // Eulerian slopes: d/dr = J d/da';  d/dS at fixed r = d/dS|a' - (dxi/dS) J d/da'
  st.zeta = z.x;
  st.slope = vec2(z.y * st.J, z.z - r.z * st.J * z.y);
  return st;
}

RingStream ringStream(float dr, float dth, float fp) { return rsInvert(dr, dth, fp, false); }
RingStream ringStreamRelief(float dr, float dth, float fp) { return rsInvert(dr, dth, fp, true); }

// forward map at the Lagrangian offset aL = a' - r0: (xi (m), zeta (m), J)
vec3 ringStreamXi(float aL, float dth, float fp) {
  if (uRsOn < 0.5) return vec3(0.0, ringStructureRelief(aL, dth, fp).x, 1.0);
  vec3 r, z;
  rsEval(aL, dth, fp, true, r, z);
  return vec3(r.x, z.x, 1.0 / max(1.0 + r.y, uRsJFloor));
}

void ringLocalPolar(vec3 l, out float dr, out float dth) {
  dr = ringDrFromLocal(l);
  dth = atan(l.y, uRingR0 + l.x);
}

// Profile sample at level-0 index I + sub (I integer-valued, sub small: e.g. uRsIdx0.y + dr / uRingDr0) with exact
// cell and weight at the finest level. (uRingIdx0 + dr / uRingDr0 rounds to 0.03 cells = 7.8 m at the outer A ring:
// invisible for circular edges, stair-steps along displaced ones.)
RingSample ringSampleIdxPrecise(float I, float sub, float fp) {
  float fi0 = I + sub;
  float nTot = float(uRingLevelN[0]);
  if (fi0 < -0.5 || fi0 > nTot - 0.5) return ringEmpty();
  float lev = clamp(log2(max(fp, uRingDr0) / uRingDr0), 0.0, float(uRingLevels - 1));
  int L0 = int(floor(lev));
  int L1 = min(L0 + 1, uRingLevels - 1);
  float lf = lev - float(L0);
  vec4 a0, b0;
  if (L0 == 0) {
    int n = uRingLevelN[0];
    float fl = floor(sub);
    float ii = I + fl, f = sub - fl;
    if (ii < 0.0) { ii = 0.0; f = 0.0; }
    if (ii >= float(n - 1)) { ii = float(n - 1); f = 0.0; }
    int i0 = int(ii);
    int i1 = min(i0 + 1, n - 1);
    int off = uRingLevelOff[0];
    a0 = mix(texelFetch(uRingTexA, ringTexel(off + i0), 0), texelFetch(uRingTexA, ringTexel(off + i1), 0), f);
    b0 = mix(texelFetch(uRingTexB, ringTexel(off + i0), 0), texelFetch(uRingTexB, ringTexel(off + i1), 0), f);
  } else {
    ringFetchLevel(fi0, L0, a0, b0);
  }
  if (lf > 0.001 && L1 != L0) {
    vec4 a1, b1;
    ringFetchLevel(fi0, L1, a1, b1);
    a0 = mix(a0, a1, lf);
    b0 = mix(b0, b1, lf);
  }
  RingSample s;
  s.tau = a0.x; s.H = a0.y; s.sigma = a0.z; s.wake = a0.w; s.albedo = b0.rgb; s.dust = b0.a;
  return s;
}
// the (unperturbed) profile at the Lagrangian offset aL = a' - r0 (precise)
RingSample ringSampleLagrangian(float aL, float fp) { return ringSampleIdxPrecise(uRsIdx0.x, uRsIdx0.y + aL / uRingDr0, fp); }

// THE main-ring lookup: the profile at the Lagrangian radius, tau and Sigma scaled by J x tauMod. The footprint is
// taken in Lagrangian units (x J: a crowded region maps more material into the same Eulerian footprint).
RingSample ringSampleStream(float dr, float dth, float fp) {
  RingStream st = ringStream(dr, dth, fp);
  RingSample s = ringSampleLagrangian(dr + st.da, fp * st.J);
  float f = st.J * st.tauMod;
  s.tau *= f;
  s.sigma *= f;
  return s;
}
RingSample ringSampleLocal(vec3 l, float fp) {
  float dr, dth;
  ringLocalPolar(l, dr, dth);
  return ringSampleStream(dr, dth, fp);
}
// The same lookup plus the local mid-plane there: rel = (height zeta (m), slope dzeta/dr, dzeta/(r dth), Lagrangian
// offset a' - r0 (m)).
RingSample ringSampleLocalRelief(vec3 l, float fp, out vec4 rel) {
  float dr, dth;
  ringLocalPolar(l, dr, dth);
  RingStream st = ringStreamRelief(dr, dth, fp);
  RingSample s = ringSampleLagrangian(dr + st.da, fp * st.J);
  float f = st.J * st.tauMod;
  s.tau *= f;
  s.sigma *= f;
  rel = vec4(st.zeta, st.slope, dr + st.da);
  return s;
}
// Height of the camera above the local mid-plane (m).
float ringCamHeight() { return uRingCamLocal.z - uRsCam.y; }

// ringSunTransmission (sv_ringProfile) through the 2-D structure: direct-sunlight transmission of the main rings
// (thin sheet) for a camera-relative point p
float ringSunTransmissionStream(vec3 p, float footprint) {
  float zs = p.z + uCamPos.z;
  float sz = uSunDir.z;
  if (abs(sz) < 1e-6 || zs * sz >= 0.0) return 1.0;
  vec3 h = p + (-zs / sz) * uSunDir;
  return exp(-ringSampleLocal(ringLocalFromRel(h), footprint).tau / abs(sz));
}

#endif
