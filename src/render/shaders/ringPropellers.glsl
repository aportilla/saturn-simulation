// ===== sv_ringPropellers =====================================================================
// "Propeller" moonlets embedded in the A ring: their 2-D optical-depth structure (partial gaps, density-enhanced
// lobes, moonlet wakes) and vertical relief. Two of the hooks of sv_ringStructure; included BY that chunk (after
// sv_ringTexture, whose flow model it uses) -- do not include it on its own. Requires sv_common, sv_ringProfile;
// rsTab (the universal moonlet response table) is defined later in sv_ringStructure (prototype below).
// Uniforms, population, CPU mirror: src/rings/propellers.ts; model and sources: docs/ring-physics.md section 11.
//
//   vec3 rsPropellersMod(aL, dth, fp)      (mean tau factor at the footprint, sub-footprint variance, self-gravity-
//                                           wake strength factor: the stirred material carries no wakes)
//   vec2 rsTauModPropellers(aL, dth, fp)   (.xy of the above)
//   vec3 rsReliefPropellers(aL, dth)       (height (m), d/da', d/dS)
//
// Structure of one propeller (moonlet Hill radius h; x = radial offset of the point from the moonlet's orbit, s = its
// arc from the moonlet, prograde > 0; the disturbance is carried downstream: d = -s on the outer side, +s on the
// inner side):
//   M = (1 - D0 L_D(d/dD) G(|x| - 2h; 0.7h) + E(d) G(|x| - 4.5h; sB(d))) x (1 + moonlet wakes)
//   partial gaps (lobes radially 4 h apart, Seiss et al. 2005) with L_D(u) = u e^(1-u); density-enhanced lobes 9 h
//   apart (Sremcevic et al. 2007) holding the gaps' deficit at every d (E sB = D0 L_D 0.7h), widening downstream
//   sB = 0.6 h (1 + d/dB) (their brightness peaks near d ~ dB, the gaps' at dD); moonlet wakes = the streamline
//   density 1/(dr/da') of the universal Hill response (rsTab) for 6 <= |x|/h <= 13 (tapered), truncated after 4
//   lobe separations. Footprint prefilter: the Gaussian lobes are convolved with the footprint (mean preserved), the
//   wakes faded like the gap-edge waves; what is smoothed away is returned as variance.
// Populations: up to RP_GIANTS named giants (Tiscareno et al. 2010, positions from the CPU) and RP_CLASSES
// procedural classes (propeller belts, trans-Encke region) on a hash grid co-moving with each moonlet's own orbit:
// radial cells in mean-motion space (units of 2^-24 revolutions per day), one orbit per cell, azimuthal cells along
// it; integer arithmetic keeps every moonlet's longitude exact and smooth over decades (src/rings/propellers.ts).
#ifndef SV_RING_PROPELLERS
#define SV_RING_PROPELLERS

#define RP_GIANTS 12
#define RP_CLASSES 5
#define RP_D0 0.6
uniform vec4 uRpCtl;             // (on: 1 / 0, K_N = n-units per rad/s, n0 - n_ref (frame origin's rate), f = day fraction)
uniform ivec4 uRpT;              // (k = whole days since J2000, n_ref, P (frame origin's phase in orbit n_ref, 2^-32 turns), dnu)
uniform vec4 uRpTF;              // (P residual (turns, < 2^-32), procedural range lo [m], hi [m] (incl. reach), -)
uniform vec4 uRpG0[RP_GIANTS];   // (a_p - r0 [m], s0 = arc of the frame origin from the moonlet [m], h [m], dB [m])
uniform vec4 uRpG1[RP_GIANTS];   // (gap depth, current height z_m [m], azimuthal reach [m], dD [m])
uniform int uRpGiantN;
uniform vec4 uRpC0[RP_CLASSES];  // (dr_lo [m], 1 - (hi/lo)^-Q, -1/Q, h per dr)
uniform vec4 uRpC1[RP_CLASSES];  // (dB per dr, dD per dr, number density [1/m^2], Z / h)
uniform vec4 uRpC2[RP_CLASSES];  // region: (lo1, hi1, lo2, hi2) [m]
uniform vec4 uRpC3[RP_CLASSES];  // region: (lo3, hi3, edge width [m], h_max [m])
uniform ivec4 uRpCI[RP_CLASSES]; // (N cell [n-units], B (2^B azimuthal cells per orbit), I = floor(n_ref / N), n_ref - I N)
uniform int uRpNearMask;         // bit k: a propeller can reach near-field size class k's particles (nearUpdate.glsl)

vec3 rsTab(int g, float b, float t);   // sv_ringStructure (the universal moonlet response)

float rpU24(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }
// Gaussian of width sg convolved with a Gaussian footprint kernel (std sf): (mean, mean of the square) at offset y
vec2 rpGauss(float y, float sg, float sf) {
  float s1 = sg * sg + sf * sf, s2 = sg * sg + 2.0 * sf * sf;
  return vec2(sg * inversesqrt(s1) * exp(-0.5 * y * y / s1), sg * inversesqrt(s2) * exp(-y * y / s2));
}
float rpLD(float u) { return u > 0.0 ? u * exp(1.0 - u) * (1.0 - smoothstep(4.5, 6.0, u)) : 0.0; }
// one side's lobes at downstream distance d: (deficit mean, deficit var, excess mean, excess var)
vec4 rpLobes(float y, float d, float h, float dB, float dD, float sf, float D0) {
  float L = D0 * rpLD(d / dD);
  if (L <= 0.0) return vec4(0.0);
  vec2 gd = rpGauss(y - 2.0 * h, 0.7 * h, sf);
  float sB = 0.6 * h * (1.0 + max(d, 0.0) / dB);
  float E = L * 0.7 * h / sB;
  vec2 gb = rpGauss(y - 4.5 * h, sB, sf);
  return vec4(L * gd.x, L * L * max(gd.y - gd.x * gd.x, 0.0), E * gb.x, E * E * max(gb.y - gb.x * gb.x, 0.0));
}
// Moonlet wakes: density factor - 1 of the streamline map at |x| = b h, downstream d (Hill table; |x| >= 6 h)
float rpWake(float x, float s, float h, float dB) {
  float b = abs(x) / h;
  float tb = smoothstep(5.5, 6.5, b) * (1.0 - smoothstep(10.0, 13.0, b));
  if (tb <= 0.0) return 0.0;
  float d = x >= 0.0 ? -s : s;
  float td = 1.0 - smoothstep(6.0 * dB, 8.0 * dB, d);
  if (td <= 0.0) return 0.0;
  float t = d / (1.5 * b * h);
  vec3 K = rsTab(0, b, t);
  float ib = 1.0 / b;
  float dxi = K.y * ib * ib - 2.0 * K.x * ib * ib * ib - K.z * ib * ib * t * ib;   // dxi / da'
  return (1.0 / max(1.0 + dxi, 0.2) - 1.0) * tb * td;
}
// One propeller at (x, s): mean factor, sub-footprint variance, and the self-gravity-wake strength factor. The
// material the moonlet stirred up (its partial gaps, the dense lobes and the encounter region around it) has random
// velocities far above the ring's, i.e. Toomre Q >> 2: no self-gravity wakes there (Salo 1995: wakes need Q <~ 2) --
// a homogeneous layer, brighter than the wake-structured ring on the lit face and more opaque on the unlit face (the
// lit-face bright / unlit-face dark wings of the giant propellers, PIA12790 / PIA12791; Tiscareno et al. 2010 sec.
// 2.1). The wakes are kept at 10 % where the disturbance is full.
vec3 rpStructure(float x, float s, float fp, float h, float dB, float dD, float D0) {
  float sf = 0.5 * fp;
  float wo = smoothstep(-0.5 * h, 0.5 * h, x);
  float gaz = dB / sqrt(dB * dB + fp * fp);   // azimuthal footprint averaging (crude)
  vec4 lo = wo > 0.0 ? rpLobes(x, -s, h, dB, dD, sf, D0) : vec4(0.0);
  vec4 li = wo < 1.0 ? rpLobes(-x, s, h, dB, dD, sf, D0) : vec4(0.0);
  vec4 l = (wo * lo + (1.0 - wo) * li) * vec4(gaz, gaz * gaz, gaz, gaz * gaz);
  float m = max(1.0 - l.x + l.z, 0.02);
  float v = l.y + l.w;
  // disturbance 0..1: the gaps (deficit / D0), the dense lobes (excess / its peak 0.433 D0), the encounter region
  float sn = 1.5 * h + sf;
  float near = exp(-0.5 * (x * x + s * s) / (sn * sn)) * (1.5 * h / sn) * gaz;
  float dist = clamp(l.x / max(D0, 1e-3) + l.z / max(0.433 * D0, 1e-3) + near, 0.0, 1.0);
  float w = rpWake(x, s, h, dB);
  if (w != 0.0) {
    float fw = 1.0 - smoothstep(0.3 * h, 1.5 * h, fp);
    v += (1.0 - fw * fw) * w * w * m * m;
    m *= max(1.0 + fw * w, 0.02);
  }
  return vec3(m, v, 1.0 - 0.9 * dist);
}
// Vertical relief: the excited material follows the moonlet's height z_m (Hoffmann et al. 2013, 2015), decaying away
// from it (radially over 2.5 h, downstream over dB, upstream over 2 h). (height, d/dx, d/ds)
vec3 rpRelief(float x, float s, float h, float dB, float zm) {
  if (zm == 0.0) return vec3(0.0);
  float sr = 2.5 * h;
  float G = exp(-0.5 * x * x / (sr * sr));
  float wo = smoothstep(-0.5 * h, 0.5 * h, x);
  float dwo = (abs(x) < 0.5 * h) ? 6.0 * (x / h + 0.5) * (0.5 - x / h) / h : 0.0;
  // Lz(d) and dLz/dd for the outer side (d = -s) and the inner side (d = s)
  float dO = -s, dI = s;
  float LO = dO >= 0.0 ? exp(-dO / dB) : exp(dO / (2.0 * h));
  float LI = dI >= 0.0 ? exp(-dI / dB) : exp(dI / (2.0 * h));
  float LOd = dO >= 0.0 ? -LO / dB : LO / (2.0 * h);
  float LId = dI >= 0.0 ? -LI / dB : LI / (2.0 * h);
  float L = wo * LO + (1.0 - wo) * LI;
  float z = zm * G * L;
  float dzdx = zm * (-x / (sr * sr) * G * L + G * dwo * (LO - LI));
  float dzds = zm * G * (-wo * LOd + (1.0 - wo) * LId);
  return vec3(z, dzdx, dzds);
}

// smooth radial window of a procedural class (its propeller belts / region), 0..1
float rpRegion(int c, float a) {
  vec4 R2 = uRpC2[c], R3 = uRpC3[c];
  float e = max(R3.z, 1.0);
  float w = smoothstep(R2.x - e, R2.x + e, a) * (1.0 - smoothstep(R2.y - e, R2.y + e, a));
  if (R2.w > R2.z) w += smoothstep(R2.z - e, R2.z + e, a) * (1.0 - smoothstep(R2.w - e, R2.w + e, a));
  if (R3.y > R3.x) w += smoothstep(R3.x - e, R3.x + e, a) * (1.0 - smoothstep(R3.y - e, R3.y + e, a));
  return min(w, 1.0);
}

// Enumerate the propellers near (aL, dth): mode 0 accumulates the tau factor and the wake factor (acc.xyz = mean,
// variance, wake-strength factor), mode 1 the relief (acc.xyz = height, d/da', d/dS).
void rpEnumerate(float aL, float dth, float fp, int mode, inout vec4 acc) {
  // ---- named giants (positions from the CPU, double precision)
  for (int k = 0; k < RP_GIANTS; k++) {
    if (k >= uRpGiantN) break;
    vec4 G0 = uRpG0[k], G1 = uRpG1[k];
    float h = G0.z;
    float x = aL - G0.x;
    if (abs(x) > 13.5 * h) continue;
    float ap = uRingR0 + G0.x;
    float s = G0.y + ap * dth;
    float hc = PI * ap;
    if (abs(s) > hc) s -= 2.0 * hc * floor(s / (2.0 * hc) + 0.5);
    if (abs(s) > G1.z) continue;
    if (mode == 0) {
      vec3 p = rpStructure(x, s, fp, h, G0.w, G1.w, G1.x);
      acc.y = acc.y * p.x * p.x + p.y * acc.x * acc.x + acc.y * p.y;
      acc.x *= p.x;
      acc.z = min(acc.z, p.z);
    } else {
      acc.xyz += rpRelief(x, s, h, G0.w, G1.y);
    }
  }
  // ---- procedural populations: hash grid co-moving with each orbit
  float a = uRingR0 + aL;
  if (!(a > uRpTF.y && a < uRpTF.z)) return;
  float dnq = uRpCtl.z + uRpCtl.y * rtDeltaOmega(aL);       // rate of the query's orbit - n_ref (n-units)
  float dnda = uRpCtl.y * rtOmegaSlope(aL);                  // |dn/da| (n-units per m)
  uint kday = uint(uRpT.x);
  for (int c = 0; c < RP_CLASSES; c++) {
    ivec4 CI = uRpCI[c];
    if (CI.x <= 0) continue;
    vec4 C0 = uRpC0[c], C1 = uRpC1[c], C3 = uRpC3[c];
    float hmax = C3.w;
    float cf = 1.0 - smoothstep(8.0 * hmax, 16.0 * hmax, fp);  // whole class below the footprint
    if (cf <= 0.0) continue;
    // no orbit of this class within reach has region weight > 0 (windows are >> the reach wide)
    float reachR = 13.5 * hmax;
    if (rpRegion(c, a - reachR) <= 0.0 && rpRegion(c, a) <= 0.0 && rpRegion(c, a + reachR) <= 0.0) continue;
    uint salt = uint(c + 1) * 0x6C8E9CF5u;
    int B = CI.y;
    float Nc = float(CI.x);
    float cpos = (float(CI.w) + dnq) / Nc;
    int i0 = int(floor(cpos));
    for (int di = -1; di <= 1; di++) {
      int ic = i0 + di;
      uint hR = pcgHash(uint(CI.z + ic) * 0x9E3779B1u ^ salt);
      int dni = ic * CI.x + int(hR % uint(CI.x)) - CI.w;         // n_i - n_ref (exact)
      float x = (float(dni) - dnq) / dnda;                        // query - orbit (m), outward > 0
      if (abs(x) > reachR) continue;
      float ai = a - x;
      // expected number per azimuthal cell of this orbit: density x region x cell area at the orbit
      float pc = C1.z * rpRegion(c, ai) * (Nc / dnda) * (TWO_PI * ai / exp2(float(B)));
      if (pc <= 0.0) continue;
      // the query's phase in this orbit's co-moving frame (2^-32 turns): P + dth/2pi - n_i (k + f) / 2^24
      uint t1 = (uint(dni) * kday) & 0xFFFFFFu;
      float fr = dth * (1.0 / TWO_PI) - float(dni) * uRpCtl.w * (1.0 / 16777216.0) + uRpTF.x;
      fr -= floor(fr + 0.5);
      float frs = fr * 4294967296.0;
      float fi = floor(frs + 0.5);
      float rem = frs - fi;
      uint U = uint(uRpT.z) + uint(int(fi)) - (t1 << 8u);
      uint jq0 = U >> uint(32 - B);
      float arc = TWO_PI * ai / 4294967296.0;                     // m per 2^-32 turns
      for (int dj = -1; dj <= 1; dj++) {
        uint jc = (jq0 + uint(dj)) & ((1u << uint(B)) - 1u);
        uint hC = pcgHash(hR ^ (jc * 0x85EBCA77u) ^ 0x27D4EB2Fu);
        if (rpU24(pcgHash(hC ^ 0x165667B1u)) >= pc) continue;
        uint phi = (jc << uint(32 - B)) | (pcgHash(hC ^ 0xD3A2646Cu) >> uint(B));
        float s = (rem - float(int(phi - U))) * arc;              // query arc from the moonlet
        float dr = C0.x * pow(1.0 - rpU24(pcgHash(hC ^ 0xFD7046C5u)) * C0.y, C0.z);
        float h = dr * C0.w;
        if (abs(x) > 13.5 * h) continue;
        float dB = dr * C1.x, dD = dr * C1.y;
        if (abs(s) > 6.0 * dD) continue;
        if (mode == 0) {
          vec3 p = rpStructure(x, s, fp, h, dB, dD, RP_D0);
          p = vec3(1.0 + cf * (p.x - 1.0), cf * cf * p.y, 1.0 + cf * (p.z - 1.0));
          acc.y = acc.y * p.x * p.x + p.y * acc.x * acc.x + acc.y * p.y;
          acc.x *= p.x;
          acc.z = min(acc.z, p.z);
        } else {
          // the moonlet's height: vertical phase advancing at its vertical frequency
          uint nz = uint(uRpT.y + dni + uRpT.w);
          float ph = rpU24(pcgHash(hC ^ 0xB55A4F09u)) + float((nz * kday) & 0xFFFFFFu) * (1.0 / 16777216.0)
            + float(nz) * (1.0 / 16777216.0) * uRpCtl.w;
          float zm = C1.w * h * cos(TWO_PI * fract(ph));
          acc.xyz += rpRelief(x, s, h, dB, zm);
        }
      }
    }
  }
}

// (mean tau factor, its sub-footprint variance, self-gravity-wake strength factor)
vec3 rsPropellersMod(float aL, float dth, float fp) {
  if (uRpCtl.x <= 0.0) return vec3(1.0, 0.0, 1.0);
  vec4 acc = vec4(1.0, 0.0, 1.0, 0.0);
  rpEnumerate(aL, dth, fp, 0, acc);
  return acc.xyz;
}
vec2 rsTauModPropellers(float aL, float dth, float fp) { return rsPropellersMod(aL, dth, fp).xy; }
vec3 rsReliefPropellers(float aL, float dth) {
  if (uRpCtl.x <= 0.0) return vec3(0.0);
  vec4 acc = vec4(0.0);
  rpEnumerate(aL, dth, 0.0, 1, acc);
  return acc.xyz;
}

#endif
