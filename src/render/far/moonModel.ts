// Per-moon surface / photometric parameters for the far-field renderer.
//
// Photometry (all airless bodies): lunar-Lambert mix with an opposition surge and a macroscopic-roughness
// phase darkening, per surface element:
//   I/F = An * B(a) * exp(-beta a) * [ L(a) 2 mu0/(mu0+mu) + (1-L(a)) mu0 ],  B(a) = 1 + B0/(1 + tan(a/2)/h),
//   L(a) = L0 + (L1-L0) a/pi,   geometric albedo p = An (1+B0) (L0 + (1-L0) 2/3).
// beta was fitted (scratch script, disk integration) so that the phase integral q = A_Bond/p matches
// published values: bright icy q~0.6 (Enceladus p=1.375, A_B=0.81; Verbiscer et al. 2007), dark q~0.3
// (Phoebe p=0.081, A_B=0.023; Buratti et al. 2008), Hyperion q~0.4.
export interface MoonPhotometry { B0: number; h: number; beta: number; L0: number; L1: number }

export const PHOT_BRIGHT_ICY: MoonPhotometry = { B0: 0.6, h: 0.04, beta: 0.53, L0: 0.55, L1: 0.3 };
export const PHOT_ICY: MoonPhotometry = { B0: 0.5, h: 0.05, beta: 0.55, L0: 0.6, L1: 0.35 };
export const PHOT_MEDIUM: MoonPhotometry = { B0: 0.6, h: 0.06, beta: 1.03, L0: 0.8, L1: 0.6 };
export const PHOT_DARK: MoonPhotometry = { B0: 0.9, h: 0.06, beta: 1.245, L0: 0.95, L1: 0.8 };
export const PHOT_SMALL: MoonPhotometry = { B0: 0.5, h: 0.06, beta: 0.81, L0: 0.7, L1: 0.45 };
/** Titan: An = p (the haze-body law in glsl/moons.ts carries its own disk/shell normalisation) */
export const PHOT_TITAN: MoonPhotometry = { B0: 0, h: 0.1, beta: 0, L0: 1, L1: 1 };

/** Procedural surface model ids (must match the GLSL switch in glsl/moons.ts). */
export const MoonMat = {
  Generic: 0, Mimas: 1, Enceladus: 2, Tethys: 3, Dione: 4, Rhea: 5, Titan: 6, Iapetus: 7,
  Hyperion: 8, Phoebe: 9, Small: 10,
} as const;
export type MoonMat = (typeof MoonMat)[keyof typeof MoonMat];

export interface MoonLook {
  mat: MoonMat;
  /** visual geometric albedo used when the provider gives none (or to override obviously wrong values) */
  pGeom?: number;
  /** relative linear-RGB colour of the surface (normalised to G = 1) */
  color: [number, number, number];
  phot: MoonPhotometry;
  /** crater density 0..1 and number of crater octaves for the procedural surface */
  craters: number;
  /** bump strength multiplier */
  bump: number;
  seed: number;
}

const L = (mat: MoonMat, color: [number, number, number], phot: MoonPhotometry, craters: number, bump: number, seed: number, pGeom?: number): MoonLook =>
  ({ mat, color, phot, craters, bump, seed, pGeom });

// Colours: Buratti & Veverka / Cassini ISS colour ratios (icy moons nearly neutral, slightly red; Iapetus dark
// terrain red-brown; Titan orange haze; Hyperion & Phoebe reddish / neutral grey).
export const MOON_LOOKS: Record<string, MoonLook> = {
  mimas: L(MoonMat.Mimas, [1.0, 1.0, 0.97], PHOT_ICY, 0.9, 1.0, 11, 0.962),
  enceladus: L(MoonMat.Enceladus, [0.99, 1.0, 1.02], PHOT_BRIGHT_ICY, 0.35, 0.7, 12, 1.375),
  tethys: L(MoonMat.Tethys, [1.0, 1.0, 0.98], PHOT_ICY, 0.8, 0.9, 13, 1.229),
  dione: L(MoonMat.Dione, [1.0, 0.99, 0.96], PHOT_ICY, 0.75, 0.9, 14, 0.998),
  rhea: L(MoonMat.Rhea, [1.0, 0.98, 0.94], PHOT_ICY, 0.95, 1.0, 15, 0.949),
  titan: L(MoonMat.Titan, [1.5, 1.0, 0.42], PHOT_TITAN, 0, 0, 16, 0.22),
  iapetus: L(MoonMat.Iapetus, [1.04, 1.0, 0.92], PHOT_ICY, 0.8, 1.0, 17, 0.6),
  hyperion: L(MoonMat.Hyperion, [1.16, 1.0, 0.81], PHOT_MEDIUM, 1.0, 1.4, 18, 0.3),
  phoebe: L(MoonMat.Phoebe, [1.02, 1.0, 0.97], PHOT_DARK, 0.9, 1.2, 19, 0.081),
  pan: L(MoonMat.Small, [1.05, 1.0, 0.93], PHOT_SMALL, 0.3, 1.2, 21),
  daphnis: L(MoonMat.Small, [1.05, 1.0, 0.93], PHOT_SMALL, 0.3, 1.2, 22),
  atlas: L(MoonMat.Small, [1.05, 1.0, 0.93], PHOT_SMALL, 0.3, 1.2, 23),
  prometheus: L(MoonMat.Small, [1.06, 1.0, 0.92], PHOT_SMALL, 0.5, 1.4, 24),
  pandora: L(MoonMat.Small, [1.05, 1.0, 0.93], PHOT_SMALL, 0.6, 1.4, 25),
  epimetheus: L(MoonMat.Small, [1.03, 1.0, 0.95], PHOT_SMALL, 0.7, 1.4, 26),
  janus: L(MoonMat.Small, [1.03, 1.0, 0.95], PHOT_SMALL, 0.7, 1.4, 27),
};

const DEFAULT_LOOK: MoonLook = L(MoonMat.Small, [1.05, 1.0, 0.95], PHOT_SMALL, 0.6, 1.3, 31);

export function moonLook(name: string, kind: string): MoonLook {
  const k = name.toLowerCase();
  const l = MOON_LOOKS[k];
  if (l) return l;
  if (kind === 'irregular') return { ...L(MoonMat.Phoebe, [1.03, 1.0, 0.96], PHOT_DARK, 0.8, 1.3, 40 + (k.length * 7) % 50), pGeom: undefined };
  return { ...DEFAULT_LOOK, seed: 40 + (k.charCodeAt(0) * 13 + k.length * 7) % 200 };
}

/** Geometric-albedo factor p/An of the photometric law. */
export function photFactor(p: MoonPhotometry): number {
  return (1 + p.B0) * (p.L0 + (1 - p.L0) * (2 / 3));
}
