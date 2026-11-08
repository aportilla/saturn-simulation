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
// Further sun-shadowing spheres that are not moons of the far field (the propeller moonlets near the camera, set by
// PropellerMoonletPass.update): same layout, included in moonsSunVisibility.
#define MAX_SHADOW_SPH 8
uniform int uShadowSphN;
uniform vec4 uShadowSph[MAX_SHADOW_SPH];

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
// intrinsic opposition surge of the particle phase function (alpha = phase angle, rad)
float ringParticleSurge(float a) { return 1.0 + 0.5 * exp(-a / 0.05); }
float ringParticlePhase(float cosAlpha) {
  float a = acos(clamp(cosAlpha, -1.0, 1.0));
  return RING_PHASE_C * pow(max(1.0 - a / PI, 0.0), RING_PHASE_N) * ringParticleSurge(a);
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
// Lambert-shaded particles (diagnostics: the near field's debug view 32): multiply the radiance of a Lambert
// surface (A E mu0 / pi) by this factor and a sphere's disk-integrated phase function becomes ringParticlePhase.
float ringParticleLambertFactor(float cosAlpha) {
  return ringParticlePhase(cosAlpha) / max(phaseLambertSphere(cosAlpha), 1e-3);
}
// Resolved particles: regolith surface law, radiance factor I/F of a surface element lit at incidence cosine
// mu0 and seen at mu (w.r.t. its normal), phase angle g (cosg), grain single-scattering albedo w. Hapke's model
// with macroscopic roughness theta-bar = 30 deg (Hapke 1984) and the 2002 H functions, single-term HG grains
// (xi = -0.35); no opposition term (the surge is carried by the per-particle factor). The radiance of a
// particle is L = (A E / pi) I/F f(alpha) with f from nearRegolithFactor (nearCommon.glsl), which makes a
// sphere's disk-integrated phase function exactly ringParticlePhase. CPU mirror, parameters and sources:
// src/render/near/NearRegolith.ts (regolithIF) - keep both identical.
#define RG_TANT 0.577350269   // tan(theta-bar)
#define RG_COTT 1.732050808
#define RG_CHI 0.698908180    // (1 + pi tan^2(theta-bar))^-1/2
#define RG_XI (-0.35)
float ringRegolithIF(float mu0, float mu, float cosg, float w) {
  if (mu0 <= 0.0 || mu <= 0.0) return 0.0;
  float si = sqrt(max(1.0 - mu0 * mu0, 0.0)), se = sqrt(max(1.0 - mu * mu, 0.0));
  float cp = si * se > 1e-6 ? clamp((cosg - mu0 * mu) / (si * se), -1.0, 1.0) : 1.0;   // cos(azimuth psi)
  float psi = acos(cp);
  float f = exp(-2.0 * sqrt(max(1.0 - cp, 0.0) / max(1.0 + cp, 1e-6)));                 // exp(-2 tan(psi/2))
  float ci = mu0 / max(si, 1e-6), ce = mu / max(se, 1e-6);                                // cot i, cot e
  float E1i = exp(-0.636619772 * RG_COTT * ci), E1e = exp(-0.636619772 * RG_COTT * ce);
  float qi = RG_COTT * ci, qe = RG_COTT * ce;
  float E2i = exp(-INV_PI * qi * qi), E2e = exp(-INV_PI * qe * qe);
  float etai = RG_CHI * (mu0 + si * RG_TANT * E2i / (2.0 - E1i));
  float etae = RG_CHI * (mu + se * RG_TANT * E2e / (2.0 - E1e));
  float s2 = 0.5 * (1.0 - cp);
  float mu0e, mue, S;
  if (mu0 >= mu) {
    float den = 2.0 - E1e - psi * INV_PI * E1i;
    mu0e = RG_CHI * (mu0 + si * RG_TANT * (cp * E2e + s2 * E2i) / den);
    mue = RG_CHI * (mu + se * RG_TANT * (E2e - s2 * E2i) / den);
    S = (mue / etae) * (mu0 / etai) * (RG_CHI / (1.0 - f + f * RG_CHI * mu0 / etai));
  } else {
    float den = 2.0 - E1i - psi * INV_PI * E1e;
    mu0e = RG_CHI * (mu0 + si * RG_TANT * (E2i - s2 * E2e) / den);
    mue = RG_CHI * (mu + se * RG_TANT * (cp * E2i + s2 * E2e) / den);
    S = (mue / etae) * (mu0 / etai) * (RG_CHI / (1.0 - f + f * RG_CHI * mu / etae));
  }
  mu0e = max(mu0e, 1e-6);
  mue = max(mue, 1e-6);
  float gam = sqrt(max(1.0 - w, 0.0)), r0 = (1.0 - gam) / (1.0 + gam);
  float H0 = 1.0 / (1.0 - w * mu0e * (r0 + (0.5 - r0 * mu0e) * log((1.0 + mu0e) / mu0e)));
  float H1 = 1.0 / (1.0 - w * mue * (r0 + (0.5 - r0 * mue) * log((1.0 + mue) / mue)));
  float p = (1.0 - RG_XI * RG_XI) / pow(1.0 + 2.0 * RG_XI * cosg + RG_XI * RG_XI, 1.5);
  return max(0.25 * w * (mu0e / (mu0e + mue)) * (p + H0 * H1 - 1.0) * S, 0.0);
}
// Irradiance on a surface from a uniform spherical source of angular radius sigma (sinSigma) whose centre is at
// cosTheta from the normal, relative to the irradiance normal to the source: cosTheta while the whole source is
// above the horizon, exact partial-horizon form otherwise (Snyder 1996; Lagarde & de Rousiers 2014). Used as
// the effective incidence cosine of Saturn (~55 deg across inside the main rings). Energy-conserving over a sphere.
float extendedSourceCosine(float cosTheta, float sinSigma) {
  float s2 = sinSigma * sinSigma;
  if (cosTheta * cosTheta >= s2) return max(cosTheta, 0.0);
  float sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 1e-8));
  float x = sqrt(max(1.0 / max(s2, 1e-8) - 1.0, 0.0));
  float y = clamp(-x * cosTheta / sinTheta, -1.0, 1.0);
  float sty = sinTheta * sqrt(max(1.0 - y * y, 0.0));
  return max(((cosTheta * acos(y) - x * sty) * s2 + atan(sty, max(x, 1e-6))) / (PI * s2), 0.0);
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

// Visible fraction of the solar disk at p behind one shadowing sphere (center relative to the camera, radius R).
float sphereSunVisibility(vec3 p, vec4 sph) {
  vec3 c = sph.xyz - p;
  float R = sph.w;
  float d = length(c);
  if (d <= R) return 0.0;
  // angular separation Sun-moon center: atan2 form (acos near 1 resolves only ~3.5e-4 rad in float32,
  // comparable to the Sun's 4.9e-4 rad radius, which speckles penumbrae)
  float cs = dot(c, uSunDir);
  if (cs <= 0.0) return 1.0;
  float angM = asin(R / d);
  float sep = atan(length(cross(c, uSunDir)), cs);
  if (sep >= angM + uSunAngRadius) return 1.0;
  return 1.0 - diskOverlapFraction(sep, uSunAngRadius, angM);
}
// The further shadowing spheres (propeller moonlets); skipIndex: one of them to ignore (its own surface), else -1.
float extraSunVisibility(vec3 p, int skipIndex) {
  float vis = 1.0;
  for (int i = 0; i < MAX_SHADOW_SPH; i++) {
    if (i >= uShadowSphN) break;
    if (i != skipIndex) vis *= sphereSunVisibility(p, uShadowSph[i]);
  }
  return vis;
}
// Fraction of the solar disk visible from camera-relative point p considering all moons (spheres) and the further
// shadowing spheres. Set skipIndex to a moon index to ignore (e.g. when shading that moon's own surface), else -1.
float moonsSunVisibility(vec3 p, int skipIndex) {
  float vis = 1.0;
  for (int i = 0; i < MAX_MOONS; i++) {
    if (i >= uMoonCount) break;
    if (i == skipIndex) continue;
    vis *= sphereSunVisibility(p, uMoonPosR[i]);
    if (vis <= 0.0) return 0.0;
  }
  return vis * extraSunVisibility(p, -1);
}

// Combined direct-sunlight visibility from Saturn and moon occultation (ring transmission NOT included).
float sunVisibility(vec3 p) { return saturnSunVisibility(p) * moonsSunVisibility(p, -1); }

#endif
