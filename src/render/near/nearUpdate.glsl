// ===== near-field update pass (one fragment per particle slot of one size class) ===============
// Output (RGBA32F): xyz = particle center relative to the camera (SEF axes, m);
//                   w = +a if drawn in the main view, -a if present but not drawn, 0 if absent.
//
// Kinematics (exact linear solution of Hill's equations in the local frame, x radial, y prograde):
//   x  = x_g + A cos(th),            th = kappa (t - tRef) + phi
//   y  = y_g(t) - 2 (Omega/kappa) A sin(th),   y_g(t) = Y_e - q Omega x_g (t - t_e)   (Y_e: state texture)
//   z  = B cos(nu (t - tRef) + psi)
// plus the self-gravity wake displacement evaluated at the epicyclic position (x, y).
// The box is shearing-periodic: copy n of a particle sits at x_g + 2Dn and drifts relative to copy 0 at
// -q Omega 2Dn; the copy shown is the one inside the box around the camera. Copies switch exactly at
// the box edge, where the LOD window is zero, so the box following the camera is invisible.

uniform sampler2D tState;   // R: Y_e (guiding-center y relative to the box reference, m)
uniform int uTexW;
uniform int uRow0;
uniform int uCount;
uniform int uClass;
uniform int uSeed;
uniform float uBoxD;        // box half-size D (m)
uniform vec3 uRad;          // (aLo, aHi, power-law q)
uniform vec2 uSig;          // (sigma_x epicycle, sigma_z vertical) (m)
uniform vec2 uCamMod;       // (camLocal - c0) mod 2D, components in [0, 2D)
uniform vec4 uKin;          // (kappa phase, nu phase, Omega/kappa, 0)
uniform vec4 uShear;        // (q Omega (t - t_e), bulk drift mod 2D (m), F = frac(q Omega (t - tRef)), G = frac(n_cam F))
uniform float uTauBoxMax;
uniform float uTauCam;      // macroscopic tau at the camera's radius
uniform float uCull;        // > 0: statistical occlusion culling beyond this line-of-sight optical depth

layout(location = 0) out vec4 o;

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  int i = (tc.y - uRow0) * uTexW + tc.x;
  if (i >= uCount) { o = vec4(0.0); return; }
  uint idx = uint(i), seed = uint(uSeed);
  float D = uBoxD, D2 = 2.0 * D;

  // --- epicyclic position relative to the camera (box copy containing the camera)
  float xg = (2.0 * nearU(idx, seed, NS_XG) - 1.0) * D;
  float A = min(uSig.x * sqrt(-2.0 * log(nearU(idx, seed, NS_EA))), 0.7 * D);
  float th = uKin.x + TWO_PI * nearU(idx, seed, NS_EP);
  float ct = cos(th), st = sin(th);
  float xr = xg + A * ct - uCamMod.x;
  float nl = floor((xr + D) / D2);
  float qx = xr - D2 * nl;
  float Y = texelFetch(tState, tc, 0).r - uShear.x * xg - uShear.y - 2.0 * uKin.z * A * st;
  Y -= D2 * fract(uShear.w - nl * uShear.z);
  float yr = Y - uCamMod.y;
  float qy = yr - D2 * floor((yr + D) / D2);

  // --- presence: thin by the macroscopic optical depth at the guiding-center radius (empty gaps)
  vec3 lgc = vec3(uRingCamLocal.x + qx - A * ct, uRingCamLocal.y + qy, 0.0);
  RingSample rs = ringSampleIdx(ringIdxFromLocal(lgc), 0.0);
  float tauM = rs.tau * (1.0 - rs.dust);
  if (nearU(idx, seed, NS_PRES) * uTauBoxMax >= tauM) { o = vec4(0.0); return; }
  float a = nearRadius(nearU(idx, seed, NS_RAD), uRad.x, uRad.y, uRad.z);

  // --- vertical oscillation
  float B = uSig.y * sqrt(-2.0 * log(nearU(idx, seed, NS_VA)));
  float z = B * cos(uKin.y + TWO_PI * nearU(idx, seed, NS_VP));

  // --- self-gravity wakes, faded out at the box edge (where the LOD window is ~0)
  vec2 ql = vec2(uRingCamLocal.x + qx, uRingCamLocal.y + qy);
  float fw = 1.0 - smoothstep(0.85 * D, D, max(abs(qx), abs(qy)));
  vec2 dw = fw > 0.0 ? wakeDisplacement(ql) * fw : vec2(0.0);

  vec3 pl = vec3(qx + dw.x, qy + dw.y, z - uRingCamLocal.z);          // camera-relative, local axes
  vec3 p = pl.x * uRingER + pl.y * uRingEPhi + vec3(0.0, 0.0, pl.z);  // camera-relative, SEF axes
  float s = length(pl);

  // --- LOD (shared contract) with a temporally stable per-particle threshold
  bool drawn = nearU(idx, seed, NS_LOD) < lodDrawProb(a, uClass, s);
  float rb = 1.2 * a; // conservative bounding radius (ellipsoid major semi-axis <= ~1.15 a)
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
    RingSample rm = ringSampleIdx(ringIdxFromLocal(vec3(uRingCamLocal.x + 0.5 * pl.x, uRingCamLocal.y + 0.5 * pl.y, 0.0)), 0.0);
    float tauPath = min(min(uTauCam, tauM), rm.tau * (1.0 - rm.dust)) * wakeMinDensity() * 0.8;
    float tl = ringLayerSegmentTau(zc, zt, d, tauPath, rs.H);
    if (tl > uCull) drawn = false;
  }
  o = vec4(p, drawn ? a : -a);
}
