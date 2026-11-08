// ===== ring layer: main ========================================================================
// hdr = scene * T + L along each pixel ray, integrated only up to the opaque scene distance.
// Layers, composited back to front: E ring (behind the ring plane), main-ring layer (near-field march
// and/or far-field thin sheet, plus the G / Janus-Epimetheus sheets in the same plane), F ring (its own
// inclined plane), E ring (in front of the ring plane).
//
// Variants (preprocessor):
//   RL_LOWRES   half-resolution near-field march: one ray per 2x2 block (block centre), marching the
//               whole slab segment up to the farthest scene distance in the block. Output (L, T), with
//               T encoded as -1-T if the march was clipped by a scene object, 2 where no march applies.
//   RL_USE_LOW  full-resolution pass using the half-res march: pixels whose opaque scene object lies
//               INSIDE the slab segment (near-field particles) march themselves (short: they stop at the
//               object); all others take a depth-validated bilinear upsample of the blocks that marched
//               the full segment.

uniform sampler2D tScene;
uniform sampler2D tLow;
uniform int uRlDebug;
uniform float uRlLodRange;    // distance within which near-field particles may be drawn (0 = inactive)
uniform float uRlNearOn;      // 1: near-field march allowed
uniform float uRlUseLow;      // 1: the half-resolution march (tLow) is valid this frame
in vec2 vUv;
layout(location = 0) out vec4 outColor;

// ray segment inside the E-ring volume (cylinder r < R, slab |z| < Z), camera at o (Saturn-relative)
vec2 rlESegment(vec3 rd) {
  vec3 o = -uSaturnCenter;
  float R = uRlE.w;
  float Z = 3.0 * rlEH(R);
  float s0 = 0.0, s1 = 1e30;
  if (abs(rd.z) > 1e-12) {
    float a = (-Z - o.z) / rd.z, b = (Z - o.z) / rd.z;
    s0 = max(s0, min(a, b));
    s1 = min(s1, max(a, b));
  } else if (abs(o.z) > Z) return vec2(1.0, 0.0);
  vec2 d = rd.xy;
  float A = dot(d, d);
  if (A > 1e-18) {
    float B = dot(o.xy, d), C = dot(o.xy, o.xy) - R * R;
    float disc = B * B - A * C;
    if (disc < 0.0) return vec2(1.0, 0.0);
    float sq = sqrt(disc);
    s0 = max(s0, (-B - sq) / A);
    s1 = min(s1, (-B + sq) / A);
  } else if (dot(o.xy, o.xy) > R * R) return vec2(1.0, 0.0);
  return vec2(s0, s1);
}

vec3 rlFalse(float x) {
  x = clamp(x, 0.0, 1.0);
  return clamp(vec3(1.5 * x, 1.5 * x - 0.4, 3.0 * x - 2.0) + vec3(0.0, 0.0, 0.3 * (1.0 - x)), 0.0, 1.0);
}

// Slab segment [sA, sB] of the main-ring particle layer along rd (sBns: end ignoring the scene), and the
// weight wM of the near-field march vs the far-field thin sheet for this ray.
void rlSlabSegment(vec3 rd, float sd, out float sA, out float sB, out float sBns, out float wM, out bool inside) {
  float zc = uRingCamLocal.z;
  float zs = ringSlabHalfThickness(uRlHSlab);
  inside = abs(zc) < zs;
  sA = 0.0;
  sB = -1.0;
  if (inside) {
    sB = abs(rd.z) > 1e-12 ? ((rd.z > 0.0 ? zs : -zs) - zc) / rd.z : 1e30;
  } else if (rd.z * zc < 0.0) {
    sA = (abs(zc) - zs) / abs(rd.z);
    sB = (abs(zc) + zs) / abs(rd.z);
  }
  sB = min(sB, uRlMarchMax);
  // clip to the main-ring annulus (r < 139,500 km)
  vec3 o = -uSaturnCenter;
  vec2 d2 = rd.xy;
  float A = dot(d2, d2);
  float Rm = 1.395e8;
  if (A > 1e-18) {
    float B = dot(o.xy, d2), C = dot(o.xy, o.xy) - Rm * Rm;
    float disc = B * B - A * C;
    if (disc < 0.0) sB = -1.0;
    else {
      float sq = sqrt(disc);
      sA = max(sA, (-B - sq) / A);
      sB = min(sB, (-B + sq) / A);
    }
  }
  sBns = sB;
  sB = min(sB, sd);
  wM = 0.0;
  if (uRlNearOn > 0.5 && sBns > sA) {
    if (inside) wM = 1.0;
    else {
      float sMid = abs(zc / rd.z);
      // footprint of the march that produces this pixel (2x for the half-resolution march)
      float fpH = sMid * uPixelAngle * (uRlUseLow > 0.5 ? 2.0 : 1.0);
      // handover over 5 -> 2.5 px per wake spacing: completes before the march's contrast fade begins
      float wW = uRlWakeLevels > 0 ? smoothstep(2.5, 5.0, uRlLambda / max(fpH, 1e-6)) : 0.0;
      // near-field particle range: blend march -> sheet over the last quarter of the range (the sheet
      // carries sigma_unres there too, see main(), so the LOD contract holds across the band)
      float wL = uRlLodRange > 0.0 ? 1.0 - smoothstep(0.75 * uRlLodRange, uRlLodRange, sMid) : 0.0;
      wM = max(wW, wL);
    }
  }
}

float rlJitter(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

#ifdef RL_LOWRES
void main() {
  ivec2 lp = ivec2(gl_FragCoord.xy);
  ivec2 f0 = lp * 2;
  ivec2 fmax = ivec2(uResolution) - 1;
  float sd = 0.0;
  for (int j = 0; j < 2; j++)
    for (int i = 0; i < 2; i++) sd = max(sd, texelFetch(tScene, min(f0 + ivec2(i, j), fmax), 0).a);
  vec2 uv = (vec2(f0) + 1.0) / uResolution;
  vec3 rd = cameraRayDir(uv);
  float sA, sB, sBns, wM;
  bool inside;
  rlSlabSegment(rd, sd, sA, sB, sBns, wM, inside);
  if (wM <= 0.0 || sB <= sA) { outColor = vec4(0.0, 0.0, 0.0, sB <= sA && wM > 0.0 ? 1.0 : 2.0); return; }
  vec3 L;
  float T, steps;
  rlMarch(rd, sA, sB, rlJitter(vec2(lp)), L, T, steps);
  outColor = vec4(L, sd >= sBns ? T : -1.0 - T);
}
#else
void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  vec4 sc = texelFetch(tScene, pix, 0);
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 rd = cameraRayDir(uv);
  float sd = sc.a;
  float jit = rlJitter(gl_FragCoord.xy);
  vec3 col = sc.rgb;

  // ---------------------------------------------------------------- main-ring plane / slab
  float zc = uRingCamLocal.z;
  float tP = abs(rd.z) > 1e-12 ? -zc / rd.z : -1.0;
  bool hitP = tP > 0.0 && tP < sd;
  // a scene object inside the particle layer (a near-field particle) is seen through the part of the layer
  // between it and the camera, not all-or-nothing at the midplane (that made particles in front of the
  // midplane unattenuated and the sheet regime with particles ~2-3 % darker than the march at grazing view)
  float zObj = zc + rd.z * sd;
  bool objIn = tP > 0.0 && sd < 1e29 && abs(zObj) < ringSlabHalfThickness(uRlHSlab);
  float sA, sB, sBns, wM;
  bool inside;
  rlSlabSegment(rd, sd, sA, sB, sBns, wM, inside);

  // plane hit geometry (analytic layer + G rings)
  vec3 Lp = vec3(0.0);
  float Tp = 1.0;
  float tauHit = 0.0, steps = 0.0, fpHit = 0.0, rHit = 0.0, thHit = 0.0;
  float tOrder = hitP ? tP : (objIn ? sd : (wM > 0.0 ? sA : 1e30));
  if ((hitP || objIn) && wM < 1.0) {
    vec3 p = rd * tP;
    vec3 l = ringLocalFromRel(p);
    float dr = ringDrFromLocal(l);
    float theta = uRlPhi0 + atan(l.y, uRingR0 + l.x);
    float fp = rlFootprint(rd, tP, p);
    fpHit = fp;
    float r = uRingR0 + dr;
    rHit = r;
    thHit = theta;
    vec3 La;
    float Ta;
    if (r < 1.4e8) {
      // LOD contract: where near-field particles are drawn the sheet carries only the optical depth they do
      // not, 1 - sum_k tauFrac_k carry_k (the column share: carry is constant across the thin slab crossing,
      // so this equals the march's integral of sigma_unres). carry decreases with distance and is < 0.5 % of
      // tau at uRlLodRange, so stopping at 1.2x the range is invisible.
      float unres = 1.0;
      if (uRlLodRange > 0.0 && tP < 1.2 * uRlLodRange) {
        float carried = 0.0;
        for (int k = 0; k < LOD_CLASSES; k++) carried += uLodTauFrac[k] * lodCarry(uLodAEff[k], k, tP, -zc);
        unres = clamp(1.0 - carried, 0.0, 1.0);
      }
      rlMainSheet(rd, p, dr, theta, fp, unres, La, Ta, tauHit);
      if (objIn) {
        // share of the layer's column between the camera's side and the object (same vertical model as the
        // particles: anchor thickness), transmission and emission of that part
        float q = rlExt(zObj, max(uLodH, 0.1), sd).z;
        float fr = clamp(zc > 0.0 ? q : 1.0 - q, 0.0, 1.0);
        float Tf = pow(max(Ta, 1e-6), fr);
        La *= 1.0 - Ta > 1e-4 ? (1.0 - Tf) / (1.0 - Ta) : fr;
        Ta = Tf;
      }
    } else if (hitP) {
      rlGRings(rd, p, r, theta, fp, La, Ta);
    } else {
      La = vec3(0.0);
      Ta = 1.0;
    }
    Lp = La;
    Tp = Ta;
  }
  if (wM > 0.0 && sB > sA) {
    vec3 Lm = vec3(0.0);
    float Tm = 1.0;
    bool own = true;
#ifdef RL_USE_LOW
    if (uRlUseLow > 0.5 && sd >= sBns) {
      // depth-validated bilinear upsample of the blocks that marched the whole segment
      vec2 lpos = gl_FragCoord.xy * 0.5 - 0.5;
      ivec2 b0 = ivec2(floor(lpos));
      vec2 fr = lpos - vec2(b0);
      ivec2 lmax = textureSize(tLow, 0) - 1;
      vec4 acc = vec4(0.0);
      float wsum = 0.0;
      for (int j = 0; j < 2; j++)
        for (int i = 0; i < 2; i++) {
          vec4 v = texelFetch(tLow, clamp(b0 + ivec2(i, j), ivec2(0), lmax), 0);
          float w = (i == 0 ? 1.0 - fr.x : fr.x) * (j == 0 ? 1.0 - fr.y : fr.y);
          if (v.a >= 0.0 && v.a <= 1.0) { acc += w * v; wsum += w; }
        }
      if (wsum > 0.05) {
        Lm = acc.rgb / wsum;
        Tm = acc.a / wsum;
        own = false;
      }
    }
#endif
    if (own) rlMarch(rd, sA, sB, jit, Lm, Tm, steps);
    Lp = mix(Lp, Lm, wM);
    Tp = mix(Tp, Tm, wM);
  }

  // ---------------------------------------------------------------- F ring
  vec3 Lf;
  float Tf;
  float tF = rlFRing(rd, sd, 1.0, Lf, Tf);

  // ---------------------------------------------------------------- E ring segments
  vec2 eSeg = rlESegment(rd);
  eSeg.y = min(eSeg.y, sd);
  float split = clamp(tOrder, eSeg.x, max(eSeg.x, eSeg.y));

  // ---------------------------------------------------------------- composite back to front
  if (eSeg.y > split) col += rlERing(rd, split, eSeg.y, jit);
  if (tF > 0.0 && tF > tOrder) col = col * Tf + Lf;
  col = col * Tp + Lp;
  if (tF > 0.0 && tF <= tOrder) col = col * Tf + Lf;
  if (split > eSeg.x) col += rlERing(rd, eSeg.x, split, jit);

  // ---------------------------------------------------------------- debug views
  if (uRlDebug == 1) col = rlFalse(log(max(tauHit, 1e-4)) / log(10.0) * 0.25 + 1.0) * 2.0;   // tau: 1e-4..1
  else if (uRlDebug == 2) col = vec3(Tp) * 2.0;
  else if (uRlDebug == 3) col = (Lp * PI / uSunE) * 2.0;                                       // I/F
  else if (uRlDebug == 4) col = rlFalse(steps / 96.0) * 2.0;
  else if (uRlDebug == 5) col = vec3(wM, hitP ? 0.3 : 0.0, inside ? 1.0 : 0.0) * 2.0;
  else if (uRlDebug == 6) col = rlFalse(log2(max(fpHit, 1.0)) / 24.0) * 2.0;
  else if (uRlDebug == 7) col = vec3(rHit * 1e-6, (Lp * PI / uSunE).g, tauHit);          // raw, for readback
  else if (uRlDebug == 8) col = vec3(rHit * 1e-6, Tp, steps);
  else if (uRlDebug == 9) col = vec3(rHit * 1e-6, (Lp * PI / uSunE).g, thHit);
  else if (uRlDebug == 10) col = vec3(gRlS3, Tp, steps);                                       // raw: e^-3 distance
  else if (uRlDebug == 11) col = gRlWsrc < 0.0 ? vec3(0.0) : rlFalse((gRlWsrc + 1.0) / 8.0) * 2.0; // wake source
  else if (uRlDebug == 12) col = vec3(wM, gRlWsrc, (Lp * PI / uSunE).g);                       // raw
  outColor = vec4(col, 1.0);
}
#endif
