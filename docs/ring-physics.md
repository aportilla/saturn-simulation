# Saturn's main rings — physical fact sheet

Numbers used by the simulator (`src/rings/ringRegions.ts`, `public/data/rings/tau_main.*`), with sources and
uncertainty notes. SI units unless stated (1 g/cm² = 10 kg/m²). Radii are from Saturn's centre (R_S = 60,268 km).
Everything here is reproducible with the scripts in `scripts/data/rings/` (see the last section).

## 1. Scale in one paragraph

The main rings span 74,491–136,770 km (C ring inner edge to A ring outer edge; D ring inside to 66,900 km)
but are only **~5–15 m thick**. They are made of water-ice particles (≳ 95 % ice by mass; the C ring and the
Cassini Division carry 5–10× more of the dark, neutral non-icy material; Miller et al. 2024), ~0.5 cm to ~10 m
in radius, following a power law dN/da ∝ a^−q with q ≈ 2.8–3.2. The total mass is **1.54 ± 0.49 × 10¹⁹ kg =
0.41 ± 0.13 Mimas masses** (Iess et al. 2019, Cassini Grand Finale gravity). Particles orbit at 16.8–22 km/s
with random velocities of only ~0.1–1 mm/s. Neighbours 100 m apart in radius drift past each other at 2–4 cm/s
(Keplerian shear).

## 2. Optical-depth profile (`public/data/rings/tau_main.{json,f32}`)

Grid: 70,000–140,000 km, Δr = 0.25 km (n = 280,001), aligned with the RingProfile grid. The quantity is the
**normal geometric (visible-equivalent) optical depth**: extinction efficiency 1, as seen by stellar occultations
and by eye. NaN means no data: below 74,300 km (D ring, τ ~10⁻⁵–10⁻³, below detection) and beyond 136,774 km
(Roche Division, F ring). Built by `scripts/data/rings/build_tau.mjs` from:

* **Shape: Cassini RSS X-band (3.6 cm), Rev 7 egress, DSN 43, 2005-123** (`RSS_2005_123_X43_E_TAU_01KM`,
  CORSS_8001; Marouf 2018). It has 1 km reconstruction resolution (Fresnel inversion, Marouf et al. 1986) and
  0.25 km sampling. Radii include the label's pole-correction and timing-offset columns. Ring elevation
  B = −23.6°. One profile is used, not an average: eccentric ringlets and edges, and the phases of spiral
  density waves, differ between longitudes and would be smeared (verified against RSS Rev 7 ingress and 6 UVIS
  profiles).
* **Radio → visible.** The RSS τ is the extinction τ of the *coherent* signal. Particles ≫ λ remove twice their
  geometric cross-section from it (diffracted power is lost: Q_ext = 2), and sub-cm grains are nearly invisible
  at 3.6 cm. Measured directly here in the wake-free C ring and Cassini Division floor, **τ_X/τ_UVIS = 2.00 ±
  0.02**. In the C-ring ramp and the CD ramp it is 1.7 (≈15 % of the visible τ is in particles ≲ 1 cm). In the
  A ring and B1 the ratio is lower (RSS/2 is 25–45 % below UVIS in A, ~40 % in B1). That is the self-gravity-wake
  effect: at low elevation the line of sight runs along the inter-wake gaps (Colwell et al. 2006; Hedman et al.
  2007). The RSS profile is therefore multiplied by a smooth ratio map R(r) = ⟨τ_UVIS⟩/⟨τ_X/2⟩, with 50 km
  windows, ring material only, and eccentric-feature zones filled from their surroundings. R ≈ 1.0 in the C ring
  and CD, 1.15–1.4 in the ramps, 1.9 in the inner A ring falling to 1.35 in the outer A ring. The result has
  RSS fine structure on a visible, high-elevation calibration.
* **Opaque B ring (92,150–117,020 km): Cassini UVIS HSP stellar occultations of β Centauri** (B = 66.7°; six
  ingress occultations 2008-202 … 2009-065; COUVIS_8001, Colwell et al. 2010). RSS is saturated over most of
  B2–B4 (its threshold τ/2 ≈ 2). Transmission is recomputed from the raw columns, T = (signal − background)/star,
  because the tabulated τ is capped near 8.6. Each profile is registered to the RSS radius scale by
  cross-correlating circular C-ring plateaus and B1 structure (offsets −0.34…+0.15 km), averaged **in
  transmission**, and converted with τ = −μ ln⟨T⟩. Where ⟨T⟩ < 2σ of photon noise, τ is a lower limit
  (τ ≳ 8). That covers 712 km, 2.9 % of the B ring, set to τ = 8 (opaque). At 1 km the outer B ring
  (115.5–117 k) varies between τ ≈ 2 and ≈ 8 differently in every occultation, i.e. its structure is
  non-axisymmetric or sub-km. Only its mean transmission is meaningful.
* **Edges.** Negative noise is clipped and deep gap floors are smoothed (±1.5 km). Gap edges (31 of them) are
  deconvolved to a step at the half-level crossing: the data resolve ~1 km, while real gap edges are sharp at
  tens of metres. The renderer's 0.25 km grid then gives 250 m edges.

Zone means of the result: C 0.10 (median 0.07), B1 1.32, B2 4.24, B3 5.53, B4 3.12, B5 1.41, CD 0.11,
CD ramp 0.16, A inner 0.76, A outer 0.65. Of the B-ring area, 34 % has τ > 4 and 25 % τ > 5. Hedman & Nicholson
(2016) quote 27 % / < 16 % from VIMS γ Cru; our values are higher because averaging six UVIS β Cen occultations
gives a larger dynamic range.

**Caveats.** (1) Wake regions (A, B) are photometrically anisotropic: a homogeneous slab with this τ is more
opaque at low elevation than the real ring, which is more transparent along the wakes. (2) The eccentric
features are a snapshot at the 2005-123 RSS longitude: Titan ringlet 77,885–77,913 km (mean 77,867–77,890),
Maxwell ringlet 87,483–87,550 (mean 87,480–87,539), Huygens ringlet 117,822–117,842 (mean 117,806–117,824),
B-ring edge 117,650 (mean 117,570, Mimas 2:1 m = 2 mode ±~75 km; Nicholson et al. 2014a), A-ring edge 136,769
(Janus/Epimetheus 7:6, m = 7). (3) Density waves become concentric ripples, since the profile is axisymmetric.
Their real pitch is tiny, so locally this is right. (4) In the A ring the 1 km-scale ±10–15 % τ texture is real
but mostly not axisymmetric (ingress/egress correlation < 0.35 at < 2 km scales).

## 3. Zone parameters (`RING_ZONES`)

| zone (km) | q | aMin–aMax | H (m) | Σ (kg/m²) | albedo ϖ₀ (R,G,B) | wake | dust | ρ implied |
|---|---|---|---|---|---|---|---|---|
| D 66,900–74,491 | 3.5 | 1–100 µm | 1000 | ~0 | 0.75,0.78,0.85 | 0 | 1 | – |
| C inner 74,491–79,000 | 3.16 | 4.1 mm–10 m | 5 | 10 | 0.17,0.16,0.145 | 0 | 0.01 | 160 |
| C 79,000–84,000 | 3.16 | 4.1 mm–10 m | 5 | 40 | 0.21,0.20,0.18 | 0 | 0.01 | 410 |
| C outer 84,000–90,620 | 3.16 | 4.1 mm–10 m | 5 | 15 | 0.21,0.20,0.18 | 0 | 0.01 | 115 |
| C ramp 90,620–91,975 | 3.16 | 3.8 mm–10 m | 5 | 50 | 0.32,0.30,0.26 | 0 | 0.01 | 340 |
| B1 91,975–99,000 | 2.9 | 5 cm–3 m | 10 | 400 | 0.62,0.56,0.45 | 0.6 | 0 | 280 |
| B2 99,000–104,000 | 3.2 | 5 cm–2 m | 15 | 420 | 0.66,0.59,0.47 | 0.5 | 0 | 170 |
| B3 104,000–110,000 | 3.2 | 5 cm–2 m | 15 | 680 | 0.66,0.59,0.47 | 0.5 | 0 | 210 |
| B4 110,000–116,500 | 3.1 | 5 cm–2.5 m | 12 | 700 | 0.66,0.59,0.47 | 0.6 | 0 | 300 |
| B5 116,500–117,700 | 2.9 | 5 cm–3 m | 10 | 520 | 0.66,0.59,0.47 | 0.5 | 0 | 340 |
| CD 117,700–120,900 | 2.9 | 4.1 mm–9 m | 4 | 8 + 60τ (~15) | 0.30,0.28,0.25 | 0 | 0.01 | 65 |
| CD ramp 120,900–122,050 | 3.05 | 3.3 mm–10 m | 5 | 840τ (~130) | 0.42,0.39,0.33 | 0 | 0.005 | 580 |
| A inner 122,050–133,423 | 2.9 | 2 cm–5 m | 10 | 433τ (~330) | 0.58,0.52,0.43 | 1.0 | 0.001 | 300 |
| Encke gap 133,423–133,745 | dust | 1–100 µm | 200 | ~0 | dust | 0 | 1 | – |
| A outer 133,745–136,770 | 3.05 | 5 mm–7 m | 10 | 310τ (~200) | 0.58,0.52,0.43 | 0.6 | 0.003 | 280 |
| Roche Div. 136,770–139,380 | dust | 1–100 µm | 500 | ~0 | dust | 0 | 1 | – |

Σ for C and B zones is the zone mean (τ-independent; see §4). For the others it is ∝ τ with the zone-mean value
in brackets. "ρ implied" = 3Σ/(4τa_V), a_V = ∫a³n da/∫a²n da, in kg/m³ (information only). Zones are blended
over ±40 km, except across dust ↔ macroscopic boundaries (gap and ring edges are sharp).

**Particle sizes.**
* *C ring and ramp*: Jerousek et al. 2020 (UVIS + VIMS + RSS) give q ≈ 3.16, a_min ≈ 4.1 mm, a_max ≈ 10–15 m in the
  background. Plateaux have q ≈ 3.05, a_min ≈ 6 mm, a_max ≈ 5–6 m (not separable at zone scale). Harbison et
  al. 2013: a_min = 4.1 (+3.8/−1.3) mm.
* *Cassini Division*: q 2.79 (Zebker et al. 1985) to ~3.0 (Jerousek et al. 2020), a_min ~4 mm, a_max 7.5–9 m;
  ramp q ≈ 3.05, a_max up to ~20 m (capped at 10 m, the largest LOD class).
* *A ring*: q ≈ 2.74–2.9 inside the Encke gap and ≈ 3.03–3.2 outside (Zebker et al. 1985; Miller et al. 2024).
  a_min 15 mm at the Encke inner edge, 9.3 mm at its outer edge, 4.4 mm at the A-ring edge (Becker et al. 2016).
  a_max 5–10 m.
* *B ring*: Cassini RSS three-band data show almost no particles < 5 cm (Marouf et al. 2008; Cuzzi et al. 2009).
  French & Nicholson 2000 give a_min ≈ 30 cm, q 2.75, a_max ≳ 5–20 m from Earth-based 28 Sgr data. Those large
  a_max/shallow q values (a_V ≈ 1.9 m) cannot hold in B2–B4. At τ = 4–6 they imply 10–15 m³ of solid per m²
  (impossible in a 10–15 m layer) and 10–20× the mass the density waves allow. Mass, packing and the higher τ/Σ of
  the opaque regions (Hedman & Nicholson 2016) all point to smaller particles where τ is high. Adopted values give
  mid-plane volume filling ≤ 0.4 and implied ρ 0.17–0.34 g/cm³, consistent with porous aggregates (Jerousek et al.
  2020: 0.1–0.3; Afigbo et al. 2025: ~0.3 inside 84,000 km, down to 0.03 outside). **Uncertainty: ~×2 in a_max.**
* *Caveat*: the occultation size distributions and the wave-derived Σ disagree everywhere by factors of 2–10 unless
  the particles are very porous. The implied densities above are the measure of that tension.

**Thickness H** (full thickness; RingLod puts small grains at σ_z = 0.4 H and metre-sized boulders at 0.15 H).
* Upper limits from density-wave damping (Tiscareno et al. 2007): ≤ 3.0 m (118,800 km), ≤ 4.5 m (120,700 km),
  ≤ 10–15 m in the inner A ring.
* Wake heights: H/W = 0.15–0.37 with W ~20–30 m (Colwell et al. 2006); H/W < 0.12, i.e. H < 4 m, in later
  analyses (Esposito et al. 2022).
* Compilation (Miller et al. 2024): ~6 m for the A ring; velocity dispersion arguments give 4–20 m (A), ≤ 10 m (B),
  3–5 m (CD).
* Opaque B2/B3 use 15 m and B4 12 m, required for physical packing at τ = 3–6 (above). **Uncertainty: ×2.**

**Albedo and colour.** These are particle Bond (single-scattering) albedos at ~650/550/450 nm.
* A and B rings: A_V ≈ 0.5–0.6 (Doyle et al. 1989; Dones et al. 1993; Morishima et al. 2010: 0.55; 0.45 from a
  slab model, Altobelli et al. 2014). B particles are the brightest (Ciarniello et al. 2019), and both rings are
  strongly red in the visible (Cuzzi et al. 2009; Filacchione et al. 2014; Hedman et al. 2013).
* C ring: ≈ 0.15–0.25, declining toward Saturn (Cooke 1991; Morishima et al. 2010).
* Cassini Division: similar to the C ring and less red.
* Ramps are intermediate.
* **Uncertainty ±0.05–0.1**, and model-dependent: the albedo trades off against the assumed particle phase function.

**Wakes** (0–1, relative). Strongest in the inner/mid A ring, where the azimuthal brightness asymmetry and
occultation wake signal peak (Colwell et al. 2006; Hedman et al. 2007; French et al. 2007). Weaker beyond the
Encke gap. Present but packed with narrow gaps in the B ring (Colwell et al. 2007; Nicholson & Hedman 2010).
Absent in the C ring and CD (Toomre λ ≈ 1–2 m is smaller than the particles).

**Dust** (fraction of τ in ≲ 100 µm grains). The A and C rings "lack the persistent icy dust" of the F ring
(Harbison et al. 2013). Small values are kept for the C ring and CD, which brighten at high phase. Dusty zones are
the D ring, Encke-gap ringlets and the Roche Division.

## 4. Surface density and the ring-mass check

Density-wave Σ: A ring 28–38 g/cm² inside the Encke gap (Tiscareno et al. 2007, 2013; Tiscareno & Harris 2018:
30–35), 25 → 16 g/cm² from the Encke outer edge to the A-ring edge (T&H 2018). CD 1.5 (118,830 km) and 3.3
(120,669 km) g/cm² (Tiscareno et al. 2007); the ramp rises toward 28 g/cm² at 122,313 km (τ/Σ up to 10× lower than
in the main CD; Tiscareno et al. 2013). B ring 39–72 g/cm² across B1–B4 and 120–141 at the Janus 3:2 wave
(Hedman & Nicholson 2016; T&H 2018 ~25 at 95,500 km). C ring 0.25–3 g/cm² (Afigbo et al. 2025), peaking near
82,000 km (4–10 g/cm² in Hedman & Nicholson 2014). **τ is not a proxy for Σ in the B and C rings**: the B ring's Σ
is "largely uncorrelated" with τ (H&N 2016), and C-ring plateaux have about the background Σ at 4× the τ
(H&N 2014). The zone table therefore carries an optional affine model, Σ = σ₀ + σ_slope·τ (σ_slope = 0 in B and C).
`sigmaPerTau` is calibrated so the loader's proportional Σ gives the same zone masses.

`node scripts/data/rings/mass_check.mjs` (∫2πrΣ dr over the real τ profile):

| | model | literature |
|---|---|---|
| C ring (incl. ramp) | 2.2 × 10¹⁷ kg | 0.37–3.4 × 10¹⁷ (Baillié et al. 2011 … Miller et al. 2024) |
| B ring | 9.5 × 10¹⁸ kg | 7–12 × 10¹⁸ (up to 2.4 × 10¹⁹) (Hedman & Nicholson 2016) |
| Cassini Division | 1.5 × 10¹⁷ kg | 1.7 × 10¹⁷ (Miller et al. 2024) |
| A ring | 3.5 × 10¹⁸ kg | 3.7 × 10¹⁸ (Miller et al. 2024) |
| **total** | **1.34 × 10¹⁹ kg (0.36 M_Mimas)** | **1.54 ± 0.49 × 10¹⁹ (Iess et al. 2019)**, i.e. −0.4σ |

## 5. Named features (`RING_FEATURES`)

Radii are as rendered, measured in `tau_main` (`scripts/data/rings/measure_features.mjs`); catalogue values are
from the PDS Rings Node "Vital statistics" table.

| feature | profile (km) | catalogue (km) |
|---|---|---|
| C ring inner edge | 74,490 | 74,491 |
| Colombo gap / Titan ringlet | 77,730–77,930 / 77,885–77,913 (τ̄ 1.7) | 77,748–77,926 / 77,867–77,890 |
| plateaux (τ̄) | 79,222–79,263 (0.42), P5 84,750–84,948 (0.44), P6 85,662–85,755 (0.29), 85,924–85,974 (0.28), P7 86,372–86,601 (0.41), 88,358–88,592 (0.25), 89,191–89,291 (0.26), 89,790–89,938 (0.34), 90,406–90,600 (0.36) | P5–P7 naming: Hedman & Nicholson 2014 |
| Maxwell gap / ringlet | 87,349–87,609 / 87,483–87,550 (τ̄ 0.7) | 87,343–87,610 / 87,480–87,539 |
| Bond gap / ringlet | 88,681–88,723 / 88,702–88,718 (τ̄ 0.85) | 88,686–88,723 / 88,702–88,719 |
| Dawes ringlet / gap | 90,132–90,203 / 90,203–90,219 | 90,138–90,200 / 90,200–90,221 |
| B-ring regions | B1 91,975–99,000; B2 –104,000; B3 –110,000; B4 –116,500; B5 –117,570 | Colwell et al. 2009 |
| B-ring outer edge | 117,650 | 117,570 (mean; m = 2 ±~75 km) |
| Huygens gap / ringlet / Strange ringlet | 117,650–117,930 / 117,822–117,842 / 117,908–117,911 | 117,500–117,930 / 117,806–117,824 / 117,907–117,909 |
| Herschel gap (ringlet) | 118,192–118,284 (118,233–118,262) | 118,188–118,284 (118,234–118,263) |
| Russell, Jeffreys, Kuiper | 118,589–118,628, 118,932–118,967, 119,400–119,406 | 118,590–118,628, 118,930–118,967, 119,402–119,406 |
| Laplace gap (ringlet) | 119,837–120,085 (120,039–120,074) | 119,845–120,086 (120,037–120,078) |
| Bessel, Barnard | 120,230–120,243, 120,300–120,316 | 120,231–120,244, 120,304–120,316 |
| CD triple band; ramp | 120,550–120,800; 120,900–122,050 | Jerousek et al. 2020 |
| A ring inner edge | 122,050 | 122,050 |
| Encke gap | 133,424–133,745 | 133,423–133,745 (Pan) |
| Keeler gap | 136,483–136,523 | 136,487–136,522 (Daphnis) |
| A ring outer edge | 136,769 | 136,770 |
| F ring core | a = 140,221.3 km, e = 2.35 × 10⁻³, i = 0.0064° (Albers et al. 2012), ϖ̇ = 2.70°/day (Bosh et al. 2002) | |

## 6. What it is like inside the rings

Computed by `node scripts/data/rings/inside_numbers.mjs` from the zone table, the real τ (local mean), the
J2–J6 orbital frequencies (`src/core/constants.ts`) and RingLod's vertical law (σ_z = sigZFrac(a)·H, Gaussian).
Mid-plane extinction and filling include the finite particle size (a boulder bigger than its vertical scatter
blocks its full chord). Velocity dispersion is taken as ν·σ_z. It is consistent with Toomre Q ~ 1–2 in the A/B
rings, and with the ~1 mm/s inferred from density-wave damping, to within the factor-2 uncertainty of H.

| quantity | C ring (82,000 km) | C plateau P7 (86,490) | B1 (95,000) | B3 core (107,000) | Cassini Div. (119,000) | A mid (128,000) | A outer (135,000) |
|---|---|---|---|---|---|---|---|
| normal optical depth τ | 0.135 | 0.40 | 0.87 | 5.9 | 0.062 | 0.66 | 0.60 |
| q / aMin / aMax | 3.16 / 0.41 cm / 10 m | 3.16 / 0.41 cm / 10 m | 2.9 / 5 cm / 3 m | 3.2 / 5 cm / 2 m | 2.9 / 0.41 cm / 9 m | 2.9 / 2 cm / 5 m | 3.05 / 0.5 cm / 7 m |
| half of τ is in particles larger than | 6 cm | 6 cm | 48 cm | 23 cm | 40 cm | 46 cm | 14 cm |
| layer thickness H | 5 m | 5 m | 10 m | 15 m | 4 m | 10 m | 10 m |
| Σ (literature) | 40 kg/m² | 15 | 400 | 680 | 12 | 284 | 186 |
| particles per m² of ring > 1 cm / > 10 cm / > 1 m | 39 / 0.27 / 0.0018 | 110 / 0.79 / 0.0054 | 12 / 3.1 / 0.034 | 130 / 28 / 0.14 | 9.9 / 0.12 / 0.0015 | 37 / 1.8 / 0.021 | 150 / 1.3 / 0.012 |
| per m³ at mid-plane > 1 cm / > 10 cm / > 1 m | 8.1 / 0.074 / 0.00075 | 24 / 0.22 / 0.0022 | 1.5 / 0.43 / 0.0068 | 11 / 2.6 / 0.018 | 2.6 / 0.044 / 0.0008 | 4.3 / 0.25 / 0.0043 | 16 / 0.18 / 0.0023 |
| typical spacing of > 10 cm / > 1 m bodies | 2.4 m / 11 m | 1.7 / 7.7 m | 1.3 / 5.3 m | 0.7 / 3.8 m | 2.8 / 11 m | 1.6 / 6.2 m | 1.8 / 7.5 m |
| mid-plane volume filling factor | 0.03 | 0.08 | 0.17 | 0.40 | 0.03 | 0.16 | 0.10 |
| horizontal mean free path (mid-plane) | 31 m | 11 m | 7 m | 1.7 m | 56 m | 10 m | 12 m |
| **how far you can see horizontally** (to 1 %) | ~140 m | ~50 m | ~33 m | ~8 m | ~260 m | ~46 m | ~57 m |
| vertical: mid-plane → open sky, transmission | 0.93 | 0.82 | 0.65 | 0.05 (mfp 1.7 m) | 0.97 | 0.72 | 0.74 |
| whole layer, straight through (e^−τ) | 0.87 | 0.67 | 0.42 | 0.003 | 0.94 | 0.52 | 0.55 |
| direct sunlight reaching mid-plane, Sun 8.2° above the rings (Nov 2026) | 62 % | 25 % | 5 % | 10⁻⁹ (night) | 80 % | 10 % | 12 % |
| random velocity, cm grains / m boulders | 0.5 / 0.2 mm/s | 0.5 / 0.2 | 0.9 / 0.4 | 1.1 / 0.5 | 0.24 / 0.09 | 0.5 / 0.2 | 0.5 / 0.2 |
| collisions per orbit: cm grain (≈2τ) / mean (ω_c ≈ 3Ωτ) | 0.25 / 2.5 | 0.7 / 7.5 | 1.2 / 16 | 2 / >100 (in contact) | 0.12 / 1.2 | 1 / 12 | 0.9 / 11 |
| orbital period / speed | 6.61 h / 21.7 km/s | 7.16 h / 21.1 | 8.26 h / 20.1 | 9.88 h / 18.9 | 11.6 h / 17.9 | 12.94 h / 17.3 | 14.0 h / 16.8 |
| shear speed 100 m away (1.5 Ω·100 m) | 4.0 cm/s | 3.7 | 3.2 | 2.7 | 2.3 | 2.0 | 1.9 |
| epicycle / vertical-oscillation period | 6.70 / 6.52 h | 7.26 / 7.08 | 8.34 / 8.17 | 9.96 / 9.80 | 11.67 / 11.52 | 13.01 / 12.87 | 14.09 / 13.95 |
| Toomre wavelength 4π²GΣ/κ² | 1.6 m (no wakes) | 0.7 m | 24 m | 58 m | 1.4 m | 42 m | 32 m |

In words:
* **A ring (128,000 km).** About 37 particles per square metre of ring are larger than a centimetre. Fewer than
  two are larger than 10 cm, and a boulder over 1 m comes once per ~50 m². Bodies larger than 10 cm sit ~1.6 m
  apart in the 10 m-thick sheet. You can see ~10 m (1/e) to ~50 m (1 %) horizontally; looking straight up you see
  72 % of the sky. Self-gravity clumps them into trailing wakes ~40 m apart. Everything moves with everything
  else to within ~0.5 mm/s (a few cm per minute). A particle 100 m outward drifts backward at 2 cm/s. Each grain
  is struck about once per 13-h orbit.
* **B ring core (107,000 km).** A closely packed swarm in a 15 m layer: ~130 particles per m² of ring larger than
  5 cm, ~28 larger than 10 cm, a 1–2 m body every ~7 m². Bodies are spaced ~0.7 m apart; you can see 2–8 m.
  The layer above you has τ ≈ 3, so the mid-plane is in deep shadow (≤ 5 % of diffuse light; no direct Sun at
  an 8° solar elevation). Particles are continually in contact. Wakes ~60 m apart.
* **C ring (82,000 km).** Sparse and dark: 39 particles per m² larger than 1 cm (mostly 0.4–6 cm grains), one
  > 1 m boulder per ~550 m² (11 m apart in a 5 m layer, the largest ~10 m across). You see ~30–140 m sideways
  and 93 % of the sky. A grain collides only every ~4 orbits (≈ 1 day). The shear is fastest here: 4 cm/s at
  100 m.

## 7. Notes for implementers

* `RingProfile` uses Σ = sigmaPerTau·τ. That gives the right zone masses but makes Σ (and the wake wavelength)
  follow τ inside the B and C rings. For example, B2's τ ≈ 1.5 bands get Σ ≈ 150 kg/m² where 400 is measured,
  which also suppresses their wakes via WakeField's λ/aMax test. The literature behaviour is
  `Σ = zp.sigma0 · smooth(0.002, 0.02, τ) + zp.sigmaSlope · τ` (both always present in `zoneParamsAtKm`).
* `RingLod` size classes span 1 cm–10.24 m. With aMin < 1 cm (C ring, CD, outer A ring: 11–18 % of τ in
  0.4–1 cm grains) `tauFrac` sums to < 1 and `ringExtinction` under-counts the medium. The missing fraction should
  be carried as an unresolved Gaussian layer (σ_z = 0.4 H).
* The tau profile ends at the A-ring edge. The procedural fallback gives τ = 0 in the Roche Division, but the real
  value is ~10⁻⁴ of dust (PDS), with R/2004 S1 at 137,630 km.

## 8. N-body calibration of self-gravity wakes and packing

The procedural wake field (`WakeField.ts`, `wakes.glsl`) and RingLod's vertical law were compared with local N-body
simulations of the ring sheet: the same statistics, computed by the same code, for N-body snapshots and for particles
drawn from a bit-exact Python port of the procedural model. Tools, commands and runtimes:
`scripts/data/nbody/README.md`. All numbers below are in `scripts/data/nbody/results/*.json`.

**N-body method.** REBOUND (Rein & Liu 2012) in the shearing sheet: Hill's equations with the SEI integrator (Rein &
Tremaine 2011), Ω from the J2–J6 mean motion, shear-periodic boundaries, tree gravity over 3×3 images, and frictionless
hard-sphere collisions with ε(v_n) = min[1, (v_n/0.0077 cm s⁻¹)^−0.234] (Bridges et al. 1984, in the form used by Salo
et al. 2004). Time step P/1000 (P/800 for the identical particles); 4000 steps per orbit gave the same velocity
dispersions and thickness.
* *Image mean field.* REBOUND sums gravity over *box-centred* images, so the uniform background pulls particles toward
  the box centre (≈ 0.85 GΣ at the edge). In azimuth that pull destabilises corotating orbits (growth rate ≈ 0.15–0.2 Ω).
  The analytic in-plane field of the uniform image sheet is subtracted every step. A check on unstructured states leaves
  a residual ≲ 0.1 GΣ, the level of the realization noise.
* *Size distributions.* These follow the zone table but omit particles below a_min (0.1–0.2 m). Each simulated size has
  the number per m² of the full distribution at the zone's τ, and the internal density makes Σ exact. The simulated
  optical depth is therefore lower (the "τ deficit").
* *r_h.* r_h = R_Hill(pair)/(r1 + r2), the inverse of the r_p of Salo et al. (2004). Their standard run (ρ = 450 kg m⁻³,
  130,000 km, r_p = 1.18) has r_h = 0.85 by the same formula.

**Procedural side.** `procedural.py` ports WakeField.ts (RNG, texture, configure, generation clock) and wakes.glsl
(texture filtering, phase, circle map, displacement, inverse, `wakeDensity`) to Python. `--verify` runs the real
TypeScript and matches the texture texels, λ, tile, strength, shape and generation uniforms exactly.

For each N-body run a synthetic run uses the same box, Toomre λ, particle sizes and number density (so the same Poisson
noise), with the wake parameters the app would use at that site. Particles are placed the way the near field draws
them: uniform epicyclic positions plus `wakeDisplacement`, z Gaussian with σ_z = sigZFrac(a_eff)·H, and RingLod
kinematics.

**Analysis.** `analyze.py` deposits each snapshot on a λ_T/32 grid. Particles larger than half a cell are spread over
their footprint: the projected disc for mass and cross-section, the mid-plane chord disc for the filling factor. The
grid is smoothed with a physical-space Gaussian (exact for the shear-periodic box through the sheared Fourier basis).
D is the surface-mass-density factor Σ/⟨Σ⟩, the quantity `wakeDensity()` models, unless "τ field" (cross-section per
area) is stated. Uncertainties are standard errors of 1-orbit block means.

### 8.1 Runs

| run | site | Σ (kg/m²) | τ zone / simulated | radii (m), q | ρ (kg/m³) / r_h | box | N | orbits (measured) | wall time |
|---|---|---|---|---|---|---|---|---|---|
| A128-ident | 128,000 km | 284 | 0.60 / 0.60 | 1 (identical) | 355 / 0.77 | 8 λ_T = 329 m | 20,694 | 20 (8–20) | 21 min |
| A128-sd | 128,000 km | 284 | 0.66 / 0.42 | 0.2–5, q 2.9 | 322 / 0.75 | 8 λ_T = 329 m | 51,051 | 12 (6–12) | 89 min |
| A128-sd10 | 128,000 km | 284 | 0.66 / 0.49 | 0.1–5, q 2.9 | 328 / 0.75 | 4 λ_T = 165 m | 47,709 | 10 (6–10) | 89 min |
| A128-sdtau | 128,000 km | 284 | 0.66 / 0.65 | 0.2–5 + 28,116 proxies of 0.2 m | 312 / 0.74 | 3 λ_T = 123 m | 35,295 | 8 (4–8) | 58 min |
| A135-sd | 135,000 km | 186 | 0.60 / 0.26 | 0.2–7, q 3.05 | 302 / 0.77 | 8 λ_T = 253 m | 20,395 | 14 (6–14) | 28 min |
| A135-sd10 | 135,000 km | 186 | 0.60 / 0.31 | 0.1–7, q 3.05 | 339 / 0.80 | 4 λ_T = 127 m | 21,126 | 12 (6–12) | 32 min |
| A135-amax3 | 135,000 km | 186 | 0.60 / 0.23 | 0.2–3, q 3.05 | 625 / 0.98 | 8 λ_T = 253 m | 22,568 | 12 (6–12) | 25 min |
| B105-sd | 105,000 km | 600 | 2.5 / 1.34 | 0.2–2, q 3.2 | 469 / 0.69 | 4 λ_T = 191 m | 95,631 | 6 (4–6) | 118 min |

* **What the runs are for.**
  * A128-ident is the classic identical-particle reference for wake morphology.
  * A128-sd uses the app's mid-A size distribution, truncated at 0.2 m.
  * A128-sd10 and A128-sdtau test the truncation: a_min 0.1 m, and proxies restoring the full τ.
  * A135-* is the outer A ring.
  * B105-sd is a B-ring case (τ ≈ 2–3, Σ 600).
* **Common settings.** Each run is one REBOUND process on one core, 4–8 in parallel on an M5 Max. Snapshots are taken
  every 0.05 orbit in the measured window. λ_T = 4π²GΣ/Ω² is 41.1 m at 128,000 km, 31.6 m at 135,000 km and 47.9 m at
  105,000 km.
* **Q.** Toomre Q from the mass-weighted radial dispersion is 1.7 (A128-ident), 2.7/2.5/2.4 (A128-sd/sd10/sdtau),
  4.5/3.8/4.0 (A135-sd/sd10/amax3) and 1.7 (B105).

### 8.2 Mid-A ring (128,000 km): wake morphology

The table compares A128-ident (identical 1 m particles, τ 0.6, measured over 12 orbits) with the app's field at the same
site (strength 1, γ 0.16, spreads 1.6/5.0, R_C 0.45, T_LIFE 3) and with the recommended parameters of §8.9 (6-orbit
synthetic runs with the same particles). The surface-mass-density field is smoothed at λ_T/16 for the quantiles and
skeleton, and at λ/32 for spectra, the ACF and orientations.

| statistic | N-body (1 m identical) | app (defaults) | app, recommended (§8.9) |
|---|---|---|---|
| spectral peak spacing / λ_T | 1.67 ± 0.11 | 1.06 ± 0.02 | 1.22 ± 0.16 |
| power-weighted spacing 2π/⟨k⟩ / λ_T | 1.59 | 1.01 | 1.15 |
| ACF spacing (2 × first-minimum lag) / λ_T | 0.72 | 0.94 | 0.72 |
| pitch: crest orientation median (IQR) [deg] | 19.8 (13–26) | 21.0 (18–25) | 17.3 (12–25) |
| pitch: spectral peak / ACF axis [deg] | 15.3 / 18.7 | 21.4 / 21.5 | 23.9 / 16.6 |
| pitch within a snapshot: IQR / drift of the median over time (std) [deg] | 12.7 / 1.4 | 7.6 / 2.3 | 5.8 / 7.9 |
| share of crest energy trailing | 0.98 | 0.99 | 0.99 |
| along-crest correlation length (1/e) / λ_T | 0.85 | 1.35 | 0.95 |
| across-crest correlation length (1/e) / λ_T | 0.130 | 0.106 | 0.099 |
| ACF across crests: first minimum / next maximum | −0.17 / −0.04 | −0.27 / +0.13 | −0.19 / +0.01 |
| crest end points per λ_T² | 0.98 ± 0.01 | 0.47 ± 0.02 | 0.81 ± 0.06 |
| crest branch points per λ_T² | 0.82 ± 0.01 | 0.66 ± 0.05 | 0.97 ± 0.08 |
| mean filament length 2L/n_end / λ_T | 3.1 | 8.3 ± 0.4 | 4.6 ± 0.5 |
| D quantiles p5 / p25 / p50 / p75 / p95 / p99 (λ/16) | 0.08 / 0.34 / 0.75 / 1.42 / 2.77 / 3.86 | 0.13 / 0.32 / 0.65 / 1.49 / 2.97 / 3.71 | 0.11 / 0.35 / 0.75 / 1.41 / 2.89 / 3.88 |
| wakes (D > 1): area fraction f_B | 0.389 | 0.369 | 0.386 |
| mean D in wakes / gaps | 1.87 / 0.45 | 2.03 / 0.43 | 1.92 / 0.46 |
| mass fraction in wakes | 0.73 | 0.73 | 0.72 |
| τ_dyn in wakes / gaps | 1.12 / 0.27 | 1.22 / 0.26 | 1.15 / 0.28 |
| vertical τ_phot: all / gaps / wakes / cores | 0.53 / 0.21 / 1.41 / 3.11 | 0.45 / 0.21 / 1.05 / 2.10 | 0.44 / 0.20 / 0.97 / 1.90 |
| granola fit (slant rays): S/W, H/W, τ_G, pitch | 3.70, 0.44, 0.26, 19° | 7.12, 0.90, 0.28, 21° | 7.49, 1.07, 0.28, 16° |
| shearing-frame correlation C(0.1 / 0.2 / 0.3 / 0.5 orbit) | 0.85 / 0.58 / 0.36 / 0.12 | 0.51 / 0.13 / 0.01 / 0.00 | 0.70 / 0.62 / 0.38 / 0.04 |
| correlation half-life [orbits] | 0.24 | 0.10 | 0.25 |

Granola-bar split at D = 1: W_wake = f_B·λ_w, W_gap = (1 − f_B)·λ_w. With λ_w = λ_T (41 m) that is 16 m and 25 m for the
N-body (S/W = 1.6); with the spectral λ_w (69 m) it is 27 m and 42 m.

* **Orientation is right; the texture is not.**
  * Both fields are trailing (98–99 % of the crest energy), with a median crest pitch of ~20°: N-body 19.8° (IQR
    13–26°), procedural 21.0° (IQR 18–25°). This agrees with time-averaged simulation ACFs (25–30° in the dense core,
    15–20° in the tails; Salo et al. 2004) and with occultations (20–25° from the orbital direction; Jerousek et al. 2016).
  * The procedural crests are 1.6× longer (along-crest 1/e length 1.35 vs 0.85 λ_T), have half the end points (0.47 vs
    0.98 per λ_T²) and 2.7× longer filaments.
  * The procedural spacing is regular. The across-crest ACF has a secondary maximum of +0.13 at 1.0 λ_T; the N-body has
    none (−0.04). This is the "corduroy".
  * Orientations are mixed in every N-body snapshot: the pitch IQR *within* a snapshot is 12.8°, while the snapshot
    median stays within 17.6–22.2° (std 1.4°). At any instant one procedural generation dominates the whole field: the
    within-snapshot IQR is 7.7° and the median swings over 18–25°.
* **The N-body has no single spacing.** Its power spectrum is broad and peaks at 1.6–1.7 λ_T. Its across-crest ACF
  already has its first minimum at 0.36 λ_T, because the wakes are clumpy and branch. The procedural spectrum is narrow
  at 1.0 λ_T.
* **Contrast.**
  * The density-factor PDFs agree above the median (p95/p99 = 2.8/3.9 vs 3.0/3.7 at λ/16).
  * The N-body gaps are emptier (p5 = 0.08 vs 0.13): "almost empty gaps" (Salo et al. 2004). The circle map ties the
    gap floor γ to the core factor 1/γ, so it cannot make deeper gaps without higher peaks.
* **Lifetime.**
  * Both patterns are sheared materially. The internal shear rate that best re-aligns the field after 0.1–0.3 orbit, in
    2λ_T radial bands, is q = 1.50 ± 0.01 for the N-body and 1.51 for the procedural field (by construction). The
    N-body wakes do not resist the shear; they dissolve and re-form.
  * In that frame the N-body correlation falls to ½ after 0.24 orbit, the procedural one after 0.10.
  * Every T_LIFE/2 the procedural field hands its amplitude to an independent generation. Each generation's crests are
    also moved by the other's displacement, which reaches ~λ/4 and switches on and off within T_LIFE/2. Additive
    instead of composed displacements decorrelate just as fast.
  * More overlapping generations do not help (tested in the port: born every T/n with amplitude (2/n) sin²). Their
    calibration scores were 157–230, against 124 for two generations.

### 8.3 Size dependence (mid-A ring, the zone's q = 2.9)

Per radius bin for A128-sd (0.2–5 m; 6 orbits). The app column is RingLod's law as the near field draws it: z
Gaussian with σ_z = sigZFrac(a_eff)·H (H = 10 m), and σ_x = 1.5 σ_z.

| radius (m) | rms z, N-body: all / gaps / wakes / cores (m) | rms z: a_min 0.1 m / τ restored (m) | rms z, app (m) | c_x N-body total / local (mm/s) | c_x, app (mm/s) | participation p: N-body / a_min 0.1 m / τ restored |
|---|---|---|---|---|---|---|
| 0.10–0.20 | – | 10.6 / – | 2.9 | – | 0.58 | – / 0.53 / – |
| 0.20–0.35 | 10.2 / 10.6 / 9.5 / 9.1 | 7.8 / 8.1 | 2.7 | 2.53 / 2.53 | 0.55 | 0.60 / 0.81 / 1.06 |
| 0.35–0.60 | 7.4 / 7.8 / 6.8 / 6.6 | 6.1 / 5.6 | 2.5 | 1.93 / 1.89 | 0.50 | 0.87 / 1.02 / 1.60 |
| 0.60–1.00 | 5.6 / 5.9 / 5.3 / 5.3 | 4.9 / 4.7 | 2.3 | 1.56 / 1.46 | 0.46 | 1.13 / 1.36 / 1.97 |
| 1.00–1.75 | 4.5 / 4.6 / 4.4 / 4.8 | 4.0 / 4.1 | 2.0 | 1.33 / 1.12 | 0.41 | 1.36 / 2.02 / 2.35 |
| 1.75–3.00 | 3.4 / 3.6 / 3.3 / 3.7 | 3.2 / 3.2 | 1.8 | 1.14 / 0.73 | 0.37 | 1.36 / 1.48 / – |
| 3.00–5.00 | 2.5 / – / 2.5 / 2.5 | 2.1 / 2.1 | 1.7 | 1.00 / 0.35 | 0.34 | 1.36 / 1.49 / 1.63 |

The A128-sd standard errors of p are 0.01–0.12. The smaller boxes of the convergence runs (4 and 3 λ_T) hold only
45–170 boulders, so their absolute p values are noisier. The ratio p(small)/p(boulders) is consistent across the runs:
0.45–0.65 for 0.2–0.35 m.

The local dispersion is measured relative to the local mean flow at λ/8. Participation p is cov(n_b, D₋b) divided by
the noise-free variance of D₋b; D₋b is the mass density of all other bins, and its noise-free variance is the
covariance of two random halves of those particles. p = 1 means "follows the wakes exactly". The procedural runs give
1.04 ± 0.04 in every bin, which validates the estimator.

* **Participation rises with size.** Relative to the boulders, p_rel(a) ≈ min(1, (a / 1.2 m)^0.5): 0.45 at 0.27 m,
  0.65 at 0.46 m, 0.85 at 0.8 m, and 1 above ~1.2 m. The outer-A run with a_max = 3 m gives the same trend (0.29, 0.52,
  0.80, 0.95 from 0.27 to 1.3 m).
  * This is the "small particles tend to have a much more uniform distribution than the largest particles" of Salo et
    al. (2004), now quantified.
  * The 2–20 cm grains that hold ~35 % of the A ring's τ are not simulated. Extrapolated, p_rel ≈ 0.1–0.4.
* **Consequence for the τ field.** The cross-section field shows much less contrast than the mass field: p5/p95 =
  0.28/2.47 (N-body τ field), 0.09/3.65 (N-body mass field), 0.09/3.12 (procedural τ field). The N-body crests in τ are
  also 3× shorter along the crest (1/e length 0.33 vs 1.05 λ_T), with twice the end points.
* **Thickness and speed fall steeply with size.**
  * rms height ∝ a^−0.53, from ~10 m to 2.5 m; the app's law is ∝ a^−0.2, 2.7 → 1.7 m. The mass-weighted rms height is
    3.9 m against 1.85 m.
  * The boulders' *local* dispersion (0.35 mm/s) matches the app's. Their total (1.0 mm/s) is wake streaming.
  * The small particles are stirred by the boulders toward the boulders' escape speed (≈ 2 mm/s for 5 m at
    320 kg m⁻³; "small particles achieve a larger velocity dispersion", Salo et al. 2004). Toomre Q (mass-weighted
    c_r) = 2.7, against 1.7 for identical 1 m particles.
* **Truncation sensitivity.**
  * The hottest population is always the smallest one *simulated*. With a_min = 0.1 m the 0.1–0.2 m bin has the
    heights and speeds that the 0.2–0.35 m bin has with a_min = 0.2 m, and the 0.2–0.35 m bin is 23 % lower. So the
    absolute heights of the smallest simulated particles are set by the cut.
  * Restoring the full τ with proxies (A128-sdtau: 2–3× more collisions per particle) lowers the heights of all sizes
    by 4–24 %.
  * The size trends and the boulders' numbers (2.1–2.5 m rms height for 3–5 m bodies) are robust to both.

### 8.4 Packing and vertical structure

| mid-plane filling factor | A128-ident N-body | procedural | A128-sd N-body | procedural |
|---|---|---|---|---|
| mean | 0.18 | 0.15 | 0.10 | 0.16 |
| wake cores (top 10 % in D), λ/32 / λ/16 / λ/8 | 0.45 / 0.41 / 0.34 | 0.52 / 0.44 / 0.31 | 0.51 / 0.42 / 0.29 | 0.82 / 0.67 / 0.44 |
| 99.9th percentile, λ/32 / λ/16 / λ/8 / λ/4 | 0.64 / 0.57 / 0.47 / 0.35 | 1.22 / 0.76 / 0.45 / 0.27 | 0.98 / 0.77 / 0.51 / 0.31 | 2.08 / 1.48 / 0.85 / 0.44 |

(λ/32 = 1.3 m. On that scale a single boulder's mid-plane chord gives 1 for A128-sd: the 0.98 is boulders, not packing.)

* **There is a ceiling.**
  * With 1 m particles the 99.9th-percentile mid-plane filling on the particle scale is 0.64, i.e. random close
    packing. The N-body never exceeds it.
  * With the size distribution the core filling at λ/16 is 0.42, the 99.9th percentile 0.77, and 0.51 at λ/8.
  * The procedural field reaches 1.22–2.08 on the particle scale and 0.76–1.48 at λ/16, with the same particles. Every
    size sits in a fixed vertical profile inside crests that are too thin, all at full participation.
  * The app's medium has D × FF_mean ≈ 6.9 × 0.16 ≈ 1.1 in A-ring cores.
* **Monodisperse wakes thicken.** The column's mass-weighted rms height grows as σ_z ∝ D^0.33 for D > 1 (1.6 m in the
  gaps, 2.1 m in the cores). Filling therefore grows as D^0.67, not D.
* **A size distribution segregates instead of thickening.**
  * Per size class the height barely depends on D. Small particles are ~10 % lower in the densest columns; 1–3 m
    bodies are 10–25 % higher where D > 3.
  * The cores stay below the ceiling because the small particles, which would fill the mid-plane, are spread over
    ±10 m and participate only partly. The boulders, which carry the wakes, are flat.

### 8.5 B ring (105,000 km)

B105-sd uses the B3 zone's sizes (q = 3.2, 0.2–2 m) at τ = 2.5 and Σ = 600 kg m⁻². The simulated τ is 1.34 (the
particles below 0.2 m carry the rest), the box is 4 λ_T = 191 m, and orbits 4–6 were measured. The app column is the
zone's present field (strength 0.5, γ 0.24, spreads 2.4/6.0, R_C 0.45, T_LIFE 3; H = 15 m). Mass field at λ_T/16.

| statistic | N-body | app (B3 zone now) | app, B calibration (§8.9) |
|---|---|---|---|
| spacing: spectral peak / power-weighted / λ_T | 1.05 ± 0.13 / 1.00 | 0.99 / 0.95 | 0.95 ± 0.08 / 0.89 |
| pitch: median (IQR) [deg]; share of crest energy trailing | 18.7 (12–25); 0.96 | 18.4 (2–31); 0.79 | 16.8 (13–22); 0.99 |
| pitch within a snapshot: IQR / drift of the median [deg] | 13.6 / 1.5 | 36.6 / 5.9 | 7.7 / 5.1 |
| along-crest correlation length (1/e) / λ_T | 0.75 | 0.87 | 0.95 |
| crest end / branch points per λ_T²; filament length / λ_T | 0.65 / 0.68; 5.3 | 2.12 / 2.48; 2.0 | 0.50 / 0.68; 10.2 |
| D quantiles p5 / p25 / p50 / p75 / p95 / p99 | 0.03 / 0.20 / 0.66 / 1.52 / 3.05 / 4.20 | 0.45 / 0.68 / 0.94 / 1.29 / 1.81 / 2.17 | 0.13 / 0.31 / 0.70 / 1.53 / 2.93 / 3.72 |
| τ_dyn in wakes / gaps (D ≷ 1) | 2.70 / 0.50 | 1.80 / 0.99 | 2.65 / 0.59 |
| vertical τ_phot: all / gaps / wakes / cores | 0.75 / 0.33 / 2.63 / 7.56 | 1.22 / 0.90 / 1.83 / 2.65 | 0.71 / 0.40 / 1.75 / 3.19 |
| granola fit (slant rays): S/W, H/W, τ_G, pitch | 2.03, 0.37, 0.21, 19° | 7.0, 0.66, 1.06, 19° | 3.5, 0.89, 0.42, 20° |
| shearing-frame correlation C(0.1 / 0.2 / 0.3 / 0.5 orbit); half-life [orbits] | 0.85 / 0.57 / 0.34 / 0.10; 0.23 | 0.67 / 0.29 / 0.04 / −0.01; 0.14 | 0.67 / 0.53 / 0.29 / 0.00; 0.21 |
| mid-plane filling: mean; wake cores λ/32 / λ/16 / λ/8 | 0.29; 0.69 / 0.64 / 0.52 | 0.16; 0.33 / 0.29 / 0.23 | 0.16; 0.57 / 0.46 / 0.31 |
| mid-plane filling, 99.9th percentile λ/32 / λ/16 / λ/8 / λ/4 | 0.83 / 0.77 / 0.68 / 0.52 | 0.87 / 0.54 / 0.34 / 0.23 | 1.38 / 0.82 / 0.46 / 0.27 |
| mass-weighted rms height [m]; Toomre Q | 1.96; 1.7 | 3.33; 1.2 | 3.33; 1.2 |

The third column is the B optimum of §8.9 (strength 1, plateau envelope) with the present vertical law (H = 15 m).

| radius (m) | 0.20–0.35 | 0.35–0.60 | 0.60–1.00 | 1.00–1.75 | 1.75–2.00 |
|---|---|---|---|---|---|
| rms z, N-body: all / gaps / cores (m) | 2.69 / 3.52 / 2.57 | 2.23 / 2.26 / 2.55 | 2.13 / 1.59 / 2.68 | 1.79 / 1.01 / 2.35 | 1.22 / 0.69 / 1.58 |
| rms z, app (m) | 4.08 | 3.75 | 3.40 | 3.03 | 3.00 |
| local c_x, N-body / app (mm/s) | 0.96 / 1.12 | 0.70 / 1.03 | 0.60 / 0.93 | 0.50 / 0.81 | 0.43 / 0.76 |
| participation p | 0.94 ± 0.01 | 1.00 ± 0.02 | 1.00 ± 0.02 | 1.04 ± 0.01 | 1.02 ± 0.04 |

* **Wakes as strong as in the A ring.**
  * At Σ = 600 kg m⁻² the B ring has Q ≈ 1.7 and wakes with gaps of τ_dyn 0.50 between wakes of 2.70. The density
    quantiles span 0.03–3.05 (p5–p95), as in the mid-A ring.
  * The zone's field (strength 0.5) has a third of that contrast. Its crests are lost in the Poisson noise: 79 % of
    the crest energy is trailing, and there are 3× too many crest ends.
* **The granola bars match the occultations.** The slant-ray fit gives S/W = 2.0, H/W = 0.37, τ_G = 0.21 and a pitch of
  19°, with λ_w = 50 m, W = 17 m and H = 6 m. Jerousek et al. (2016) find S/W ≈ 1.5, H/W ≈ 0.20 and τ_gap ≈ 0.3 in B1.
* **The ring is twice as transparent as its τ_dyn.** τ_phot/τ_dyn = 0.56 for vertical rays through the spheres and 0.54
  for the continuum measure (Robbins et al. 2010). The zone's field gives 0.91.
* **The crests form a network.**
  * Pitch 18.7° (IQR 12–25°), along-crest length 0.75 λ_T and spacing ≈ 1.0 λ_T.
  * The 4 λ_T box quantises the spectral peak: the spacing is uncertain by ~0.15 λ_T, and the spectral pitch (11.7°)
    is left out of the calibration.
  * There are fewer free ends than in the A ring (0.65 vs 0.98 per λ_T²) and the filaments are longer (5.3 vs
    3.1 λ_T): branching, connected crests.
* **Lifetime as in the A ring.** The half-life is 0.23 orbit, and the pattern is sheared with the material (q = 1.51).
* **Every size follows the wakes.** p = 0.94–1.04 from 0.2 to 2 m; there is no size segregation as in the A ring (§8.3).
  The 1–2 m bodies are flat in the gaps (0.7–1.0 m) and thicker in the cores (1.6–2.4 m); the 0.2–0.35 m particles do
  the opposite (3.5 m in the gaps, 2.6 m in the cores). The column's mass-weighted σ_z grows as D^0.49 in the wakes.
* **Thinner and cooler than the zone's law.**
  * rms height ≈ 1.8 m (a/1 m)^−0.35, from 2.7 m at 0.27 m to 1.2 m at 1.9 m; the mass-weighted value is 1.96 m.
  * RingLod with H = 15 m gives 4.1–3.0 m (mass-weighted 3.3 m), with local dispersions 1.2–1.8× the N-body's.
* **Packed wake cores.**
  * The mid-plane filling averages 0.29 and reaches 0.64 in the wake cores at λ/16 (99.9th percentile 0.77; 0.68 at
    λ/8). That is random close packing.
  * The zone's field stays at 0.29 in its cores, because its layer is thicker and its contrast lower.
* **The calibrated field.**
  * At strength 1 with the plateau envelope the procedural field reproduces the contrast (p95/p99 2.9/3.7), the gap
    and wake τ_dyn (0.59/2.65), τ_phot (0.71 vs 0.75), the crest density and the coherence (half-life 0.21 orbit).
  * Still off:
    * the gap floor (p5 0.13 vs 0.03);
    * the synchrony (pitch IQR within a snapshot 7.7° vs 13.6°);
    * filaments that are twice too long;
    * H/W = 0.89 vs 0.37, because the layer is twice too thick (H = 15 m).

### 8.6 Outer A ring (135,000 km)

With the zone's size distribution (q = 3.05 up to 7 m; Σ = 186 kg m⁻², λ_T = 32 m) the N-body ring is hot and wakeless.
* Q = 4.5 and the mass-weighted rms height is 5.6 m. Crest orientation is isotropic (49 % of the crest energy trailing,
  as for noise), and the mass field is a speckle of single 3–7 m boulders.
* With a_min = 0.1 m (τ_sim 0.31) Q = 3.8, still without wakes.
* With a_max = 3 m weak, intermittent trailing wakes appear: 76 % trailing, median pitch 30°. To keep Σ at the zone's
  τ, that run needs ρ = 625 kg m⁻³ (r_h = 0.98).

Occultations do show wakes there, weaker and less coherent than inside the Encke gap (Colwell et al. 2006; Jerousek et
al. 2016). So the 7 m a_max of `A_out` is too large for its Σ: the biggest bodies stir everything above the
Toomre-stable dispersion. The τ deficit is largest here (55–62 %, the weakest damping of all runs), and the app's
λ/aMax test still gives a wake strength of 0.38.

### 8.7 Optical depth and the granola-bar view

* **Normal optical depth.** Clumping lowers τ_phot below τ_dyn (Salo et al. 2004; Robbins et al. 2010).
  * Vertical ray casting through the spheres gives τ_phot/τ_dyn = 0.88 for identical particles. For the mid-A size
    distribution it is 0.99, because the small particles fill the gaps (Salo et al. 2004). In the B ring, where every
    size follows the wakes, it is 0.56.
  * The app's medium, τ(x) = τ_zone·wakeDensity(x) with Beer–Lambert per column, transmits like 0.74–0.75 τ_zone at
    normal incidence (A128-sd/A128-ident settings; 0.90 at the B3 zone's weak wakes). The same continuum measure on the
    N-body cross-section field gives 0.87 (mid-A size distribution), 0.77 (identical) and 0.54 (B ring).
  * The profile τ is photometric. So in the A-ring wake zones the medium is ~15–25 % more transparent than the τ it was
    given; in the B ring the N-body ring is ~45 % more transparent than its τ_dyn.
* **Gap optical depth.** Vertical τ in the gaps (D < 1) is 0.21 (identical) and 0.22 (mid-A size distribution); the
  procedural values are 0.21 and 0.15. In the B ring it is 0.33, against 0.90 for the zone's field.
* **Granola-bar fits.** The model of Colwell et al. (2006, 2007), as written in Jerousek et al. (2016, eq. 9), was
  fitted to the transmission of slant rays through the snapshots (B = 10–90°, 12 azimuths).
  * Identical particles: S/W = 3.7, H/W = 0.44, τ_G = 0.26, pitch 19° (rms 0.010). The procedural values are 7.1, 0.90,
    0.28 and 21°.
  * Size distribution: the azimuthal modulation is weak (T = 0.087–0.138 at B = 10°) and the opaque-bar fit degenerates
    to S/W ≈ 17, H/W ≈ 0.9, τ_G ≈ 0.34.
  * Jerousek et al. (2016) find H/W ≈ 0.22, S/W ≈ 1.9, τ_gap ≈ 0.13 and pitch ≈ 25° near 133,000 km; Colwell et al.
    (2006) find H/W = 0.15–0.37, increasing outward.
  * So the simulated gaps hold 1.5–2.5× the observed τ. Either the A ring has fewer sub-20 cm particles than the zone
    table's q = 2.9 down to 2 cm, or they are bound to the wakes more tightly than frictionless, non-sticking spheres
    allow. This is a question for the zone table, not for the wake model.
  * B ring: S/W = 2.0, H/W = 0.37, τ_G = 0.21, pitch 19° (rms 0.012; §8.5), against S/W ≈ 1.5, H/W ≈ 0.20 and
    τ_gap ≈ 0.3 in B1 (Jerousek et al. 2016). The zone's present field gives 7.0, 0.66 and 1.06.

### 8.8 Accuracy of `wakeDensity()`

`procedural.py check-inverse` compares `wakeDensity()` (one Newton step per generation) with the exact density of the
forward map that places the particles.

At A-mid settings (strength 1, γ = 0.16):
* It differs by > 20 % on 2.6 % of the area on average (up to 8 % at some times), and by > ×2 on 0.6 %.
* 0.7 % of the area sits at the clamp of 6.9, while the particles reach 10–15× the mean density at λ/32. These are the
  speckled lines visible in the noise-free maps.
* The area mean is 0.968, down to 0.895 at some times: the medium loses on average 3 % and at times 10 % of its τ.

At B settings (strength 0.5, γ = 0.24) it is exact to < 1 % everywhere.

### 8.9 Recommended targets for the procedural model

The calibration (`calibrate.py`) scores Σ((m − m_N-body)/tol)² over 21 metrics: spacing, density quantiles, ACF, crest
skeleton, pitch (pooled, within-snapshot spread and drift) and shearing-frame correlation. The tolerance is max(15 %, a
floor). Candidates are synthetic runs of the port with the N-body run's particles.

**A-ring wake field (strength 1).** The calibration target is A128-ident (clean morphology). The last column is the
score of the same parameters against A128-sd, without its noise-dominated structure-tensor orientation metrics.

| parameter | app now | best with the present sin² envelope | **recommended: plateau envelope** |
|---|---|---|---|
| contrast γ (mean local contrast γ_eff = γ^(1/(1+R_C²))) | 0.16 (0.22) | 0.11 (0.26) | **0.10 (0.25)** |
| dislocation scale R_C | 0.45 | 0.8 | **0.8** |
| spreadPar / spreadPerp | 1.6 / 5.0 | 1.6 / 5.0 | **1.6 / 5.0** |
| T_LIFE (1/Ω) | 3 | 4 | **7** |
| birth mode m0 (pitch at birth) | (3, 6): 63° | (−1, 6): 99° (radial, slightly leading) | **(1, 6): 80°** |
| envelope | sin²(π age/T) | sin² | **plateau: smoothstep rise over 0.1 T, constant, fall over 0.1 T after T/2** |
| tile (spacing at the envelope peak) | λ·6/sin 20° | unchanged | unchanged |
| score vs A128-ident (21 metrics) | 294 | 121 | **72** |
| score vs A128-sd (17 metrics) | 92 | – | **25** |

* **Plateau envelope.**
  * Each generation rises with smoothstep over 0.1 T_LIFE, stays at full amplitude, and falls over 0.1 T_LIFE after
    T_LIFE/2. The other generation does the reverse, so the two amplitudes still sum to `strength`.
  * The field then keeps one pattern for ~T_LIFE/2 ≈ 0.55 orbit while the shear turns it from ~80° to ~10°, which is
    what the N-body wakes do (§8.2).
  * It gives N-body coherence (half-life 0.25 vs 0.24 orbit; C(0.2) = 0.62 vs 0.58), crest length (0.95 vs 0.85 λ_T),
    no spurious spacing regularity (ACF side maximum +0.01 vs −0.04) and the pooled pitch distribution (median 17°, IQR
    12–25°).
  * In `WakeField.update` this is the `env` line; T_LIFE and the birth mode change with it.
  * The A128-sd calibration, started from these values, lands on the same structure: plateau envelope (env_w 0.1),
    T_LIFE 7, m0 (2, 6), R_C 1.0 with γ 0.066 (the same γ_eff, 0.26), score 14. It also widens spreadPar to 3.2, which
    makes the spacing less regular. Its spacing (1.21 λ_T against the target's 1.48) and gap floor remain off. The
    procedural gaps are too empty here (p5 0.03 against 0.09) because every size follows the wakes fully; the
    participation rule below addresses that.
* **Kept or rejected.**
  * spreadPar/spreadPerp: changes cost more elsewhere than they gain.
  * A longer tile matches the N-body's dominant wavelength (1.5–1.7 λ_T) but lengthens crests in proportion. The
    plateau envelope already raises the spacing to 1.2 λ_T.
  * 3–4 overlapping generations score worse (157–230 vs 124).
* **Still structural.**
  * *Global synchrony.* With two global generations every crest in the field has the same age. The pitch spread within
    a snapshot is 5.8° (plateau) or 7.6° (app) against 12.7° in the N-body, and the snapshot median drifts by 7.9°
    (plateau) against 1.4°.
    * Wakes of different ages need to coexist: a spatially varying generation phase, e.g. a birth-time offset δ ∈
      [0, T/2) read from a low-frequency texture channel in each generation's own sheared coordinates, with the
      amplitudes renormalised so that they still sum to `strength`.
  * *Gap floor.* The circle map ties the gap floor to the core (γ vs 1/γ); N-body gaps are deeper at the same core.
    A separate γ for the rarefied half of the map would fix p5 (0.08 vs 0.11).

**B-ring wake field.** Target B105-sd, with 20 metrics: the 4 λ_T box quantises the spectral pitch, so it is left out.
Score differences below ~20 are noise in this box.

| parameter | B3 zone now | A-ring recommendation (above) | B optimum |
|---|---|---|---|
| strength | 0.5 | 1 | 1 |
| γ (γ_eff at strength 1) | 0.24 (0.55) | 0.10 (0.25) | 0.136 (0.19) |
| R_C | 0.45 | 0.8 | 0.45 |
| spreadPar / spreadPerp | 2.4 / 6.0 | 1.6 / 5.0 | 2.4 / 9.0 |
| T_LIFE; birth mode m0; envelope | 3; (3, 6); sin² | 7; (1, 6); plateau, env_w 0.1 | 6; (2, 6); plateau, env_w 0.2 |
| score vs B105-sd (20 metrics) | 1210 | 117 | 57 |

* The zone's present field has a third of the N-body contrast, hence the score of 1210. Strength 1 with the A-ring
  parameters brings it to 117.
* The B optimum keeps the A-ring structure: plateau envelope, T_LIFE 6–7 and m0 (1–2, 6). The same parameters with the
  sin² envelope score 149 or more.
  * It prefers a stronger contrast (γ_eff 0.19 against 0.25) and other spreads/R_C, at the edge of what this box
    resolves.
  * Its remaining misfits are the structural ones: the gap floor (p5 0.13 vs 0.03) and global synchrony
    (within-snapshot pitch IQR 7.8° vs 13.6°, drift 4.5° vs 1.5°).
* So one parameter set serves both rings: the A-ring recommendation, at strength 1 in the B ring as well.

**Size dependence (rules for RingLod and the near field).**
* *Participation.* Scale the wake displacement of particles of radius a by p_rel(a) = min(1, (a/a_p)^0.5).
  * a_p ≈ 1.2 m in the mid-A ring (§8.3) and ≈ 0.3 m in the B ring, where p ≥ 0.94 down to 0.2 m (§8.5). Small
    particles follow the wakes where collisions are frequent (τ) and the largest bodies stir less (a_max 2 m vs 5 m).
    Interpolate a_p in τ between the two sites.
  * For small contrast this gives the measured D_a − 1 ≈ p_rel (D − 1).
  * The medium should carry the τ-weighted mean, D_τ = 1 + p̄_τ (D − 1). Extrapolating p_rel below 0.2 m, p̄_τ ≈ 0.6
    for the A ring's 2 cm–5 m distribution and ≈ 0.8 for B3's 5 cm–2 m.
  * In the A ring this lowers the medium's wake contrast to the N-body τ field (p5/p95 0.28/2.47) and removes most of
    its over-transparency (§8.7).
* *Vertical law.* RingLod has sigZFrac(a)·H ∝ a^−0.2 (H = 10 m in A_mid, 15 m in B2/B3).
  * Mid-A ring: rms height ≈ 4.5 m (a/1 m)^−0.5 for 0.3–5 m. Boulders of 3–5 m are at 2.1–2.5 m, 1 m bodies at
    4–4.5 m, 0.3 m at ≳ 8 m. RingLod gives 1.7 m for boulders and 2.2 m at 1 m.
  * B ring: rms height ≈ 1.8 m (a/1 m)^−0.35 for 0.2–2 m, mass-weighted 1.96 m. RingLod gives 3.0–4.1 m.
  * The boulder values are robust. The small-particle heights are upper limits, uncertain ×2 (truncation, §8.10).
  * So the thickness is not one H per zone with a universal size law: it depends on the zone's largest bodies and τ.
    For A_mid (H = 10 m), sigZFrac(a) ≈ 0.45 (a/1 m)^−0.5, capped near 0.8 below ~0.3 m until the cm grains are
    constrained; the mass-weighted rms height, 3.9 m, is within the density-wave limits of §3. For B2/B3 the present
    law with H ≈ 9 m instead of 15 m, or 0.12 (a/1 m)^−0.35 at H = 15 m.
* *Thickening and the packing ceiling.* Where the mid-plane filling of the drawn classes,
  FF(x) = Σ_k FF_k D_k(x) (σ_z,k / σ_z,k(x)), would exceed 0.65, thicken all classes locally:
  σ_z,k(x) = σ_z,k · max(1, FF(x)/0.65).
  * In the A ring participation removes most of the cores' excess, so the cap is a safety there. In the B ring it
    binds: the N-body wake cores average 0.64 at λ/16.
  * For a monodisperse population the N-body law is σ_z ∝ D^0.33 above D = 1 (B ring, size distribution: D^0.49).
  * Identical particles never exceed 0.64 on the particle scale, nor ~0.5 at λ/8. With the B ring's size distribution
    the 99.9th percentile is 0.77 at λ/16 and 0.68 at λ/8.
* *Velocity dispersion.*
  * The A-ring boulders' local dispersion (0.35 mm/s) matches RingLod (c_r = κ · 1.5 σ_z). The total includes wake
    streaming: a 1 mm/s coherent flow along the wakes, which the procedural displacement does not move.
  * Smaller A-ring particles are 2–7× faster than RingLod's law (upper limits, as for the heights). In the B ring
    every size is 1.2–1.8× slower than RingLod's law (with H = 15 m); the thinner layer above fixes most of that.

**Other model and zone changes.**
* *wakeDensity().* Iterate the Newton step (2–3 steps) or solve the 1-D inverse along n exactly. Renormalise its mean
  to 1 (it is 0.968 on average, 0.895 at worst), and raise the clamp: the particles reach 10–15× the mean at λ/32, the
  medium 6.9.
* *Medium optical depth.* The profile τ is photometric. Choose the medium's mean τ_dyn so that
  −ln⟨exp(−τ_dyn·D_τ)⟩ = τ_profile. With D_τ from the participation rule the factor τ_dyn/τ_profile is ≈ 1.15 in
  the mid-A ring (continuum ratio 0.87 in the N-body) and ≈ 1.6–1.9 in the B ring (0.54). It depends on the local
  contrast and τ, so solve it per zone from the app's own D_τ field (the CPU mirror of `wakeDensity`).
* *B ring.* At B-ring Σ the N-body wakes are as strong and as coherent as in the A ring (§8.5).
  * Wake strength 1 instead of the B zones' 0.5–0.6, with the A-ring shape and envelope (the B calibration above).
  * Drop the τ dependence of `wakeShapeFor`. Its "chaos" raises γ (less contrast) and the spreads (shorter, more
    irregular crests) toward τ = 2.5. The N-body B ring has deeper gaps and fewer crest ends than the A ring.
  * With wakes this strong the medium-τ normalisation above matters most: τ_phot/τ_dyn ≈ 0.55, so τ_dyn ≈ 1.6–1.9 ×
    the profile τ (with D_τ from p̄_τ ≈ 0.8). The near field's particle counts follow τ_dyn.
  * B2/B3 thickness H ≈ 9 m instead of 15 m; participation p = 1 down to ~0.3 m; and a packing cap that binds in the
    wake cores (see the size rules above).
  * One site (τ_sim 1.34, Σ 600) was simulated. B3's typical τ of 5.5 has more sub-0.2 m cross-section to fill the
    gaps, so the gap τ there is less certain than the wake contrast.
* *Outer A ring.* The zone's a_max = 7 m makes the N-body wakeless (Q 4.5). Either a_max ≈ 3 m (then weak wakes, as
  observed) or a wake strength ≤ 0.2 with the present sizes.

### 8.10 Caveats

* **Truncated size range.** Particles below 0.1–0.2 m are omitted: 35–55 % of the zone's τ and 3–5 % of its mass (11 %
  in the B ring).
  * This lowers the collision rate. Proxies restoring τ change heights and speeds by 10–25 %.
  * The smallest *simulated* size is always the hottest, so heights below ~0.5 m and every extrapolation to cm grains
    are uncertain, roughly by ×2.
* **Physics left out.** No surface friction or spin, no sticking (r_h ≤ 0.8 except A135-amax3), one restitution law
  (Bridges frost: ε ≈ 0.5 at 1 mm/s), and no satellites or density waves. Hard spheres stand in for porous aggregates.
  Wake strength and lifetime depend on r_h and ε (Salo et al. 2004).
* **Statistics.**
  * Boxes are 8 λ_T (A ring) and 4 λ_T (B ring, only 2 measured orbits). The B box quantises the spectral peak
    (spacing ±0.15 λ_T; spectral pitch unusable).
  * Standard errors are 1-orbit block errors and exclude run-to-run (seed) variance.
  * In the A-ring size-distribution runs the mass field is dominated by the few 3–5 m bodies, so its orientation and
    skeleton statistics are noise-limited; the τ field and the identical-particle run carry the morphology. The B
    ring's 2 m bodies do not dominate its mass field.
* **One B-ring site.** τ_sim = 1.34 of the zone's 2.5 (46 % τ deficit), Σ = 600 kg m⁻². The B zones' τ reaches 5.5;
  how the missing sub-0.2 m cross-section fills the gaps there is not simulated.
* **Comparison method.**
  * The synthetic runs use the N-body run's Toomre λ with κ = Ω; the app's J2-corrected λ is 1 % longer.
  * The calibration uses 2-orbit candidates, so score differences < 5 (A ring) or ~20 (B ring) are not significant.
  * Of the structural changes, the plateau envelope and the extra generations were tested in the port only; local
    asynchrony is not yet implemented anywhere.

## References

Afigbo, V. M., et al. 2025, JGR Planets (Kronoseismology VII; arXiv:2502.19265) · Albers, N., et al. 2012,
Icarus 217, 367 · Altobelli, N., et al. 2014 (via Miller et al. 2024) · Baillié, K., et al. 2011, Icarus 216, 292 ·
Becker, T. M., et al. 2016, Icarus 279, 20 · Bosh, A. S., et al. 2002, Icarus 157, 57 · Bridges, F. G., Hatzes, A.,
Lin, D. N. C. 1984, Nature 309, 333 · Ciarniello, M., et al. 2019,
Icarus 317, 242 · Colwell, J. E., Esposito, L. W., Sremčević, M. 2006, GRL 33, L07201 · Colwell, J. E., et al. 2007,
Icarus 190, 127 · Colwell, J. E., et al. 2009, in *Saturn from Cassini-Huygens* (Springer), 375 · Colwell, J. E.,
et al. 2010, AJ 140, 1569 · Cooke, M. L. 1991, PhD thesis, Cornell · Cuzzi, J. N., et al. 2009, in *Saturn from
Cassini-Huygens*, 459 · Dones, L., Cuzzi, J. N., Showalter, M. R. 1993, Icarus 105, 184 · Doyle, L. R., Dones, L.,
Cuzzi, J. N. 1989, Icarus 80, 104 · Esposito, L. W., et al. 2022, EGU22-6601 · Filacchione, G., et al. 2014, Icarus
241, 45 · French, R. G., Nicholson, P. D. 2000, Icarus 145, 502 · French, R. G., Salo, H., McGhee, C. A., Dones, L. 2007,
Icarus 189, 493 ·
French, R. G., et al. 2016, Icarus 274, 131 · Harbison, R. A., Nicholson, P. D., Hedman, M. M. 2013, Icarus 226,
1225 · Hedman, M. M., et al. 2007a, Icarus 188, 89 (D ring) · Hedman, M. M., et al. 2007b, AJ 133, 2624 (A-ring
wakes) · Hedman, M. M., et al. 2013, Icarus 223, 105 · Hedman, M. M., Nicholson, P. D. 2013, AJ 146, 12 ·
Hedman, M. M., Nicholson, P. D. 2014, MNRAS 444, 1369 · Hedman, M. M., Nicholson, P. D. 2016, Icarus 279, 109 ·
Iess, L., et al. 2019, Science 364, eaat2965 · Jerousek, R. G., et al. 2016, Icarus 279, 36 · Jerousek, R. G., et
al. 2020, Icarus 344, 113565 · Lissauer, J. J. 1985 (via H&N 2016) · Marouf, E. A., Tyler, G. L., Rosen, P. A.
1986, Icarus 68, 120 · Marouf, E. A., et al. 2008 (Cassini RSS particle sizes; via Cuzzi et al. 2009) · Marouf, E.
2018, Cassini RSS ring occultations 2.0, CO-SR-RSS-4/5-OCC-V2.0, NASA PDS · Miller, K. E., et al. 2024, *The
composition of Saturn's rings*, Space Sci. Rev. (arXiv:2311.17344) · Morishima, R., et al. 2010 (via Miller et al.
2024) · Nicholson, P. D., Hedman, M. M. 2010, Icarus 206, 410 · Nicholson, P. D., et al. 2014a, Icarus 227, 152
(B-ring edge) · Nicholson, P. D., et al. 2014b, Icarus 241, 373 (C ring) · PDS Rings Node, *Vital statistics for
Saturn's rings* (pds-rings.seti.org/saturn/saturn_rings_table.html) · Rein, H., Liu, S.-F. 2012, A&A 537, A128 ·
Rein, H., Tremaine, S. 2011, MNRAS 415, 3168 · Robbins, S. J., et al. 2010, Icarus 206, 431 · Salo, H., Karjalainen, R.,
French, R. G. 2004, Icarus 170, 70 · Tiscareno, M. S., et al. 2007, Icarus 189,
14 · Tiscareno, M. S., et al. 2013, Icarus 224, 201 · Tiscareno, M. S., Harris, B. E. 2018, Icarus 312, 157 ·
Wisdom, J., Tremaine, S. 1988, AJ 95, 925 · Zebker, H. A., Marouf, E. A., Tyler, G. L. 1985, Icarus 64, 531.

Data: PDS Ring-Moon Systems Node, volumes CORSS_8001 and COUVIS_8001. Scripts in `scripts/data/rings/`:
`fetch.mjs` (downloads into `data-raw/rings/`), `build_tau.mjs`, `measure_features.mjs`, `mass_check.mjs`,
`inside_numbers.mjs`, plus `pds.mjs` for parsing. Diagnostic plots: `sandbox/ringplot.html` (`?view=overview|zoom|sigma`,
or `?x0=&x1=`).
