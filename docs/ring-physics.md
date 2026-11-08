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

**Particle surfaces and photometry** (resolved particles of the near field; `src/render/near/NearRegolith.ts`,
`nearCommon.glsl`).
* *Nature*: porous (internal densities ~0.1–0.5 g/cm³, above), regolith-covered icy aggregates — "dynamic ephemeral
  bodies" that grow and break up by collisions (Weidenschilling et al. 1984). Rendered as triaxial ellipsoids with a
  cellular relief of sub-clasts (weight 0 below ~10 cm, full above ~0.7 m) plus pebble- and grain-scale texture.
* *Spin*: principal-axis rotation about the short axis (other states are damped by collisions and internal
  friction); large particles near the orbit normal at ~Ω/2 (the vorticity of the Keplerian shear), small ones
  faster and random. Aligned large bodies are kept nearly round in this model (`NR_ISO`) because the medium's
  cross-section is isotropic; tidal (radial) alignment is not modelled.
* *Surface law*: Hapke's model with macroscopic roughness (Hapke 1984) and the 2002 H functions. θ̄ = 30°: Hapke fits
  to HST ring phase curves give 26 ± 9° for the C ring, 10 ± 5° for the Cassini Division and 63–70° for the A and
  B rings, "suggesting lumpy particles" (Poulet et al. 2002; beyond the model's range — that part of the roughness
  is the resolved relief here); icy satellites are ≤ 40°, Rhea 33° (Ciarniello et al. 2011). Grain phase function
  single-term Henyey-Greenstein, ξ = −0.35 (Poulet et al. 2002: −0.26 C … −0.38 A). Grain albedo w per particle
  from its albedo through the spherical albedo of a regolith sphere (A_s = 0.50 at w ≈ 0.95, 0.25 at w ≈ 0.71).
  Such a sphere already has nearly the power-law phase function the medium uses: P(0) = 4.6–5.3 vs 5.70 (Lambert
  sphere 2.67), so the per-particle factor that enforces the power law stays within ~0.96–1.18 for α ≤ 90°.
  The opposition surge stays an α-only factor (the medium's intrinsic surge).

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

## References

Afigbo, V. M., et al. 2025, JGR Planets (Kronoseismology VII; arXiv:2502.19265) · Albers, N., et al. 2012,
Icarus 217, 367 · Altobelli, N., et al. 2014 (via Miller et al. 2024) · Baillié, K., et al. 2011, Icarus 216, 292 ·
Becker, T. M., et al. 2016, Icarus 279, 20 · Bosh, A. S., et al. 2002, Icarus 157, 57 · Ciarniello, M., et al. 2011,
Icarus 214, 541 (Rhea, Hapke) · Ciarniello, M., et al. 2019,
Icarus 317, 242 · Colwell, J. E., Esposito, L. W., Sremčević, M. 2006, GRL 33, L07201 · Colwell, J. E., et al. 2007,
Icarus 190, 127 · Colwell, J. E., et al. 2009, in *Saturn from Cassini-Huygens* (Springer), 375 · Colwell, J. E.,
et al. 2010, AJ 140, 1569 · Cooke, M. L. 1991, PhD thesis, Cornell · Cuzzi, J. N., et al. 2009, in *Saturn from
Cassini-Huygens*, 459 · Dones, L., Cuzzi, J. N., Showalter, M. R. 1993, Icarus 105, 184 · Doyle, L. R., Dones, L.,
Cuzzi, J. N. 1989, Icarus 80, 104 · Esposito, L. W., et al. 2022, EGU22-6601 · Filacchione, G., et al. 2014, Icarus
241, 45 · French, R. G., Nicholson, P. D. 2000, Icarus 145, 502 · French, R. G., Salo, H., McGhee, C. A., Dones, L. 2007,
Icarus 189, 493 ·
French, R. G., et al. 2016, Icarus 274, 131 · Hapke, B. 1984, Icarus 59, 41 (macroscopic roughness) · Hapke, B.
2002, Icarus 157, 523 · Harbison, R. A., Nicholson, P. D., Hedman, M. M. 2013, Icarus 226,
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
Saturn's rings* (pds-rings.seti.org/saturn/saturn_rings_table.html) · Poulet, F., Cuzzi, J. N., French, R. G.,
Dones, L. 2002, Icarus 158, 224 (HST phase curves, Hapke / Shkuratov fits) · Tiscareno, M. S., et al. 2007, Icarus 189,
14 · Tiscareno, M. S., et al. 2013, Icarus 224, 201 · Tiscareno, M. S., Harris, B. E. 2018, Icarus 312, 157 ·
Weidenschilling, S. J., Chapman, C. R., Davis, D. R., Greenberg, R. 1984, in *Planetary Rings* (Univ. Arizona
Press), 367 · Wisdom, J., Tremaine, S. 1988, AJ 95, 925 · Zebker, H. A., Marouf, E. A., Tyler, G. L. 1985, Icarus 64, 531.

Data: PDS Ring-Moon Systems Node, volumes CORSS_8001 and COUVIS_8001. Scripts in `scripts/data/rings/`:
`fetch.mjs` (downloads into `data-raw/rings/`), `build_tau.mjs`, `measure_features.mjs`, `mass_check.mjs`,
`inside_numbers.mjs`, plus `pds.mjs` for parsing. Diagnostic plots: `sandbox/ringplot.html` (`?view=overview|zoom|sigma`,
or `?x0=&x1=`).
