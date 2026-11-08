// ===== astronaut companion: fragment shader (src/render/passes/AstronautPass.ts) =======================
// Requires SV_HEADER_ALL, NEAR_SHADOW_COMMON_GLSL and NEAR_SHADOW_LOOKUP_GLSL (or stubs of its two lookups).
// Output: sceneRT (rgb radiance W m^-2 sr^-1, a = distance m); log depth comes from the vertex shader, so the
// near-field particles occlude it and pass through it correctly and the ring-layer medium composites over it.
in vec3 vP;
in vec3 vN;
in float vW;
flat in float vMat;
in vec2 vSun;
in vec3 vFl;
in vec3 vFd;
in vec3 vSatDir;
in vec3 vSatE;
in float vSatT;
flat in float vSg;

uniform vec3 uAstroRs;   // far-field ringshine irradiance vector (W/m^2, SEF, toward the rings; weighted)
#ifdef ASTRO_RINGSHINE
uniform sampler2D uRingshineTab;   // ringshine on Saturn's deck, (E_ring / E_sun) rgb
#endif

layout(location = 0) out vec4 outColor;

// Saturn's clouds, relative colour (unit luminance), and Lambert albedo (as the vertex shader)
const vec3 SATURN_TINT = vec3(1.1, 0.99, 0.79);
const float SATURN_ALB = 1.5 * SATURN_GEOM_ALBEDO;

// GGX microfacet BRDF times pi-free normalization: D * Vis * F (multiply by irradiance E n.l for radiance).
vec3 astroGGX(vec3 n, vec3 v, vec3 l, float alpha, vec3 F0) {
  vec3 h = normalize(l + v);
  float nh = max(dot(n, h), 0.0), nl = max(dot(n, l), 0.0), nv = max(dot(n, v), 1e-4);
  float a2 = alpha * alpha;
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float Vis = 0.5 / (nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2) + 1e-6);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  return D * Vis * F;
}

// Irradiance (W/m^2) on a surface element facing direction n from everything but the direct Sun.
vec3 astroAmbient(vec3 n) {
  float c = vSg * n.z;
  vec3 E = vFl * (0.5 + 0.5 * c) + vFd * (0.5 - 0.5 * c);   // ring layer, from each half-space
  E += vec3(max(dot(n, uAstroRs), 0.0));                      // distant rings
  E += vSatE * clamp((dot(n, vSatDir) + 0.15) / 1.15, 0.0, 1.0);   // Saturnshine (extended disc)
  return E;
}

// Radiance seen in a mirror direction r: Saturn's disc (clouds lit by the Sun and by the rings, ring-attenuated)
// and the glow of the ring layer from the half-space r points into (hemispheric flux / pi). Black sky otherwise.
vec3 astroMirror(vec3 p, vec3 r) {
  vec3 L = (vSg * r.z > 0.0 ? vFl : vFd) * INV_PI;
  vec2 hit = saturnIntersect(p, r);
  if (hit.x < hit.y && hit.x > 0.0) {
    vec3 ns = saturnNormal(p + r * hit.x - uSaturnCenter);
    vec3 E = vec3(uSunE * max(dot(ns, uSunDir), 0.0));
#ifdef ASTRO_RINGSHINE
    float dl = atan(ns.y, ns.x) - atan(uSunDir.y, uSunDir.x);
    dl = mod(dl + PI, TWO_PI) - PI;
    float lat = asin(clamp(ns.z, -1.0, 1.0));
    E += textureLod(uRingshineTab, vec2((dl + PI) / TWO_PI, (lat + 0.5 * PI) * INV_PI), 0.0).rgb * uSunE;
#endif
    L += SATURN_TINT * (SATURN_ALB * INV_PI) * E * vSatT;
  }
  return L;
}

void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(-vP);
  float nv = dot(n, v);
  if (nv < 0.02) { n = normalize(n + (0.02 - nv) * v); nv = dot(n, v); }   // interpolated normals at silhouettes

  // materials: diffuse albedo kd, specular reflectance at normal incidence F0, GGX roughness alpha (0: matte)
  int m = int(vMat + 0.5);
  vec3 kd = vec3(0.8, 0.79, 0.76), F0 = vec3(0.04);
  float alpha = 0.0;
  if (m == 1) { kd = vec3(0.76, 0.76, 0.75); alpha = 0.3; }                                  // painted shells
  else if (m == 2) { kd = vec3(0.05); F0 = vec3(0.62, 0.62, 0.64); alpha = 0.28; }           // anodized metal
  else if (m == 3) { kd = vec3(0.012, 0.01, 0.007); F0 = vec3(1.0, 0.76, 0.33); alpha = 0.035; }  // gold visor
  else if (m == 4) { kd = vec3(0.55, 0.55, 0.53); }                                          // gloves
  else if (m == 5) { kd = vec3(0.07); alpha = 0.5; }                                         // soles, grips
  else if (m == 6) { kd = vec3(0.47, 0.48, 0.5); alpha = 0.35; }                             // chest module

  // direct sunlight; near-field particles cast their exact shadows where the shadow map covers the body
  float ndl = dot(n, uSunDir);
  float Es = vSun.x;
  float mapW = nearShadowCoverage(vP);
  if (mapW > 0.0) {
    float sh = ndl > 0.0 ? nearShadowVisibility(vP, vec3(1e9), 0.5 * vW * uPixelAngle) : 1.0;
    Es = mix(vSun.x, vSun.y * sh, mapW);
  }

  vec3 col = kd * INV_PI * (Es * max(ndl, 0.0) + astroAmbient(n));
  if (alpha > 0.0) {
    if (ndl > 0.0) col += Es * ndl * astroGGX(n, v, uSunDir, alpha, F0);
    // environment: sharp mirror image for the visor, the irradiance-weighted average for rough surfaces
    vec3 r = reflect(-v, n);
    vec3 Fr = F0 + (1.0 - F0) * pow(1.0 - max(nv, 0.0), 5.0);
    float rough = smoothstep(0.05, 0.25, alpha);
    vec3 Lenv = rough < 1.0 ? astroMirror(vP, r) : vec3(0.0);
    col += Fr * mix(Lenv, astroAmbient(r) * INV_PI, rough);
  }
  outColor = vec4(col, length(vP));
}
