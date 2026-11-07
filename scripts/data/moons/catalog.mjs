// Moon catalog inputs for the build: identifiers, Horizons coverage, starting mean elements (JPL SSD
// "Planetary Satellite Mean Elements", https://ssd.jpl.nasa.gov/sats/elem/, epoch 2000-01-01.5 TDB, Laplace
// plane) and physical data. Physical sources (see docs/data-sources.md):
//   radii      IAU WGCCRE 2015 (Archinal et al. 2018, CMDA 130:22) as implemented in NAIF pck00011.tpc
//   GM         JPL SSD satellite physical parameters (SAT441 / SAT415 solutions, Jacobson); for bodies without
//              a measured mass: volume x assumed density (flagged gmEstimated)
//   albedo     visual geometric albedo: Verbiscer et al. 2007 (Science 315:815) for the icy mid-sized moons and
//              the Lagrangian/co-orbital moons; Buratti et al. 2019 (Science 364) ring moons; Titan, Hyperion,
//              Iapetus, Phoebe and the small moons from JPL SSD / Horizons / Thomas et al. 2013, 2019
//   colors     linear-RGB reflectance tints relative to the Sun (white = solar spectrum), from published
//              disk-integrated colors (B-V, V-R); see colorFromIndices() in build_moons.mjs
// Horizons coverage: sat441l major + Lagrangian + Methone/Polydeuces: 1749-12-31..2250-01-05;
// sat415 ring moons, Janus/Epimetheus, Pallene, Anthe, Aegaeon: 1949-12-27..2050-01-09;
// Daphnis: 1990-06-15..2018-01-17 (!); irregulars (sat456): 1749-12-31..2150-01-07.
export const SPAN_LONG = [2360235.5, 2542400.5]; // 1749-12-31 .. 2250-01-05 (approx)

// SSD mean elements: a km, e, w deg, M deg, i deg, node deg, P days, Papsis yr, Pnode yr, laplace RA, Dec, tilt
// signs: apsides advance (+) unless noted; nodes regress (-) (rates are refined by the fit anyway)
export const MOONS = [
  { id: 618, name: 'Pan', kind: 'ring', cover: [2433282.5, 2469812.5], ssd: [133600, 0.0, 0.0, 146.6, 0.0, 0.0, 0.575051, 0, 0], lap: null,
    radii: [17.2, 15.4, 10.4], gm: 0.00028, albedo: 0.5, colorIdx: { bv: 0.78, vr: 0.45 }, rot: 'sync' },
  { id: 635, name: 'Daphnis', kind: 'ring', cover: [2448057.5, 2458135.5], ssd: [136500, 0.0, 0.0, 153.6, 0.0, 0.0, 0.594080, 0, 0], lap: null,
    radii: [4.6, 4.5, 2.8], gm: 0.0000056, albedo: 0.5, colorIdx: { bv: 0.78, vr: 0.45 }, rot: 'sync' },
  { id: 615, name: 'Atlas', kind: 'ring', cover: [2433282.5, 2469812.5], ssd: [137700, 0.001, 82.3, 289.1, 0.0, 0.0, 0.604602, 0.342, 0], lap: null,
    radii: [20.5, 17.8, 9.4], gm: 0.00037, albedo: 0.4, colorIdx: { bv: 0.80, vr: 0.47 }, rot: 'sync' },
  { id: 616, name: 'Prometheus', kind: 'ring', cover: [2433282.5, 2469812.5], ssd: [139400, 0.002, 341.9, 135.4, 0.0, 0.0, 0.615878, 0.357, 0], lap: null,
    radii: [68.2, 41.6, 28.2], gm: 0.01071, albedo: 0.5, colorIdx: { bv: 0.74, vr: 0.42 }, rot: 'sync' },
  { id: 617, name: 'Pandora', kind: 'ring', cover: [2433282.5, 2469812.5], ssd: [141700, 0.004, 217.9, 123.9, 0.0, 0.0, 0.631369, 0.379, 0], lap: null,
    radii: [52.2, 40.8, 31.5], gm: 0.00926, albedo: 0.5, colorIdx: { bv: 0.74, vr: 0.42 }, rot: 'sync' },
  { id: 611, name: 'Epimetheus', kind: 'coorbital', cover: [2433282.5, 2469812.5], ssd: [151400, 0.020, 96.3, 197.2, 0.3, 189.8, 0.697012, 0.240, 0.482], lap: null,
    radii: [64.9, 57.3, 53.0], gm: 0.03514, albedo: 0.73, colorIdx: { bv: 0.73, vr: 0.40 }, rot: 'sync', librationDeg: 5.9 },
  { id: 610, name: 'Janus', kind: 'coorbital', cover: [2433282.5, 2469812.5], ssd: [151500, 0.007, 11.1, 111.7, 0.2, 159.9, 0.697353, 0.240, 0.482], lap: null,
    radii: [101.7, 93.0, 76.3], gm: 0.12662, albedo: 0.71, colorIdx: { bv: 0.73, vr: 0.40 }, rot: 'sync' },
  { id: 653, name: 'Aegaeon', kind: 'minor', cover: [2433282.5, 2469812.5], ssd: [167500, 0.0, 0.0, 4.4, 0.0, 0.0, 0.808115, 0, 0], lap: null,
    radii: [0.7, 0.25, 0.2], gm: 0.0000000012, gmEstimated: true, albedo: 0.15, colorIdx: { bv: 0.75, vr: 0.42 }, rot: 'sync' },
  { id: 601, name: 'Mimas', kind: 'major', cover: [2360235.5, 2542400.5], ssd: [186000, 0.020, 160.4, 275.3, 1.6, 66.2, 0.942422, 0.493, 0.986], lap: null,
    radii: [207.8, 196.7, 190.6], gm: 2.50349, albedo: 0.962, colorIdx: { bv: 0.70, vr: 0.36 }, rot: 'sync', librationDeg: 0.84 },
  { id: 632, name: 'Methone', kind: 'minor', cover: [2360235.5, 2542400.5], ssd: [194700, 0.002, 315.5, 0.0, 0.0, 0.0, 1.009549, 0.003, 0], lap: null,
    radii: [1.94, 1.29, 1.21], gm: null, density: 310, gmEstimated: true, albedo: 0.5, colorIdx: { bv: 0.70, vr: 0.36 }, rot: 'sync' },
  { id: 649, name: 'Anthe', kind: 'minor', cover: [2433282.5, 2469812.5], ssd: [198100, 0.002, 293.4, 351.4, 0.0, 0.0, 1.038898, 1.190, 0], lap: null,
    radii: [0.5, 0.5, 0.5], gm: 0.0000000001, gmEstimated: true, albedo: 0.5, colorIdx: { bv: 0.70, vr: 0.36 }, rot: 'sync' },
  { id: 633, name: 'Pallene', kind: 'minor', cover: [2433282.5, 2469812.5], ssd: [212300, 0.004, 194.9, 2.0, 0.2, 304.3, 1.156059, 0.790, 1.582], lap: null,
    radii: [2.88, 2.08, 1.8], gm: 0.0000000102, gmEstimated: true, albedo: 0.5, colorIdx: { bv: 0.70, vr: 0.36 }, rot: 'sync' },
  { id: 602, name: 'Enceladus', kind: 'major', cover: [2360235.5, 2542400.5], ssd: [238400, 0.005, 119.5, 57.0, 0.0, 0.0, 1.370218, 2.916, 0], lap: null,
    radii: [256.6, 251.4, 248.3], gm: 7.21037, albedo: 1.375, colorIdx: { bv: 0.62, vr: 0.32 }, rot: 'sync', librationDeg: 0.12 },
  { id: 603, name: 'Tethys', kind: 'major', cover: [2360235.5, 2542400.5], ssd: [295000, 0.001, 335.3, 0.0, 1.1, 273.0, 1.887802, 0.005, 4.982], lap: null,
    radii: [538.4, 528.3, 526.3], gm: 41.21353, albedo: 1.229, colorIdx: { bv: 0.70, vr: 0.36 }, rot: 'sync' },
  { id: 613, name: 'Telesto', kind: 'trojan', cover: [2360235.5, 2542400.5], ssd: [295000, 0.001, 66.2, 360.0, 1.2, 242.1, 1.887802, 0.005, 4.982], lap: null,
    radii: [16.3, 11.8, 9.8], gm: 0.0000027, gmEstimated: true, albedo: 1.0, colorIdx: { bv: 0.70, vr: 0.36 }, rot: 'sync' },
  { id: 614, name: 'Calypso', kind: 'trojan', cover: [2360235.5, 2542400.5], ssd: [295000, 0.001, 221.6, 0.0, 1.5, 326.6, 1.887803, 0.005, 4.983], lap: null,
    radii: [15.3, 9.3, 6.3], gm: 0.0000013, gmEstimated: true, albedo: 1.34, colorIdx: { bv: 0.70, vr: 0.36 }, rot: 'sync' },
  { id: 604, name: 'Dione', kind: 'major', cover: [2360235.5, 2542400.5], ssd: [377700, 0.002, 116.0, 212.0, 0.0, 0.0, 2.736916, 11.698, 0], lap: null,
    radii: [563.4, 561.3, 559.6], gm: 73.11607, albedo: 0.998, colorIdx: { bv: 0.71, vr: 0.38 }, rot: 'sync' },
  { id: 612, name: 'Helene', kind: 'trojan', cover: [2360235.5, 2542400.5], ssd: [377600, 0.007, 194.3, -64.5, 0.2, 260.8, 2.736916, 5.825, 11.707], lap: null,
    radii: [22.5, 19.6, 13.3], gm: 0.00048, albedo: 1.67, colorIdx: { bv: 0.70, vr: 0.36 }, rot: 'sync' },
  { id: 634, name: 'Polydeuces', kind: 'trojan', cover: [2360235.5, 2542400.5], ssd: [377600, 0.019, 94.1, 359.0, 0.2, 167.5, 2.736916, 5.810, 11.692], lap: null,
    radii: [1.5, 1.2, 1.0], gm: 0.0000000016, gmEstimated: true, albedo: 0.7, colorIdx: { bv: 0.70, vr: 0.36 }, rot: 'sync' },
  { id: 605, name: 'Rhea', kind: 'major', cover: [2360235.5, 2542400.5], ssd: [527200, 0.001, 44.3, 31.5, 0.3, 133.7, 4.517503, 33.939, 35.775], lap: [40.6, 83.5, 0.0],
    radii: [765.0, 763.1, 762.4], gm: 153.94175, albedo: 0.949, colorIdx: { bv: 0.76, vr: 0.40 }, rot: 'sync' },
  { id: 606, name: 'Titan', kind: 'major', cover: [2360235.5, 2542400.5], ssd: [1221900, 0.029, 78.3, 11.7, 0.3, 78.6, 15.945448, 346.680, 687.370], lap: [36.4, 84.0, 0.6],
    radii: [2575.15, 2574.78, 2574.47], gm: 8978.1371, albedo: 0.22, colorIdx: { bv: 1.28, vr: 0.65 }, rot: 'sync' },
  { id: 607, name: 'Hyperion', kind: 'major', cover: [2360235.5, 2542400.5], ssd: [1481500, 0.105, 214.0, 122.9, 0.6, 87.1, 21.276658, -20.843, 257.625], lap: [40.2, 83.6, 0.1],
    radii: [180.1, 133.0, 102.7], gm: 0.37049, albedo: 0.30, colorIdx: { bv: 0.78, vr: 0.45 }, rot: 'chaotic' },
  { id: 608, name: 'Iapetus', kind: 'major', cover: [2360235.5, 2542400.5], ssd: [3561700, 0.028, 254.5, 74.8, 7.6, 86.5, 79.331002, 1662.9, 3130.302], lap: [288.7, 78.9, 14.8],
    radii: [745.7, 745.7, 712.1], gm: 120.51511, albedo: 0.31, colorIdx: { bv: 0.72, vr: 0.43 }, rot: 'sync' },
  { id: 609, name: 'Phoebe', kind: 'irregular', cover: [2360235.5, 2542400.5], ssd: [12929400, 0.164, 240.3, 308.0, 175.2, 192.7, 550.303910, 468.321, 741.483], lap: [276.0, 67.5, 26.7],
    radii: [109.4, 108.5, 101.8], gm: 0.55479, albedo: 0.081, colorIdx: { bv: 0.63, vr: 0.34 }, rot: 'iau',
    iau: { ra: 356.90, dec: 77.80, w0: 178.58, wdot: 931.639 } },
  // large irregulars (SSD elements are ecliptic; Laplace plane ~ Saturn's orbit plane)
  { id: 629, name: 'Siarnaq', kind: 'irregular', cover: [2360235.5, 2505000.5], ssd: [17881100, 0.308, 68.4, 62.7, 47.8, 64.0, 892.6799, 680.6, 598.3], lap: 'ecliptic',
    radii: [19.6, 19.6, 19.6], gm: 0.0026, gmEstimated: true, albedo: 0.06, colorIdx: { bv: 0.87, vr: 0.50 }, rot: 'iau',
    iau: { ra: 0, dec: 90, w0: 0, wdot: 360 / (10.188 / 24), estimated: true } },
  { id: 626, name: 'Albiorix', kind: 'irregular', cover: [2360235.5, 2505000.5], ssd: [16329200, 0.482, 62.8, 155.0, 36.8, 111.1, 779.0701, 384.4, 434.3], lap: 'ecliptic',
    radii: [14.3, 14.3, 14.3], gm: 0.0010, gmEstimated: true, albedo: 0.06, colorIdx: { bv: 0.87, vr: 0.50 }, rot: 'iau',
    iau: { ra: 0, dec: 90, w0: 0, wdot: 360 / (13.32 / 24), estimated: true } },
  { id: 620, name: 'Paaliaq', kind: 'irregular', cover: [2360235.5, 2505000.5], ssd: [14997700, 0.378, 237.6, 318.2, 48.5, 353.2, 685.7153, 846.2, 704.4], lap: 'ecliptic',
    radii: [12.5, 12.5, 12.5], gm: 0.00055, gmEstimated: true, albedo: 0.06, colorIdx: { bv: 0.87, vr: 0.50 }, rot: 'iau',
    iau: { ra: 0, dec: 90, w0: 0, wdot: 360 / (18.75 / 24), estimated: true } },
  { id: 619, name: 'Ymir', kind: 'irregular', cover: [2360235.5, 2505000.5], ssd: [22955600, 0.338, 45.3, 167.5, 172.3, 204.5, 1298.6819, 154.5, 267.8], lap: 'ecliptic',
    radii: [9.5, 9.5, 9.5], gm: 0.00024, gmEstimated: true, albedo: 0.06, colorIdx: { bv: 0.70, vr: 0.40 }, rot: 'iau',
    iau: { ra: 0, dec: 90, w0: 0, wdot: 360 / (11.92 / 24), estimated: true } },
];

export const EPOCH_SSD_JD = 2451545.0;

// ---------------------------------------------------------------- fit configuration
// H: residual-table step (days). lib: libration terms {P (days, initial), harm, a, ecc, fitNu}.
// maxAutoLib: extra periodogram-detected terms. table: [jd0, jd1] (default TABLE_SPAN, clipped to coverage).
export const TABLE_SPAN = [2449718.5, 2471722.5]; // 1995-01-01 .. 2055-04-01
export const FIT = {
  Pan: { H: 16, maxAutoLib: 1 },
  // Horizons stops 2018-01-17 and the sat415 Daphnis orbit shows a mean-motion change around 2010: fit the
  // global model to 2011-2018 only (best linear extrapolation forward); the table reproduces 1995-2018
  Daphnis: { H: 8, globalSpan: [2455562.5, 2458130.5], maxAutoLib: 0 },
  Atlas: { H: 8 },
  Prometheus: { H: 8 },
  Pandora: { H: 8 },
  Epimetheus: { H: 4, lib: [{ P: 2921, harm: 15, a: true, ecc: true }], maxAutoLib: 1 },
  Janus: { H: 4, lib: [{ P: 2921, harm: 15, a: true, ecc: true }], maxAutoLib: 1 },
  Aegaeon: { H: 4, lib: [{ P: 25762 }, { P: 1279, harm: 2 }], maxAutoLib: 1 },
  Mimas: { H: 4, lib: [{ P: 25762, harm: 2 }], maxAutoLib: 2 },
  Methone: { H: 4, lib: [{ P: 25762 }, { P: 520, harm: 3, a: true }], maxAutoLib: 1 },
  Anthe: { H: 4, lib: [{ P: 25762 }, { P: 762, harm: 3, a: true }], maxAutoLib: 1 },
  Pallene: { H: 8 },
  Enceladus: { H: 4, lib: [{ P: 4024, harm: 2 }], maxAutoLib: 1 },
  Tethys: { H: 4, lib: [{ P: 25762 }], maxAutoLib: 1 },
  Telesto: { H: 4, lib: [{ P: 25762 }, { P: 696, harm: 3, a: true }], maxAutoLib: 1 },
  Calypso: { H: 4, lib: [{ P: 25762 }, { P: 696, harm: 3, a: true }], maxAutoLib: 1 },
  Dione: { H: 4, maxAutoLib: 1 },
  Helene: { H: 4, lib: [{ P: 768, harm: 4, a: true, ecc: true }], maxAutoLib: 1 },
  Polydeuces: { H: 4, lib: [{ P: 792, harm: 4, a: true, ecc: true }], maxAutoLib: 1 },
  Rhea: { H: 4, maxAutoLib: 1, fitFrame: true },
  Titan: { H: 8, maxAutoLib: 1 },
  Hyperion: { H: 3, lib: [{ P: 642, harm: 3, a: true, ecc: true }], maxAutoLib: 2, fitFrame: false },
  Iapetus: { H: 4, maxAutoLib: 1, fitFrame: false },
  Phoebe: { H: 8, tableKind: 'cartesian', center: 'barycenter', lib: [{ P: 5380, harm: 2, ecc: true }], maxAutoLib: 1 },
  Siarnaq: { H: 4, tableKind: 'cartesian', center: 'barycenter', lib: [{ P: 5380, harm: 2, ecc: true }], maxAutoLib: 0, scanRates: false },
  Albiorix: { H: 4, tableKind: 'cartesian', center: 'barycenter', lib: [{ P: 5380, harm: 2, ecc: true }], maxAutoLib: 0, scanRates: false },
  Paaliaq: { H: 4, tableKind: 'cartesian', center: 'barycenter', lib: [{ P: 5380, harm: 2, ecc: true }], maxAutoLib: 0, scanRates: false },
  Ymir: { H: 8, tableKind: 'cartesian', center: 'barycenter', lib: [{ P: 5380, harm: 2, ecc: true }], maxAutoLib: 0, scanRates: false },
};
export function moonConfig(name) {
  const base = MOONS.find((m) => m.name.toLowerCase() === name.toLowerCase());
  return base ? { ...base, ...(FIT[base.name] ?? {}) } : null;
}
