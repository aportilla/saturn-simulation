// Spectral color helpers shared by the moon and star builds.
// CIE 1931 2-deg colour-matching functions: multi-lobe Gaussian fit of Wyman, Sloan & Shirley (2013, JCGT 2(2)).
// Linear sRGB (Rec.709 primaries). White point convention of the renderer: sunlight = (1,1,1), so colours are
// divided channel-wise by the RGB of the solar spectrum and normalised to unit luminance.
function g(x, mu, s1, s2) {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
export function cmf(l) {
  const X = 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
  const Y = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
  const Z = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
  return [X, Y, Z];
}
export function planck(lnm, T) {
  const c2 = 1.4387769e7; // nm K
  return 1 / (Math.pow(lnm, 5) * (Math.exp(c2 / (lnm * T)) - 1));
}
export function xyzToLinearSrgb([X, Y, Z]) {
  return [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
}
export function spectrumRgb(S) {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 2) {
    const s = S(l);
    const c = cmf(l);
    X += s * c[0]; Y += s * c[1]; Z += s * c[2];
  }
  return xyzToLinearSrgb([X, Y, Z]);
}
export const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** Ballesteros (2012, EPL 97, 34008) effective temperature from B-V. */
export function ballesterosT(bv) {
  const b = Math.max(-0.4, Math.min(2.0, bv));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}
export const SUN_BV = 0.653; // Ramirez et al. 2012
export const SUN_VR = 0.356; // Cousins, Ramirez et al. 2012
export const SUN_T = ballesterosT(SUN_BV); // ~5767 K: a solar-colour star maps to exactly white
const SUN_RGB = spectrumRgb((l) => planck(l, SUN_T));

/** Star tint from B-V: blackbody at the Ballesteros temperature, white-balanced to the Sun, unit luminance. */
export function starTint(bv) {
  const T = ballesterosT(bv);
  const c = spectrumRgb((l) => planck(l, T)).map((v, i) => v / SUN_RGB[i]);
  const L = lum(c);
  return c.map((v) => Math.max(0, v / L));
}

/**
 * Reflectance tint of a body from its disk-integrated colour indices (B-V, V-R Cousins): reflectance relative
 * to the Sun is piecewise linear through B (440 nm), V (550 nm), R (640 nm); illuminated by the solar spectrum,
 * white-balanced to the Sun, unit luminance (so albedo x tint keeps the V-band albedo).
 */
export function reflectanceTint(bv, vr) {
  const rB = Math.pow(10, -0.4 * (bv - SUN_BV));
  const rR = Math.pow(10, 0.4 * (vr - SUN_VR));
  const rho = (l) => {
    if (l <= 440) return rB;
    if (l <= 550) return rB + ((1 - rB) * (l - 440)) / 110;
    if (l <= 640) return 1 + ((rR - 1) * (l - 550)) / 90;
    return rR;
  };
  const c = spectrumRgb((l) => planck(l, 5772) * rho(l)).map((v, i) => v / spectrumRgb((ll) => planck(ll, 5772))[i]);
  const L = lum(c);
  return c.map((v) => v / L);
}
