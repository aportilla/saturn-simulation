// ===== near-field update pass (one fragment per particle slot of one size class) ===============
// Output (RGBA32F): xyz = particle center relative to the camera (SEF axes, m);
//                   w = +a if drawn in the main view, -a if present but not drawn, 0 if absent.
//
// Kinematics (exact linear solution of Hill's equations in the local frame, x radial, y prograde):
//   x  = x_g + A cos(th),            th = kappa (t - tRef) + phi
//   y  = y_g(t) - 2 (Omega/kappa) A sin(th),   y_g(t) = Y_e - q Omega x_g (t - t_e)   (Y_e: state texture)
//   z  = B cos(nu (t - tRef) + psi)
// plus the self-gravity wake displacement evaluated at the epicyclic position (x, y).
// Each particle lives in its own shearing-periodic box of half-size D(a) around the camera: the horizontal
// distance beyond which it is below the display-pixel handover band from any camera height the allocation
// serves (src/rings/RingLod.ts), so it is never simulated where it could not be drawn. Copy n of a particle
// sits at x_g + 2Dn and drifts relative to copy 0 at -q Omega 2Dn; the copy shown is the one inside the box
// around the camera. Copies switch exactly at the box edge, where the particle is too small to be drawn, so the
// box is invisible.
//
// Count contract: every particle >= 1 display pixel across is drawn (lodCarryParticle = 1); in the handover
// band (0.4-0.5 display px) the near field carries the fraction lodCarryParticle of its optical depth (the
// classifier rasterizes such particles with that probability, and particles smaller than half a render pixel
// as discs of half a render pixel with probability (rho / 0.5)^2 x lodCarryParticle: expected coverage = true
// coverage). The medium leaves out exactly the class mean of it (lodCarry, sv_ringLod).
// 2-D ring structure (sv_ringStructure, e.g. moonlet-perturbed gap edges): the boxes are LAGRANGIAN -- the guiding
// centre is the particle's unperturbed streamline radius a', presence is tested there (tau0(a')), and the particle
// is drawn displaced by its streamline's xi(a', theta) relative to the camera's xi (uRsCam.x), so the drawn density
// is tau0 J like the medium's. The box copy switches at the Lagrangian box edge, so where streamlines are
// compressed (J > the allocation's zoom headroom, ~1.25) particles near the Eulerian edge of their reach are not
// instantiated (documented limitation: wave crests just downstream of Daphnis).

uniform sampler2D tState;   // R: Y_e (guiding-center y relative to the box reference, m)
uniform int uTexW;
uniform int uRow0;
uniform int uCount;
uniform int uClass;
uniform int uSeed;
// (uRadP / uRadB: the class's radius / box sampler, nearCommon.glsl)
uniform vec2 uSig;          // (sigma_x epicycle, sigma_z vertical) (m)
uniform vec2 uCamOff;       // camera position - box reference c0 (local frame, m)
uniform vec4 uKin;          // (kappa phase, nu phase, Omega/kappa, 0)
uniform vec4 uShear;        // (q Omega (t - t_e), q Omega c0x (t - t_e) (m), F = frac(q Omega (t - tRef)), 0)
uniform float uTauBoxMax;
uniform float uTauCam;      // macroscopic tau at the camera's radius
uniform float uCull;        // > 0: statistical occlusion culling beyond this line-of-sight optical depth

layout(location = 0) out vec4 o;

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  int i = (tc.y - uRow0) * uTexW + tc.x;
  if (i >= uCount) { o = vec4(0.0); return; }
  uint idx = uint(i), seed = uint(uSeed);
  float a, D;
  nearRadiusBox(nearU(idx, seed, NS_RAD), a, D);
  float D2 = 2.0 * D;

  // --- epicyclic position relative to the camera (box copy containing the camera)
  float xg = (2.0 * nearU(idx, seed, NS_XG) - 1.0) * D;
  float A = min(uSig.x * sqrt(-2.0 * log(nearU(idx, seed, NS_EA))), 0.7 * D);
  float th = uKin.x + TWO_PI * nearU(idx, seed, NS_EP);
  float ct = cos(th), st = sin(th);
  float nCam = floor(uCamOff.x / D2);
  float camX = uCamOff.x - D2 * nCam, camY = uCamOff.y - D2 * floor(uCamOff.y / D2);
  float xr = xg + A * ct - camX;
  float nl = floor((xr + D) / D2);
  float qx = xr - D2 * nl;
  float Y = texelFetch(tState, tc, 0).r - uShear.x * xg - (uShear.y - D2 * floor(uShear.y / D2)) - 2.0 * uKin.z * A * st;
  Y -= D2 * fract(fract(nCam * uShear.z) - nl * uShear.z);
  float yr = Y - camY;
  float qy = yr - D2 * floor((yr + D) / D2);

  // --- streamline map: qx is the offset from the camera's LAGRANGIAN position (uCamOff); lgc = the guiding centre
  // in Lagrangian local coordinates; qe = the drawn (Eulerian) radial offset from the camera. (The streamline height
  // zeta, ringStreamXi(..).y, is not applied yet: vertical-relief work package.)
  vec3 lgc = vec3(uRingCamLocal.x - uRsCam.x + qx - A * ct, uRingCamLocal.y + qy, 0.0);
  float aL, dthP;
  ringLocalPolar(lgc, aL, dthP);
  float qe = qx;
  float Jp = 1.0;
  if (uRsCam.w > 0.5) {
    vec3 sx = ringStreamXi(aL, dthP, 0.0);
    qe += sx.x - uRsCam.x;
    Jp = sx.z;
  }

  // --- vertical oscillation
  float B = uSig.y * sqrt(-2.0 * log(nearU(idx, seed, NS_VA)));
  float z = B * cos(uKin.y + TWO_PI * nearU(idx, seed, NS_VP));
  float rb = 1.2 * a; // conservative bounding radius (ellipsoid major semi-axis <= ~1.15 a)

  // --- early out (most slots): a particle that is neither possibly in view and large enough to be drawn nor
  // a possible shadow caster is not needed this frame. Margin: the largest self-gravity wake displacement
  // (two generations of at most half a wavelength each, wavelength <= tile / 6).
  float mw = uWakeOn > 0.5 ? uWakeTile / 6.0 : 0.0;
  vec3 p0 = qe * uRingER + qy * uRingEPhi + vec3(0.0, 0.0, z - uRingCamLocal.z);
  if (!nearShadowCaster(p0, rb + mw, uClass)) {
    float r = rb + mw;
    vec3 v = uWorldToCam * p0;
    float w = -v.z;
    float tx = uTanHalfFov * uAspect, ty = uTanHalfFov;
    bool outside = w < -r || abs(v.x) > w * tx + r * sqrt(1.0 + tx * tx) || abs(v.y) > w * ty + r * sqrt(1.0 + ty * ty);
    if (outside || lodCarryParticle(a, uClass, max(length(p0) - mw, 1e-4), p0.z) <= 0.0) { o = vec4(p0, 0.0); return; }
  }

  // --- presence: thin by the macroscopic optical depth at the guiding-center (Lagrangian) radius (empty gaps)
  RingSample rs = ringSampleLagrangian(aL, 0.0);
  float tauM = rs.tau * (1.0 - rs.dust);
  if (nearU(idx, seed, NS_PRES) * uTauBoxMax >= tauM) { o = vec4(0.0); return; }

  // --- self-gravity wakes (Eulerian field), faded out at the particle's (Lagrangian) box edge, where it is too
  // small to be drawn
  vec2 ql = vec2(uRingCamLocal.x + qe, uRingCamLocal.y + qy);
  float fw = 1.0 - smoothstep(0.85 * D, D, max(abs(qx), abs(qy)));
  vec2 dw = fw > 0.0 ? wakeDisplacement(ql) * fw : vec2(0.0);

  vec3 pl = vec3(qe + dw.x, qy + dw.y, z - uRingCamLocal.z);          // camera-relative, local axes
  vec3 p = pl.x * uRingER + pl.y * uRingEPhi + vec3(0.0, 0.0, pl.z);  // camera-relative, SEF axes
  float s = length(pl);

  // --- count contract (display pixels): every particle >= 1 px across (and the handover band below it) in
  // view and not statistically occluded is drawn; the classifier decides how it is rasterized
  bool drawn = lodCarryParticle(a, uClass, s, pl.z) > 0.0;
  if (drawn) {
    // view frustum (sphere test)
    vec3 v = uWorldToCam * p;
    float w = -v.z;
    float tx = uTanHalfFov * uAspect, ty = uTanHalfFov;
    if (w < -rb || abs(v.x) > w * tx + rb * sqrt(1.0 + tx * tx) || abs(v.y) > w * ty + rb * sqrt(1.0 + ty * ty)) drawn = false;
  }
  if (drawn && uCull > 0.0) {
    // statistical occlusion: optical depth of the slab between the camera and the near side of the particle,
    // using the lowest tau along the path and the emptiest wake-gap density (conservative)
    float d = max(length(pl.xy) - rb, 0.0);
    float zc = uRingCamLocal.z;
    float zt = z + clamp(zc - z, -rb, rb);
    RingSample rm = ringSampleLocal(vec3(uRingCamLocal.x + 0.5 * pl.x, uRingCamLocal.y + 0.5 * pl.y, 0.0), 0.0);
    float tauPath = min(min(uTauCam, tauM * Jp), rm.tau * (1.0 - rm.dust)) * wakeMinDensity() * 0.8;
    float tl = ringLayerSegmentTau(zc, zt, d, tauPath, rs.H);
    if (tl > uCull) drawn = false;
  }
  o = vec4(p, drawn ? a : -a);
}
