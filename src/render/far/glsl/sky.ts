// Sky background for the far-field pass: limb-darkened Sun (true angular size and radiance; flux-conserving
// pixel-integrated PSF when it is sub-pixel), the star layer (rendered as points beforehand), and a faint
// Milky Way (integrated light of the unresolved stars, ~20.5 mag/arcsec^2 toward the bulge to ~23 at the
// galactic poles). Requires sv_common, FAR_NOISE_GLSL.
export const FAR_PSF_GLSL = /* glsl */ `
// Fraction of a circular Gaussian (sigma, px) centred 'off' px from the pixel centre that falls in the pixel.
float pixelGauss(vec2 off, float sigma) {
  float k = 0.70710678 / sigma;
  vec2 a = (off + 0.5) * k, b = (off - 0.5) * k;
  return 0.25 * (erfApprox(a.x) - erfApprox(b.x)) * (erfApprox(a.y) - erfApprox(b.y));
}
// Solid angle (sr) of the pixel whose camera-space ray has tangent-plane coordinates tp (z = -1 plane).
float pixelSolidAngle(vec2 tp) {
  float l2 = 1.0 + dot(tp, tp);
  return uPixelAngle * uPixelAngle / (l2 * sqrt(l2));
}
`;

export const FAR_SKY_GLSL = /* glsl */ `
uniform sampler2D uStarTex;     // star layer radiance (W m^-2 sr^-1), same size as the scene target
uniform float uStarsOn;
uniform mat3 uGalRot;           // rows: galactic x (centre), y, z (north pole) in SEF
uniform float uMilkyWay;        // 0 = skip, else brightness multiplier

const float SUN_LD_U = 0.6;     // linear limb-darkening coefficient (visible)

vec3 sunRadiance(vec3 rd, vec2 fragPx, float omegaPix) {
  vec3 sc = uWorldToCam * uSunDir;
  if (sc.z >= -1e-6) return vec3(0.0);
  vec2 tp = sc.xy / (-sc.z);
  vec2 ndc = tp / vec2(uTanHalfFov * uAspect, uTanHalfFov);
  vec2 sPx = (ndc * 0.5 + 0.5) * uResolution;
  float rPx = uSunAngRadius / uPixelAngle;
  vec2 off = fragPx - sPx;
  float reach = max(4.0, rPx + 3.0);
  if (dot(off, off) > reach * reach) return vec3(0.0);
  float wDisk = smoothstep(1.5, 3.0, rPx);
  float L = 0.0;
  if (wDisk < 1.0) {
    float sig = sqrt(0.36 + 0.25 * rPx * rPx);
    L += (1.0 - wDisk) * uSunE * pixelGauss(off, sig) / omegaPix;
  }
  if (wDisk > 0.0) {
    float s = length(cross(rd, uSunDir));             // sin(angular distance), precise for small angles
    float x = s / uSunAngRadius;
    float cov = clamp((uSunAngRadius - s) / uPixelAngle + 0.5, 0.0, 1.0);
    float mu = sqrt(max(1.0 - x * x, 0.0));
    float I0 = uSunRadiance / (1.0 - SUN_LD_U / 3.0);
    L += wDisk * cov * I0 * (1.0 - SUN_LD_U * (1.0 - mu));
  }
  return vec3(L);
}

vec3 milkyWay(vec3 rd) {
  vec3 g = uGalRot * rd;
  float b = asin(clamp(g.z, -1.0, 1.0));
  float l = atan(g.y, g.x);
  float cl = cos(l);
  float thick = mix(0.09, 0.2, 0.5 - 0.5 * cl);
  float disk = exp(-abs(b) / thick) * (0.3 + 0.7 * (0.5 + 0.5 * cl));
  // bright star clouds: Sagittarius/Scutum, Cygnus, Carina-Crux
  float clouds = 0.0;
  clouds += 0.6 * exp(-0.5 * (pow((l - 0.45) / 0.3, 2.0) + pow(b / 0.08, 2.0)));
  clouds += 0.4 * exp(-0.5 * (pow((l - 1.35) / 0.25, 2.0) + pow(b / 0.07, 2.0)));
  clouds += 0.35 * exp(-0.5 * (pow((l + 1.2) / 0.35, 2.0) + pow(b / 0.06, 2.0)));
  float bulge = exp(-(l * l + 2.0 * b * b) / (2.0 * 0.2 * 0.2));
  float n = fbmL(g * 7.0, 4.0, 2.1, 0.55);
  float n2 = fbmL(g * 23.0 + 5.0, 3.0, 2.0, 0.5);
  // dust: Great Rift (l -10..+60 deg) and patchy lanes along the plane
  float lane = exp(-0.5 * pow((b - 0.01 * n) / 0.028, 2.0));
  float rift = lane * smoothstep(-0.35, -0.1, l) * (1.0 - smoothstep(1.0, 1.25, l));
  float dust = clamp(0.75 * rift + 0.35 * lane * (0.5 + 0.5 * n) + 0.25 * max(n2, 0.0) * exp(-abs(b) / 0.12), 0.0, 0.9);
  float I = (0.45 * disk + clouds * exp(-abs(b) / 0.1) + 0.9 * bulge) * (0.75 + 0.5 * (0.5 + 0.5 * n)) * (1.0 - dust);
  float base = 7e-7 * (1.0 + 0.6 * exp(-abs(b) / 0.5));
  return vec3(1.0, 0.94, 0.84) * (base + 6e-6 * I) * uMilkyWay;
}

vec3 skyRadiance(vec3 rd, vec2 fragPx, float omegaPix) {
  vec3 L = sunRadiance(rd, fragPx, omegaPix);
  if (uStarsOn > 0.5) L += texelFetch(uStarTex, ivec2(fragPx), 0).rgb;
  if (uMilkyWay > 0.0) L += milkyWay(rd);
  return L;
}
`;
