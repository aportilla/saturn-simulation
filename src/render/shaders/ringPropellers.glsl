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
//   vec3 rsReliefPropellers(aL, dth, fp)   (height (m), d/da', d/dS) prefiltered to fp -- part of z0
//   float rpReliefBound(aL, fp, proc)      upper bound of |height| near aL (giants; + procedural classes if proc)
//   float rpReliefSunVis(aL, dth, hs, cr, ct, tanB, rs, sg, fp)   sun visibility after the relief's shadows
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
uniform ivec4 uRpT;              // (k = whole days since J2000, n_ref, P (frame origin's phase in orbit n_ref, 2^-32 turns), -)
uniform vec4 uRpTF;              // (P residual (turns, < 2^-32), procedural range lo [m], hi [m] (incl. reach), -)
uniform vec4 uRpG0[RP_GIANTS];   // (a_p - r0 [m], s0 = arc of the frame origin from the moonlet [m], h [m], dB [m])
uniform vec4 uRpG1[RP_GIANTS];   // (gap depth, relief height z_m [m] (signed: the Sun's side), azimuthal reach [m], dD [m])
uniform int uRpGiantN;
uniform vec4 uRpC0[RP_CLASSES];  // (dr_lo [m], 1 - (hi/lo)^-Q, -1/Q, h per dr)
uniform vec4 uRpC1[RP_CLASSES];  // (dB per dr, dD per dr, number density [1/m^2], Z / h x the Sun's side x relief scale)
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
// Vertical relief: the moonlet's gravity pulls the stirred material out of the ring plane (Tiscareno et al. 2010: the
// equinox shadows are cast by the structure as a whole, at the same height on three epochs for Bleriot; a thickening
// of the layer that decays downstream, Hoffmann et al. 2013). Of that symmetric thickening the single mid-plane height
// carries the sunlit half (as region A, sv_ringRelief): z_m = sign(Sun's elevation) Z (uRpG1.y, uRpC1.w h), decaying
// away from the moonlet (radially over 2.5 h, downstream over dB, upstream over 2 h). Prefiltered to the footprint fp like the lobes:
// the radial Gaussian convolved with the footprint kernel (std sf = fp / 2, mean preserving: sigma^2 -> sigma^2 + sf^2,
// amplitude x sigma / sqrt(..)), the along-orbit profile damped by dB / sqrt(dB^2 + fp^2) (rpStructure's gaz).
// rpReliefAmp = the amplitude factor (<= 1); rpRelief = (height, d/dx, d/ds).
float rpReliefAmp(float h, float dB, float fp) {
  float sr = 2.5 * h, sf = 0.5 * fp;
  return sr * inversesqrt(sr * sr + sf * sf) * dB * inversesqrt(dB * dB + fp * fp);
}
vec3 rpRelief(float x, float s, float h, float dB, float zm, float fp) {
  if (zm == 0.0) return vec3(0.0);
  float sr = 2.5 * h, sf = 0.5 * fp;
  float s2 = sr * sr + sf * sf;
  float A = zm * rpReliefAmp(h, dB, fp);
  float G = exp(-0.5 * x * x / s2);
  // the blend of the two sides across the horseshoe zone (|x| < 2 h: that material turns around in front of / behind
  // the moonlet, so the stirred side meets the undisturbed one without a step; the tau structure's S keeps its h / 2)
  // and the short upstream rise (2 h), both widened with the footprint (no sub-pixel kinks: they aliased into dotted
  // lines at a few km per pixel and steps narrower than the sheet's 250 m hit-search spacing were missed)
  float wb = sqrt(4.0 * h * h + sf * sf), up = sqrt(4.0 * h * h + fp * fp);
  float wo = smoothstep(-wb, wb, x);
  float dwo = (abs(x) < wb) ? 0.75 * (x / wb + 1.0) * (1.0 - x / wb) / wb : 0.0;
  // Lz(d) and dLz/dd for the outer side (d = -s) and the inner side (d = s)
  float dO = -s, dI = s;
  float LO = dO >= 0.0 ? exp(-dO / dB) : exp(dO / up);
  float LI = dI >= 0.0 ? exp(-dI / dB) : exp(dI / up);
  float LOd = dO >= 0.0 ? -LO / dB : LO / up;
  float LId = dI >= 0.0 ? -LI / dB : LI / up;
  float L = wo * LO + (1.0 - wo) * LI;
  float z = A * G * L;
  float dzdx = A * (-x / s2 * G * L + G * dwo * (LO - LI));
  float dzds = A * G * (-wo * LOd + (1.0 - wo) * LId);
  return vec3(z, dzdx, dzds);
}
// Relief shadows (mode 2 of rpEnumerate): one propeller's excited region as an opaque Gaussian ridge (radial sigma of
// the prefiltered relief, 0.6 dB along the orbit -- the half-height length of its downstream decay; symmetric about the
// moonlet: the S shape is not resolved by the shadow) at its sun-side height. Inputs set by rpReliefSunVis:
// gRpSun0 = (cos, sin of the sun's horizontal direction in the point's radial / azimuthal axes, elevation, angular
// radius), gRpSun1 = (lowest limb's slope, the point's sun-side height, the sign of the Sun's elevation, radius of the
// point).
vec4 gRpSun0 = vec4(0.0), gRpSun1 = vec4(0.0);
// the procedural propellers' relief in mode 1 (off: the giants' only)
bool gRpProcRelief = true;
float rpShadowVis(float x, float s, float a, float h, float dB, float zm, float fp) {
  float hz = gRpSun1.z * zm * rpReliefAmp(h, dB, fp);
  if (hz <= gRpSun1.y) return 1.0;
  float sr = 2.5 * h, sf = 0.5 * fp;
  return 1.0 - rrPeakOcc(-x, -s / a, hz, sqrt(sr * sr + sf * sf), 0.6 * dB, gRpSun1.w, gRpSun1.y, gRpSun0.x, gRpSun0.y,
                         gRpSun0.z, gRpSun0.w, gRpSun1.x, fp);
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

// The procedural propellers whose relief a lookup (modes 1 / 3) found at the point gRpListKey = (aL, dth): their
// shadows on that point (rpReliefSunVis, at its own footprint) need no second enumeration. (x, s, orbit radius, h),
// (dB, zm at the lookup's footprint); -1: overflow.
#define RP_LIST_MAX 6
vec4 gRpList0[RP_LIST_MAX];
vec2 gRpList1[RP_LIST_MAX];
int gRpListN = -1;
vec2 gRpListKey = vec2(1e30);
// mode 3 (the tau factor and the relief in one pass): the relief, for rsReliefPropellers at gRpRelKey
vec3 gRpRel = vec3(0.0);
vec3 gRpRelKey = vec3(1e30);
bool gRpAlsoRelief = false;
// the propellers' relief is on (propellers on and the relief multiplier, which scales every class's Z / h, not 0)
bool rpReliefOn() { return uRpCtl.x > 0.0 && uRpC1[0].w != 0.0; }

// Enumerate the propellers near (aL, dth): mode 0 accumulates the tau factor and the wake factor (acc.xyz = mean,
// variance, wake-strength factor), mode 1 the relief (acc.xyz = height, d/da', d/dS), mode 2 the sun visibility after
// the procedural propellers' relief shadows (acc.x; the giants' shadows: rpReliefSunVis, with a longer reach), mode 3
// modes 0 and 1 in one pass (the relief into gRpRel). Modes 1 and 3 also list the procedural propellers they find.
void rpEnumerate(float aL, float dth, float fp, int mode, inout vec4 acc) {
  bool doMod = mode == 0 || mode == 3, doRel = mode == 1 || mode == 3;
  // (a lookup without the procedural propellers -- the ray-surface search -- leaves no list: -1 = enumerate)
  if (doRel) { gRpListN = (mode == 1 && !gRpProcRelief) ? -1 : 0; gRpListKey = vec2(aL, dth); }
  bool overflow = false;
  // ---- named giants (positions from the CPU, double precision)
  for (int k = 0; k < RP_GIANTS; k++) {
    if (mode == 2 || k >= uRpGiantN) break;
    vec4 G0 = uRpG0[k], G1 = uRpG1[k];
    float h = G0.z;
    float x = aL - G0.x;
    if (abs(x) > 13.5 * h) continue;
    float ap = uRingR0 + G0.x;
    float s = G0.y + ap * dth;
    float hc = PI * ap;
    if (abs(s) > hc) s -= 2.0 * hc * floor(s / (2.0 * hc) + 0.5);
    if (abs(s) > G1.z) continue;
    if (doMod) {
      vec3 p = rpStructure(x, s, fp, h, G0.w, G1.w, G1.x);
      acc.y = acc.y * p.x * p.x + p.y * acc.x * acc.x + acc.y * p.y;
      acc.x *= p.x;
      acc.z = min(acc.z, p.z);
    }
    if (mode == 1) acc.xyz += rpRelief(x, s, h, G0.w, G1.y, fp);
    else if (mode == 3) gRpRel += rpRelief(x, s, h, G0.w, G1.y, fp);
  }
  // ---- procedural populations: hash grid co-moving with each orbit (the relief: unless gRpProcRelief is off -- the
  // sheet's ray-surface search, sv_ringReliefShade)
  float a = uRingR0 + aL;
  if (!(a > uRpTF.y && a < uRpTF.z) || (mode == 1 && !gRpProcRelief)) return;
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
    // the class's largest prefiltered relief: below 0.5 m it is left out of z0 (CPU mirror: the same rule); its
    // shadows where even the longest is shorter than half the footprint
    bool relC = false;
    if (mode != 0) {
      float zc = cf * abs(C1.w) * hmax * rpReliefAmp(hmax, C1.x * hmax / C0.w, fp);
      relC = zc >= 0.5 && (mode != 2 || zc >= 0.5 * fp * gRpSun1.x);
      if (!relC && mode != 3) continue;
    }
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
        if (doMod) {
          vec3 p = rpStructure(x, s, fp, h, dB, dD, RP_D0);
          p = vec3(1.0 + cf * (p.x - 1.0), cf * cf * p.y, 1.0 + cf * (p.z - 1.0));
          acc.y = acc.y * p.x * p.x + p.y * acc.x * acc.x + acc.y * p.y;
          acc.x *= p.x;
          acc.z = min(acc.z, p.z);
        }
        if (relC) {
          // the excited region's height (its sunlit half: C1.w carries the Sun's side; faded with the class)
          float zm = cf * C1.w * h;
          if (mode == 2) acc.x *= rpShadowVis(x, s, ai, h, dB, zm, fp);
          else {
            vec3 rv = rpRelief(x, s, h, dB, zm, fp);
            if (mode == 1) acc.xyz += rv;
            else gRpRel += rv;
            if (gRpListN < RP_LIST_MAX) {
              gRpList0[gRpListN] = vec4(x, s, ai, h);
              gRpList1[gRpListN] = vec2(dB, zm);
              gRpListN++;
            } else overflow = true;
          }
        }
      }
    }
  }
  if (overflow) gRpListN = -1;
}

// (mean tau factor, its sub-footprint variance, self-gravity-wake strength factor); with gRpAlsoRelief (set by
// sv_ringStructure rsInvert when it needs the relief at the same point) the relief in the same pass (gRpRel)
vec3 rsPropellersMod(float aL, float dth, float fp) {
  if (uRpCtl.x <= 0.0) return vec3(1.0, 0.0, 1.0);
  vec4 acc = vec4(1.0, 0.0, 1.0, 0.0);
  if (gRpAlsoRelief && rpReliefOn()) {
    gRpRel = vec3(0.0);
    rpEnumerate(aL, dth, fp, 3, acc);
    gRpRelKey = vec3(aL, dth, fp);
    return acc.xyz;
  }
  rpEnumerate(aL, dth, fp, 0, acc);
  return acc.xyz;
}
vec2 rsTauModPropellers(float aL, float dth, float fp) { return rsPropellersMod(aL, dth, fp).xy; }
// (height, d/da', d/dS) of the propellers' relief at the footprint fp (part of z0: sv_ringStructure ringStructureRelief)
vec3 rsReliefPropellers(float aL, float dth, float fp) {
  if (!rpReliefOn()) return vec3(0.0);
  if (gRpRelKey == vec3(aL, dth, fp) && gRpProcRelief) return gRpRel;   // computed with the tau factor (mode 3)
  vec4 acc = vec4(0.0);
  rpEnumerate(aL, dth, fp, 1, acc);
  return acc.xyz;
}
// Upper bound of |height| of the propellers' relief near the offset aL (m) at footprint fp: the giants within their
// radial reach (+ 3 km: Pan's streamline map may move the material near Earhart / Post), plus (proc) each procedural
// class whose region is within reach (its largest moonlet's amplitude, prefiltered).
float rpReliefBound(float aL, float fp, bool proc) {
  if (!rpReliefOn()) return 0.0;
  float bg = 0.0;
  for (int k = 0; k < RP_GIANTS; k++) {
    if (k >= uRpGiantN) break;
    vec4 G0 = uRpG0[k];
    if (abs(aL - G0.x) > 13.5 * G0.z + 3000.0) continue;
    bg = max(bg, abs(uRpG1[k].y) * rpReliefAmp(G0.z, G0.w, fp));
  }
  float bc = 0.0;
  float a = uRingR0 + aL;
  if (proc && a > uRpTF.y && a < uRpTF.z) {
    for (int c = 0; c < RP_CLASSES; c++) {
      if (uRpCI[c].x <= 0) continue;
      float hmax = uRpC3[c].w;
      float cf = 1.0 - smoothstep(8.0 * hmax, 16.0 * hmax, fp);
      if (cf <= 0.0) continue;
      float reachR = 13.5 * hmax;
      if (rpRegion(c, a - reachR) <= 0.0 && rpRegion(c, a) <= 0.0 && rpRegion(c, a + reachR) <= 0.0) continue;
      bc += cf * abs(uRpC1[c].w) * hmax * rpReliefAmp(hmax, uRpC1[c].x * hmax / uRpC0[c].w, fp);
    }
  }
  return bg + bc;
}
// Sun visibility at a point (Lagrangian offset aL, azimuth offset dth, sun-side height hs) after the propellers'
// relief shadows; (cr, ct) = the sun's horizontal direction in the point's radial / azimuthal axes, tanB its elevation
// tangent (mirrored to the lit side: sg = sign of the Sun's elevation), rs its angular radius, fp the footprint. The
// giants with a reach extended by their shadow length; the procedural propellers whose structure reaches the point
// (their 3 x 3 hash cells; shadows longer than ~13 r_H -- the Sun within ~2 deg of the ring plane -- are cut there).
float rpReliefSunVis(float aL, float dth, float hs, float cr, float ct, float tanB, float rs, float sg, float fp) {
  if (!rpReliefOn()) return 1.0;
  float tanLo = max(tan(atan(tanB) - rs), 2e-5);
  float a = uRingR0 + aL;
  gRpSun0 = vec4(cr, ct, atan(tanB), rs);
  gRpSun1 = vec4(tanLo, hs, sg, a);
  float vis = 1.0;
  for (int k = 0; k < RP_GIANTS; k++) {
    if (k >= uRpGiantN) break;
    vec4 G0 = uRpG0[k], G1 = uRpG1[k];
    float h = G0.z, zm = G1.y;
    if (sg * zm <= hs) continue;
    float L = (sg * zm - hs) / tanLo;                     // the longest shadow
    float x = aL - G0.x;
    if (abs(x) > 7.5 * h + 0.5 * fp + L) continue;
    float ap = uRingR0 + G0.x;
    float s = G0.y + ap * dth;
    float hc = PI * ap;
    if (abs(s) > hc) s -= 2.0 * hc * floor(s / (2.0 * hc) + 0.5);
    if (abs(s) > 2.0 * G0.w + L) continue;
    vis *= rpShadowVis(x, s, ap, h, G0.w, zm, fp);
  }
  if (a > uRpTF.y && a < uRpTF.z) {
    if (gRpListN >= 0 && abs(aL - gRpListKey.x) < 0.01 && abs(dth - gRpListKey.y) < 1e-10) {
      // the propellers the relief lookup at this very point found (rsReliefPropellers): no second enumeration (the
      // callers recompute (aL, dth) from the same position: equal up to rounding -- 1 cm / 1e-10 rad tolerance; the
      // list's membership changes only at the reach, where a propeller's shadow is ~0)
      for (int j = 0; j < RP_LIST_MAX; j++) {
        if (j >= gRpListN) break;
        vec4 P = gRpList0[j];
        vec2 Q = gRpList1[j];
        if (gRpSun1.z * Q.y * rpReliefAmp(P.w, Q.x, fp) < 0.5 * fp * tanLo) continue;   // shadow below half a footprint
        vis *= rpShadowVis(P.x, P.y, P.z, P.w, Q.x, Q.y, fp);
      }
    } else {
      vec4 acc = vec4(1.0, 0.0, 0.0, 0.0);
      rpEnumerate(aL, dth, fp, 2, acc);
      vis *= acc.x;
    }
  }
  return vis;
}

#endif
