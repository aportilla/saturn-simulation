// Which references the "What you're seeing" explainer (key I) cites for each place: preset id (src/app/presets.ts)
// -> 3–8 ids from src/app/references.ts, most relevant first, chosen for what that view shows and its explainer
// says. Custom views (no preset) get context defaults: by the moon being orbited, else by ring radius.
//
// Kept out of presets.ts on purpose (no imports at all, so Node can load it for scripts/check-refs.mjs, which
// checks that every id below exists and every place has a list). A new place: add `'<preset id>': [...]` here.

export const PLACE_SOURCES: Record<string, string[]> = {
  // ---------------------------------------------------------------- system
  overview: ['archinal2018', 'naifPck00011', 'jplHorizons', 'jacobson2022', 'iess2019', 'colwell2009', 'tiscareno2007'],
  'rings-above': ['corss8001', 'couvis8001', 'colwell2009', 'colwell2010', 'pdsVitalStats', 'dones1993', 'mitchell2013'],
  'edge-on': ['tiscareno2007', 'colwell2006', 'hedman2007a', 'hedman2007c', 'hedman2012', 'poulet2002'],
  // ---------------------------------------------------------------- inside the rings
  'a-ring-inside': ['becker2016', 'zebker1985', 'tiscareno2007', 'tiscarenoharris2018', 'salo1992', 'colwell2006', 'dones1993', 'weidenschilling1984'],
  'a-ring-30m': ['becker2016', 'harbison2013', 'zebker1985', 'colwell2006', 'hapke1984', 'poulet2002', 'dones1993'],
  'a-ring-1km': ['salo1992', 'colwell2006', 'hedman2007b', 'french2007', 'salo2004', 'jerousek2016', 'rein2012'],
  'b-ring-inside': ['hedmannicholson2016', 'colwell2007', 'colwell2010', 'couvis8001', 'marouf2008', 'cuzzi2009', 'robbins2010', 'nicholsonhedman2010'],
  'c-ring-inside': ['jerousek2020', 'harbison2013', 'hedmannicholson2014', 'afigbo2025', 'nicholson2014b', 'baillie2011', 'hedman2011', 'cooke1991'],
  'cassini-division': ['jerousek2020', 'french2016', 'tiscareno2007', 'tiscareno2013', 'nicholson2014a', 'spitale2010', 'hedman2013'],
  shadow: ['archinal2018', 'park2021', 'altobelli2014', 'morishima2010', 'karkoschka1994', 'dones1993'],
  'under-rings': ['salo2004', 'dones1993', 'french2007', 'colwell2010', 'corss8001', 'couvis8001'],
  'bending-wave': ['shu1983', 'sega2024', 'koh2022', 'nicholson2024', 'lissauer1985', 'pia11676', 'jplHorizons'],
  // ---------------------------------------------------------------- gaps and shepherds
  'encke-gap': ['showalter1986', 'cuzzi1985', 'henon1986', 'porco2007', 'weiss2009', 'thomas2018shapes', 'buratti2019', 'charnoz2007'],
  'keeler-gap': ['weiss2009', 'pia11656', 'tajeddine2017', 'henon1986', 'cuzzi1985', 'porco2007', 'thomas2018shapes', 'buratti2019'],
  'propeller-bleriot': ['tiscareno2010', 'seiss2005', 'sremcevic2007', 'sremcevic2002', 'hoffmann2015', 'hoffmann2013', 'porco2007', 'spahn2000'],
  'propeller-belt': ['tiscareno2008', 'tiscareno2006', 'sremcevic2007', 'seiss2005', 'salo1995', 'pia07792', 'spahn2000'],
  'f-ring': ['murray2005', 'albers2012', 'bosh2002', 'porco2007', 'thomas2013', 'thomas2018shapes'],
  // ---------------------------------------------------------------- moons
  enceladus: ['porco2006', 'verbiscer2007', 'thomas2016', 'hedman2012', 'bland2018', 'usgsEnceladus'],
  titan: ['fulchignoni2005', 'archinal2018', 'jacobson2022', 'jplHorizons'],
  mimas: ['pia17214', 'tajeddine2014', 'spitale2010', 'nicholson2014a', 'verbiscer2007', 'archinal2018'],
  iapetus: ['pia18436', 'porco2005', 'spencerdenk2010', 'archinal2018', 'jacobson2022'],
  // ---------------------------------------------------------------- Saturn
  'cloud-tops': ['sanchezlavega2000', 'garciamelendo2011', 'mankovich2019', 'iess2019', 'karkoschka1994', 'archinal2018'],
};

/** Custom views orbiting a moon (label click, or a place without a list): lower-case moon name -> ids. */
export const MOON_SOURCES: Record<string, string[]> = {
  pan: ['thomas2018shapes', 'buratti2019', 'charnoz2007', 'porco2007', 'showalter1986'],
  daphnis: ['thomas2018shapes', 'buratti2019', 'weiss2009', 'porco2007'],
  atlas: ['thomas2018shapes', 'buratti2019', 'charnoz2007', 'porco2007'],
  prometheus: ['thomas2018shapes', 'thomas2013', 'murray2005', 'porco2007'],
  pandora: ['thomas2018shapes', 'buratti2019', 'thomas2013', 'porco2007'],
  epimetheus: ['thomas2018shapes', 'tiscareno2009', 'thomas2013', 'jplHorizons'],
  janus: ['thomas2018shapes', 'tiscareno2009', 'thomas2013', 'jplHorizons'],
  mimas: PLACE_SOURCES.mimas,
  enceladus: PLACE_SOURCES.enceladus,
  tethys: ['usgsTethys', 'verbiscer2007', 'thomas2010', 'archinal2018'],
  dione: ['usgsDione', 'verbiscer2007', 'thomas2010', 'archinal2018'],
  rhea: ['usgsRhea', 'verbiscer2007', 'ciarniello2011', 'thomas2010', 'archinal2018'],
  titan: PLACE_SOURCES.titan,
  iapetus: PLACE_SOURCES.iapetus,
  hyperion: ['thomas2007', 'thomas2010', 'jplHorizons'],
  phoebe: ['pia07775', 'buratti2008', 'porco2005', 'archinal2018'],
  aegaeon: ['hedman2007c', 'thomas2013', 'jplHorizons'],
  methone: ['thomas2013', 'jplHorizons'],
  anthe: ['thomas2013', 'jplHorizons'],
  pallene: ['thomas2013', 'jplHorizons'],
  polydeuces: ['thomas2013', 'jplHorizons'],
  calypso: ['thomas2010', 'verbiscer2007', 'jplHorizons'],
  telesto: ['thomas2010', 'verbiscer2007', 'jplHorizons'],
  helene: ['thomas2010', 'verbiscer2007', 'jplHorizons'],
  paaliaq: ['grav2015', 'denk2018', 'denkmottola2019', 'grav2003'],
  albiorix: ['grav2015', 'denk2018', 'denkmottola2019', 'grav2003'],
  siarnaq: ['grav2015', 'denk2018', 'denkmottola2019', 'grav2003'],
  ymir: ['grav2015', 'denk2018', 'denkmottola2019', 'grav2003'],
};

/** Moons without a list of their own. */
export const MOON_DEFAULT: string[] = ['archinal2018', 'naifPck00011', 'jplHorizons', 'verbiscer2007', 'thomas2010'];

/** Dusty rings without a place of their own (custom views at their radii). */
export const DUSTY_RING_SOURCES: Record<'D' | 'G' | 'E', string[]> = {
  D: ['hedman2007a', 'harbison2013', 'archinal2018'],
  G: ['hedman2007c', 'thomas2013'],
  E: ['hedman2012', 'porco2006', 'verbiscer2007'],
};

/**
 * References for a custom view: the moon being orbited, else what lies at the camera's distance from Saturn's axis
 * (zone edges as in docs/ring-physics.md §3/§5; heights above ~300 m in the A ring show its wakes from above).
 * rKm: distance from Saturn's axis (km); zM: height above the ring plane (m); altKm: height above Saturn's clouds.
 */
export function contextSources(o: { moon?: string | null; rKm: number; zM: number; altKm: number }): string[] {
  if (o.moon && o.moon !== 'saturn') return MOON_SOURCES[o.moon.toLowerCase()] ?? MOON_DEFAULT;
  const r = o.rKm;
  const z = Math.abs(o.zM);
  if (o.altKm < 30_000 && (r < 66_900 || z > 5e6)) return PLACE_SOURCES['cloud-tops']; // over Saturn's clouds
  if (z > 1e8 || r < 66_900) return PLACE_SOURCES.overview; // far out of the ring plane
  if (r < 74_491) return DUSTY_RING_SOURCES.D;
  if (r < 91_975) return PLACE_SOURCES['c-ring-inside'];
  if (r < 117_570) return PLACE_SOURCES['b-ring-inside'];
  if (r < 122_050) return PLACE_SOURCES['cassini-division'];
  if (r >= 133_423 && r <= 133_745) return PLACE_SOURCES['encke-gap'];
  if (r >= 136_483 && r <= 136_523) return PLACE_SOURCES['keeler-gap'];
  if (r < 136_770) return z > 300 ? PLACE_SOURCES['a-ring-1km'] : PLACE_SOURCES['a-ring-inside'];
  if (r < 141_000) return PLACE_SOURCES['f-ring'];
  if (r >= 166_000 && r <= 173_200) return DUSTY_RING_SOURCES.G;
  if (r >= 180_000 && r <= 480_000) return DUSTY_RING_SOURCES.E;
  return PLACE_SOURCES.overview;
}

/**
 * Features without a place of their own (planned, or rendered but not yet a preset). Listed so the references stay in
 * the bibliography and are ready when the place lands: move a list to PLACE_SOURCES under the new preset id. Not
 * shown in the app.
 */
export const PLANNED_SOURCES: Record<string, string[]> = {
  // rendered since the relief work (no place yet): the Titan −1:0 wave and the 1983 corrugation of the C / D rings
  'titan-bending-wave': ['nicholsonhedman2016', 'rosen1988', 'koh2022', 'shu1983', 'french2025'],
  'c-ring-corrugation': ['hedman2011', 'hedman2015', 'french2025', 'hedman2007a'],
  'b-ring-edge-region-a': ['spitale2010', 'pia11668', 'nicholson2014a'],
  'ring-grazing-textures': ['tiscareno2019', 'buratti2019'],
  'ring-moon-flybys': ['buratti2019', 'thomas2018shapes', 'charnoz2007'],
  'nbody-wakes': ['salo1992', 'salo2004', 'wisdom1988', 'rein2012', 'reintremaine2011', 'robbins2010', 'bridges1984'],
};
