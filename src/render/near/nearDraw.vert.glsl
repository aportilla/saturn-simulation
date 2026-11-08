// ===== near-field draw: vertex stage (points for small/medium particles, quads for large ones) ======
// Particles smaller than half a render pixel are flat discs of half a render pixel, rasterized with
// probability (rho / 0.5)^2 (expected coverage = true coverage; at render scale 1 that only concerns the
// 0.4-0.5 display-px handover band: every particle >= 1 display px is drawn at its true size). Each vertex
// fetches its particle through the compacted list (HistoPyramid). Per drawn particle: projected footprint, body
// orientation, ellipsoid axes, albedo, and the lighting environment at the particle center:
//   sunlight  x Saturn/moon occultation x layer transmission: inside the shadow-map tube the map's
//             discrete visibility x the statistically unresolved part, elsewhere the whole column; the
//             statistical column is scaled by the self-gravity-wake density along the sun path (as the
//             medium) and corrected for interparticle shadow hiding near opposition
//   Saturnshine (Saturn is ~55 deg across, half its disk seen through the layer above, half below)
//   multiply-scattered ring light: two-stream diffuse fluxes at the particle's depth (as the medium)
// (tR0, uTexW, class tables, nearClassify and the compacted-list traversal are included before this)
uniform float uQuad;      // 0: point-sprite pass, 1: quad pass (particles too large / close for sprites)
uniform float uClsSpinW[LOD_CLASSES];   // per class: (Omega/8) (t - tRef) mod 2pi
uniform vec2 uNearBeta;   // two-stream back-scatter fractions of the particle phase function: (diffuse, beam at mu0)
uniform vec4 uNearEnv;    // per frame: (Saturn sun visibility, Saturnshine irradiance, Saturn ang. radius, per-particle moons)
uniform vec4 uNearEnv2;   // per frame: (fraction of the layer column above the camera, -, -, -)
uniform vec3 uNearSatDir; // per frame: direction to Saturn's center (SEF)
uniform float uNearAllocD[LOD_CLASSES];   // half-size of each class's allocated particle box (m; >= the LOD window)

flat out vec4 vC;         // center (camera-relative SEF, m), 1 = tiny (flat disc of half a render pixel) else 0
flat out vec4 vQ;         // body -> world orientation
flat out vec4 vAx;        // ellipsoid semi-axes (m), w = sprite size (px)
flat out vec4 vAlb;       // albedo rgb, w = surface texture seed
flat out vec4 vE;         // (E_sun (W/m^2) x Saturn/moon visibility, E_saturn (attenuated), 1 = shadow lookup needed, Lambert->phase factor)
flat out vec4 vSS;        // direction to Saturn (SEF), w = shadow-map weight
flat out vec4 vTiny;      // flat-disc radiance (rgb) for sub-pixel particles, w = view depth of the center
flat out vec2 vT;         // layer transmission of sunlight: (whole column, part not resolved by the shadow map)
flat out vec3 vFl;        // multiply-scattered ring light arriving from the lit-face side (W/m^2, rgb)
flat out vec3 vFd;        // ... and from the dark-face side

void reject() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 1.0;
  vC = vec4(0.0);
}

void main() {
  bool quad = uQuad > 0.5;
  ivec2 tc;
  if (!nearListFetch(quad ? 1 : 0, quad ? gl_InstanceID : gl_VertexID, tc)) { reject(); return; }
  int k = nearClassOfRow(tc.y);
  vec4 r0 = texelFetch(tR0, tc, 0);
  vec3 c = r0.xyz;
  float a = r0.w;
  uint idx = uint((tc.y - uClsRow0[k]) * uTexW + tc.x), seed = uint(uClsSeed[k]);
  vec3 ax = a * nearShape(idx, seed);
  float rb = ax.x;
  float s = length(c);
  vec3 v = uWorldToCam * c;
  float w = -v.z;
  float sinB = rb / s;
  // largest semi-axis of the projected ellipse (px), including the off-axis stretch
  float cosT = clamp(w / s, -1.0, 1.0);
  float rpx = (w > 0.0) ? sinB / sqrt(max(1.0 - sinB * sinB, 1e-6)) / (uPixelAngle * cosT * cosT) : 1e9;

  // smaller than half a render pixel: flat disc of half a render pixel (the classifier rasterizes it with
  // probability (rho / 0.5)^2 x the handover fraction, so its expected coverage is its true one)
  float rho = a / (s * uPixelAngle);                  // equivalent-sphere radius (render px)
  bool tiny = rho < 0.5 && !quad;
  vC = vec4(c, tiny ? 1.0 : 0.0);
  vQ = nearOrientation(idx, seed, a, uClsSpinW[k]);
  vTiny = vec4(0.0, 0.0, 0.0, w);

  // --- material
  vec3 lp = ringLocalFromRel(c);
  RingSample rs = ringSampleIdx(ringIdxFromLocal(lp), 0.0);
  float tau = rs.tau, H = max(rs.H, 0.5);
  vec3 alb = clamp(rs.albedo * nearAlbedoFactor(idx, seed), 0.0, 0.95);

  // --- lighting environment at the center
  float zl = lp.z;
  // Saturn's penumbra (~100 km) and Saturnshine vary negligibly across the near field: per-frame values from
  // the CPU; moon shadows are evaluated per particle only when one can reach the near field
  float vis = uNearEnv.x * (uNearEnv.w > 0.5 ? moonsSunVisibility(c, -1) : 1.0);
  float mu0 = max(abs(uSunDir.z), 1e-3);
  float sg = uSunDir.z >= 0.0 ? 1.0 : -1.0;
  // layer columns in one pass over the size classes: above z (tUp), sunward beyond the class boxes (part),
  // and the vertical density at z (for the view path)
  vec2 pl2 = vec2(dot(c, uRingER), dot(c, uRingEPhi));
  vec2 sh = vec2(dot(uSunDir, uRingER), dot(uSunDir, uRingEPhi));
  float shl = max(length(sh), 1e-6);
  vec2 sdir = sh / shl;
  float dzdl = uSunDir.z / shl;
  float fUp = 0.0, fPart = 0.0, gz = 0.0, wsum = 0.0;
  for (int kk = 0; kk < LOD_CLASSES; kk++) {
    float wk = uLodTauFrac[kk];
    if (wk <= 0.0) continue;
    float sig = max(uLodSigZ[kk] * H, 0.02);
    float qu = lodGaussQ(zl, sig);
    fUp += wk * qu;
    gz += wk * lodGaussPdf(zl, sig);
    wsum += wk;
    float qs = sg > 0.0 ? qu : 1.0 - qu;
    if (uShInfo.y > 0.5 && float(kk) >= uShInfo.z) {
      // the map holds every present particle of this class out to the edge of its allocated box (not just
      // the LOD window): only the column beyond that edge is statistical
      float D = uNearAllocD[kk];
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
    gz += uLodTauSub * lodGaussPdf(zl, sig);
    fPart += uLodTauSub * (sg > 0.0 ? qu : 1.0 - qu);
    wsum += uLodTauSub;
  }
  if (wsum <= 0.0) { float sig = max(0.3 * H, 0.02); fUp = lodGaussQ(zl, sig); gz = lodGaussPdf(zl, sig); fPart = sg > 0.0 ? fUp : 1.0 - fUp; wsum = 1.0; }
  float tUp = tau * fUp, tDn = tau * (wsum - fUp);
  // statistical sun path scaled by the self-gravity-wake density along the slanted path (sampled where it
  // crosses the bulk of the column, as the ring-layer medium does): wake gaps let sunlight through, which
  // dominates the brightness of the unlit face
  // (the stratified nodes of sv_ringLod ringSunNodeRise, exactly as the medium: a noisier estimate has more
  // variance and, through the convexity of exp(-tau W / mu0), would make the particles systematically brighter)
  float Ws = 1.0;
  if (uWakeOn > 0.5) {
    vec2 sh2 = sh / max(abs(uSunDir.z), 0.02);
    float qsun = (sg > 0.0 ? fUp : wsum - fUp) / wsum, acc = 0.0;
    for (int j = 0; j < LOD_SUN_NODES; j++) acc += wakeDensity(lp.xy + sh2 * (ringSunNodeRise(j, qsun, sg * zl / H) * H));
    Ws = acc / float(LOD_SUN_NODES);
  }
  vec2 tauSun = vec2(sg > 0.0 ? tUp : tDn, tau * fPart) * (Ws / mu0);  // slant: (whole column, part the map can't resolve)
  float mapW = nearShadowCoverage(c);
  vec3 vdir = -c / s;                                  // particle -> camera
  float cosA = dot(uSunDir, vdir);
  // interparticle shadow hiding (as in the ring-layer medium): near opposition the sunward and viewing paths
  // share their occluders, joint transmission exp(-tau_i - tau_e + b min(tau_i, tau_e)), b = 1/(1+tan(a/2)/h),
  // h = 3D/8, D = Sigma/(450 H) the volume filling factor. Applied to the statistical part only (the shadow map
  // resolves this correlation geometrically for the mapped particles).
  float dzv = uRingCamLocal.z - zl;
  float Lv = sqrt(dot(c.xy, c.xy) + dzv * dzv);
  float tauView = abs(dzv) > 0.04 * H + 1e-3 ? abs(tUp - tau * uNearEnv2.x) * Lv / abs(dzv) : tau * gz * Lv;
  float hFill = 0.375 * clamp(rs.sigma / (450.0 * H), 1e-4, 0.6);
  float bSh = 1.0 / (1.0 + tan(0.5 * acos(clamp(cosA, -1.0, 1.0))) / hFill);
  vT = exp(-tauSun + bSh * min(tauSun, vec2(tauView)));
  float Esun = uSunE * vis;
  vec3 dS = uNearSatDir;
  float Ess = uNearEnv.y;
  float thS = uNearEnv.z;
  float Tup = 0.0, Tdn = 0.0;
  for (int j = 0; j < 3; j++) {
    float fe = j == 0 ? 0.2 : (j == 1 ? 0.5 : 0.8);
    float we = j == 0 ? 0.4 : (j == 1 ? 0.355 : 0.245);
    float se = max(sin(fe * thS), 0.02);
    Tup += we * exp(-tUp / se);
    Tdn += we * exp(-tDn / se);
  }
  Ess *= 0.5 * (Tup + Tdn);
  // multiply-scattered ring light: two-stream diffuse fluxes at the particle's depth below the lit face, with
  // the back-scatter fractions of the particle phase function (src/render/rings/phase.ts, as the medium)
  vec3 Fl, Fd;
  nearTwoStream(sg > 0.0 ? tUp : tDn, tau, rs.albedo, uNearBeta.x, uNearBeta.y, mu0, Fl, Fd);
  float Ediff = uSunE * vis;
  vFl = Fl * Ediff;
  vFd = Fd * Ediff;
  // photometry: regolith-covered particles follow the power-law phase function (ringParticlePhase, incl. the
  // opposition surge); resolved particles are Lambert-shaded per pixel and rescaled so that their
  // disk-integrated phase function is the power law (no seam with the medium they replace)
  float cosSS = dot(dS, vdir);
  float fSun = ringParticleLambertFactor(cosA);
  float fSS = ringParticleLambertFactor(cosSS);
  // the shadow-map lookup only matters where unshadowed direct sunlight would not be negligible next to the
  // multiply-scattered light (< 1% of it: deep in dense rings, in eclipse); elsewhere the statistical mean
  float dirMax = Esun * mix(vT.x, vT.y, mapW) * fSun;
  float needSh = mapW > 0.0 && dirMax > 0.01 * dot(Fl + Fd, vec3(0.5 / 3.0)) * Ediff ? 1.0 : 0.0;

  vAlb = vec4(alb, float(nearHash(idx, seed, NS_TEX) >> 9u) * (1.0 / 8388608.0));
  vE = vec4(Esun, Ess * fSS, needSh, fSun);
  vSS = vec4(dS, mapW);

  if (tiny) {
    // sub-render-pixel: flat disc with the disc-averaged radiance of the particle; shadows from the caster map
    // as a sharp point sample at the center (the particle itself excluded)
    float T = needSh > 0.5 ? mix(vT.x, vT.y * nearShadowVisibilityPoint(c, c), mapW) : vT.x;
    // diffuse light seen on the visible hemisphere, weighted like the medium (back-scatter fraction beta)
    float cb = (2.0 * uNearBeta.x - 1.0) * sg * vdir.z;
    vec3 Ed = vFl * (0.5 + 0.5 * cb) + vFd * (0.5 - 0.5 * cb);
    vec3 L = alb * INV_PI * (0.25 * Esun * T * ringParticlePhase(cosA) + 0.25 * Ess * ringParticlePhase(cosSS) + Ed);
    vTiny.rgb = L;
  }

  if (!quad) {
    gl_Position = uProj * vec4(v, 1.0);
    gl_Position.z = 0.0;   // depth is written per fragment
    float sz = 2.0 * (tiny ? 0.5 : rpx) + 2.0;
    gl_PointSize = sz;
    vAx = vec4(ax, sz);
  } else {
    // camera-facing quad in front of the particle covering its tangent cone
    int corner = gl_VertexID;   // 0..5 -> two triangles
    int cid = corner == 0 ? 0 : (corner == 1 || corner == 4) ? 1 : (corner == 2 || corner == 3) ? 2 : 3;
    vec2 cxy = vec2((cid & 1) == 1 ? 1.0 : -1.0, (cid & 2) == 2 ? 1.0 : -1.0);
    vec3 dirv = v / s;                                   // view-space direction to the center
    vec3 up = abs(dirv.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 e1 = normalize(cross(up, dirv)), e2 = cross(dirv, e1);
    float dq = max(s - rb, 2e-3);
    float h = dq * sinB / sqrt(max(1.0 - sinB * sinB, 1e-4)) * 1.05 + 2e-3;
    vec3 pv = dirv * dq + (e1 * cxy.x + e2 * cxy.y) * h;
    gl_Position = uProj * vec4(pv, 1.0);
    gl_Position.z = 0.0;
    vAx = vec4(ax, 4096.0);   // (no sprite) full surface detail
  }
}
