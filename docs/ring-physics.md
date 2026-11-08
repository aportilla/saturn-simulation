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
(Janus/Epimetheus 7:6, m = 7). **The B-ring edge is now de-projected at load time to its mean radius and moved by
its normal modes (§9)**; the ringlets and the A-ring edge are still the snapshot. (3) Density waves become
concentric ripples, since the profile is axisymmetric.
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
| B-ring outer edge | 117,650 (snapshot; rendered: mean 117,568 ± the §9 modes) | 117,570 (mean; m = 2 ±~75 km) |
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

## 8. Moonlet-perturbed gap edges: the streamline model (`sv_ringStructure`)

Pan (Encke gap) and Daphnis (Keeler gap) raise waves on the gap edges. The renderer models them as a **streamline
map** shared by every renderer (`src/render/shaders/ringStructure.glsl`, CPU mirror `src/rings/streamlines.ts`):

* Material is labelled by its Lagrangian (unperturbed-streamline) radius a'; the radial profile of §2 is τ0(a'). At
  azimuth θ and time t the streamline sits at r = a' + ξ(a', θ, t) and at height ζ(a', θ, t) above the mid-plane.
* Surface-density conservation gives the Eulerian optical depth **τ(r, θ) = τ0(a') J**, J = 1/(∂r/∂a'): converging
  streamlines (moonlet "wakes", sharp crests) are denser. a'(r, θ) comes from 4 Newton steps from a' = r (residual
  ≤ 2 mm). A gap is empty by construction — no material streamline maps into it.
* The map is radial only: the azimuthal epicyclic displacement η = 2e sin φ is neglected. Its density effect (the
  oscillating drift speed relative to the moonlet, a ±(4/3)(e/b) term, ~±15 % in the first Keeler-edge wavelength)
  is not included; the secular crowding term that dominates after the first wavelength is.
* Near-field particles carry a' as their guiding centre: presence is tested at τ0(a') and they are drawn displaced
  by ξ(a') − ξ_camera (Lagrangian boxes centred on the camera's Lagrangian position), so drawn particles and the
  medium have the same density τ0 J.

**Moonlet response.** A particle on a circular orbit at b = |a' − a_moon| / r_H (Hill radius r_H = a (m/3M)^(1/3))
drifts past the moonlet at the Keplerian shear rate 1.5 Ω (a' − a_moon) and leaves on a forced epicycle, which
downstream (behind the moonlet for the outer edge, ahead of it for the inner one) is a radial wave of azimuthal
wavelength **λ = 3π |Δa|** (Cuzzi & Scargle 1985). In Hill units (lengths r_H, time 1/Ω; Hénon & Petit 1986) the
problem has no free parameter, so one table serves both moonlets. `scripts/data/rings/moonlet_response.mjs`
integrates Hill's equations
x'' = 2y' + 3x − 3x/r³, y'' = −2x' − 3y/r³ (RK4 from t = −200 with the analytic upstream guiding-centre tail
−(8/3)/(b²|t|); accuracy: Jacobi-constant drift ≤ 3×10⁻⁶, step halving changes ξ by ≤ 1×10⁻⁵ r_H) for 36 b in
2.5–30 and stores K = b²ξ/r_H (nearly b-independent: the linear kick ∝ 1/b²) with its t, b and mixed derivatives
for bicubic Hermite interpolation (smooth J; exact float32 weights via texelFetch). Checks:

* Linear limit: the asymptotic epicycle is e b²/6.72 = 1.0165 (b = 8), 1.0047 (12), 1.0009 (20), 1.0002 (30), i.e.
  A → 6.72 r_H/b² = **2.24 μ a (a/Δa)²** (Julian & Toomre 1966; Goldreich & Tremaine 1980; Showalter et al. 1986).
* The guiding-centre shift obeys the Jacobi constant, δb = (2/3)e²/b, to 0.1–1.2 % (the moonlet pushes the edges
  outward by ~0.3 km at the Keeler gap, the gap-opening torque).
* At the Keeler edges (b ≈ 3.3–4.5) the response is **nonlinear: e b²/6.72 = 1.27 at b = 3.5** (+21 to +36 % at
  the catalogued edges). Closest approach at b = 2.5 is 0.89 r_H (Daphnis' radius 0.77 r_H).

| moonlet (moons.json) | edge | Δa (km) | b | A linear (km) | A Hill (km) | peak in 1st λ (km) | λ (km) |
|---|---|---|---|---|---|---|---|
| Pan: GM 2.8×10⁻⁴ km³/s² (4.20×10¹⁵ kg), a = 133,584.5 km, r_H = 18.03 km | inner 133,424 / outer 133,745 (profile = catalogue ±1 km) | −160.5 / +160.5 | 8.9 | 1.53 | 1.55 | 1.72 | 1,513 |
| Daphnis: GM 5.6×10⁻⁶ (8.39×10¹³ kg), a = 136,505.5 km, r_H = 5.00 km | inner, catalogue 136,487 | −18.5 | 3.71 | 2.45 | 2.97 | 2.86 | 175 |
| | outer, catalogue 136,522 | +16.5 | 3.29 | 3.11 | 4.23 | 3.54 | 155 |
| | **inner, profile 136,483 (rendered)** | −22.5 | 4.51 | 1.65 | 1.83 | 1.92 | 213 |
| | **outer, profile 136,523 (rendered)** | +17.5 | 3.49 | 2.76 | 3.53 | 3.21 | 164 |

"A" is the asymptotic forced epicycle before damping; "peak in 1st λ" the largest |ξ| of the enveloped table in the
first wavelength. Pan's 1.5 km follows from the moons.json GM; ≈ 1.8 km would need GM ≈ 3.3×10⁻⁴ km³/s² (the
Porco et al. 2007 mass, 4.95×10¹⁵ kg). The rendered Keeler gap is the RSS 2005 profile's (136,483–136,523), 4 km
wider on the inner side than the catalogue; the occultation may itself have caught the edges displaced (by up to
~2–3 km) at its longitude relative to Daphnis.

**The moonlet's own orbit.** Its guiding centre and radial epicycle come from the live state vector each frame
(r − a_g = (Ω(r) − θ')r/((2 − q)Ω), J2–J6 frequencies; Daphnis' radial excursion is ~1.0 km in Nov 2026, Pan's
~0.65 km), and each streamline point uses the moonlet's radius **at that particle's conjunction**, t_H/κ ago
(b = |a' − a_moon(t_conj)|/r_H; near the moonlet this is its instantaneous radius). The response table itself is
for a circular moonlet; its eccentric motion during the encounter is not modelled.

**Vertical response.** The moonlet's inclined orbit makes it oscillate vertically, z_m = Z cos(νt + ψ); the particle's
vertical equation z'' = −z + 3(z_m − z)/r³ is integrated (linear in Z) for z_m = cos t and sin t, stored as b³z, and
combined with the moonlet's vertical phase at each particle's conjunction (ψ_c = ψ_now − t_H). Downstream this gives
a corrugation of **half the radial wavelength** (the particles' vertical oscillation and the moonlet's have the same
frequency, so a train kicked by a moonlet of changing height beats at 2ν) plus a uniform tilt that follows ψ. With
the live ephemeris Z = 6.0 km (i ≈ 0.0025°, the same in Aug 2009 and Nov 2026) the maximum |ζ| in the first two
wavelengths is 0.55 km at the catalogued outer edge (ζ/Z = 0.092), 0.38 km at the inner one, 0.46 / 0.20 km at the
rendered (profile) edges. Cassini's equinox images show ~1 km high structure (Weiss, Porco & Tiscareno 2009; "≲ 1.5
km"): the model is ~2× lower. Candidate causes: the inclination (i = 0.0036°, Z = 8.6 km, would give 0.79 km), and
that the linear vertical response ignores the moonlet's height in the encounter distance (Z/Δa ≈ 0.35 — that would
weaken it further) and the coupling to the strongly nonlinear radial motion. ζ is part of the one height field z0 and
rendered as geometry with its shadows (§10). The maximum |ζ| depends on the moonlet's vertical phase: over a vertical
period 0.07–0.20 km at the rendered inner edge, 0.19–0.42 km at the outer (0.12–0.40 / 0.22–0.51 km at the catalogue
edges), 0.16 km at the outer edge on 2009-04-13 12:00 (PIA11656), 0.46 km in test:relief's 2026-11-08 view. The
observed 0.5–1.5 km come from shadow lengths, which measure the crest above the surface the shadow falls on — up to
crest-to-trough, 2|ζ| — so the deficit is ~1.5–3×; not corrected (no measured quantity to calibrate to without a
fudge factor: the published inclinations differ by 1.4×, and the shadow-height conversion by up to 2×).

**Damping and streamline crossing** (baked into the table, `envelope()` in the script):
* Phase mixing: neighbouring streamlines have different wavelengths, so ∂r/∂a' = 1 + ∂ξ/∂b acquires a secular term
  of amplitude Q = e t/b (t = Hill time since conjunction). Q reaches 1 — streamline crossing — about one wavelength
  downstream at the Keeler edges (t ≈ b/e ≈ 6.4), after ~17 wavelengths at the Encke edges. Real rings cannot cross
  streamlines: collisions dissipate the forced motion where they would. The amplitude is limited smoothly by
  (1 + (Q/Q_c)²)^(−1/2), Q_c = 1, which caps the secular term: min ∂r/∂a' = 0.42–0.46 at the Keeler edges (J ≤ 2.4),
  0.91 at the Encke edges; with Daphnis' eccentricity ≥ 0.28 (J ≤ 3.7). The shader additionally floors
  ∂r/∂a' at 0.2 (J ≤ 5), which binds only for an inspection scale `edgeWaveScale` ≳ 1.5 (then the map can fold).
* Collisional damping exp(−x/4λ) (x downstream distance, λ = 3π|Δa|; the previous implementation's choice). This is
  an assumption: plain viscous damping of the phase-mixed wake (rate ν k_r², ν ≈ 100 cm²/s) would take ~30
  wavelengths at the Keeler gap; the observed decay over a few wavelengths is attributed to the crossing
  collisions. The guiding-centre shift δb decays with the same envelope (physically viscous spreading refills the
  edge over the synodic period, ~8 yr for the Keeler edges).
* Tapers: upstream tail below t = −22 (|ξ| < 1 % of A there), end of the table t = 60–72, b = 24–30; the waves are
  faded out for radial pixel footprints of 0.3–1.5 r_H (unresolved).
* Inside the gap (b < 3) ξ is linear across it between the two sides (keeps r(a') monotonic; no material).

**Validation** (`npm run test:edges`): looking down on the gaps, the rendered sheet τ per pixel matches the CPU mirror
(median τ/(τ0(a')J) = 1.000), the gaps hold only the profile's own gap material (τ ≤ 0.015 in the Keeler gap, dusty
ringlets ≤ 0.025 in the Encke gap; ≤ 0.009 above τ0(a')J) where the old Eulerian lookup put τ ≈ 0.5 slivers, and
the rendered edges follow the model ξ(a'_edge, θ) to 50–80 m RMS (Keeler, 0.13 km footprint) and
0.16–0.39 km (Encke, 0.39 km footprint); peak outer-Keeler-edge displacement in the first 80 km behind Daphnis
2.71 km (model 2.76 km at the moonlet's radius on 2026-11-08). Near-field particles appear over displaced material and
vanish with straight edges.

**Not modelled / caveats.** Other perturbations of these edges: the Keeler outer edge's m = 32 pattern from the
Prometheus 32:31 resonance (Tajeddine et al. 2017), the Encke gap's non-Pan structure, the ringlets inside the Encke
gap, Pan's wakes far inside the A ring (b > 30 is tapered off). Particle-particle interactions (self-gravity of the
perturbed edge) beyond the damping envelope. The near-field particles are lit with the profile at their drawn
(Eulerian) position until `nearDraw.vert.glsl` samples through `ringSampleLocal` (particle work package), which makes
displaced edge material too bright (×2.4 at a crest, test:edges near-crest; ×1.1 with the change).

## 9. Normal modes of eccentric edges: the B-ring outer edge (`src/rings/ringModes.ts`)

The same streamline map carries **normal modes** of sharp edges: r = a' − Σ_k A_k g_k(a') cos(m_k(θ − ϖ_k(t))),
ϖ_k(t) = ϖ0_k + Ω_p,k (t − t0), ϖ the longitude of a radial **minimum** (Spitale & Porco 2010: "λ = ϖ at the
minimum", "one minimum locked to Mimas"); θ = inertial J2000 ring longitude (= SEF azimuth). The B-ring outer edge
uses the four-mode fit of **Spitale & Porco 2010 (AJ 140, 1747), Table 2** (Cassini ISS images; central epoch JED
2454256.9 = 2007-06-09, a0 = 117,568 ± 4 km, RMS 7.9 km):

| mode | e (a e) | ϖ0 | Ω_p (°/day) | cavity / zone (S&P) | decay length used |
|---|---|---|---|---|---|
| m = 1 free | 1.78×10⁻⁴ (20.9 km) | 73° | 5.098 | 253 km (ILR 117,314.9 km) | 253 km |
| m = 2 forced (Mimas 2:1 ILR) | 2.94×10⁻⁴ (34.6 km) | 7.2° (lags Mimas by 2.9°) | 381.9835 (= n_Mimas, fixed) | resonance half-width 60–90 km | 173 km |
| m = 2 free | 3.17×10⁻⁴ (37.3 km) | 123.1° | 382.0731 | 30 km (ILR 117,537.7 km) | 186 km |
| m = 3 free | 1.00×10⁻⁴ (11.8 km) | 23.8° | 507.700 | 24 km (ILR 117,544.2 km) | 59 km |

The forced and free m = 2 beat every 5.5 yr; the edge spans 117,491–117,640 km on 2026-11-08 (peak-to-peak up to
~150 km over 2005–2030). **Radial profile** (schematic): into the material g = exp(−u/L) (tapered to 0 at 1,000 km),
across the Huygens gap a linear ramp to 0 at the Huygens ringlet (238 km). The decay lengths are the cavities
lengthened to L ≥ 5A: a kinematic streamline edge with the cavity widths would cross streamlines (free m = 2: 37 km
over 30 km — strongly nonlinear in reality), so each mode is capped at |∂ξ/∂a'| ≤ 0.2 (all four ≤ 0.68; min ∂r/∂a' =
0.33 over 2005–2030, J ≤ 3). The edge position (what images and occultations measure) is the fitted one; the interior
structure of the modes is not.

**De-projection of the snapshot** (`RingProfile.deprojectSnapshot`). The RSS Rev 7 egress profile crossed the edge at
ring longitude 60.317° on 2005-123T08:09:48.7 UTC (CORSS_8001 table: ring event time, J2000 ring longitude) with the
edge at 117,649.2 km. Within the feature's zone (117,568 − 1,000 … + 238 km) the loaded profile is replaced by the
Lagrangian one, τ0(a') = τ_snap(a' + ξ_s(a')) (1 + ∂ξ_s/∂a') (surface density conserved), with ξ_s the modes' field
at that instant. The S&P model, extrapolated 2.1 yr back from its epoch, puts the edge there at +49.8 km (m=1 −2.7,
forced m=2 +27.2, free m=2 +20.4, m=3 +5.0 km) while the occultation shows +81.2 km: a 31 km (4σ) discrepancy,
plausibly the free modes' evolution or modes missing from the four-mode fit (Nicholson et al. 2014a fit more).
ξ_s is therefore the model field scaled by 81.2/49.8, so that the mean radius of the rendered edge is the measured
117,568 km (it is: test:edges finds the de-projected edge at 117,568.00 km), and the rendered edge follows the S&P
modes everywhere (rendered vs model 1–3 % in test:edges b-edge views). Consequence: at the snapshot's own time and
longitude the rendered edge is 31 km inside the RSS edge.

**Not yet modelled (remaining milestone-2 work).** The other eccentric features are still the 2005 snapshot:
* A-ring outer edge (136,770 km): Janus/Epimetheus 7:6 ILR, m = 7, ~10–15 km, pattern speed = the dominant
  co-orbital's mean motion, switching at the 4-yr swaps, plus free modes m = 5…18 (Spitale & Porco 2009, AJ 138,
  1520; El Moutamid et al. 2016, Icarus 279, 125). Needs those papers' amplitudes / phases per swap epoch.
* Titan ringlet (77,880 km; m = 1 locked to Titan by the 1:0 apsidal resonance, Ω_p = n_Titan), Maxwell ringlet
  (87,510 km; freely precessing m = 1 plus m = 2), both from Nicholson et al. 2014b (Icarus 241, 373, tables of a,
  ae, ϖ0, Ω_p per edge); Huygens ringlet (117,815 km; m = 1 and m = 2, French et al. 2016, Icarus 274, 131).
  A ringlet needs a second feature type (material between two edges whose eccentricities differ: the width
  variation W(θ) = W0 + Δ(ae) cos(…) follows from e(a') linear across the ringlet, J from the map), with gap ramps on
  both sides; snapshot − mean offsets for the de-projection are in §2 caveat (2).
The machinery is generic: add an `EdgeFeature` (modes, decay, gap, snapshot geometry) to `EDGE_FEATURES` (≤ 2
features / 8 modes in the shader: `RS_FEATURES`, `RS_MODES`).

## 10. Vertical relief (`src/rings/relief.ts`, `sv_ringRelief`, `sv_ringReliefShade`)

The rings are not flat at the 0.01–3 km level: bending waves, an impact-generated corrugation, the B-ring edge's
"splashing" structures and the moonlets' vertical edge waves lift the ~10 m thick layer by up to 100–300× its
thickness. They are invisible from high elevations (slopes ≤ 10⁻³–1) but dominate equinox images (shadows h / tan B,
hundreds of km long) and the view from inside (the layer tilts by up to 45° in the Titan wave). Model: ONE height
field z0(a', θ, t) of the material's mid-plane = the moonlets' ζ (§8) + the sources below, evaluated at the
Lagrangian radius (the relief rides on the streamline map), with slopes; every renderer takes heights relative to it
(contract: ARCHITECTURE.md → "Vertical relief contract"). Numbers below: `node scripts/data/rings/relief_check.mjs`;
checks: `npm run test:relief`.

**Bending waves** (linear theory, Shu, Cuzzi & Lissauer 1983, SCL83). At an inner vertical resonance (IVR) of
order m the forcing term of the moon's inclination, Φ ∝ sin i' cos(mθ − (m+1)λ' + Ω'), drives a vertical wave with
pattern speed Ω_p = ((m+1)n' − Ω̇')/m at the radius r_V where D(r) = ν² − m²(Ω − Ω_p)² = 0 (J2–J6 frequencies); it
propagates inward (toward Saturn) as a trailing spiral with the dispersion relation |k| = |D'| |x| / (2πGΣ), x = r − r_V.
The height is z = A_V Re[ℋ(η) e^{iΘ}] with η = x/W, W = √(2πGΣ/|D'|), Θ = mθ − (m+1)λ' + Ω' (phase from the live
ephemeris: λ', Ω' are the moon's mean longitude and node from its state vector, J2-aware epicyclic elements), the
normalized Fresnel profile ℋ(η) = e^{−iη²/2} ∫_η^∞ e^{iu²/2} du / √(2π) (|ℋ| → 1 propagating, → 1/(η√2π)
evanescent), A_V = F / √(G Σ |D'|) with F = GM' sin i' b_{3/2}^{(m)}(α) / (2a'²), and viscous damping
exp(−(x/x_D)³), x_D³ = 6πGΣW⁴ / (ν_visc μ) (the damping form of SCL83). Tables of (|z|, phase, derivatives) with
4096 nodes (`uRrTab`) plus an inverse crest table (crest positions for the shadow horizon) are built at start-up.

| wave | r_V (km) | Σ (kg/m²) | ν_visc (cm²/s) | W / x_D (km) | A_V linear / used (m) | peak |z| (m) at x (km) | max slope | λ (km) at 20 / 60 km |
|---|---|---|---|---|---|---|---|---|
| Mimas 5:3 (m = 4) | 131,900.2 | 367 | 576 | 11.6 / 104 | 779 / 390 | 450 at −24.7 | 8.5° at −69 | 50 / 14 |
| Mimas 4:2 (m = 3) | 116,724.4 | 540 | 576 | 13.5 / 136 | 386 / 386 | 448 at −28.9 | 8.1° at −92 | 66 / 20 |
| Titan −1:0 (nodal, m = 1) | 77,525.5 | 6 | 1.6 | 4.5 / 40 | — / 1006 | 1161 at +9.5 | 45° at +27 | 6.5 / 2.2 |

* Mimas 5:3: Σ and ν from Sega et al. 2024 (UVIS); linear theory gives a 0.9 km peak and 17.5° slopes, VIMS
  occultations show ~400–450 m peaks (~250 m at low effective elevations, likely an artefact) and ~10° slopes
  (Hedman, Sega et al., DPS 2022 / 2024): the profile is scaled to a 450 m peak (one factor, the shape stays linear
  theory; the resulting maximum slope is 8.5°).
* Mimas 4:2: Σ from Lissauer 1985 (the profile's B5 value); no amplitude measurement — pure linear theory (uncertain
  by ~2×, as the 5:3 comparison shows).
* Titan −1:0: the nodal resonance θ + λ' − ϖ' − Ω' (pattern speed −n' + ϖ̇' + Ω̇' < 0) makes it propagate OUTWARD as a
  leading spiral (Nicholson & Hedman 2016, whose r_V = 77,525.5 km is used: J2–J6 alone put it 33 km inward; Σ from
  their λ = 5 km at 25 km; first analysed in Voyager data by Rosen & Lissauer 1988). The wave is strongly nonlinear —
  slopes up to ~45° and 0.5–1.5 km amplitudes at 15–45 km (Sega & Stewart, DPS 2022) — so the linear profile
  (A_V = 431 m) is scaled to a 45° maximum slope (|z| 1.16 / 0.92 / 0.68 / 0.24 km at 10 / 20 / 30 / 45 km);
  ν = 1.6 cm²/s (French et al. 2025).
* The waves keep the profile's τ (the occultation profile already contains their τ signature; its de-projection
  from the 2005 RSS geometry leaves ±30 % artefacts there).

**The 1983 corrugation** (Hedman et al. 2011, 2015; French et al. 2025). An impact of cometary debris on 1983 Sep
19.25 ± 5.5 d (UTC) tilted every streamline of the C and D rings by the same small angle; differential nodal
regression has since wound the tilt into a spiral corrugation, z1 = A1 sin(θ − θ1 − (Ω − ν)(r)(t − t_i)), radial
wavelength 2π / ((t − t_i)|d(Ω − ν)/dr|) (exact J2–J6 derivative): 30 / 41 / 58 / 72 km at 75 / 80 / 86 / 90
thousand km in Aug 2009 (Hedman et al. 2011: 30–80 km from the D ring to the outer C ring, amplitudes 2–20 m),
22 km at 70,000 km (D ring), 25 km at 80,000 km in Nov 2026. A1 =
r × tilt with tilt = 10⁻⁷ in the C ring (photometry: 2–20 m, i.e. 2×10⁻⁸–3×10⁻⁷) and 300 m at 70,000 km in the
D ring (Hedman et al. 2007a), blended over 74,490 ± 500 km and faded out over 91–92 thousand km. The inner C ring
(74,490–77,765 km) also carries m = 0 and slow m = 2 ripples (French et al. 2025: 2.6–6.6 m in 2010–2017): z0 =
A sin(ν(t − t_i)), z2 = A sin(2(θ − θ2) − (2Ω − ν)(t − t_i)), A = 4 m in 2017 decaying with a 19.5 yr e-folding
(5.8 m in 2009, 2.4 m in 2026), λ ≈ 1 km. θ1, θ2 are unpublished ("without loss of generality" 0 in Hedman et al.):
0 here. The slopes are tiny (10⁻³ for m = 1) but at the 2009 equinox (B ~ 0.004°) they modulate the direct
sunlight by ×4 in μ0 and the relief shadows (vis 0.2–0.6): visible in direct light; in the near-equinox render
Saturnshine dominates the radiance near local noon, so the pattern is subtle there.

**B-ring edge: region A and S/2009 S1** (Spitale & Porco 2010). Region A is a site ~20 km inside the B-ring edge
(a = 117,547.6 km) orbiting at 758.986°/d, spanning ~10° (20,000 km) of azimuth, where vertical structures up to
3.5 km (PIA11668: 2.5 km) cast shadows near equinox, coincident with bright streaks along the edge (interpreted as
"splashing" around embedded bodies). The J2000 longitude 95° is read as the longitude at epoch J2000.0 in the
ascending-node system; it then puts the site at 168.2° at the PIA11668 frame time (2009-07-26 09:57 UTC), inside
the frame's ring footprint (165.8–168.4°, NAC N1627295980 via OPUS; their central epoch would give 355°). The
structures are phenomenological — a procedural cell field identical on CPU and GPU (PCG hash): 40 km cells, 65 %
occupied by one Gaussian structure of height h = 3.5 km (0.08 + 0.92 u⁵) (322 structures: median 0.32 km, 10 %
above 2.1 km, tallest 3.3 km), radial σ 2–5 km, 1.5–3.5× longer along the orbit, at a' from 5 km inside to 18 km
outside the site (they move with the edge modes), tapered over the outer 1.5° of the span. S/2009 S1 (a = 116,914 ±
17 km, ~300 m across, its shadow 36 km long at B = 0.24°: ~150 m above the plane) is a single 150 m Gaussian bump
(σ 150 / 300 m) at 144.4° on 2009-07-26 11:30:49.7 UTC (frame N1627301569) moving at the local Keplerian rate (its
longitude is uncertain by ±0.17°/d away from 2009). Both are vertically symmetric thickenings of the layer in
reality; a single mid-plane height can carry only one side: their sunlit half, i.e. the peaks rise toward the lit
face (and switch sides at equinox). Rendered shadow length of S/2009 S1 in test:relief: 35.3 km vs h / tan B =
35.9 km.

**Rendering** (ARCHITECTURE.md → relief contract): the sheet intersects the displaced surface (bounded march +
Illinois regula falsi; test:relief: hit error ≤ 0.22 footprints) and shades the layer in its local frame (normal from
the slopes; the Sun as a disk, so the terminator of a tilted face is soft; transmission exp(−τ/|V·n|)); shadows test
the horizon toward the Sun against the bending-wave crests (exact crest positions from the inverse phase table; inside
a wave whose wavelength is below the footprint only crests more than one local wavelength away), the single peaks
(opaque Gaussians, footprint- and penumbra-averaged), region A (walk over ≤ 16 cells toward the Sun) and the moonlet
edges (ζ sampled 0 / 0.6 / 1.5 Hill radii into the ring, footprint-averaged); heights are prefiltered (faded where
the footprint exceeds a fraction of the local wavelength / structure size), occluders are kept at their true heights
(their shadows are much longer than the footprint). The near-slab march, the near-field particles (displaced by z0 at
their guiding centre, lit relative to the local mid-plane) and the astronaut follow z0; the camera keeps its height
above the local mid-plane (station keeping includes the material's vertical motion, ~5 cm/s in the Mimas 5:3 wave).

**Not modelled.** The Mimas 7:4 and 8:5 bending waves (third-order e'i' / i'³ terms; their shadow bands appear in
PIA11676), the Encke-gap ringlet clumps (~600 m, PIA11676) and other ringlet structure, propellers' vertical
structure (propeller package), the vertical rift of the B-ring edge's other sites, non-linear bending-wave profiles
(the calibrations only scale linear theory), the waves' τ modulation by the tilted path (the occultation τ already
contains it), multiple crossings of one ray through a strongly corrugated surface (the hit search returns the first),
the sub-pixel bright walls of region A (prefiltered away from a distance).

## References

**§10 (vertical relief):** Shu, F. H., Cuzzi, J. N., Lissauer, J. J. 1983, Icarus 53, 185 (SCL83, bending waves) ·
Sega, D. D., et al. 2024, Icarus 413, 115987 (Mimas 5:3 Σ, ν) · Hedman, M. M., Sega, D. D., et al., DPS 2022 / 2024
abstracts (VIMS bending-wave amplitudes) · Lissauer, J. J. 1985 (Mimas 4:2 Σ, via Hedman & Nicholson 2016) ·
Nicholson, P. D., Hedman, M. M. 2016, Icarus 279, 78 (Titan −1:0) · Rosen, P. A., Lissauer, J. J. 1988, Science 241,
690 · Sega, D. D., Stewart, G. R., DPS 2022 abstract (Titan wave slopes) · Hedman, M. M., et al. 2011, Science 332,
708 (corrugated C ring) · Hedman, M. M., et al. 2015, Icarus 248, 137 · French, R. G., et al. 2025, Icarus (C-ring
ripples, impact epoch) · Spitale, J. N., Porco, C. C. 2010, AJ 140, 1747 (region A, S/2009 S1) · Weiss, J. W.,
Porco, C. C., Tiscareno, M. S. 2009, AJ 138, 272 (Daphnis' edge waves) · NASA/JPL PIA11655, PIA11656, PIA11668,
PIA11676 (Cassini ISS equinox images).

Afigbo, V. M., et al. 2025, JGR Planets (Kronoseismology VII; arXiv:2502.19265) · Albers, N., et al. 2012,
Icarus 217, 367 · Altobelli, N., et al. 2014 (via Miller et al. 2024) · Baillié, K., et al. 2011, Icarus 216, 292 ·
Becker, T. M., et al. 2016, Icarus 279, 20 · Bosh, A. S., et al. 2002, Icarus 157, 57 · Ciarniello, M., et al. 2011,
Icarus 214, 541 (Rhea, Hapke) · Ciarniello, M., et al. 2019,
Icarus 317, 242 · Colwell, J. E., Esposito, L. W., Sremčević, M. 2006, GRL 33, L07201 · Colwell, J. E., et al. 2007,
Icarus 190, 127 · Colwell, J. E., et al. 2009, in *Saturn from Cassini-Huygens* (Springer), 375 · Colwell, J. E.,
et al. 2010, AJ 140, 1569 · Cooke, M. L. 1991, PhD thesis, Cornell · Cuzzi, J. N., Scargle, J. D. 1985, ApJ 292, 276 ·
Cuzzi, J. N., et al. 2009, in *Saturn from
Cassini-Huygens*, 459 · Dones, L., Cuzzi, J. N., Showalter, M. R. 1993, Icarus 105, 184 · Doyle, L. R., Dones, L.,
Cuzzi, J. N. 1989, Icarus 80, 104 · El Moutamid, M., et al. 2016, Icarus 279, 125 · Esposito, L. W., et al. 2022,
EGU22-6601 · Filacchione, G., et al. 2014, Icarus
241, 45 · French, R. G., Nicholson, P. D. 2000, Icarus 145, 502 · French, R. G., Salo, H., McGhee, C. A., Dones, L. 2007,
Icarus 189, 493 ·
French, R. G., et al. 2016, Icarus 274, 131 · Goldreich, P., Tremaine, S. 1980, ApJ 241, 425 · Hapke, B. 1984,
Icarus 59, 41 (macroscopic roughness) · Hapke, B. 2002, Icarus 157, 523 · Harbison, R. A., Nicholson, P. D., Hedman,
M. M. 2013, Icarus 226,
1225 · Hedman, M. M., et al. 2007a, Icarus 188, 89 (D ring) · Hedman, M. M., et al. 2007b, AJ 133, 2624 (A-ring
wakes) · Hedman, M. M., et al. 2013, Icarus 223, 105 · Hedman, M. M., Nicholson, P. D. 2013, AJ 146, 12 ·
Hedman, M. M., Nicholson, P. D. 2014, MNRAS 444, 1369 · Hedman, M. M., Nicholson, P. D. 2016, Icarus 279, 109 ·
Hénon, M., Petit, J.-M. 1986, Celest. Mech. 38, 67 · Iess, L., et al. 2019, Science 364, eaat2965 · Jerousek, R. G., et
al. 2016, Icarus 279, 36 · Jerousek, R. G., et al. 2020, Icarus 344, 113565 · Julian, W. H., Toomre, A. 1966, ApJ 146,
810 · Lissauer, J. J. 1985 (via H&N 2016) · Marouf, E. A., Tyler, G. L., Rosen, P. A.
1986, Icarus 68, 120 · Marouf, E. A., et al. 2008 (Cassini RSS particle sizes; via Cuzzi et al. 2009) · Marouf, E.
2018, Cassini RSS ring occultations 2.0, CO-SR-RSS-4/5-OCC-V2.0, NASA PDS · Miller, K. E., et al. 2024, *The
composition of Saturn's rings*, Space Sci. Rev. (arXiv:2311.17344) · Morishima, R., et al. 2010 (via Miller et al.
2024) · Nicholson, P. D., Hedman, M. M. 2010, Icarus 206, 410 · Nicholson, P. D., et al. 2014a, Icarus 227, 152
(B-ring edge) · Nicholson, P. D., et al. 2014b, Icarus 241, 373 (C ring) · PDS Rings Node, *Vital statistics for
Saturn's rings* (pds-rings.seti.org/saturn/saturn_rings_table.html) · Porco, C. C., et al. 2007, Science 318, 1602 ·
Poulet, F., Cuzzi, J. N., French, R. G., Dones, L. 2002, Icarus 158, 224 (HST phase curves, Hapke / Shkuratov fits) ·
Showalter, M. R., Cuzzi, J. N., Marouf, E. A., Esposito, L. W. 1986, Icarus 66, 297 · Spitale, J. N., Porco, C. C.
2009, AJ 138, 1520 · Spitale, J. N., Porco, C. C. 2010, AJ 140, 1747 · Tajeddine, R., et al. 2017,
ApJS 232, 28 · Tiscareno, M. S., et al. 2007, Icarus 189,
14 · Tiscareno, M. S., et al. 2013, Icarus 224, 201 · Tiscareno, M. S., Harris, B. E. 2018, Icarus 312, 157 ·
Weidenschilling, S. J., Chapman, C. R., Davis, D. R., Greenberg, R. 1984, in *Planetary Rings* (Univ. Arizona
Press), 367 · Weiss, J. W., Porco, C. C., Tiscareno, M. S. 2009, AJ 138, 272 · Wisdom, J., Tremaine, S. 1988, AJ 95,
925 · Zebker, H. A., Marouf, E. A., Tyler, G. L. 1985, Icarus 64, 531.

Data: PDS Ring-Moon Systems Node, volumes CORSS_8001 and COUVIS_8001. Scripts in `scripts/data/rings/`:
`fetch.mjs` (downloads into `data-raw/rings/`), `build_tau.mjs`, `measure_features.mjs`, `mass_check.mjs`,
`inside_numbers.mjs`, `moonlet_response.mjs` (§8; reads moons.json, writes `public/data/rings/moonlet_response.*` and
prints the checks; `--check-only`), plus `pds.mjs` for parsing. Diagnostic plots: `sandbox/ringplot.html` (`?view=overview|zoom|sigma`,
or `?x0=&x1=`).
