// ===== near-field state pass: initialize or re-base the azimuthal guiding centers =================
// State (R32F): Y_e = guiding-center y of copy 0 relative to the box reference c0y at epoch t_e, wrapped
// into [-D, D). Re-basing folds the accumulated shear drift into the state so the per-frame drift term
// q Omega x_g (t - t_e) stays small (float precision) for any warp / direction of time. The update pass
// uses the identical expression, so a re-base never moves a particle.
uniform sampler2D tState;
uniform int uTexW;
uniform int uRow0;
uniform int uCount;
uniform int uSeed;
uniform int uMode;          // 0: initialize, 1: re-base
uniform float uBoxD;
uniform vec4 uShear;        // (q Omega (t - t_e), bulk drift mod 2D (m), -, -)

layout(location = 0) out vec4 o;

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  int i = (tc.y - uRow0) * uTexW + tc.x;
  if (i >= uCount) { o = vec4(0.0); return; }
  uint idx = uint(i), seed = uint(uSeed);
  float D = uBoxD, D2 = 2.0 * D;
  if (uMode == 0) {
    o = vec4((2.0 * nearU(idx, seed, NS_Y0) - 1.0) * D, 0.0, 0.0, 0.0);
    return;
  }
  float xg = (2.0 * nearU(idx, seed, NS_XG) - 1.0) * D;
  float Y = texelFetch(tState, tc, 0).r - uShear.x * xg - uShear.y;
  Y -= D2 * floor((Y + D) / D2);
  o = vec4(Y, 0.0, 0.0, 0.0);
}
