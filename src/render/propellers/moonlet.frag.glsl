// ===== propeller moonlets: fragment shader (src/render/passes/PropellerMoonletPass.ts) ====================
// Ray-traces each moonlet's body and shades it in physical units with the models of the resolved ring particles
// (regolith law ringRegolithIF x the per-body factor that makes a sphere's disk-integrated phase function the ring
// particles' power law). Requires SV_HEADER_ALL.
//  * shape: a triaxial ellipsoid with the proportions of the Hill (Roche) lobe of a body in Saturn's tide, 1 : 0.667 :
//    0.638 (radial : along the orbit : polar; the lobe reaches L1/L2 at r_H radially), scaled to the volume-equivalent
//    radius R = 0.72 r_H of a Roche-lobe-filling moonlet (Porco et al. 2007): the long axis points at Saturn (tidally
//    locked); a mild low-order relief on the shading normal (a rubble-pile aggregate of ring particles);
//  * direct sunlight x Saturn's / the moons' / the other moonlets' shadows x the main rings' column toward the Sun
//    where the surface lies on the unlit side of the ring plane (thin sheet at the crossing point, through
//    sv_ringStructure: the propeller's own partial gaps included);
//  * diffuse light of the ring layer around it: the two-stream field of the layer (as the particles and the
//    astronaut) -- the glow of the face the surface element is on, filling the half-space toward the mid-plane;
//  * Saturnshine (sunlit clouds, an extended source of ~55 deg seen from the A ring), through the rings likewise.
in vec3 vP;
flat in vec3 vC;
flat in vec4 vAxis;
flat in vec4 vSize;
flat in vec4 vPhot;

uniform vec3 uPmW;       // grain albedo w per channel for the regolith law (from the A-ring particle albedo)
uniform vec3 uPmAs;      // spherical albedo per channel (diffusely lit surfaces)
uniform vec2 uPmBeta;    // two-stream back-scatter fractions of the ring layer (diffuse, beam at mu0)
uniform int uPmDebug;    // 1: normals

layout(location = 0) out vec4 outColor;

// Two-stream diffuse fluxes of the ring layer per unit beam irradiance (the same solution as nearTwoStream in
// nearCommon.glsl): at depth t below the lit face, the diffuse irradiance arriving from the lit-face side (Flit)
// and from the dark-face side (Fdark).
void pmTwoStream(float t, float tau, vec3 w, float beta, float beta0, float mu0, out vec3 Flit, out vec3 Fdark) {
  vec3 a = 2.0 * (1.0 - w * (1.0 - beta));
  vec3 b = max(2.0 * w * beta, vec3(1e-5));
  vec3 lam = sqrt(max(a * a - b * b, vec3(1e-8)));
  float k = 1.0 / max(mu0, 0.02);
  vec3 D = lam * lam - k * k;
  D = mix(D, vec3(-1e-3), lessThan(abs(D), vec3(1e-3)));
  vec3 sd = w * (1.0 - beta0), su = w * beta0;
  vec3 U = (sd * (a + k) + b * su) / D;
  vec3 V = ((a - k) * su + b * sd) / D;
  vec3 r = (a - lam) / b;
  vec3 e = exp(-lam * tau);
  float ek = exp(-k * tau);
  vec3 C2 = (U * r * e - V * ek) / (1.0 - r * r * e * e);
  vec3 C1 = -U - C2 * r * e;
  vec3 e1 = exp(-lam * t), e2 = exp(-lam * max(tau - t, 0.0));
  float et = exp(-k * t);
  Flit = max(C1 * e1 + C2 * r * e2 + U * et, vec3(0.0));
  Fdark = max(C1 * r * e1 + C2 * e2 + V * et, vec3(0.0));
}

// mild relief of a rubble pile: a few smooth random undulations of the normal (body coordinates, seed s)
vec3 pmBump(vec3 u, float s) {
  vec3 g = vec3(0.0);
  for (int k = 0; k < 5; k++) {
    vec3 h = hash33i(ivec3(int(s * 1000.0), k, 7));
    vec3 kv = normalize(h - 0.5) * (2.0 + 3.0 * float(k));
    float ph = TWO_PI * hash33i(ivec3(int(s * 1000.0), k, 11)).x;
    g += kv * cos(dot(kv, u) + ph) * (0.06 / (1.0 + float(k)));
  }
  return g;
}

// transmission of the main rings along u from p (local height lz) if the ray crosses the ring plane
float pmRingTrans(vec3 p, float lz, vec3 u) {
  if (abs(u.z) < 1e-6 || lz * u.z >= 0.0) return 1.0;
  vec3 h = p + (-lz / u.z) * u;
  RingSample s = ringSampleLocal(ringLocalFromRel(h), 0.0);
  return exp(-s.tau / max(abs(u.z), 0.02));
}

void main() {
  vec3 rd = normalize(vP);
  vec3 ex = vec3(vAxis.xy, 0.0), ez = vec3(0.0, 0.0, 1.0), ey = cross(ez, ex);
  vec3 S = vSize.xyz;
  vec3 oc = -vC;
  vec3 ro = vec3(dot(oc, ex), dot(oc, ey), dot(oc, ez)) / S;
  vec3 rb = vec3(dot(rd, ex), dot(rd, ey), dot(rd, ez)) / S;
  float A = dot(rb, rb), B = dot(ro, rb), C = dot(ro, ro) - 1.0;
  float disc = B * B - A * C;
  if (disc < 0.0) discard;
  float sq = sqrt(disc);
  float t = (-B - sq) / A;
  if (t <= 0.0) t = (-B + sq) / A;     // camera inside the body
  if (t <= 0.0) discard;
  vec3 pu = ro + rb * t;               // hit in unit-sphere coordinates
  vec3 nb = pu / S;
  vec3 n = normalize(ex * nb.x + ey * nb.y + ez * nb.z);
  vec3 V = -rd;
  vec3 bmp = pmBump(pu, vAxis.w);
  vec3 ns = normalize(n + ex * bmp.x + ey * bmp.y + ez * bmp.z);
  if (dot(ns, V) < 0.05) ns = n;
  vec3 p = rd * t;
  float mu = max(dot(ns, V), 1e-3);

  // ---- direct sunlight
  float visSat = saturnSunVisibility(p);
  float vis = visSat;
  for (int i = 0; i < MAX_MOONS; i++) {
    if (i >= uMoonCount) break;
    vis *= sphereSunVisibility(p, uMoonPosR[i]);
  }
  vis *= extraSunVisibility(p, int(vAxis.z + 0.5) - 1);
  vec3 lp = ringLocalFromRel(p);
  float lz = lp.z;
  float Tr = pmRingTrans(p, lz, uSunDir);
  float mu0s = dot(ns, uSunDir);
  float cg = dot(uSunDir, V);
  vec3 L = vec3(0.0);
  if (mu0s > 0.0 && vis * Tr > 0.0) {
    vec3 IF = vec3(ringRegolithIF(mu0s, mu, cg, uPmW.r), ringRegolithIF(mu0s, mu, cg, uPmW.g), ringRegolithIF(mu0s, mu, cg, uPmW.b));
    L += uSunE * INV_PI * vis * Tr * vPhot.x * vSize.w * IF;
  }
  // ---- Saturnshine (extended source), through the rings
  vec3 dS;
  float Es = saturnshine(p, dS);
  if (Es > 0.0) {
    float thS = asin(clamp(uSaturnRadii.x / length(uSaturnCenter - p), 0.0, 1.0));
    float cS = extendedSourceCosine(dot(ns, dS), sin(thS));
    if (cS > 0.0) {
      float cgS = dot(dS, V);
      vec3 IFs = vec3(ringRegolithIF(cS, mu, cgS, uPmW.r), ringRegolithIF(cS, mu, cgS, uPmW.g), ringRegolithIF(cS, mu, cgS, uPmW.b));
      L += Es * INV_PI * pmRingTrans(p, lz, dS) * vSize.w * IFs;
    }
  }
  // ---- diffuse light of the ring layer: the glow of the face this surface element is on
  RingSample rl = ringSampleLocal(vec3(lp.xy, 0.0), 0.0);
  if (rl.tau > 0.0) {
    float sz = uSunDir.z;
    float sg = sz >= 0.0 ? 1.0 : -1.0;
    float mu0 = max(abs(sz), 1e-3);
    bool litSide = lz * sg >= 0.0;
    vec3 Fl, Fd;
    pmTwoStream(litSide ? 0.0 : rl.tau, rl.tau, rl.albedo, uPmBeta.x, uPmBeta.y, mu0, Fl, Fd);
    vec3 F = litSide ? Fd : Fl;
    float toward = litSide ? -sg : sg;   // z direction toward the layer
    // (F per unit irradiance normal to the solar beam; a facet gets F (1 + cos) / 2 of a uniform half-space)
    L += uPmAs * vSize.w * INV_PI * (uSunE * visSat) * F * 0.5 * (1.0 + ns.z * toward);
  }
  if (uPmDebug == 1) L = (ns * 0.5 + 0.5) * 0.3;
  outColor = vec4(L, t);
  gl_FragDepth = logDepth01(viewDepth(p));
}
