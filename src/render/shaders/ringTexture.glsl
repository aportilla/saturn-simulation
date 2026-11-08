// ===== sv_ringTexture ========================================================================
// Sub-km optical-depth texture of the main rings: a 2-D, Keplerian-sheared, evolving random field. It is one of the
// multiplicative tauMod sources of sv_ringStructure and is included BY that chunk (at its hooks) -- do not include it
// on its own. Requires sv_common and sv_ringProfile. Uniforms and CPU mirror: src/rings/ringTexture.ts (model,
// parameters, sources); docs/ring-physics.md section 10.
//
//   vec2 rsTauModTexture(aL, dth, fp)   (mean factor M at the footprint, variance of the sub-footprint part)
//   M = 1 + A F,  F = clamp(sum_j wv_j(fp) w_j [s_0 n_j0 + s_1 n_j1], +-3 sigma_F)
// six octaves (radial correlation 500 .. 15.6 m, the former rlFineNoise spectrum), amplitude per region from the
// 1 km-prefiltered profile at a' (the former rlFineFactor law); n_jg = variance-normalized value noise of the 256^2
// tile on a lattice that was isotropic at the structure's birth and is advected with the Keplerian (+J2) flow since:
// lattice azimuth = theta - Omega(a') age_g, so the structures trail with aspect ~ 1 + q Omega age. Two overlapping
// generations g (amplitudes s_g, s_0^2 + s_1^2 = 1).
#ifndef SV_RING_TEXTURE
#define SV_RING_TEXTURE

#define RT_OCT 6
uniform sampler2D uRtNoise;        // 256 x 256 R16F, i.i.d. uniform values in [-1, 1]; LINEAR, REPEAT
uniform vec4 uRtOct[2 * RT_OCT];   // [g * RT_OCT + j]: (u0, v0: lattice coordinates of the frame origin mod 256 (cells),
                                   //  1 / lambda_b [1/m], N_j / 2 pi [cells/rad])
uniform vec4 uRtGen;               // (amplitude slot 0, amplitude slot 1, shear age slot 0 [s], shear age slot 1 [s])
uniform vec4 uRtFlow;              // flow model at the frame origin: (Omega_K(r0) [rad/s], C1, C2, C3) (ringTexture.ts)
uniform vec4 uRtFlow2;             // (1 / r0 [1/m], amplitude multiplier (0 = off), -, -)
uniform vec4 uRtOctW[RT_OCT];      // per octave: (radial correlation length [m], weight w_j in F, w_j^2 / 3, -);
                                   // [0].w = clamp of F (3 sigma_F, ringTexture.ts RT_F_CLAMP)

// (1 + x)^-p - 1 without cancellation (series for |x| < 0.05)
float rtPowM1(float x, float p) {
  if (abs(x) < 0.05) {
    float t = 1.0, s = 0.0;
    for (int k = 1; k <= 7; k++) {
      t *= -(p + float(k) - 1.0) / float(k) * x;
      s += t;
    }
    return s;
  }
  return pow(1.0 + x, -p) - 1.0;
}
// Omega(r0 + aL) - Omega(r0) of the flow model (circular orbits with J2..J6; ringTexture.ts omegaModel), rad/s
float rtDeltaOmega(float aL) {
  float x = aL * uRtFlow2.x;
  return uRtFlow.x * (rtPowM1(x, 1.5) + uRtFlow.y * rtPowM1(x, 3.5) + uRtFlow.z * rtPowM1(x, 5.5) + uRtFlow.w * rtPowM1(x, 7.5));
}
// |dOmega/da| of the flow model at r0 + aL (rad/s/m)
float rtOmegaSlope(float aL) {
  float y = 1.0 + aL * uRtFlow2.x;
  return uRtFlow.x * uRtFlow2.x * (1.5 * pow(y, -2.5) + 3.5 * uRtFlow.y * pow(y, -4.5) + 5.5 * uRtFlow.z * pow(y, -6.5) + 7.5 * uRtFlow.w * pow(y, -8.5));
}
// variance-normalized value noise at lattice point p (cells): smoothstep weights through the hardware bilinear filter
float rtNoise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  vec2 s = f * f * (3.0 - 2.0 * f);
  vec2 q = (1.0 - s) * (1.0 - s) + s * s;
  return textureLod(uRtNoise, (i + s + 0.5) * (1.0 / 256.0), 0.0).r * inversesqrt(q.x * q.y);
}

vec2 rsTauModTexture(float aL, float dth, float fp) {
  if (uRtFlow2.y <= 0.0) return vec2(1.0, 0.0);
  // amplitude per region: the 1 km-prefiltered profile at a'
  RingSample s1 = ringSampleIdx(uRingIdx0 + aL / uRingDr0, 1000.0);
  if (s1.tau <= 0.0) return vec2(1.0, 0.0);
  float A = uRtFlow2.y * (0.22 + 0.35 * smoothstep(1.0, 3.0, s1.tau) + 0.1 * s1.wake);
  float F = 0.0, vU = 0.0, dW = 0.0;
  bool flow = false;
  for (int j = 0; j < RT_OCT; j++) {
    vec4 ow = uRtOctW[j];
    float wv = clamp((ow.x / max(fp, 1e-3) - 1.0) * 0.5, 0.0, 1.0);
    vU += (1.0 - wv * wv) * ow.z;
    if (wv <= 0.0) continue;
    if (!flow) { dW = rtDeltaOmega(aL); flow = true; }
    vec4 o0 = uRtOct[j], o1 = uRtOct[RT_OCT + j];
    float n = 0.0;
    if (uRtGen.x > 0.0) n += uRtGen.x * rtNoise(vec2(o0.x + aL * o0.z, o0.y + (dth - dW * uRtGen.z) * o0.w));
    if (uRtGen.y > 0.0) n += uRtGen.y * rtNoise(vec2(o1.x + aL * o1.z, o1.y + (dth - dW * uRtGen.w) * o1.w));
    F += wv * ow.y * n;
  }
  F = clamp(F, -uRtOctW[0].w, uRtOctW[0].w);
  return vec2(1.0 + A * F, A * A * vU);
}

#endif
