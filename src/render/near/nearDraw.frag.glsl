// ===== near-field draw: fragment stage ======================================================
// Sub-render-pixel particles: flat disc of half a render pixel with the disc-averaged radiance (per particle).
// Resolved particles (spheres below high quality):
//   * shape: high quality, >= NR_PX0 render px radius: the displaced surface r(u) = kappa (1 + amp h(u)) of the
//     axis-scaled body frame (nearRelief, nearCommon.glsl) is ray-marched between its inner and outer shells
//     (uniform steps + bisection, exact depth), with soft self-shadowing toward the Sun inside the outer shell;
//     smaller: exact ray / triaxial-ellipsoid intersection with the same relief as a normal perturbation
//     (layers by on-screen size), so outline and shading follow one field;
//   * shading: regolith surface law (ringRegolithIF: Hapke roughness 30 deg, back-scattering grains) for the Sun
//     and for Saturnshine (Saturn's extended disc through extendedSourceCosine), each times its per-particle
//     factor (nearRegolithFactor) that makes a sphere's disk-integrated phase function the power law of the
//     medium; multiply-scattered ring light stays cosine-weighted (a near-isotropic field, as in the medium);
//     albedo patchiness tied to the relief (mean 1);
//   * shadows of the nearby particles from their analytic (relief-profiled) outlines (NearShadow.ts: edges
//     smoothed over the physical penumbra or one pixel, whichever is larger); exact depth.
flat in vec4 vC;
flat in vec4 vQ;
flat in vec4 vAx;
flat in vec4 vAlb;
flat in vec4 vE;
flat in vec4 vSS;
flat in vec4 vTiny;
flat in vec2 vT;
flat in vec3 vFl;
flat in vec3 vFd;
flat in vec3 vLitN;   // local layer normal toward its lit face (vertical relief)
flat in vec4 vDisp;
flat in vec4 vRel;

uniform int uDebug;
uniform vec2 uNearBeta;   // (diffuse back-scatter fraction, beam back-scatter fraction at mu0)
uniform vec4 uNearEnv;    // (Saturn sun visibility, Saturnshine irradiance, Saturn ang. radius, per-particle moons)

layout(location = 0) out vec4 outColor;

// implicit surface of the displaced body in the axis-scaled frame: < 0 inside (value-only relief)
float nearSurfF(vec3 y, int layers) {
  float r = length(y);
  return r - vDisp.y * (1.0 + vDisp.x * nearReliefH(y / r, vRel, layers));
}

void main() {
  if (vC.w > 0.5) {
    // sub-render-pixel particle: flat disc of half a render pixel (rasterized with probability (rho/0.5)^2)
    vec2 pc = (gl_PointCoord - 0.5) * vAx.w;
    if (dot(pc, pc) > 0.25) discard;
    outColor = vec4(vTiny.rgb, length(vC.xyz));
    if (uDebug == 15) { float W = wakeDensity(ringLocalFromRel(vC.xyz).xy); outColor.rgb = W > 1.0 ? vec3(1.0, 0.1, 0.1) : vec3(0.1, 0.2, 1.0); }
    gl_FragDepth = logDepth01(vTiny.w);
    return;
  }
  vec3 rd = cameraRayDir(gl_FragCoord.xy / uResolution);
  vec3 c = vC.xyz;
  // ray relative to its point of closest approach to the center (no cancellation for small, distant particles)
  float b = dot(c, rd);
  vec3 o = b * rd - c;
  vec3 ob = nearQRotInv(vQ, o) / vAx.xyz;
  vec3 db = nearQRotInv(vQ, rd) / vAx.xyz;
  float A = dot(db, db), Bh = dot(ob, db), C0 = dot(ob, ob);
  float spx = vAx.w;                      // sprite size (px; 4096 for quads)
  float amp = vDisp.x;
  bool relief = uNearQuality > 1.5 && uDebug != 31;
  // relief layers of the march (cost) and of the shading normal, by on-screen size (a layer's features span >= ~2
  // px: n2 above ~14 px sprites, c2 above ~22, n3 above ~40): the marched surface's normal uses its own geometric
  // layers (+ the low-slope detail layer when large), so no normal faces away from where the geometry is visible;
  // the analytic ellipsoid gets the coarse layers as a normal perturbation
  int geoL = spx > 48.0 ? 4 : 3;
  int nrmL = amp > 0.0 ? (spx > 40.0 ? 5 : geoL) : (spx > 14.0 ? 3 : 2);
  float tl;
  if (amp <= 0.0) {
    float disc = Bh * Bh - A * (C0 - 1.0);
    if (disc < 0.0) discard;
    tl = (-Bh - sqrt(disc)) / A;
    if (b + tl <= 1e-3) discard;
  } else {
    // ray-march the displaced surface between the shells kappa (1 + amp hLo) .. kappa (1 + amp hHi)
    float disc = Bh * Bh - A * (C0 - vDisp.w * vDisp.w);
    if (disc < 0.0) discard;
    float sq = sqrt(disc);
    float t0 = max((-Bh - sq) / A, 1e-3 - b);       // (not behind the camera)
    float t1 = (-Bh + sq) / A;
    float dIn = Bh * Bh - A * (C0 - vDisp.z * vDisp.z);
    if (dIn > 0.0) t1 = min(t1, (-Bh - sqrt(dIn)) / A);   // the inner core is solid: F(t1) <= 0
    if (t1 <= t0) discard;
    // sphere tracing: |dF/dt| <= L (Lipschitz bound of the relief, value-only textures); steps of 2 F / L
    // (over-relaxed: the bound is ~3x the typical slope) and at least 1/32 of the shell crossing, a sign change
    // refined by bisection; converged when F < 2e-4 radii. (A crossing can only be missed by a relief sliver
    // thinner than one step: at grazing incidence on the outline.)
    float L = sqrt(A) * (1.0 + vDisp.y * amp * nearReliefSlope(vRel.w, geoL) / max(vDisp.z, 0.3));
    float dtMin = (t1 - t0) * (1.0 / 32.0);
    float tk = t0, ta = t0;
    float F = nearSurfF(ob + tk * db, geoL);
    if (F < 0.0) discard;                                  // (camera inside the body)
    bool hit = false;
    for (int k = 0; k < 40; k++) {
      if (F < 2e-4) { hit = true; break; }
      ta = tk;
      tk = min(tk + max(2.0 * F / L, dtMin), t1);
      F = nearSurfF(ob + tk * db, geoL);
      if (F < 0.0) {
        float tb = tk;
        for (int m = 0; m < 6; m++) {
          float tm = 0.5 * (ta + tb);
          if (nearSurfF(ob + tm * db, geoL) < 0.0) tb = tm; else ta = tm;
        }
        tk = 0.5 * (ta + tb);
        hit = true;
        break;
      }
      if (tk >= t1) break;
    }
    if (!hit) discard;
    tl = tk;
  }
  float t = b + tl;
  vec3 pb = ob + tl * db;                 // hit point, axis-scaled body frame (base ellipsoid = unit sphere)
  float pr = length(pb);
  vec3 u = pb / pr;

  // relief at the hit point: shading normal of F(y) = |y| - kappa (1 + h(u)) at full amplitude (a normal
  // perturbation on the analytic ellipsoid, the true normal of the marched surface); albedo patchiness
  vec4 hr = relief && spx > 7.0 ? nearRelief(u, vRel, nrmL) : vec4(0.0);
  vec3 gt = (hr.yzw - dot(hr.yzw, u) * u) * (vDisp.y / pr);
  vec3 ngb = normalize((u - amp * gt) / vAx.xyz);    // geometric normal (base ellipsoid / marched surface)
  // + the absolute-scale regolith texture where it is resolved (pixel footprint on the surface)
  float aM = (vAx.x + vAx.y + vAx.z) * (1.0 / 3.0);
  if (relief && spx > 7.0) {
    vec3 ngw = nearQRot(vQ, ngb);
    vec4 rt = nearRegolithTexture(u, vRel, aM, (b + tl) * uPixelAngle / max(abs(dot(ngw, rd)), 0.15));
    gt += (rt.yzw - dot(rt.yzw, u) * u) * (vDisp.y / pr);
  }
  vec3 nb = normalize((u - gt) / vAx.xyz);           // body-frame shading normal (D^-1 grad F)
  float albPatch = 1.0 + 0.6 * hr.x;
  vec3 n = nearQRot(vQ, nb);
  vec3 ng = nearQRot(vQ, ngb);
  vec3 hit = rd * t;
  vec3 vdir = -rd;
  // a perturbed normal cannot face away from the viewer on a visible surface: pull it back to >= 3 deg
  n = normalize(n + max(0.05 - dot(n, vdir), 0.0) * vdir);

  float mu0 = dot(n, uSunDir);
  bool lit = mu0 > 0.0 && dot(ng, uSunDir) > -0.1;
  float T = vT.x;
  float shDbg = 1.0;
  // footprint of one pixel on the surface (its projection onto the sun plane is never larger): shadow edges
  // are smoothed over max(physical penumbra, this) - no aliasing, no unphysical blur
  float rpx = 0.5 * t * uPixelAngle / max(abs(dot(ng, rd)), 0.3);
  // debug 19-22 (raw lookups): 19 at the hit point regardless of the lighting; 20-22 at points 1 km
  // downsun (shadowed wherever a caster outline covers it), 1 km sunward (never shadowed), 50 m sunward
  float dOff = uDebug == 20 ? -1000.0 : (uDebug == 21 ? 1000.0 : (uDebug == 22 ? 50.0 : 0.0));
  bool dbgSh = uDebug >= 19 && uDebug <= 22;
  // (vE.z = 0: the VS found even unshadowed direct sunlight negligible here; one call site keeps the
  // inlined lookup code small)
  if (((lit && vE.z > 0.5) || dbgSh) && vSS.w > 0.0) {
    // analytic shadow outlines of the nearby casters at the exact hit point (the particle itself excluded)
    float sh = nearShadowVisibility(hit + uSunDir * dOff, dOff != 0.0 ? vec3(1e9) : c, rpx);
    T = mix(vT.x, vT.y * sh, vSS.w);
    shDbg = sh;
  }
  // self-shadowing of the marched relief: march toward the Sun inside the outer shell; soft over the larger of
  // the penumbra and the pixel footprint (radial clearance F per cone radius)
  float selfSh = 1.0;
  // (relief slopes are <= ~45 deg in practice: no cast relief shadow where the Sun is > 50 deg above the
  // local tangent plane)
  if (lit && amp > 0.0 && vE.z > 0.5 && dot(ng, uSunDir) < 0.77) {
    vec3 sbs = nearQRotInv(vQ, uSunDir) / vAx.xyz;   // scaled-frame displacement per metre toward the Sun
    float ss2 = dot(sbs, sbs);
    float bq = dot(pb, sbs), cq = pr * pr - vDisp.w * vDisp.w;
    float tEx = (-bq + sqrt(max(bq * bq - ss2 * cq, 0.0))) / ss2;   // metres to the outer shell
    float Ls = sqrt(ss2) * (1.0 + vDisp.y * amp * nearReliefSlope(vRel.w, geoL) / max(vDisp.z, 0.3));
    // sphere tracing toward the Sun (soft: smallest radial clearance per cone radius, the cone being the larger of
    // the penumbra and the pixel footprint), from where the local tangent plane has dropped two footprints below
    // the ray (closer relief is sub-pixel, and the receiving surface itself must not count as an occluder)
    float ts = min(2.0 * rpx / max(dot(ng, uSunDir), 0.05), tEx), occ = 1.0;
    for (int k = 0; k < 12; k++) {
      float Fs = nearSurfF(pb + ts * sbs, geoL);
      occ = min(occ, Fs * aM / max(ts * uSunAngRadius, rpx));
      if (occ < -1.0) break;
      ts += max(2.0 * Fs / Ls, 0.06 * tEx);
      if (ts > tEx) break;
    }
    selfSh = smoothstep(-1.0, 1.0, occ);
  }
  float mu = clamp(dot(n, vdir), 0.02, 1.0);
  float Ssun = lit ? ringRegolithIF(mu0, mu, dot(uSunDir, vdir), vAlb.w) * selfSh : 0.0;
  // Saturnshine: regolith law at Saturn's centre direction with the extended-disc incidence cosine
  float mu0S = extendedSourceCosine(dot(n, vSS.xyz), sin(uNearEnv.z));
  float Sss = mu0S > 0.0 ? ringRegolithIF(mu0S, mu, dot(vSS.xyz, vdir), vAlb.w) : 0.0;
  // multiply-scattered ring light from the two half-spaces (toward the lit face / toward the dark face); the
  // normal weighting 1.5 (2 beta - 1) makes the disk average back-scatter the fraction beta, like the medium
  float cl = 1.5 * (2.0 * uNearBeta.x - 1.0) * dot(n, vLitN);
  vec3 Ed = vFl * (0.5 + 0.5 * cl) + vFd * (0.5 - 0.5 * cl);
  vec3 col = vAlb.rgb * albPatch * INV_PI * (vE.x * T * Ssun * vE.w + vE.y * Sss + Ed);
  if (uDebug == 32) {
    // the former Lambert law (x ringParticleLambertFactor, wrapped Saturnshine) for comparison
    vec3 vc = -c / length(c);
    float fSSr = nearRegolithFactor(dot(vSS.xyz, vc), luminance(vAlb.rgb)).x;
    float ssLit = clamp((dot(n, vSS.xyz) + 0.15) / 1.15, 0.0, 1.0);
    col = vAlb.rgb * albPatch * INV_PI * (vE.x * T * (lit ? mu0 : 0.0) * ringParticleLambertFactor(dot(uSunDir, vc))
        + vE.y / max(fSSr, 1e-6) * ssLit * ringParticleLambertFactor(dot(vSS.xyz, vc)) + Ed);
  }
  if (uDebug == 11) col = vec3(T, lit ? mu0 : 0.0, vSS.w) * 0.5;
  // lighting-term debug views (radiance-scaled so a sunlit albedo-0.5 surface would be ~2.4)
  if (uDebug == 12) col = vec3(vE.x * T / uSunE) * 2.4;             // direct-sun factor (visibility x layer transmission)
  if (uDebug == 13) col = vec3(0.5 * INV_PI * vE.y * Sss) * 4.0;    // Saturnshine term (x4)
  if (uDebug == 14) col = 0.5 * INV_PI * Ed * 4.0;                  // multiply-scattered ring light (x4)
  if (uDebug == 15) { float W = wakeDensity(ringLocalFromRel(c).xy); col = W > 1.0 ? vec3(1.0, 0.1, 0.1) : vec3(0.1, 0.2, 1.0); }
  // shadow-map consistency: on sunlit fragments inside the tube, R = T_part * map visibility, G = T_full
  if (uDebug == 17) col = (lit && vSS.w > 0.99) ? vec3(vT.y * shDbg, vT.x, 1.0) : vec3(0.0);
  if (dbgSh) {
    // raw map visibility: white lit, red shadowed, blue outside the tube (19: dimmed on faces turned away)
    col = vSS.w < 0.5 ? vec3(0.0, 0.0, 0.5) : mix(vec3(0.6, 0.0, 0.0), vec3(1.0), shDbg);
    if (uDebug == 19 && dot(ng, uSunDir) < 0.0) col *= 0.3;
  }
  // 33: ray-marched relief (red = amp), 34: relief self-shadow (white = lit)
  if (uDebug == 33) col = vec3(amp, 0.25 + 0.5 * hr.x * 5.0, 1.0 - amp) * 0.8;
  if (uDebug == 34) col = vec3(selfSh) * (lit ? 1.0 : 0.2);
  outColor = vec4(col, t);
  gl_FragDepth = logDepth01(t * max(-(uWorldToCam * rd).z, 1e-4));
}
