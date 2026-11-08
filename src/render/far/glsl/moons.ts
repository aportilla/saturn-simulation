// Moons for the far-field renderer: triaxial-ellipsoid ray intersection with analytic limb coverage, or - for the
// small moons with measured shapes (Pan, Daphnis, Atlas, Prometheus, Pandora, Epimetheus, Janus; src/moons/shapes.ts)
// - a sphere-traced march of the star-shaped radius map with refined hits, limb coverage and self-shadowing;
// procedural or texture-mapped albedo, crater bump mapping, airless-body photometry (lunar-Lambert +
// opposition surge + roughness, see moonModel.ts), shadows (Saturn, rings, other moons), Saturnshine and
// ringshine. Titan: opaque haze body + single-scattering upper-haze shell with a detached layer.
// Requires sv_common, sv_saturn, sv_ringProfile, sv_lighting, FAR_NOISE_GLSL, FAR_SATURN_GLSL.
//
// Body frame (src/moons/types.ts): +x = 0 deg longitude (sub-Saturn), +z = north, +y = 90E (trailing).
export const FAR_MOONS_GLSL = /* glsl */ `
uniform vec4 uMoonQuat[MAX_MOONS];   // body -> SEF quaternion (x,y,z,w)
uniform vec4 uMoonRadii[MAX_MOONS];  // xyz semi-axes (m), w: material id
uniform vec4 uMoonPhot[MAX_MOONS];   // An (normal albedo), B0, h, beta
uniform vec4 uMoonPhot2[MAX_MOONS];  // L0, L1, texture layer (-1 = none), seed
uniform vec4 uMoonColor[MAX_MOONS];  // relative linear rgb, w: crater density
uniform vec4 uMoonExtra[MAX_MOONS];  // x: bump, y: texture u at lon 0, z: +1 east-right / -1 west-right, w: texture gain
uniform vec4 uMoonRing[MAX_MOONS];   // ringshine irradiance vector (W/m^2, SEF), w: 0
uniform highp sampler2DArray uMoonTex;
uniform float uMoonTexW;             // texture width (texels) for LOD selection
// Measured shapes: two layers per moon (base: gradient for lat >= 0, base + 1: lat < 0 - they differ only on an
// equatorial crest, MoonShape.gradientFields), texel (i, j) at east longitude -pi + i*step, latitude -pi/2 + j*step;
// .r = radius / rMax, .gba = tangential gradient of the radius (rMax units per radian, body xyz). Bilinear in
// (lon, lat) = MoonShape.radiusAlong (the camera uses the same function).
uniform highp sampler2DArray uShapeTex;
uniform vec4 uShapeGrid;             // width, height, step (rad), 0
uniform vec4 uMoonShape[MAX_MOONS];  // x: layer (-1 = ellipsoid), y: rMax (m), z: smooth-ridge half-width (rad), w: march step factor

#define MAT_MIMAS 1
#define MAT_ENCELADUS 2
#define MAT_TETHYS 3
#define MAT_DIONE 4
#define MAT_RHEA 5
#define MAT_TITAN 6
#define MAT_IAPETUS 7
#define MAT_HYPERION 8
#define MAT_PHOEBE 9
#define MAT_SMALL 10

vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec3 qrotInv(vec4 q, vec3 v) { return qrot(vec4(-q.xyz, q.w), v); }

// ---- measured shapes ------------------------------------------------------------------------------
// Radius map texel at the body-frame direction d (any length): .r = r / rMax, .gba = tangential gradient.
vec4 shapeFetch(float layer, vec3 d) {
  float rxy = length(d.xy);
  float lon = rxy > 0.0 ? atan(d.y, d.x) : 0.0;
  float lat = atan(d.z, rxy);
  vec2 xy = vec2(lon + PI, lat + 0.5 * PI) / uShapeGrid.z + 0.5;
  return textureLod(uShapeTex, vec3(xy / uShapeGrid.xy, layer + (d.z < 0.0 ? 1.0 : 0.0)), 0.0);
}
// Tangential part of the gradient at the unit direction u and the outward normal n = normalize(u - grad r / r).
vec3 shapeTangentGrad(vec3 u, vec4 S) { return S.gba - u * dot(S.gba, u); }
vec3 shapeNormal(vec3 u, vec4 S) { return normalize(u - shapeTangentGrad(u, S) / S.r); }

// Sun visibility of a point p (camera-relative, on the surface, geometric normal nG) of shaped moon i through its own
// topography - ridges, crater walls, the far end of an elongated body near the terminator: soft-shadow march toward
// the Sun to the bounding sphere. The edge is softened over the solar disk and ~a pixel / a quarter texel.
float shapeSunVisibility(int i, vec3 p, vec3 nG, float t) {
  vec4 sh = uMoonShape[i];
  vec4 q = uMoonQuat[i];
  vec3 pb = qrotInv(q, p - uMoonPosR[i].xyz) / sh.y;
  vec3 nb = qrotInv(q, nG);
  vec3 sb = qrotInv(q, uSunDir);
  float texA = uShapeGrid.z;
  float rho0 = length(pb);
  float fpU = t * uPixelAngle / sh.y;
  float soft0 = fpU + 0.25 * texA * rho0;
  vec3 o = pb + nb * max(0.5 * texA * rho0, fpU);    // start above the C0 surface (smooth normals vs. facets)
  float bb = dot(o, sb);
  float sExit = -bb + sqrt(max(bb * bb - dot(o, o) + 1.0, 0.0));
  float vis = 1.0, s = 0.0;
  for (int k = 0; k < 48; k++) {
    vec3 x = o + sb * s;
    float rho = length(x);
    float f = rho - shapeFetch(sh.x, x).r;
    vis = min(vis, clamp(0.5 + f / (soft0 + 2.0 * uSunAngRadius * s), 0.0, 1.0));
    if (vis <= 0.0) break;
    s += max(f * sh.w, 0.3 * texA * rho);
    if (s >= sExit) break;
  }
  return vis * vis * (3.0 - 2.0 * vis);
}

vec3 dirLatLon(float latDeg, float lonEDeg) {
  float la = latDeg * PI / 180.0, lo = lonEDeg * PI / 180.0;
  return vec3(cos(la) * cos(lo), cos(la) * sin(lo), sin(la));
}

// Large named crater/basin: angular radius th (rad), depth / rim / central peak heights (radius units).
// Adds to height h and the tangential slope gT (body frame); returns u/th (normalised distance).
float bigCrater(vec3 u, vec3 c, float th, float depth, float rim, float peak, inout float h, inout vec3 gT) {
  float ca = clamp(dot(u, c), -1.0, 1.0);
  float a = acos(ca);
  float x = a / th;
  if (x > 2.5) return x;
  float hh, dh;  // dh = dh/da
  if (x < 1.0) {
    // flat floor (complex crater) rising steeply to the rim
    const float x0 = 0.62;
    float s = smoothstep(x0, 1.0, x);
    hh = -depth + (depth + rim) * s * s;
    float y = (x - x0) / (1.0 - x0);
    float ds = (x > x0) ? 6.0 * y * (1.0 - y) / (1.0 - x0) : 0.0;
    dh = (depth + rim) * 2.0 * s * ds / th;
    float cp = exp(-x * x * 30.0);
    hh += peak * cp;
    dh += peak * cp * (-60.0 * x) / th;
  } else {
    float e = exp(-(x - 1.0) * 3.0);
    hh = rim * e;
    dh = -3.0 * rim * e / th;
  }
  h += hh;
  vec3 ea = u * ca - c;                          // direction of increasing a (away from c)
  float le = length(ea);
  if (le > 1e-6) gT += dh * (ea / le);
  return x;
}

struct MoonSurf { vec3 alb; vec3 gT; float B0; float hh; float beta; float L0; float L1; };

// Albedo (An, linear rgb) and bump slope for moon i at body-frame unit direction u. fpR = pixel footprint
// in units of the mean radius.
MoonSurf moonSurface(int i, vec3 u, float fpR) {
  MoonSurf s;
  int mat = int(uMoonRadii[i].w + 0.5);
  vec4 ph = uMoonPhot[i];
  vec4 ph2 = uMoonPhot2[i];
  s.B0 = ph.y; s.hh = ph.z; s.beta = ph.w; s.L0 = ph2.x; s.L1 = ph2.y;
  uint seed = uint(ph2.w);
  float density = uMoonColor[i].w;
  float bump = uMoonExtra[i].x;
  float lat = asin(clamp(u.z, -1.0, 1.0));
  float lonE = atan(u.y, u.x);
  float f = 1.0;           // albedo factor (mean ~ 1)
  vec3 tint = vec3(1.0);
  float h = 0.0;
  vec3 g = vec3(0.0);      // 3-D slope (crater octaves)
  vec3 gT = vec3(0.0);     // tangential slope (named features)
  float ca = 0.0;          // crater albedo modulation
  // measured shape: its geometry already holds the global form and the largest craters, but not the bowls of craters
  // a few grid steps across ("morphology of small craters is not reliably included", PDS notes; 2 deg grid), so the
  // procedural craters start there - octave F = 4 (diameters <= 0.26/F rad = 3.8 deg) on the cratered shepherds and
  // co-orbitals, F = 8 (<= 1.9 deg) on the smooth ring moons with ridges - fade in crater by crater with their pixel
  // size (no sub-pixel aliasing into dots), and there are no fake lumps
  bool shaped = uMoonShape[i].x >= 0.0;
  // ---- crater octaves (LOD: cells larger than ~5 pixels)
  float floorDark = mat == MAT_HYPERION ? 0.55 : (mat == MAT_PHOEBE ? 0.1 : (mat == MAT_IAPETUS ? 0.15 : 0.05));
  float cdens = density;
  if (mat == MAT_ENCELADUS) cdens *= smoothstep(-0.35, 0.35, u.z) * 0.9 + 0.1 * smoothstep(0.3, 0.9, abs(u.y));
  if (mat == MAT_HYPERION) cdens = 0.95;
  // smooth equatorial ridges of accreted ring material (Pan, Atlas, Daphnis): nearly crater-free
  float ridgeW = uMoonShape[i].z;
  if (shaped && ridgeW > 0.0) cdens *= mix(0.12, 1.0, smoothstep(0.75 * ridgeW, 1.25 * ridgeW, abs(lat)));
  if (cdens > 0.0) {
    float F = mat == MAT_HYPERION ? 4.0 : (shaped ? (ridgeW > 0.0 ? 8.0 : 4.0) : 2.0);
    for (int o = 0; o < 8; o++) {
      float cell = 1.0 / F;
      // ellipsoids: octaves with cells > ~5 px; measured shapes: each crater fades in between ~0.75 and 1.5 px radius
      // (lattice units: one pixel = fpR * F), the octave ends when even its largest craters (0.13 cell) are smaller
      float rFade = shaped ? 0.75 * fpR * F : 0.0;
      float w = shaped ? (0.13 > rFade ? 1.0 : 0.0) : clamp(log2(cell / (5.0 * fpR)) + 1.0, 0.0, 1.0);
      if (w <= 0.0) break;
      float h1 = 0.0, a1 = 0.0;
      vec3 g1 = vec3(0.0);
      craterOctave(u * F, seed * 7u + uint(o), cdens, floorDark, rFade, h1, g1, a1);
      h += w * h1 / F;
      g += w * g1;
      ca += w * a1;
      F *= 2.0;
    }
  }
  // ---- low-frequency lumpiness for small / irregular bodies (ellipsoids only)
  if (!shaped && (mat == MAT_SMALL || mat == MAT_HYPERION || mat == MAT_PHOEBE)) {
    // height ~ 8% of the radius in broad lumps (3 octaves); slope = A * 2.2 * grad(fbm) ~ 0.2-0.4
    vec3 e = vec3(0.03, 0.0, 0.0);
    float oc = clamp(log2(0.25 / max(fpR, 1e-5)), 0.0, 3.0);
    float n0 = fbmL(u * 2.2 + float(seed), oc, 2.0, 0.45);
    vec3 gg = vec3(fbmL(u * 2.2 + float(seed) + e.xyy, oc, 2.0, 0.45), fbmL(u * 2.2 + float(seed) + e.yxy, oc, 2.0, 0.45),
                   fbmL(u * 2.2 + float(seed) + e.yyx, oc, 2.0, 0.45)) - n0;
    g += (0.08 * 2.2) * gg / 0.03;
    f *= 1.0 + 0.08 * n0;
  }
  // ---- per-body signature features
  if (mat == MAT_MIMAS) {
    // Herschel (139 km, 1.7S 111.8W): 5 km walls, ~10 km deep floor, 6 km central peak
    bigCrater(u, dirLatLon(-1.7, -111.8), 0.351, 0.03, 0.012, 0.032, h, gT);
  } else if (mat == MAT_ENCELADUS) {
    // south polar terrain + tiger stripes (Alexandria, Cairo, Baghdad, Damascus sulci; ~35 km apart, ~130 km long)
    float sp = 0.5 * PI + lat;                // angular distance from the south pole
    if (sp < 0.75) {
      vec2 xy = sp * vec2(cos(lonE), sin(lonE));
      const float psi = 0.80;                 // stripe orientation (rad, from the 0-meridian)
      float aa = dot(xy, vec2(cos(psi), sin(psi)));
      float bb = dot(xy, vec2(-sin(psi), cos(psi)));
      float stripe = 0.0, flank = 0.0;
      for (int k = 0; k < 4; k++) {
        float ak = (float(k) - 1.5) * 0.139;
        float len = 0.30 + 0.05 * float(k % 2) - 0.04 * abs(float(k) - 1.5);
        float ac = aa + 0.18 * bb * bb - ak + 0.005 * snoise(vec3(bb * 7.0, float(k), 3.0));
        float tp = 1.0 - smoothstep(len - 0.06, len, abs(bb));
        float sw = max(0.016, 1.2 * fpR);    // never thinner than ~a pixel (keeps them visible, no aliasing)
        stripe += tp * exp(-0.5 * pow(ac / sw, 2.0)) * min(1.0, 0.016 / sw * 1.5);
        flank += tp * exp(-0.5 * pow(ac / 0.05, 2.0));
      }
      f *= 1.0 - 0.5 * min(stripe, 1.0);
      tint *= mix(vec3(1.0), vec3(0.82, 0.91, 1.0), min(flank, 1.0));
      // SPT: fractured, slightly different texture; boundary ridges near 55S
      float spt = 1.0 - smoothstep(0.55, 0.65, sp + 0.03 * snoise(vec3(lonE * 4.0, 1.0, 2.0)));
      float fr = ridgeL(u * 18.0 + 3.0, clamp(log2(0.05 / max(fpR, 1e-5)) + 1.0, 0.0, 4.0));
      f *= 1.0 - 0.07 * spt * fr;
    }
    // ridged plains (fine ridges, few craters) away from the cratered north
    float plains = 1.0 - smoothstep(-0.3, 0.3, u.z);
    float rp = ridgeL(vec3(u.x * 6.0, u.y * 6.0, u.z * 14.0) + 11.0, clamp(log2(0.08 / max(fpR, 1e-5)) + 1.0, 0.0, 4.0));
    f *= 1.0 + 0.05 * plains * (rp - 0.5);
  } else if (mat == MAT_TETHYS) {
    // Odysseus (445 km, 32.8N 128.9W), relaxed with a central peak complex
    vec3 cO = dirLatLon(32.8, -128.9);
    bigCrater(u, cO, 0.418, 0.008, 0.004, 0.006, h, gT);
    // Ithaca Chasma: ~100 km wide trough system on the great circle ~90 deg from Odysseus, 3/4 of the way round
    float aO = acos(clamp(dot(u, cO), -1.0, 1.0));
    vec3 e1 = normalize(vec3(0.0, 0.0, 1.0) - cO * cO.z);
    vec3 e2 = cross(cO, e1);
    vec3 up = normalize(u - cO * dot(u, cO));
    // beta = 0 at the northernmost point (57N 309W), -90 deg at (0, 39W), +-180 at (57S, 129W), +90 at (0, 219W):
    // the chasma runs from the north point through the Saturn-facing side round to (0, 219W); gap in (0, 90).
    float beta = atan(dot(up, e2), dot(up, e1));       // azimuth around Odysseus' axis
    float span = 1.0 - smoothstep(0.0, 0.25, beta) * (1.0 - smoothstep(1.32, 1.57, beta));
    float x = (aO - 0.5 * PI + 0.015 * snoise(vec3(beta * 3.0, 2.0, 5.0))) / 0.094;
    float trough = exp(-2.0 * x * x);
    float flanks = exp(-0.5 * pow((abs(x) - 0.9) / 0.25, 2.0));
    h += span * (-0.006 * trough + 0.002 * flanks);
    vec3 ea = normalize(u * dot(u, cO) - cO);          // direction of increasing distance from Odysseus
    float dhdx = 0.024 * x * trough - 0.032 * flanks * sign(x) * (abs(x) - 0.9);
    gT += span * dhdx / 0.094 * ea;
    f *= 1.0 + span * (0.04 * flanks - 0.03 * trough);
    // trailing hemisphere darker; faint bluish band across the leading hemisphere
    f *= 1.0 - 0.12 * smoothstep(-0.2, 0.8, u.y);
    float lens = exp(-0.5 * pow(lat / 0.28, 2.0)) * smoothstep(0.2, 0.8, -u.y);
    tint *= mix(vec3(1.0), vec3(0.93, 0.96, 1.0), lens);
  } else if (mat == MAT_DIONE || mat == MAT_RHEA) {
    float trail = smoothstep(-0.25, 0.7, u.y);
    float wisp = ridgeL(vec3(u.x * 3.0, u.y * 2.2, u.z * 3.6) + float(seed), clamp(log2(0.06 / max(fpR, 1e-5)) + 1.0, 1.0, 5.0));
    float wm = smoothstep(0.80, 0.97, wisp) * trail;
    if (mat == MAT_DIONE) {
      f *= (1.0 - 0.30 * trail) * (1.0 + 0.65 * wm);
    } else {
      f *= (1.0 - 0.18 * trail) * (1.0 + 0.35 * wm);
      // Inktomi (48 km, 14.1S 112.1W): young bright-rayed crater
      vec3 cI = dirLatLon(-14.1, -112.1);
      float aI = acos(clamp(dot(u, cI), -1.0, 1.0));
      vec3 ref = normalize(vec3(0.0, 0.0, 1.0) - cI * cI.z);
      vec3 up = u - cI * dot(u, cI);
      float az = atan(dot(up, cross(cI, ref)), dot(up, ref));
      float rays = pow(0.5 + 0.5 * sin(9.0 * az + 2.0 * snoise(vec3(az * 3.0, 1.0, 1.0))), 6.0);
      f *= 1.0 + 0.9 * exp(-aI / 0.035) + 0.35 * rays * exp(-aI / 0.25) * smoothstep(0.03, 0.06, aI);
      bigCrater(u, cI, 0.031, 0.004, 0.0015, 0.0, h, gT);
    }
    g *= 1.0 + 0.6 * wm;
  } else if (mat == MAT_IAPETUS) {
    // Cassini Regio: dark (p~0.04, red-brown) terrain centred on the leading apex (90W = body -y),
    // elongated along the equator; ragged boundary; dark crater floors in the transition zone.
    float dlon = abs(mod(lonE + 0.5 * PI + PI, TWO_PI) - PI);          // angular lon distance from 90W
    float xl = dlon / 1.45;
    float fd = length(vec2(xl, lat / (0.74 * (1.0 - 0.3 * xl * xl))));
    float oc = clamp(log2(0.05 / max(fpR, 1e-5)) + 2.0, 1.0, 6.0);
    fd += 0.12 * fbmL(u * 5.0 + 7.0, oc, 2.1, 0.55) + 0.05 * snoise(u * 23.0);
    float D = 1.0 - smoothstep(0.93, 1.05, fd);
    float trans = (1.0 - smoothstep(1.0, 1.45, fd)) * smoothstep(0.9, 1.0, fd);
    D = max(D, trans * smoothstep(0.02, 0.10, -ca));                    // dark crater floors
    D = max(D, trans * 0.5 * smoothstep(0.1, 0.5, -dot(g, vec3(0.0, 0.0, sign(lat)))));  // equator-facing slopes
    f *= mix(1.0, 0.065, D);
    tint *= mix(vec3(1.0, 0.98, 0.94), vec3(1.0, 0.70, 0.50), D);
    s.B0 = mix(ph.y, 0.9, D); s.beta = mix(ph.w, 1.245, D); s.L0 = mix(ph2.x, 0.95, D); s.L1 = mix(ph2.y, 0.8, D);
    // equatorial ridge (~20 km wide, up to ~20 km high) along most of Cassini Regio
    float lw = -lonE * 180.0 / PI;                                       // west longitude (deg)
    lw = mod(lw, 360.0);
    float along = smoothstep(18.0, 30.0, lw) * (1.0 - smoothstep(170.0, 190.0, lw));
    float pk = 0.6 + 0.4 * snoise(vec3(lonE * 12.0, 0.5, 0.5));
    float ridge = along * pk * exp(-0.5 * pow(lat / 0.011, 2.0));
    h += 0.02 * ridge;
    gT += -0.02 * ridge * (lat / (0.011 * 0.011)) * normalize(vec3(-u.z * u.x, -u.z * u.y, 1.0 - u.z * u.z) + 1e-6);
    // large basins: Turgis, Engelier, Gerin
    bigCrater(u, dirLatLon(17.0, -28.0), 0.39, 0.014, 0.005, 0.004, h, gT);
    bigCrater(u, dirLatLon(-43.0, -263.0), 0.34, 0.012, 0.004, 0.004, h, gT);
    bigCrater(u, dirLatLon(48.0, -236.0), 0.30, 0.010, 0.004, 0.003, h, gT);
  } else if (mat == MAT_HYPERION) {
    f *= 1.0 + 0.6 * ca;
  } else if (mat == MAT_PHOEBE) {
    f *= 1.0 + 1.5 * max(ca, 0.0) + 0.3 * min(ca, 0.0);
  }
  if (mat != MAT_IAPETUS && mat != MAT_HYPERION && mat != MAT_PHOEBE) f *= 1.0 + 0.5 * ca;
  // ---- texture (overrides the procedural large-scale albedo, keeps the procedural fine detail)
  float layer = ph2.z;
  if (layer >= 0.0) {
    float uu = fract(uMoonExtra[i].y + uMoonExtra[i].z * lonE / TWO_PI);
    float vv = 0.5 - lat * INV_PI;
    float lod = log2(max(fpR * uMoonTexW / TWO_PI, 1e-3));
    vec3 tx = textureLod(uMoonTex, vec3(uu, vv, layer), lod).rgb * uMoonExtra[i].w;
    float fine = 1.0 + 0.35 * ca;
    s.alb = ph.x * tx * fine;
    if (mat == MAT_IAPETUS) {
      float dk = 1.0 - smoothstep(0.08, 0.3, dot(tx, vec3(0.3333)));
      s.B0 = mix(ph.y, 0.9, dk); s.beta = mix(ph.w, 1.245, dk); s.L0 = mix(ph2.x, 0.95, dk); s.L1 = mix(ph2.y, 0.8, dk);
    }
  } else {
    s.alb = ph.x * uMoonColor[i].rgb * tint * max(f, 0.0);
  }
  // tangential slope: crater gradient (3-D) projected to the tangent plane + named features
  vec3 gt = g - u * dot(g, u);
  s.gT = bump * gt + gT;
  return s;
}

// Lunar-Lambert + opposition surge + roughness I/F.
vec3 moonIF(vec3 An, float mu0, float mu, float cosAlpha, MoonSurf s) {
  float a = acos(clamp(cosAlpha, -1.0, 1.0));
  float L = s.L0 + (s.L1 - s.L0) * a * INV_PI;
  float B = 1.0 + s.B0 / (1.0 + tan(min(0.5 * a, 1.5)) / s.hh);
  float R = B * exp(-s.beta * a);
  return An * R * (L * 2.0 * mu0 / (mu0 + mu) + (1.0 - L) * mu0);
}

// Radiance of a moon surface point. p: camera-relative point, nG: geometric normal (SEF), u: body unit dir.
vec3 moonShadePoint(int i, vec3 p, vec3 nG, vec3 u, vec3 rd, float t, float fpR) {
  MoonSurf s = moonSurface(i, u, fpR);
  vec4 q = uMoonQuat[i];
  vec3 n = normalize(nG - qrot(q, s.gT));
  float mu0g = dot(nG, uSunDir);
  float mu0 = dot(n, uSunDir);
  float mu = max(dot(n, -rd), 0.02);
  float cosA = dot(uSunDir, -rd);
  vec3 L = vec3(0.0);
  float term = smoothstep(-0.03, 0.03, mu0g);
  if (mu0 > 0.0 && term > 0.0) {
    float vis = saturnSunVisibility(p) * farMoonsSunVisibility(p, i);
    if (vis > 0.0 && uMoonShape[i].x >= 0.0) vis *= shapeSunVisibility(i, p, nG, t);
    if (vis > 0.0) {
      float T = ringSunTransmission(p, ringShadowFootprint(p, nG, rd, t));
      L += moonIF(s.alb, mu0, mu, cosA, s) * (uSunE * INV_PI) * vis * T * term;
    }
  }
  // Saturnshine (Saturn treated as a Lambert-phase sphere of geometric albedo 0.5)
  vec3 dS;
  float Es = saturnshine(p, dS);
  float aS = asin(clamp(uSaturnRadii.x / length(uSaturnCenter - p), 0.0, 1.0));
  float cS = dot(n, dS);
  // extended source: smooth horizon over the apparent radius of Saturn
  float cSe = cS >= aS ? cS : (cS > -aS ? (cS + aS) * (cS + aS) / (4.0 * aS) : 0.0);
  L += s.alb * (0.85 / PI) * Es * cSe;
  // ringshine (irradiance vector)
  vec3 Er = uMoonRing[i].xyz;
  float El = length(Er);
  if (El > 0.0) L += s.alb * (0.85 / PI) * El * max(dot(n, Er / El) * 0.75 + 0.25, 0.0);
  return L;
}

// ---- Titan --------------------------------------------------------------------------------------
// Opaque haze body at R + 200 km (orange, Minnaert/Lommel-Seeliger mix), exponential upper haze (H = 65 km,
// vertical tau ~0.25 at 545 nm) and a detached haze layer at ~500 km altitude, single scattering with a
// forward-peaked phase function (bright limb ring at high phase). Returns radiance; T = transmittance of
// the background (when the ray misses the haze body), cov = haze-body pixel coverage, tHit = distance.
const float TI_HBODY = 240e3;
const float TI_HTOP = 900e3;
vec3 titanShade(int i, vec3 rd, out vec3 T, out float cov, out float tHit) {
  vec3 c = uMoonPosR[i].xyz;
  float Rs = uMoonRadii[i].x;
  float Rb = Rs + TI_HBODY;
  float Rt = Rs + TI_HTOP;
  T = vec3(1.0); cov = 0.0; tHit = SKY_DIST;
  float b = dot(c, rd);
  vec3 qv = c - b * rd;                 // centre -> closest point (camera-relative offset)
  float r2 = dot(qv, qv);
  if (r2 >= Rt * Rt || b + sqrt(Rt * Rt - r2) <= 0.0) return vec3(0.0);
  float rca = sqrt(r2);
  float D = length(c);
  float sdPx = (rca - Rb) / (sqrt(max(D * D - Rb * Rb, 1.0)) * gAAPix);
  cov = D > Rb ? clamp(0.5 - sdPx, 0.0, 1.0) : 1.0;
  bool hit = rca < Rb;
  float tB = hit ? b - sqrt(Rb * Rb - r2) : b;
  tHit = max(b, 0.0);                   // depth-sort distance of the haze for miss rays (output needs cov >= 0.5)
  vec3 Lbody = vec3(0.0);
  // An = p; x1.1 for the disk average of the law below, x1.3 for the shell's two-way attenuation
  vec3 alb = uMoonPhot[i].x * uMoonColor[i].rgb * 1.43;
  if (cov > 0.0) {
    vec3 pc = hit ? (rd * tB - c) : (-qv / max(rca, 1.0)) * Rb;      // point on the haze body rel. centre
    vec3 p = pc + c;
    vec3 n = normalize(pc);
    vec3 u = qrotInv(uMoonQuat[i], n);
    float lat = asin(clamp(u.z, -1.0, 1.0));
    // seasonal structure: faint polar hoods, mild hemispheric asymmetry, subtle banding
    float hood = 1.0 - 0.10 * smoothstep(1.05, 1.25, lat) - 0.06 * smoothstep(1.15, 1.35, -lat);
    float band = 1.0 + 0.02 * sin(lat * 7.0) + 0.04 * smoothstep(-0.2, 0.6, lat) - 0.02;
    vec3 A = alb * hood * band;
    float mu0 = dot(n, uSunDir), mu = max(dot(n, -rd), 0.03);
    float mu0s = 0.02 * log(1.0 + exp(mu0 / 0.02));
    float vis = saturnSunVisibility(p) * farMoonsSunVisibility(p, i);
    // Lommel-Seeliger-like haze body (little limb darkening at low phase), mild forward brightening
    float cosA = dot(uSunDir, -rd);
    float ls = 2.0 * mu0s / (mu0s + mu);
    vec3 IF = A * (0.7 * ls + 0.3 * pow(mu0s, 0.9) * pow(mu, -0.1)) * (1.0 + 0.6 * pow(max(-cosA, 0.0), 4.0));
    Lbody = IF * uSunE * INV_PI * vis;
    vec3 dS;
    float Es = saturnshine(p, dS);
    Lbody += A * (0.85 / PI) * Es * max(dot(n, dS), 0.0);
    tHit = hit ? tB : b;
  }
  // upper haze shell between the entry point and the haze body (or the exit)
  float hT = sqrt(max(Rt * Rt - r2, 0.0));
  float t0 = max(b - hT, 0.0);
  float t1 = hit ? tB : b + hT;
  vec3 tauV = vec3(0.10, 0.13, 0.17);           // vertical optical depth above the haze body (R, G, B)
  vec3 tauD = vec3(0.003, 0.005, 0.009);        // detached layer (smaller particles: bluer)
  const float H = 55e3;
  const float zD = 500e3 - TI_HBODY, wD = 14e3;
  vec3 wSS = vec3(0.96, 0.86, 0.62);            // same orange haze optics as the main deck
  vec3 wD3 = vec3(0.97, 0.96, 0.93);
  float cosT = dot(uSunDir, rd);
  float Ph = phaseHG2(cosT, 0.72, -0.2, 0.92);
  float PhD = phaseHG2(cosT, 0.5, -0.2, 0.9);
  vec3 tauAcc = vec3(0.0);
  vec3 Lin = vec3(0.0);
  const int M = 14;
  float tc = clamp(b, t0, t1);
  for (int j = 0; j < M; j++) {
    float x = (float(j) + 0.5) / float(M);
    float t, dt;
    if (j < M / 2) {
      float xx = (float(j) + 0.5) / float(M / 2);
      float a = tc - t0;
      t = tc - a * (1.0 - xx) * (1.0 - xx);
      dt = a * 2.0 * (1.0 - xx) / float(M / 2);
    } else {
      float xx = (float(j - M / 2) + 0.5) / float(M / 2);
      float a = t1 - tc;
      t = tc + a * xx * xx;
      dt = a * 2.0 * xx / float(M / 2);
    }
    vec3 pr = rd * t - c;
    float rr = length(pr);
    float z = max(rr - Rb, 0.0);
    vec3 sigH = tauV / H * exp(-z / H);
    vec3 sigD = tauD / (2.5066 * wD) * exp(-0.5 * pow((z - zD) / wD, 2.0));
    vec3 sig = sigH + sigD;
    float cosChi = dot(pr / rr, uSunDir);
    // solar attenuation through the shell; occultation by the haze body
    float fsl = slantFactor(z, Rb, cosChi, H);
    float sinChi = sqrt(max(1.0 - cosChi * cosChi, 0.0));
    float occ = (cosChi < 0.0 && rr * sinChi < Rb) ? 0.0 : 1.0;
    vec3 p = rd * t;
    float vis = occ * saturnSunVisibility(p);
    vec3 Tsun = vis * exp(-tauV * min(fsl, 60.0));
    vec3 Tv = exp(-(tauAcc + 0.5 * sig * dt));
    Lin += (wSS * sigH * Ph + wD3 * sigD * PhD) * (0.25 * INV_PI) * Tsun * Tv * dt;
    tauAcc += sig * dt;
  }
  Lin *= uSunE;
  vec3 Tsh = exp(-tauAcc);
  T = Tsh * (1.0 - cov);
  return Lin + cov * Lbody * Tsh;
}

// ---- generic moon tracing ------------------------------------------------------------------------
struct MoonTrace { vec3 L; vec3 T; float cov; float dist; };

// Measured (star-shaped) shape: march F(p) = |p| - r(p/|p|) along the ray inside the bounding sphere (body frame,
// units of rMax; p = qc + sigma db, camera at sigma = b, so far cameras keep full precision). Steps F * marchStep are
// safe (Lipschitz bound of the map); a floor of 0.3 texel / half a pixel bounds the cost of grazing rays. The first
// crossing is refined by guarded secant steps. Limb coverage mirrors the ellipsoid's analytic AA: a missing ray
// covers 0.5 - (closest perpendicular gap in pixels), a grazing ray 0.5 + (deepest penetration in pixels) - unless
// it hits the body again behind (ridge in front of the core: covered).
const int SHAPE_MAX_STEPS = 128;
MoonTrace traceShapedMoon(int i, vec3 rd) {
  MoonTrace m;
  m.L = vec3(0.0); m.T = vec3(1.0); m.cov = 0.0; m.dist = SKY_DIST;
  vec4 sh = uMoonShape[i];
  float layer = sh.x, Rm = sh.y, kStep = sh.w;
  vec3 c = uMoonPosR[i].xyz;
  vec4 q = uMoonQuat[i];
  vec3 ob = qrotInv(q, -c) / Rm;
  vec3 db = normalize(qrotInv(q, rd));
  float b = dot(ob, db);
  vec3 qc = ob - b * db;
  float r2 = dot(qc, qc);
  float px = gAAPix;
  float Rs = 1.0 + 0.5 * px * length(ob) + 1e-5;   // + half a pixel of AA reach
  if (r2 >= Rs * Rs) return m;
  float h = sqrt(Rs * Rs - r2);
  float sA = max(-h, b), sB = h;
  if (sB <= sA) return m;
  float texA = uShapeGrid.z;
  int state = 0;                 // 0: before the first hit, 1: inside it, 2: out again
  float s = sA, sPrev = sA, fPrev = 1.0;
  float minPx = 1e9, sMin = sA, sHit = sA, depthPx = 0.0;
  bool covered = false;
  for (int k = 0; k < SHAPE_MAX_STEPS; k++) {
    vec3 p = qc + s * db;
    float rho = length(p);
    vec4 S = shapeFetch(layer, p);
    float f = rho - S.r;
    float tU = max(s - b, 1e-9);
    vec3 g = shapeTangentGrad(p / rho, S);
    float gPx = f * inversesqrt(1.0 + dot(g, g) / (S.r * S.r)) / (tU * px);   // normal distance (pixels)
    if (state == 0) {
      if (f > 0.0) {
        if (gPx < minPx) { minPx = gPx; sMin = s; }
      } else {
        float a0 = sPrev, a1 = s, f0 = fPrev, f1 = f;
        for (int r = 0; r < 6; r++) {
          float sm = clamp(a0 + (a1 - a0) * f0 / (f0 - f1), mix(a0, a1, 0.1), mix(a0, a1, 0.9));
          vec3 pm = qc + sm * db;
          float fm = length(pm) - shapeFetch(layer, pm).r;
          if (fm > 0.0) { a0 = sm; f0 = fm; } else { a1 = sm; f1 = fm; }
        }
        sHit = a0 + (a1 - a0) * f0 / (f0 - f1);
        state = 1;
        depthPx = -gPx;
        if (depthPx >= 0.5) { covered = true; break; }
      }
    } else if (state == 1) {
      if (f <= 0.0) {
        depthPx = max(depthPx, -gPx);
        if (depthPx >= 0.5) { covered = true; break; }
      } else state = 2;
    } else if (f <= 0.0) {
      covered = true;
      break;
    }
    sPrev = s; fPrev = f;
    s += max(abs(f) * kStep, max(0.3 * texA * rho, 0.5 * tU * px));
    if (s >= sB) break;
  }
  float cov;
  vec3 pb;                       // shading point (body frame, rMax units)
  float tU;
  if (state == 0) {
    cov = clamp(0.5 - minPx, 0.0, 1.0);
    if (cov <= 0.0) return m;
    vec3 u0 = normalize(qc + sMin * db);
    pb = u0 * shapeFetch(layer, u0).r;            // closest approach, projected onto the surface
    tU = sMin - b;
  } else {
    cov = covered ? 1.0 : clamp(0.5 + depthPx, 0.5, 1.0);
    pb = qc + sHit * db;
    tU = sHit - b;
  }
  vec3 u = normalize(pb);
  vec3 nb = shapeNormal(u, shapeFetch(layer, u));
  vec3 nG = qrot(q, nb);
  vec3 p = c + qrot(q, pb * Rm);                   // camera-relative point
  float t = tU * Rm;
  if (uFarDebug >= 40 && uFarDebug <= 44) {
    // debug views (?debug=40..44; 11-22 and 31-34 belong to the near field): body-frame normal as colour /
    // self-shadow sun visibility on the lit side / geometric cos(incidence) / march outcome (red: miss within AA
    // reach, green: covered hit, blue: grazing hit) / external shadows: r = Saturn, g = other moons, b = ring
    // transmission
    vec3 dc = uFarDebug == 40 ? 0.5 + 0.5 * nb
      : uFarDebug == 41 ? vec3(dot(nG, uSunDir) > 0.0 ? shapeSunVisibility(i, p, nG, t) : 0.0)
      : uFarDebug == 42 ? vec3(max(dot(nG, uSunDir), 0.0))
      : uFarDebug == 44 ? vec3(saturnSunVisibility(p), farMoonsSunVisibility(p, i), ringSunTransmission(p, ringShadowFootprint(p, nG, rd, t)))
      : (state == 0 ? vec3(1.0, 0.0, 0.0) : covered ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
    m.L = cov * dc; m.cov = cov; m.T = vec3(1.0 - cov); m.dist = t;
    return m;
  }
  float mu = max(dot(nG, -rd), 0.05);
  float fpR = t * uPixelAngle / mu / uMoonPosR[i].w;
  m.L = cov * moonShadePoint(i, p, nG, u, rd, t, fpR);   // premultiplied by coverage
  m.cov = cov;
  m.T = vec3(1.0 - cov);
  m.dist = t;
  return m;
}

MoonTrace traceMoon(int i, vec3 rd) {
  MoonTrace m;
  m.L = vec3(0.0); m.T = vec3(1.0); m.cov = 0.0; m.dist = SKY_DIST;
  int mat = int(uMoonRadii[i].w + 0.5);
  if (mat == MAT_TITAN) {
    vec3 T; float cov, th;
    m.L = titanShade(i, rd, T, cov, th);
    m.T = T; m.cov = cov; m.dist = th;
    return m;
  }
  if (uMoonShape[i].x >= 0.0) return traceShapedMoon(i, rd);
  vec3 c = uMoonPosR[i].xyz;
  vec4 q = uMoonQuat[i];
  vec3 R = uMoonRadii[i].xyz;
  vec3 ob = qrotInv(q, -c) / R;
  vec3 db = qrotInv(q, rd) / R;
  float dl = length(db);
  db /= dl;
  float b = dot(ob, db);
  if (b >= 0.0) return m;                          // moving away from the centre: behind the camera
  vec3 qc = ob - b * db;
  float r2 = dot(qc, qc);
  float D = length(ob);
  if (D <= 1.0) return m;
  float rca = sqrt(r2);
  float sdPx = (rca - 1.0) / (sqrt(D * D - 1.0) * gAAPix);
  float cov = clamp(0.5 - sdPx, 0.0, 1.0);
  if (cov <= 0.0) return m;
  bool hit = r2 < 1.0;
  vec3 ps = hit ? qc - sqrt(1.0 - r2) * db : qc / rca;
  float s = dot(ps - ob, db);
  if (s <= 0.0) return m;
  float t = s / dl;
  vec3 pb = ps * R;                                  // body-frame point (m)
  vec3 nb = normalize(ps / R);
  vec3 nG = qrot(q, nb);
  vec3 p = c + qrot(q, pb);                          // camera-relative point
  float rMean = uMoonPosR[i].w;
  float mu = max(dot(nG, -rd), 0.05);
  float fpR = t * uPixelAngle / mu / rMean;
  m.L = cov * moonShadePoint(i, p, nG, normalize(pb), rd, t, fpR);   // premultiplied by coverage
  m.cov = cov;
  m.T = vec3(1.0 - cov);
  m.dist = t;
  return m;
}
`;
