// ===== sv_common ============================================================================
// Shared constants, camera rays, logarithmic depth, hashing/noise. All world-space quantities are in
// SEF axes, METERS, relative to the camera (the camera is at the origin of shader space).
#ifndef SV_COMMON
#define SV_COMMON

#define PI 3.14159265358979
#define TWO_PI 6.28318530717959
#define INV_PI 0.318309886183791
#define SKY_DIST 1e30
#define SATURN_GEOM_ALBEDO 0.499

uniform vec2 uResolution;     // internal render size (px)
uniform float uPixelAngle;    // rad per pixel (vertical)
uniform float uTanHalfFov;    // tan(fovY/2)
uniform float uAspect;        // width/height
uniform mat3 uCamToWorld;     // camera-local -> SEF
uniform mat3 uWorldToCam;     // SEF -> camera-local
uniform mat4 uProj;           // perspective projection (x,y,w); z is replaced by log depth
uniform vec3 uCamPos;         // camera position in SEF (m). float32: ~8 m precision near the rings; use the
                              // ring-frame uniforms (sv_ringProfile) for precise near-camera ring geometry.
uniform float uLogDepthFC;    // 2 / log2(1 + LOG_DEPTH_FAR)
uniform float uTimeMod;       // sim time modulo 1e5 s (for animated noise only)
uniform vec3 uSunDir;         // unit vector Saturn->Sun (SEF)
uniform float uSunE;          // solar irradiance at Saturn (W/m^2)
uniform float uSunRadiance;   // radiance of the solar disk (W m^-2 sr^-1)
uniform float uSunAngRadius;  // angular radius of the Sun (rad)

// Unit ray direction (SEF) through screen position uv in [0,1]^2 (uv = gl_FragCoord.xy / uResolution).
vec3 cameraRayDir(vec2 uv) {
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 v = normalize(vec3(ndc.x * uTanHalfFov * uAspect, ndc.y * uTanHalfFov, -1.0));
  return normalize(uCamToWorld * v);
}
// View-space depth w (> 0 in front of the camera, m) of a camera-relative point.
float viewDepth(vec3 p) { return -(uWorldToCam * p).z; }
// Logarithmic depth in [0,1] for a view-space depth w (write to gl_FragDepth in fullscreen passes).
float logDepth01(float w) { return log2(max(1e-6, 1.0 + w)) * 0.5 * uLogDepthFC; }
// For rasterized geometry: after gl_Position = uProj * vec4(viewPos,1), set
//   gl_Position.z = logDepthClipZ(gl_Position.w);
// (valid for small primitives; large triangles should write gl_FragDepth instead).
float logDepthClipZ(float w) { return (log2(max(1e-6, 1.0 + w)) * uLogDepthFC - 1.0) * w; }

// ---- hashing (PCG-based, stable across platforms)
uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float hashU(uint v) { return float(pcgHash(v)) * (1.0 / 4294967296.0); }
float hash11(float p) { return hashU(floatBitsToUint(p)); }
float hash12(vec2 p) { return hashU(pcgHash(floatBitsToUint(p.x)) ^ floatBitsToUint(p.y)); }
float hash13(vec3 p) { return hashU(pcgHash(pcgHash(floatBitsToUint(p.x)) ^ floatBitsToUint(p.y)) ^ floatBitsToUint(p.z)); }
vec3 hash33i(ivec3 c) {
  uint h = pcgHash(uint(c.x) * 73856093u ^ uint(c.y) * 19349663u ^ uint(c.z) * 83492791u);
  return vec3(hashU(h), hashU(pcgHash(h + 1u)), hashU(pcgHash(h + 2u)));
}

// ---- value noise / fbm
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  ivec3 c = ivec3(i);
  float n000 = hash33i(c).x, n100 = hash33i(c + ivec3(1,0,0)).x;
  float n010 = hash33i(c + ivec3(0,1,0)).x, n110 = hash33i(c + ivec3(1,1,0)).x;
  float n001 = hash33i(c + ivec3(0,0,1)).x, n101 = hash33i(c + ivec3(1,0,1)).x;
  float n011 = hash33i(c + ivec3(0,1,1)).x, n111 = hash33i(c + ivec3(1,1,1)).x;
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm3(vec3 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= oct) break;
    s += a * (vnoise3(p) * 2.0 - 1.0);
    n += a;
    p = p * 2.03 + vec3(17.1, 9.2, 3.7);
    a *= 0.5;
  }
  return s / n;
}

// ---- math helpers
float erfApprox(float x) {
  float x2 = x * x;
  float t = 1.0 - exp(-x2 * (1.27323954 + 0.147 * x2) / (1.0 + 0.147 * x2));
  return sign(x) * sqrt(max(t, 0.0));
}
float sat(float x) { return clamp(x, 0.0, 1.0); }
float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

#endif
