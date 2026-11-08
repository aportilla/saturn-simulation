// Ring zones (with physical parameters) and named features.
//
// Values are best estimates compiled from the literature; see docs/ring-physics.md for the full discussion,
// numbers, uncertainties and references. Radii in km from Saturn's center. Particle radii in meters.
//
// Size distribution: dN/da = C a^-q for aMin <= a <= aMax (per unit area), C fixed by the local
// normal optical depth tau = pi C Int a^(2-q) da.  tau is the GEOMETRIC (visible) normal optical depth
// of public/data/rings/tau_main (UVIS/RSS-derived; see scripts/data/rings/build_tau.mjs).
//
// Surface density: Sigma = sigmaPerTau * tau (the RingProfile loader). Observationally tau is NOT a good proxy
// for Sigma in the B and C rings (Hedman & Nicholson 2014, 2016): the optional affine model
//   Sigma = sigma0 * smooth(0.002, 0.02, tau) + sigmaSlope * tau
// reproduces the density-wave measurements better; zoneParamsAtKm returns blended sigma0 / sigmaSlope for
// every zone (zones without them: sigma0 = 0, sigmaSlope = sigmaPerTau, i.e. identical to the proportional
// model). sigmaPerTau itself is calibrated so that both models give the same zone mass with the real tau
// profile (scripts/data/rings/mass_check.mjs: total 1.34e19 kg vs 1.54 +- 0.49e19 kg, Iess et al. 2019).

export interface RingZone {
  key: string;
  name: string;
  rInnerKm: number;
  rOuterKm: number;
  /** power-law index of the differential size distribution */
  q: number;
  /** minimum / maximum particle radius (m) */
  aMin: number;
  aMax: number;
  /** characteristic FULL vertical thickness of the particle layer (m) */
  H: number;
  /** surface mass density per unit normal optical depth (kg m^-2) — Sigma ~ sigmaPerTau * tau */
  sigmaPerTau: number;
  /** particle single-scattering albedo, linear RGB (visible) */
  albedo: [number, number, number];
  /** self-gravity wake strength 0..1 (0 = none) */
  wake: number;
  /** wake parameter set (WakeField WAKE_SETS): 0 = A-ring calibration (default), 1 = B-ring calibration */
  wakeB?: number;
  /** fraction of the optical depth in fine (micron) dust — strongly forward-scattering */
  dust: number;
  /** representative tau, used by the procedural fallback profile */
  tauTypical: number;
  /** whether macroscopic (cm..m) particles dominate (near-field particles are rendered) */
  macroscopic: boolean;
  /** optional affine surface-density model (kg m^-2): Sigma = sigma0 * smooth(0.002, 0.02, tau) + sigmaSlope * tau */
  sigma0?: number;
  sigmaSlope?: number;
  /** implied mean particle bulk density (kg m^-3) = 3 Sigma / (4 tau a_V), a_V = Int a^3 n / Int a^2 n (info only) */
  rhoBulk?: number;
  /** short source note (full references in docs/ring-physics.md) */
  ref?: string;
}

export type FeatureType = 'gap' | 'ringlet' | 'edge' | 'densityWave' | 'bendingWave' | 'plateau' | 'region';
export interface RingFeature {
  name: string;
  type: FeatureType;
  rKm: number;
  widthKm: number;
  /** optical depth (ringlets / plateaus) */
  tau?: number;
  /** associated moon or resonance */
  note?: string;
}

// Particle single-scattering (Bond) albedos, linear RGB at ~650/550/450 nm. A/B: A_V ~ 0.5-0.6 (Doyle et al.
// 1989; Dones et al. 1993; Morishima et al. 2010: 0.55), B brightest (Ciarniello et al. 2019), strongly red
// in the visible (Cuzzi et al. 2009; Filacchione et al. 2014); C ring and Cassini Division dark and much less
// red (C ~0.15-0.25, declining toward Saturn: Cooke 1991, Morishima et al. 2010; Miller et al. 2024).
const A_ALB: [number, number, number] = [0.58, 0.52, 0.43];
const B_ALB: [number, number, number] = [0.66, 0.59, 0.47];
const B1_ALB: [number, number, number] = [0.62, 0.56, 0.45];
// C ring raised ~25% (within the +-0.05-0.1 uncertainty) so the power-law photometry gives the observed
// low-phase I/F ~0.05-0.06 (ring-layer calibration at an HST-like geometry)
const C_IN_ALB: [number, number, number] = [0.21, 0.2, 0.18];
const C_ALB: [number, number, number] = [0.26, 0.25, 0.225];
const C_RAMP_ALB: [number, number, number] = [0.32, 0.3, 0.26];
const CD_ALB: [number, number, number] = [0.3, 0.28, 0.25];
const CD_RAMP_ALB: [number, number, number] = [0.42, 0.39, 0.33];
// Fine dust (D ring, Encke gap ringlets, Roche Division): micron grains, high albedo, bluish (E-ring-like).
const DUST_ALB: [number, number, number] = [0.75, 0.78, 0.85];
// Sigma/tau of micron dust (q = 3.5, 1-100 um, rho = 920): (4/3) rho a_V ~ 0.012 kg/m^2 per unit tau.
const DUST_SPT = 0.012;

export const RING_ZONES: RingZone[] = [
  {
    key: 'D', name: 'D ring', rInnerKm: 66_900, rOuterKm: 74_491,
    q: 3.5, aMin: 1e-6, aMax: 1e-4, H: 1000, sigmaPerTau: DUST_SPT, albedo: DUST_ALB, wake: 0, dust: 1, tauTypical: 1e-4, macroscopic: false,
    ref: 'Hedman et al. 2007 (D ring, tau 1e-5..1e-3); dust grains',
  },
  {
    // inner C ring: Sigma ~1 g/cm^2 (Mimas 4:1 wave, 74,890 km: Afigbo et al. 2025)
    key: 'C_in', name: 'C ring (inner)', rInnerKm: 74_491, rOuterKm: 79_000,
    q: 3.16, aMin: 0.0041, aMax: 10.0, H: 5, sigmaPerTau: 160, sigma0: 10, sigmaSlope: 0,
    albedo: C_IN_ALB, wake: 0, dust: 0.01, tauTypical: 0.044, macroscopic: true, rhoBulk: 160,
    ref: 'size: Jerousek et al. 2020, Harbison et al. 2013; Sigma: Afigbo et al. 2025',
  },
  {
    // mid C ring: Sigma peaks near 82,000 km: 2.5-3 (Afigbo et al. 2025) .. 4-10 g/cm^2 (Hedman & Nicholson 2014)
    key: 'C', name: 'C ring', rInnerKm: 79_000, rOuterKm: 84_000,
    q: 3.16, aMin: 0.0041, aMax: 10.0, H: 5, sigmaPerTau: 420, sigma0: 40, sigmaSlope: 0,
    albedo: C_ALB, wake: 0, dust: 0.01, tauTypical: 0.09, macroscopic: true, rhoBulk: 410,
    ref: 'size: Jerousek et al. 2020; Sigma: Hedman & Nicholson 2014, Afigbo et al. 2025',
  },
  {
    // outer C ring incl. plateaux P5-P7 etc.: Sigma 0.25-1.8 g/cm^2 (Afigbo et al. 2025), plateaux 1.2-4.7 (H&N 2014)
    key: 'C_out', name: 'C ring (outer)', rInnerKm: 84_000, rOuterKm: 90_620,
    q: 3.16, aMin: 0.0041, aMax: 10.0, H: 5, sigmaPerTau: 115, sigma0: 15, sigmaSlope: 0,
    albedo: C_ALB, wake: 0, dust: 0.01, tauTypical: 0.07, macroscopic: true, rhoBulk: 115,
    ref: 'size: Jerousek et al. 2020 (plateaux: q 3.05, aMax 5-6 m); Sigma: Afigbo et al. 2025, H&N 2014',
  },
  {
    key: 'C_ramp', name: 'C ring ramp', rInnerKm: 90_620, rOuterKm: 91_975,
    q: 3.16, aMin: 0.0038, aMax: 10.0, H: 5, sigmaPerTau: 340, sigma0: 50, sigmaSlope: 0,
    albedo: C_RAMP_ALB, wake: 0, dust: 0.01, tauTypical: 0.146, macroscopic: true, rhoBulk: 340,
    ref: 'size: Jerousek et al. 2020; Sigma interpolated (C ring -> inner B ring), uncertain x2',
  },
  {
    // B ring sizes: few particles < 5 cm (Cassini RSS 3-band, Marouf et al. 2008; French & Nicholson 2000: aMin
    // 30 cm); occultation fits give q ~2.75-2.8 and aMax ~7-20 m (French & Nicholson 2000; Miller et al. 2024) but
    // are weak here (the core is opaque). Those imply a_V ~1.9 m: with tau ~4-6 that is ~10-15 m^3 of solid per m^2,
    // impossible in a ~10-15 m thick layer, and 10-20x the mass the density waves allow. Mass (Sigma), packing and
    // the higher tau/Sigma of the opaque regions (Hedman & Nicholson 2016) all require smaller particles, the more
    // so the higher tau: adopted B1/B5 q = 2.9, aMax = 3 m, H = 10 m; B4 q = 3.1, aMax = 2.5 m, H = 12 m;
    // B2/B3 q = 3.2, aMax = 2 m, H = 15 m (mid-plane volume filling 0.25-0.4, implied bulk density 0.2-0.3 g/cm^3;
    // scripts/data/rings/inside_numbers.mjs). These are consistency-driven estimates, uncertain by ~x2 in aMax.
    // Sigma from hidden density waves (Hedman & Nicholson 2016): 45-69 g/cm^2 at the Janus 2:1 wave
    // (96,350-96,690 km); Tiscareno & Harris 2018: ~25 g/cm^2 at 95,500 km.
    // wakes (all B zones): strength 1 with the B-ring wake set (N-body at Sigma 600: Q 1.7, wakes as strong and coherent
    // as in the A ring; docs/ring-physics.md 10.5, 10.11)
    key: 'B1', name: 'B ring (B1)', rInnerKm: 91_975, rOuterKm: 99_000,
    q: 2.9, aMin: 0.05, aMax: 3.0, H: 10, sigmaPerTau: 303, sigma0: 400, sigmaSlope: 0,
    albedo: B1_ALB, wake: 1.0, wakeB: 1, dust: 0, tauTypical: 1.25, macroscopic: true, rhoBulk: 280,
    ref: 'Hedman & Nicholson 2016; Tiscareno & Harris 2018; French & Nicholson 2000',
  },
  {
    // B2: Mimas 5:2 wave 39-42 g/cm^2 (H&N 2016), 43 g/cm^2 at 100,500 km (Tiscareno & Harris 2018)
    key: 'B2', name: 'B ring (B2)', rInnerKm: 99_000, rOuterKm: 104_000,
    q: 3.2, aMin: 0.05, aMax: 2.0, H: 15, sigmaPerTau: 99, sigma0: 420, sigmaSlope: 0,
    albedo: B_ALB, wake: 1.0, wakeB: 1, dust: 0, tauTypical: 3.66, macroscopic: true, rhoBulk: 170,
    ref: 'Hedman & Nicholson 2016; Tiscareno & Harris 2018',
  },
  {
    // B3 (core): Pandora 3:2 wave 65-72 g/cm^2 at tau 3.4-4.7 (H&N 2016)
    key: 'B3', name: 'B ring (B3, core)', rInnerKm: 104_000, rOuterKm: 110_000,
    q: 3.2, aMin: 0.05, aMax: 2.0, H: 15, sigmaPerTau: 123, sigma0: 680, sigmaSlope: 0,
    albedo: B_ALB, wake: 1.0, wakeB: 1, dust: 0, tauTypical: 5.49, macroscopic: true, rhoBulk: 210,
    ref: 'Hedman & Nicholson 2016',
  },
  {
    // B4: Enceladus 3:1 wave 65-71 g/cm^2; Janus 3:2 (116,070-116,185 km) 120-141 g/cm^2 (H&N 2016)
    key: 'B4', name: 'B ring (B4)', rInnerKm: 110_000, rOuterKm: 116_500,
    q: 3.1, aMin: 0.05, aMax: 2.5, H: 12, sigmaPerTau: 224, sigma0: 700, sigmaSlope: 0,
    albedo: B_ALB, wake: 1.0, wakeB: 1, dust: 0, tauTypical: 3.02, macroscopic: true, rhoBulk: 300,
    ref: 'Hedman & Nicholson 2016',
  },
  {
    // B5: Mimas 4:2 bending wave 54 g/cm^2 at 116,625 km (Lissauer 1985, via H&N 2016). Outer boundary is set
    // just outside the B-ring edge of the tau profile (117,650 km at the 2005-123 RSS longitude; mean edge
    // 117,570 km, m = 2 Mimas 2:1 distortion +-~75 km) so B-ring parameters cover all B-ring material.
    key: 'B5', name: 'B ring (B5, outer)', rInnerKm: 116_500, rOuterKm: 117_700,
    q: 2.9, aMin: 0.05, aMax: 3.0, H: 10, sigmaPerTau: 370, sigma0: 540, sigmaSlope: 0,
    albedo: B_ALB, wake: 1.0, wakeB: 1, dust: 0, tauTypical: 1.41, macroscopic: true, rhoBulk: 340,
    ref: 'Hedman & Nicholson 2016; Nicholson et al. 2014 (B-ring edge)',
  },
  {
    // Cassini Division (Huygens gap .. ramp): q 2.79-3.0, aMin ~4 mm, aMax ~9 m (Zebker et al. 1985; Jerousek
    // et al. 2020); Sigma 1.5 g/cm^2 at 118,830 km, 3.3 at 120,669 km (Tiscareno et al. 2007); H <= 3-4.5 m.
    key: 'CD', name: 'Cassini Division', rInnerKm: 117_700, rOuterKm: 120_900,
    q: 2.9, aMin: 0.0041, aMax: 9.0, H: 4, sigmaPerTau: 131, sigma0: 8, sigmaSlope: 60,
    albedo: CD_ALB, wake: 0, dust: 0.01, tauTypical: 0.074, macroscopic: true, rhoBulk: 65,
    ref: 'Tiscareno et al. 2007; Jerousek et al. 2020; Zebker et al. 1985',
  },
  {
    // Cassini Division ramp: opacity tau/Sigma up to ~10x lower than the main CD (Tiscareno et al. 2013); Sigma
    // rises toward the A ring (28 g/cm^2 at 122,313 km). q ~3.0-3.07, aMin 3.3 mm, aMax up to ~20 m
    // (Jerousek et al. 2020; capped at 10 m = largest LOD class).
    key: 'CD_ramp', name: 'Cassini Division ramp', rInnerKm: 120_900, rOuterKm: 122_050,
    q: 3.05, aMin: 0.0033, aMax: 10.0, H: 5, sigmaPerTau: 840,
    albedo: CD_RAMP_ALB, wake: 0, dust: 0.005, tauTypical: 0.155, macroscopic: true, rhoBulk: 580,
    ref: 'Tiscareno et al. 2013; Jerousek et al. 2020',
  },
  {
    // inner/mid A ring: Sigma 28-38 g/cm^2 (Tiscareno et al. 2007, 2013; Tiscareno & Harris 2018: 30-35);
    // q ~2.74-2.9, aMin ~1.5-2.5 cm (Becker et al. 2016 at the Encke inner edge: 15 mm; Jerousek 2018), aMax 5-10 m
    // (Zebker et al. 1985 inner A ring: 5.4 m; 5 m adopted for packing at tau ~1-1.4 in the inner A ring);
    // thickness <= 10-15 m (Tiscareno et al. 2007); wakes strongest here (Colwell et al. 2006; Hedman et al. 2007).
    key: 'A_in', name: 'A ring (inner)', rInnerKm: 122_050, rOuterKm: 133_423,
    q: 2.9, aMin: 0.02, aMax: 5.0, H: 10, sigmaPerTau: 433,
    albedo: A_ALB, wake: 1.0, dust: 0.001, tauTypical: 0.67, macroscopic: true, rhoBulk: 300,
    ref: 'Tiscareno & Harris 2018; Tiscareno et al. 2007, 2013; Becker et al. 2016; Miller et al. 2024',
  },
  {
    key: 'Encke', name: 'Encke Gap', rInnerKm: 133_423, rOuterKm: 133_745,
    q: 3.5, aMin: 1e-6, aMax: 1e-4, H: 200, sigmaPerTau: DUST_SPT, albedo: DUST_ALB, wake: 0, dust: 1, tauTypical: 1e-3, macroscopic: false,
    ref: 'cleared by Pan; faint dusty ringlets (Hedman et al. 2013)',
  },
  {
    // outer A ring: Sigma 25 g/cm^2 at the Encke outer edge falling to 16 at the A-ring edge (Tiscareno & Harris
    // 2018); q ~3.05, aMin 4-9 mm (Becker et al. 2016; Miller et al. 2024)
    key: 'A_out', name: 'A ring (outer)', rInnerKm: 133_745, rOuterKm: 136_770,
    q: 3.05, aMin: 0.005, aMax: 7.0, H: 10, sigmaPerTau: 310,
    albedo: A_ALB, wake: 0.6, dust: 0.003, tauTypical: 0.6, macroscopic: true, rhoBulk: 280,
    ref: 'Tiscareno & Harris 2018; Becker et al. 2016',
  },
  {
    key: 'Roche', name: 'Roche Division', rInnerKm: 136_770, rOuterKm: 139_380,
    q: 3.5, aMin: 1e-6, aMax: 1e-4, H: 500, sigmaPerTau: DUST_SPT, albedo: DUST_ALB, wake: 0, dust: 1, tauTypical: 1e-4, macroscopic: false,
    ref: 'tau ~1e-4 dust (PDS Rings Node); R/2004 S1 (137,630 km) and R/2004 S2 (138,900 km) ringlets',
  },
];

/** Narrow / dusty rings outside the main-ring profile, handled analytically by the ring renderer. */
export const OUTER_RINGS = {
  // F ring: Albers et al. 2012 (a = 140,221.3 km, e = 2.35e-3, i = 0.0064 deg), apsidal precession 2.70 deg/day
  // (Bosh et al. 2002); bright core ~1-2 km, envelope ~500 km (PDS: 139,826-140,612 km, tau 0.01-0.2)
  F: { aKm: 140_221, e: 0.00235, incDeg: 0.0064, coreWidthKm: 2.5, coreTau: 0.5, envelopeWidthKm: 400, envelopeTau: 0.01, precessDegPerDay: 2.7 },
  JanusEpimetheus: { rInnerKm: 149_000, rOuterKm: 154_000, tau: 1e-7 },
  // G ring: 166,000-173,200 km, tau ~1e-6; arc at 167,500 km (Hedman et al. 2007, Aegaeon)
  G: { rInnerKm: 166_000, rOuterKm: 173_200, peakKm: 167_500, tau: 1e-6, arcTau: 1e-5 },
  // E ring: 180,000-480,000 km, peak at Enceladus' orbit (237,948 km), tau ~5e-6..1e-5
  E: { rInnerKm: 180_000, rOuterKm: 480_000, peakKm: 237_948, tau: 1e-5, scaleHeightKm: 1500 },
};

/**
 * Named features (for HUD labels and for the procedural fallback profile). Radii of gaps, ringlets, plateaux
 * and edges are measured in public/data/rings/tau_main (scripts/data/rings/measure_features.mjs), i.e. where
 * the rendered profile has them; eccentric features are at their Rev 7 egress (2005-123) position, with the
 * mean radius in `note`. Catalogue values: PDS Rings Node "Vital Statistics" (Colwell et al. 2009; Nicholson
 * et al. 2014; French et al. 2016).
 */
export const RING_FEATURES: RingFeature[] = [
  // D ring (Hedman et al. 2007)
  { name: 'D68 ringlet', type: 'ringlet', rKm: 67_630, widthKm: 100, tau: 2e-3 },
  { name: 'D72 ringlet', type: 'ringlet', rKm: 71_600, widthKm: 400, tau: 1e-3 },
  { name: 'D73 ringlet', type: 'ringlet', rKm: 73_200, widthKm: 200, tau: 1e-3 },
  // C ring
  { name: 'C ring inner edge', type: 'edge', rKm: 74_490, widthKm: 1 },
  { name: 'Colombo Gap', type: 'gap', rKm: 77_830, widthKm: 200, note: 'PDS 77,748-77,926 km' },
  { name: 'Titan Ringlet', type: 'ringlet', rKm: 77_899, widthKm: 28, tau: 1.7, note: 'eccentric (ae ~ 20 km), apse locked to Titan (1:0 apsidal resonance); mean 77,867-77,890 km' },
  { name: 'C ring plateau (79.24k)', type: 'plateau', rKm: 79_243, widthKm: 41, tau: 0.42 },
  { name: 'Plateau P5', type: 'plateau', rKm: 84_849, widthKm: 197, tau: 0.44, note: 'Hedman & Nicholson 2014 naming' },
  { name: 'Plateau P6', type: 'plateau', rKm: 85_708, widthKm: 93, tau: 0.29 },
  { name: 'C ring plateau (85.95k)', type: 'plateau', rKm: 85_949, widthKm: 50, tau: 0.28 },
  { name: 'Plateau P7', type: 'plateau', rKm: 86_486, widthKm: 229, tau: 0.41 },
  { name: 'Maxwell Gap', type: 'gap', rKm: 87_479, widthKm: 260 },
  { name: 'Maxwell Ringlet', type: 'ringlet', rKm: 87_517, widthKm: 67, tau: 0.7, note: 'eccentric (ae ~ 30 km), embedded wave; mean 87,480-87,539 km' },
  { name: 'C ring plateau (88.48k)', type: 'plateau', rKm: 88_475, widthKm: 234, tau: 0.25 },
  { name: 'Bond Gap', type: 'gap', rKm: 88_702, widthKm: 42 },
  { name: 'Bond Ringlet (1.470 R_S)', type: 'ringlet', rKm: 88_710, widthKm: 16, tau: 0.85, note: 'Mimas 3:1 (second order)' },
  { name: 'C ring plateau (89.24k)', type: 'plateau', rKm: 89_241, widthKm: 100, tau: 0.26 },
  { name: 'C ring plateau (89.86k)', type: 'plateau', rKm: 89_864, widthKm: 148, tau: 0.34 },
  { name: 'Dawes Ringlet (1.495 R_S)', type: 'ringlet', rKm: 90_167, widthKm: 71, tau: 0.67, note: 'not detached from the C ring' },
  { name: 'Dawes Gap', type: 'gap', rKm: 90_211, widthKm: 16 },
  { name: 'C ring plateau (90.5k)', type: 'plateau', rKm: 90_503, widthKm: 194, tau: 0.36 },
  { name: 'C ring ramp', type: 'region', rKm: 91_298, widthKm: 1_355, tau: 0.15 },
  // B ring (regions after Colwell et al. 2009)
  { name: 'B1', type: 'region', rKm: 95_488, widthKm: 7_025, tau: 1.3 },
  { name: 'Janus/Epimetheus 2:1 density wave', type: 'densityWave', rKm: 96_234, widthKm: 500, note: 'Sigma 45-69 g/cm^2 (Hedman & Nicholson 2016)' },
  { name: 'B2', type: 'region', rKm: 101_500, widthKm: 5_000, tau: 4.2 },
  { name: 'Mimas 5:2 density wave', type: 'densityWave', rKm: 101_400, widthKm: 300, note: 'Sigma 39-42 g/cm^2 (Hedman & Nicholson 2016)' },
  { name: 'B3 (core)', type: 'region', rKm: 107_000, widthKm: 6_000, tau: 5.5 },
  { name: 'Pandora 3:2 density wave', type: 'densityWave', rKm: 108_650, widthKm: 100 },
  { name: 'B4', type: 'region', rKm: 113_250, widthKm: 6_500, tau: 3.1 },
  { name: 'Enceladus 3:1 density wave', type: 'densityWave', rKm: 115_300, widthKm: 400 },
  { name: 'Janus/Epimetheus 3:2 density wave', type: 'densityWave', rKm: 116_000, widthKm: 200 },
  { name: 'B5', type: 'region', rKm: 117_075, widthKm: 1_150, tau: 1.5 },
  { name: 'B ring outer edge', type: 'edge', rKm: 117_650, widthKm: 1, note: 'Mimas 2:1 ILR; mean 117,570 km, m = 2 amplitude ~75 km (Nicholson et al. 2014); vertical structures to ~2.5 km' },
  // Cassini Division
  { name: 'Huygens Gap', type: 'gap', rKm: 117_790, widthKm: 280, note: 'PDS 117,500-117,930 km' },
  { name: 'Huygens Ringlet', type: 'ringlet', rKm: 117_832, widthKm: 20, tau: 1.6, note: 'eccentric; mean 117,806-117,824 km' },
  { name: 'Strange Ringlet', type: 'ringlet', rKm: 117_909, widthKm: 3, note: 'narrow, inclined' },
  { name: 'Herschel Gap', type: 'gap', rKm: 118_238, widthKm: 92 },
  { name: 'Herschel Ringlet', type: 'ringlet', rKm: 118_247, widthKm: 29, tau: 0.1, note: 'eccentric and inclined' },
  { name: 'Russell Gap', type: 'gap', rKm: 118_608, widthKm: 40 },
  { name: 'Jeffreys Gap', type: 'gap', rKm: 118_949, widthKm: 35 },
  { name: 'Kuiper Gap', type: 'gap', rKm: 119_403, widthKm: 6 },
  { name: 'Laplace Gap', type: 'gap', rKm: 119_961, widthKm: 248 },
  { name: 'Laplace Ringlet', type: 'ringlet', rKm: 120_056, widthKm: 35, tau: 0.5 },
  { name: 'Bessel Gap', type: 'gap', rKm: 120_237, widthKm: 13 },
  { name: 'Barnard Gap', type: 'gap', rKm: 120_308, widthKm: 16 },
  { name: 'Cassini Division triple band', type: 'region', rKm: 120_675, widthKm: 250, tau: 0.45, note: 'Jerousek et al. 2020' },
  { name: 'Cassini Division ramp', type: 'region', rKm: 121_475, widthKm: 1_150, tau: 0.155 },
  // A ring
  { name: 'A ring inner edge', type: 'edge', rKm: 122_050, widthKm: 1 },
  { name: 'Pandora 5:4 density wave', type: 'densityWave', rKm: 122_313, widthKm: 60, note: 'Sigma 28 g/cm^2 (Tiscareno et al. 2013)' },
  { name: 'Prometheus 6:5 density wave', type: 'densityWave', rKm: 123_578, widthKm: 60, note: 'Sigma 38 g/cm^2 (Tiscareno et al. 2013)' },
  { name: 'Janus 4:3 density wave', type: 'densityWave', rKm: 125_270, widthKm: 200 },
  { name: 'Janus 5:4 density wave', type: 'densityWave', rKm: 130_700, widthKm: 120 },
  { name: 'Mimas 5:3 bending wave', type: 'bendingWave', rKm: 131_900, widthKm: 150, note: 'vertical amplitude ~250-450 m' },
  { name: 'Mimas 5:3 density wave', type: 'densityWave', rKm: 132_300, widthKm: 200 },
  { name: 'Encke Gap', type: 'gap', rKm: 133_587, widthKm: 315, note: 'cleared by Pan (PDS 133,423-133,745 km); faint dusty ringlets' },
  { name: 'Janus 6:5 density wave', type: 'densityWave', rKm: 134_265, widthKm: 100 },
  { name: 'Keeler Gap', type: 'gap', rKm: 136_503, widthKm: 40, note: 'cleared by Daphnis (PDS 136,487-136,522 km)' },
  { name: 'A ring outer edge', type: 'edge', rKm: 136_769, widthKm: 1, note: 'Janus/Epimetheus 7:6 resonance (m = 7 distortion ~10 km)' },
  // beyond
  { name: 'F ring', type: 'ringlet', rKm: 140_221, widthKm: 50, note: 'shepherded by Prometheus & Pandora' },
];

export function zoneAtKm(rKm: number): RingZone | null {
  for (const z of RING_ZONES) if (rKm >= z.rInnerKm && rKm < z.rOuterKm) return z;
  return null;
}

/** Human-readable location description for the HUD. */
export function describeRadiusKm(rKm: number): string {
  if (rKm < 60_268) return 'inside Saturn';
  if (rKm < 66_900) return 'between Saturn and the D ring';
  // nearest gap/ringlet containing r
  let inside: RingFeature | null = null;
  for (const f of RING_FEATURES) {
    if ((f.type === 'gap' || f.type === 'ringlet') && Math.abs(rKm - f.rKm) <= f.widthKm / 2) {
      if (!inside || f.widthKm < inside.widthKm) inside = f;
    }
  }
  const z = zoneAtKm(rKm);
  if (inside) return z ? `${inside.name} (${z.name})` : inside.name;
  if (z) return z.name;
  const o = OUTER_RINGS;
  if (Math.abs(rKm - o.F.aKm) < 300) return 'F ring';
  if (rKm < 140_000) return 'Roche Division';
  if (rKm >= o.JanusEpimetheus.rInnerKm && rKm <= o.JanusEpimetheus.rOuterKm) return 'Janus/Epimetheus ring';
  if (rKm >= o.G.rInnerKm && rKm <= o.G.rOuterKm) return 'G ring';
  if (rKm >= o.E.rInnerKm && rKm <= o.E.rOuterKm) return 'E ring';
  return 'outside the rings';
}

export type ZoneParams = Omit<RingZone, 'key' | 'name' | 'rInnerKm' | 'rOuterKm' | 'sigma0' | 'sigmaSlope' | 'wakeB'> & {
  zone: RingZone | null;
  /** affine surface-density model (always present; see header) */
  sigma0: number;
  sigmaSlope: number;
  /** wake parameter set, blended (0 = A-ring set, 1 = B-ring set) */
  wakeB: number;
};

/**
 * Smoothly-blended zone parameters at radius rKm (blend half-width `blendKm` across zone boundaries,
 * except tau which comes from the radial profile). Zones are not blended across a boundary between a
 * macroscopic zone and a dust zone (gap edges / ring edges are physically sharp).
 */
export function zoneParamsAtKm(rKm: number, blendKm = 40): ZoneParams {
  const z = zoneAtKm(rKm);
  const base = z ?? RING_ZONES[RING_ZONES.length - 1];
  const out: ZoneParams = {
    zone: z,
    q: base.q, aMin: base.aMin, aMax: base.aMax, H: base.H, sigmaPerTau: base.sigmaPerTau,
    sigma0: base.sigma0 ?? 0, sigmaSlope: base.sigmaSlope ?? base.sigmaPerTau,
    albedo: [...base.albedo] as [number, number, number], wake: base.wake, wakeB: base.wakeB ?? 0, dust: base.dust,
    tauTypical: base.tauTypical, macroscopic: base.macroscopic, rhoBulk: base.rhoBulk, ref: base.ref,
  };
  if (!z) return out;
  const idx = RING_ZONES.indexOf(z);
  const blendWith = (other: RingZone, w: number) => {
    if (other.macroscopic !== z.macroscopic) return;
    // log-blend sizes, linear-blend the rest
    out.q = out.q * (1 - w) + other.q * w;
    out.aMin = Math.exp(Math.log(out.aMin) * (1 - w) + Math.log(other.aMin) * w);
    out.aMax = Math.exp(Math.log(out.aMax) * (1 - w) + Math.log(other.aMax) * w);
    out.H = out.H * (1 - w) + other.H * w;
    out.sigmaPerTau = out.sigmaPerTau * (1 - w) + other.sigmaPerTau * w;
    out.sigma0 = out.sigma0 * (1 - w) + (other.sigma0 ?? 0) * w;
    out.sigmaSlope = out.sigmaSlope * (1 - w) + (other.sigmaSlope ?? other.sigmaPerTau) * w;
    for (let i = 0; i < 3; i++) out.albedo[i] = out.albedo[i] * (1 - w) + other.albedo[i] * w;
    out.wake = out.wake * (1 - w) + other.wake * w;
    out.wakeB = out.wakeB * (1 - w) + (other.wakeB ?? 0) * w;
    out.dust = out.dust * (1 - w) + other.dust * w;
  };
  const dIn = rKm - z.rInnerKm;
  const dOut = z.rOuterKm - rKm;
  if (dIn < blendKm && idx > 0) blendWith(RING_ZONES[idx - 1], 0.5 * (1 - dIn / blendKm));
  else if (dOut < blendKm && idx < RING_ZONES.length - 1) blendWith(RING_ZONES[idx + 1], 0.5 * (1 - dOut / blendKm));
  return out;
}
