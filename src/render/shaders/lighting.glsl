// ===== sv_lighting ==========================================================================
// Phase functions, Saturnshine, and moon occultations of the Sun. Requires sv_common, sv_saturn.
// Radiance convention: a surface of albedo A lit by irradiance E has radiance L = A*E*cos(i)/pi (Lambert).
// A volume element with extinction sigma, single-scattering albedo w and normalized phase function P
// (Int P dOmega = 4 pi) contributes dL = sigma * w * P/(4 pi) * E_sun * T ds.
#ifndef SV_LIGHTING
#define SV_LIGHTING

#define MAX_MOONS 32
uniform int uMoonCount;
uniform vec4 uMoonPosR[MAX_MOONS];   // xyz: moon center relative to the camera (m), w: mean radius (m)

// Disk-integrated phase function of a Lambertian sphere, normalized to Int P dOmega = 4pi.
// cosAlpha = cos(phase angle) = dot(dirToSun, dirToViewer). P(0) = 8/3.
float phaseLambertSphere(float cosAlpha) {
  float a = acos(clamp(cosAlpha, -1.0, 1.0));
  return (8.0 / (3.0 * PI)) * (sin(a) + (PI - a) * cos(a));
}
// Henyey-Greenstein, normalized to 4pi. cosTheta = cos(scattering angle) (forward = +1).
float phaseHG(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-6), 1.5);
}
// Phase function of a macroscopic ring particle, normalized to Int P dOmega = 4pi: power law
// P = C (1 - alpha/pi)^n with n = 3.3 (Dones, Cuzzi & Showalter 1993, Voyager A-ring photometry), times the
// intrinsic opposition surge. Regolith-covered icy particles back-scatter far more strongly than Lambert
// spheres (P(0) = 5.70 vs 2.67); with the measured albedos this reproduces the observed low-phase I/F
// (B ~0.45, A ~0.3), which no Lambert-sphere albedo <= 1 can. C = 2 / (pi Int_0^1 u^n sin(pi u) du).
#define RING_PHASE_N 3.3
#define RING_PHASE_C 5.69698
float ringParticlePhase(float cosAlpha) {
  float a = acos(clamp(cosAlpha, -1.0, 1.0));
  return RING_PHASE_C * pow(max(1.0 - a / PI, 0.0), RING_PHASE_N) * (1.0 + 0.5 * exp(-a / 0.05));
}
// Fine dust: strongly forward scattering double Henyey-Greenstein.
float ringDustPhase(float cosAlpha) {
  float cosTheta = -cosAlpha;
  return 0.75 * phaseHG(cosTheta, 0.85) + 0.25 * phaseHG(cosTheta, 0.3);
}
// Ensemble phase function for ring material: macroscopic particles mixed with dust.
float ringPhase(float cosAlpha, float dust) {
  return mix(ringParticlePhase(cosAlpha), ringDustPhase(cosAlpha), dust);
}
// Lambert-sphere variant (diagnostics only).
float ringPhaseLambert(float cosAlpha, float dust) {
  float a = acos(clamp(cosAlpha, -1.0, 1.0));
  return mix(phaseLambertSphere(cosAlpha) * (1.0 + 0.5 * exp(-a / 0.05)), ringDustPhase(cosAlpha), dust);
}
// Resolved particles: multiply the radiance of a Lambert-shaded sphere (A E mu0 / pi) by this factor and the
// sphere's disk-integrated phase function becomes ringParticlePhase, so an ensemble of resolved particles has
// exactly the brightness of the medium it replaces (includes the opposition surge).
float ringParticleLambertFactor(float cosAlpha) {
  return ringParticlePhase(cosAlpha) / max(phaseLambertSphere(cosAlpha), 1e-3);
}

// Irradiance (W/m^2, on a surface facing Saturn) at camera-relative point p due to sunlight reflected by
// Saturn's disk, treating Saturn as a Lambert-phase sphere of geometric albedo 0.5. Also returns the unit
// direction from p toward Saturn's center.
float saturnshine(vec3 p, out vec3 dirToSaturn) {
  vec3 v = uSaturnCenter - p;
  float d = length(v);
  dirToSaturn = v / d;
  float a = acos(clamp(dot(-dirToSaturn, uSunDir), -1.0, 1.0));
  float phi = (sin(a) + (PI - a) * cos(a)) / PI;
  float Rm = uSaturnRadii.x * 0.96;
  return uSunE * SATURN_GEOM_ALBEDO * (Rm * Rm) / (d * d) * phi;
}

// Fraction of a disk of radius rs covered by a disk of radius rm at center separation d (any units).
float diskOverlapFraction(float d, float rs, float rm) {
  if (d >= rs + rm) return 0.0;
  if (d <= abs(rs - rm)) return rm >= rs ? 1.0 : (rm * rm) / (rs * rs);
  float r1 = rs, r2 = rm;
  float a1 = r1 * r1 * acos(clamp((d * d + r1 * r1 - r2 * r2) / (2.0 * d * r1), -1.0, 1.0));
  float a2 = r2 * r2 * acos(clamp((d * d + r2 * r2 - r1 * r1) / (2.0 * d * r2), -1.0, 1.0));
  float a3 = 0.5 * sqrt(max(0.0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
  return clamp((a1 + a2 - a3) / (PI * r1 * r1), 0.0, 1.0);
}

// Fraction of the solar disk visible from camera-relative point p considering all moons (spheres).
// Set skipIndex to a moon index to ignore (e.g. when shading that moon's own surface), else -1.
float moonsSunVisibility(vec3 p, int skipIndex) {
  float vis = 1.0;
  for (int i = 0; i < MAX_MOONS; i++) {
    if (i >= uMoonCount) break;
    if (i == skipIndex) continue;
    vec3 c = uMoonPosR[i].xyz - p;
    float R = uMoonPosR[i].w;
    float d = length(c);
    if (d <= R) return 0.0;
    float angM = asin(R / d);
    // angular separation Sun-moon center: atan2 form (acos near 1 resolves only ~3.5e-4 rad in float32,
    // comparable to the Sun's 4.9e-4 rad radius, which speckles penumbrae)
    float cs = dot(c, uSunDir);
    if (cs <= 0.0) continue;
    float sep = atan(length(cross(c, uSunDir)), cs);
    if (sep >= angM + uSunAngRadius) continue;
    vis *= 1.0 - diskOverlapFraction(sep, uSunAngRadius, angM);
  }
  return vis;
}

// Combined direct-sunlight visibility from Saturn and moon occultation (ring transmission NOT included).
float sunVisibility(vec3 p) { return saturnSunVisibility(p) * moonsSunVisibility(p, -1); }

#endif
