// Noise helpers for the far-field shaders (GLSL ES 3.0). Self-contained; requires nothing.
//
// snoise: 3-D simplex noise (Ian McEwan / Stefan Gustavson, "webgl-noise", MIT license; 2022 variant with
// the continuous 0.5 kernel). Output in about [-1, 1], zero mean.
export const FAR_NOISE_GLSL = /* glsl */ `
#ifndef FAR_NOISE
#define FAR_NOISE
vec3 fn_mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 fn_mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 fn_permute(vec4 x) { return fn_mod289(((x * 34.0) + 10.0) * x); }
vec4 fn_taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = fn_mod289(i);
  vec4 p = fn_permute(fn_permute(fn_permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  const float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = fn_taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// fbm with a fractional octave count (the last octave fades in -> no popping as the LOD changes).
// Normalized to unit amplitude sum of the full octaves.
float fbmL(vec3 p, float octaves, float lac, float gain) {
  float a = 1.0, s = 0.0, n = 0.0;
  for (int o = 0; o < 12; o++) {
    float w = clamp(octaves - float(o), 0.0, 1.0);
    if (w <= 0.0) break;
    s += a * w * snoise(p);
    n += a;
    p = p * lac + vec3(13.17, 7.31, 3.91);
    a *= gain;
  }
  return n > 0.0 ? s / n : 0.0;
}
// ridged multifractal-ish: thin bright lines where the noise crosses zero
float ridgeL(vec3 p, float octaves) {
  float a = 1.0, s = 0.0, n = 0.0;
  for (int o = 0; o < 8; o++) {
    float w = clamp(octaves - float(o), 0.0, 1.0);
    if (w <= 0.0) break;
    float r = 1.0 - abs(snoise(p));
    s += a * w * r * r;
    n += a;
    p = p * 2.07 + vec3(5.3, 1.7, 9.1);
    a *= 0.5;
  }
  return n > 0.0 ? s / n : 0.0;
}

// cheap integer hash -> [0,1)^4 for a lattice cell (+seed)
vec4 fn_hash4(ivec3 c, uint seed) {
  uint h = uint(c.x) * 0x8da6b343u ^ uint(c.y) * 0xd8163841u ^ uint(c.z) * 0xcb1ab31fu ^ seed * 0x9e3779b9u;
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
  uint h2 = h * 0x9e3779b9u + 0x7f4a7c15u; h2 ^= h2 >> 15; h2 *= 0x2c1b3c6du; h2 ^= h2 >> 12;
  uint h3 = h2 * 0x297a2d39u + 0x165667b1u; h3 ^= h3 >> 15; h3 *= 0x68e31da4u; h3 ^= h3 >> 13;
  uint h4 = h3 * 0x1b873593u + 0x3c6ef372u; h4 ^= h4 >> 16; h4 *= 0x85ebca6bu; h4 ^= h4 >> 13;
  return vec4(float(h >> 8), float(h2 >> 8), float(h3 >> 8), float(h4 >> 8)) * (1.0 / 16777216.0);
}

// Crater field (one octave) on a sphere: x = point on the unit sphere * cellFreq (cell space).
// Each lattice cell holds at most one crater (probability 'density') whose centre is projected onto the
// sphere (so every crater intersects the surface); crater radius <= 0.13 cell so that, with the
// projection offset, a 2x2x2 neighbourhood suffices. Accumulates height h (in cell units) and its 3-D
// gradient g, and an albedo modulation (fresh rims bright, floors per 'floorDark'). Profile: parabolic
// bowl of depth/diameter 0.2, raised rim, exponential ejecta blanket; larger craters get a central peak.
// rFade > 0 (lattice units, ~a pixel): craters with radius < 2 rFade fade out individually (no sub-pixel aliasing);
// rFade = 0: every crater at full strength.
void craterOctave(vec3 x, uint seed, float density, float floorDark, float rFade, inout float h, inout vec3 g, inout float alb) {
  vec3 base = floor(x - 0.5);
  float F = length(x);
  for (int k = 0; k < 8; k++) {
    ivec3 c = ivec3(base) + ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    vec4 r = fn_hash4(c, seed);
    if (r.x > density) continue;
    vec4 r2 = fn_hash4(c, seed + 101u);
    vec3 ctr = vec3(c) + 0.25 + 0.5 * r2.xyz;
    ctr *= F / length(ctr);
    // power-law sizes: many small, few large
    float R = 0.13 * (0.2 + 0.8 * r.y * r.y);
    float fade = 1.0;
    if (rFade > 0.0) {
      fade = smoothstep(rFade, 2.0 * rFade, R);
      if (fade <= 0.0) continue;
    }
    vec3 dv = x - ctr;
    float d = length(dv);
    float u = d / R;
    if (u >= 2.2) continue;
    float depth = 0.4 * R;           // d/D = 0.2
    float rim = 0.04 * 2.0 * R;      // rim height ~4% of the diameter
    float hh, dh;
    if (u < 1.0) {
      hh = depth * (u * u - 1.0) + rim;
      dh = 2.0 * depth * u;
      // central peak for larger craters
      if (r.z > 0.6) {
        float cp = exp(-u * u * 40.0);
        hh += 0.35 * depth * cp;
        dh += 0.35 * depth * cp * (-80.0 * u);
      }
    } else {
      float e = exp(-(u - 1.0) * 5.0);
      hh = rim * e;
      dh = -5.0 * rim * e;
    }
    if (rFade > 0.0) { hh *= fade; dh *= fade; }
    h += hh;
    g += (dh / R) * (dv / max(d, 1e-6));
    // albedo: fresh craters (r.w high) have bright rims/ejecta, older ones fade; floors per material
    float fresh = smoothstep(0.75, 1.0, r.w);
    float aRim = fresh * 0.25 * exp(-abs(u - 1.0) * 4.0) * (u < 1.6 ? 1.0 : 0.0);
    float aFloor = floorDark * (1.0 - smoothstep(0.55, 0.95, u));
    if (rFade > 0.0) {
      alb += fade * (aRim - aFloor);
    } else {
      alb += aRim;
      alb -= aFloor;
    }
  }
}
#endif
`;
