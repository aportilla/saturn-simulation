// ===== astronaut companion: vertex shader (src/render/passes/AstronautPass.ts) ========================
// Requires SV_HEADER_ALL, nearCommon (nearTwoStream) and NEAR_SHADOW_COMMON_GLSL.
// Per-vertex lighting environment (smooth over the 1.9 m body), in physical units and with the same models
// as the near-field particles (src/render/near/nearDraw.vert.glsl):
//  * direct sunlight: solar irradiance x Saturn's and the moons' shadows (penumbrae) x the ring column toward
//    the Sun (vertical layer model at the radius where the sun ray crosses the mid-plane, self-gravity wake
//    density sampled along the path); split like the particles' into the whole column and the part the
//    near-field shadow map cannot resolve (the fragment shader adds the map);
//  * diffuse ring light: near the rings the two-stream field of the layer at the body's depth (inside the
//    layer, or the glow of the lit / unlit face outside it), far away the ringshine irradiance vector;
//  * Saturnshine through the rings along six rays across Saturn's disc: the sunlit clouds (Lambert-phase
//    sphere, as saturnshine()) plus the clouds lit by the rings (the far pass's ringshine table, averaged over
//    the visible disc) - all that lights the suit on Saturn's night side.
in vec3 position;
in vec3 normal;
in float mat;

uniform mat3 uAstroRot;                    // body -> camera-local rotation
uniform vec3 uAstroPos;                    // body origin in camera-local coordinates (m)
uniform vec2 uNearBeta;                    // two-stream back-scatter fractions (diffuse, beam at mu0)
uniform float uAstroPlaneW;                // weight of the plane-parallel ring field (1 near the rings)
uniform float uNearAllocD[LOD_CLASSES];    // near-field particle box per class (shadow-map complement)

out vec3 vP;          // camera-relative position (SEF, m)
out vec3 vN;          // normal (SEF)
out float vW;         // view depth (m)
flat out float vMat;
out vec2 vSun;        // sun irradiance (W/m^2 normal to the Sun): x whole column statistical, y part the map can't resolve
out vec3 vFl;         // diffuse ring light from the lit-face half-space (W/m^2 on a surface facing it)
out vec3 vFd;         // ... from the dark-face half-space
out vec3 vSatDir;     // direction to Saturn
out vec3 vSatE;       // Saturnshine irradiance through the rings (W/m^2 on a surface facing Saturn)
out float vSatT;      // ring transmission toward Saturn's disc (for its reflection in the visor)
flat out float vSg;   // +1: the Sun is north of the ring plane

// Saturn's clouds, relative colour (unit luminance)
const vec3 SATURN_TINT = vec3(1.1, 0.99, 0.79);
// Lambert albedo of Saturn's clouds consistent with the geometric albedo saturnshine() uses (A = 1.5 p)
const float SATURN_ALB = 1.5 * SATURN_GEOM_ALBEDO;
#ifdef ASTRO_RINGSHINE
uniform sampler2D uRingshineTab;   // ringshine on the deck, (E_ring / E_sun) rgb (FarFieldPass / Ringshine.ts)
// Ringshine irradiance (W/m^2) on the cloud deck at unit normal n (spherical approximation).
vec3 astroDeckRingshine(vec3 n) {
  float dl = atan(n.y, n.x) - atan(uSunDir.y, uSunDir.x);
  dl = mod(dl + PI, TWO_PI) - PI;
  float lat = asin(clamp(n.z, -1.0, 1.0));
  return textureLod(uRingshineTab, vec2((dl + PI) / TWO_PI, (lat + 0.5 * PI) * INV_PI), 0.0).rgb * uSunE;
}
#endif

// Transmission along unit direction u from camera-relative point p at height zA above the ring plane through
// the main rings: the column between p and the face the ray leaves through, taken at the radius where the ray
// crosses the mid-plane (1 if it reaches Saturn first, at distance dMax).
float astroRingTrans(vec3 p, float zA, vec3 u, float dMax) {
  float t = abs(u.z) > 1e-6 ? -zA / u.z : -1.0;
  if (t >= dMax) return 1.0;
  vec3 q = t > 0.0 ? p + u * t : p;
  RingSample s = ringSample(length((q + uCamPos).xy), 0.0);
  float col = ringLayerTauBeyond(zA, s.tau, max(s.H, 0.5), u.z >= 0.0 ? 1.0 : -1.0);
  return exp(-col / max(abs(u.z), 0.02));
}

void main() {
  vec3 view = uAstroRot * position + uAstroPos;
  vec3 p = uCamToWorld * view;
  vP = p;
  vN = uCamToWorld * (uAstroRot * normal);
  vW = -view.z;
  vMat = mat;
  gl_Position = uProj * vec4(view, 1.0);
  // log depth per vertex: the triangles are cm-sized at metres, so the interpolation error is < 0.1 mm, and the
  // hardware early depth test can skip the fragments hidden behind ring particles (no gl_FragDepth)
  gl_Position.z = logDepthClipZ(gl_Position.w);

  float mu0 = max(abs(uSunDir.z), 1e-3);
  float sg = uSunDir.z >= 0.0 ? 1.0 : -1.0;
  vSg = sg;
  float vis = saturnSunVisibility(p) * moonsSunVisibility(p, -1);
  float Esun = uSunE * vis;

  // near the rings: precise local Hill-frame geometry; far away: SEF heights and the thin-sheet transmission
  bool nearRings = abs(uRingCamLocal.z) < 2.0e5;
  vec3 lp = ringLocalFromRel(p);
  float zl = nearRings ? lp.z : p.z + uCamPos.z;
  vec2 tSun = vec2(1.0);
  vec3 Fl = vec3(0.0), Fd = vec3(0.0);
  if (nearRings) {
    RingSample rs = ringSampleIdx(ringIdxFromLocal(lp), 0.0);
    float H = max(rs.H, 0.5);
    vec2 sh = vec2(dot(uSunDir, uRingER), dot(uSunDir, uRingEPhi));
    vec2 sh2 = sh / max(abs(uSunDir.z), 0.02);
    // where the sun ray crosses the mid-plane (when the layer lies sunward of the body)
    RingSample rc = ringSampleIdx(ringIdxFromLocal(vec3(lp.xy + sh2 * max(-sg * zl, 0.0), 0.0)), 0.0);
    // column fractions above the body (fUp) and, for the shadow map's complement, the part the map does not
    // hold (as the particles: unmapped classes whole, mapped ones beyond the sun ray's exit from their boxes)
    vec2 pl2 = vec2(dot(p, uRingER), dot(p, uRingEPhi));
    float shl = max(length(sh), 1e-6);
    vec2 sdir = sh / shl;
    float dzdl = uSunDir.z / shl;
    float fUp = 0.0, fPart = 0.0, wsum = 0.0;
    for (int k = 0; k < LOD_CLASSES; k++) {
      float wk = uLodTauFrac[k];
      if (wk <= 0.0) continue;
      float sig = max(uLodSigZ[k] * H, 0.02);
      float qu = lodGaussQ(zl, sig);
      fUp += wk * qu;
      wsum += wk;
      float qs = sg > 0.0 ? qu : 1.0 - qu;
      if (uShInfo.y > 0.5 && float(k) >= uShInfo.z) {
        float D = uNearAllocD[k];
        float tx = abs(sdir.x) > 1e-6 ? (sign(sdir.x) * D - pl2.x) / sdir.x : 1e9;
        float ty = abs(sdir.y) > 1e-6 ? (sign(sdir.y) * D - pl2.y) / sdir.y : 1e9;
        qs = lodGaussQ(sg * (zl + max(min(tx, ty), 0.0) * dzdl), sig);
      }
      fPart += wk * qs;
    }
    if (uLodTauSub > 0.0) {
      float sig = max(uLodSigZSub * H, 0.02);
      float qu = lodGaussQ(zl, sig);
      fUp += uLodTauSub * qu;
      fPart += uLodTauSub * (sg > 0.0 ? qu : 1.0 - qu);
      wsum += uLodTauSub;
    }
    if (wsum <= 0.0) { float sig = max(0.3 * H, 0.02); fUp = lodGaussQ(zl, sig); fPart = sg > 0.0 ? fUp : 1.0 - fUp; wsum = 1.0; }
    // self-gravity wakes along the sun path (the stratified nodes the medium and the particles use)
    float Ws = 1.0;
    if (uWakeOn > 0.5) {
      float qsun = (sg > 0.0 ? fUp : wsum - fUp) / wsum, acc = 0.0;
      for (int j = 0; j < LOD_SUN_NODES; j++) acc += wakeDensity(lp.xy + sh2 * (ringSunNodeRise(j, qsun, sg * zl / H) * H));
      Ws = acc / float(LOD_SUN_NODES);
    }
    tSun = exp(-vec2(sg > 0.0 ? fUp : wsum - fUp, fPart) * (rc.tau * Ws / mu0));
    // two-stream diffuse field of the layer at the body's depth below the lit face (outside the layer: the
    // glow of the face it is on)
    float tUp = rs.tau * fUp, tDn = rs.tau * (wsum - fUp);
    nearTwoStream(sg > 0.0 ? tUp : tDn, rs.tau, rs.albedo, uNearBeta.x, uNearBeta.y, mu0, Fl, Fd);
    Fl *= Esun * uAstroPlaneW;
    Fd *= Esun * uAstroPlaneW;
  } else {
    tSun = vec2(ringSunTransmission(p, 0.0));
  }
  vSun = Esun * tSun;
  vFl = Fl;
  vFd = Fd;

  // Saturnshine: the sunlit clouds (Lambert-phase sphere) and the ring-lit clouds (disc average of the
  // ringshine table: centre + six points at 0.7 of the projected radius, equal-area weights)
  vec3 dS;
  float Ess = saturnshine(p, dS);
  float dSat = length(uSaturnCenter - p);
  float thS = asin(clamp(uSaturnRadii.x / dSat, 0.0, 1.0));
  vec3 Esat = SATURN_TINT * Ess;
#ifdef ASTRO_RINGSHINE
  {
    vec3 c = -dS;
    vec3 e1 = normalize(cross(abs(c.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0), c)), e2 = cross(c, e1);
    vec3 Er = 0.25 * astroDeckRingshine(c);
    for (int i = 0; i < 6; i++) {
      float ph = float(i) * (TWO_PI / 6.0);
      Er += 0.125 * astroDeckRingshine(c * 0.714 + 0.7 * (cos(ph) * e1 + sin(ph) * e2));
    }
    // a disc of radiance L = A E / pi gives the irradiance pi L sin^2(theta) on a surface facing it
    float s2 = sin(thS) * sin(thS);
    Esat += SATURN_TINT * SATURN_ALB * Er * s2;
  }
#endif
  vec3 upS = vec3(0.0, 0.0, 1.0) - dS.z * dS;
  float ul = length(upS);
  upS = ul > 1e-4 ? upS / ul : normalize(cross(dS, vec3(1.0, 0.0, 0.0)));
  float Ts = 0.0;
  for (int j = 0; j < 3; j++) {
    float fe = j == 0 ? 0.2 : (j == 1 ? 0.5 : 0.8);
    float we = j == 0 ? 0.4 : (j == 1 ? 0.355 : 0.245);
    float ce = cos(fe * thS), se = sin(fe * thS);
    Ts += 0.5 * we * (astroRingTrans(p, zl, dS * ce + upS * se, dSat) + astroRingTrans(p, zl, dS * ce - upS * se, dSat));
  }
  vSatDir = dS;
  vSatE = Esat * Ts;
  vSatT = Ts;
}
