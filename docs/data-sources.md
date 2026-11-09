# Data sources — moons, Sun, stars, surface maps

Owner: moons & sky data. Everything here is reproducible from the scripts in `scripts/data/{ephemeris,moons,stars,textures}/`
(raw downloads and the Horizons cache live in `data-raw/`, gitignored). Frames and units follow `docs/ARCHITECTURE.md`
(SEF = Saturn-centred, +Z = IAU 2015 Saturn pole at J2000, +X = node of Saturn's equator on the ICRF equator; ICRF→SEF
via `ICRF_TO_SEF` in `src/core/ephemeris.ts`, pole RA 40.589°, Dec 83.537°).

Every paper, data set, map and catalogue cited here is also an entry of the app's bibliography, `src/app/references.ts`
(in-app Sources panel, key G; with licence, DOI or archive link and what uses it). `npm run check:refs` keeps the two
in sync: a new citation here needs an entry there.

## Runtime APIs

| module | export | data |
|---|---|---|
| `src/moons/MoonSystem.ts` | `loadMoonSystem(): Promise<MoonProvider>` (falls back to `StubMoons` with a warning), `class MoonSystem implements MoonProvider` (+ `indexOf(name)`, `accurateSpanJd(i)`), `createMoonSystem(json, i16, f32, hyperion)` (for Node tests) | `public/data/moons/moons.json`, `moon_tables.i16`, `moon_tables.f32`, `hyperion_rotation.f32` |
| `src/moons/orbitModel.ts` | `OrbitModel`, `OrbitSample`, `tauFromT` (runtime mirror of `scripts/data/moons/model.mjs`) | |
| `src/moons/hyperionRotation.ts` | `HyperionRotation` | |
| `src/moons/shapes.ts` | `loadMoonShapes(): Promise<Map<string, MoonShape>>` (empty map + warning if missing; `loadMoonSystem` attaches them as `MoonState.shape`), `MoonShape.radiusAlong(x,y,z)`, `.gradientFields()`, `moonSurfaceRadius(m, dBody)` (shape or ellipsoid; used by the cameras) | `public/data/moons/shapes.json`, `shapes.u16` (section 6) |
| `src/sky/starCatalog.ts` | `loadStarCatalog(): Promise<StarCatalog \| null>`, `starIrradiance(V)`, `starColorFromBV(bv)`, `teffFromBV(bv)`, `STAR_E0` | `public/data/stars/stars.json`, `stars.bin` |
| `src/core/ephemeris.ts` (orchestrator) | `loadSunTable()` | `public/data/ephemeris/sun_from_saturn.json` |
| far-field renderer | reads `public/data/textures/manifest.json` | `public/data/textures/moons/<key>.jpg` |

`MoonSystem.getStates(t, out)` fills all `MoonState` fields for 28 moons, allocation-free, **16.7 µs per call for all 28
moons** (Node 24 / V8, Apple M5 Max; measured by `verify_runtime.ts`). Array order (shaders use the first `MAX_MOONS` = 32):
Mimas, Enceladus, Tethys, Dione, Rhea, Titan, Iapetus, Hyperion, Phoebe, Pan, Daphnis, Atlas, Prometheus, Pandora, Janus,
Epimetheus, then Aegaeon, Methone, Anthe, Pallene, Calypso, Telesto, Polydeuces, Helene, Paaliaq, Albiorix, Siarnaq, Ymir.

## 1. Moon catalogue (`moons.json` → `MoonState`)

| # | moon | NAIF | kind | radii a×b×c (km) | mean R (km) | GM (km³/s²) | p_V | tint (lin. RGB) | rotation | orbit table |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | Mimas | 601 | major | 207.8 × 196.7 × 190.6 | 198.24 | 2.50349 | 0.962 | 1.011, 1.000, 0.964 | synchronous + 0.84° forced libration | elements 4 d |
| 1 | Enceladus | 602 | major | 256.6 × 251.4 × 248.3 | 252.077 | 7.21037 | 1.375 | 0.973, 1.005, 1.034 | synchronous + 0.12° forced libration | elements 4 d |
| 2 | Tethys | 603 | major | 538.4 × 528.3 × 526.3 | 530.974 | 41.2135 | 1.229 | 1.011, 1.000, 0.964 | synchronous | elements 4 d |
| 3 | Dione | 604 | major | 563.4 × 561.3 × 559.6 | 561.431 | 73.1161 | 0.998 | 1.024, 0.998, 0.952 | synchronous | elements 4 d |
| 4 | Rhea | 605 | major | 765 × 763.1 × 762.4 | 763.499 | 153.942 | 0.949 | 1.045, 0.996, 0.911 | synchronous | elements 4 d |
| 5 | Titan | 606 | major | 2575.15 × 2574.78 × 2574.47 | 2574.8 | 8978.14 | 0.22 | 1.281, 0.961, 0.564 | synchronous | elements 8 d |
| 6 | Iapetus | 608 | major | 745.7 × 745.7 × 712.1 | 734.327 | 120.515 | 0.31 | 1.056, 0.990, 0.934 | synchronous | elements 4 d |
| 7 | Hyperion | 607 | major | 180.1 × 133 × 102.7 | 134.993 | 0.37049 | 0.3 | 1.079, 0.988, 0.887 | chaotic (Euler eqs.) | elements 3 d |
| 8 | Phoebe | 609 | irregular | 109.4 × 108.5 × 101.8 | 106.512 | 0.55479 | 0.081 | 0.987, 1.002, 1.021 | IAU pole 356.9/77.8, W=178.58+931.639d | cartesian 8 d |
| 9 | Pan | 618 | ring | 17.2 × 15.4 × 10.4 | 14.018 | 0.00028 | 0.5 | 1.079, 0.988, 0.887 | synchronous | elements 16 d |
| 10 | Daphnis | 635 | ring | 4.6 × 4.5 × 2.8 | 3.87 | 0.0000056 | 0.5 | 1.079, 0.988, 0.887 | synchronous | elements 8 d |
| 11 | Atlas | 615 | ring | 20.5 × 17.8 × 9.4 | 15.081 | 0.00037 | 0.4 | 1.095, 0.985, 0.869 | synchronous | elements 8 d |
| 12 | Prometheus | 616 | ring | 68.2 × 41.6 × 28.2 | 43.09 | 0.01071 | 0.5 | 1.054, 0.992, 0.921 | synchronous | elements 8 d |
| 13 | Pandora | 617 | ring | 52.2 × 40.8 × 31.5 | 40.633 | 0.00926 | 0.5 | 1.054, 0.992, 0.921 | synchronous | elements 8 d |
| 14 | Janus | 610 | coorbital | 101.7 × 93 × 76.3 | 89.697 | 0.12662 | 0.71 | 1.040, 0.995, 0.933 | synchronous | elements 4 d |
| 15 | Epimetheus | 611 | coorbital | 64.9 × 57.3 × 53 | 58.196 | 0.03514 | 0.73 | 1.040, 0.995, 0.933 | synchronous + 5.9° forced libration | elements 4 d |
| 16 | Aegaeon | 653 | minor | 0.7 × 0.25 × 0.2 | 0.327 | 4.9e-9 (est.) | 0.15 | 1.055, 0.992, 0.914 | synchronous | elements 4 d |
| 17 | Methone | 632 | minor | 1.94 × 1.29 × 1.21 | 1.447 | 2.6e-7 (est.) | 0.5 | 1.011, 1.000, 0.964 | synchronous | elements 4 d |
| 18 | Anthe | 649 | minor | 0.5 × 0.5 × 0.5 | 0.5 | 1.7e-8 (est.) | 0.5 | 1.011, 1.000, 0.964 | synchronous | elements 4 d |
| 19 | Pallene | 633 | minor | 2.88 × 2.08 × 1.8 | 2.209 | 1.5e-6 (est.) | 0.5 | 1.011, 1.000, 0.964 | synchronous | elements 8 d |
| 20 | Calypso | 614 | trojan | 15.3 × 9.3 × 6.3 | 9.642 | 1.25e-4 (est.) | 1.34 | 1.011, 1.000, 0.964 | synchronous | elements 4 d |
| 21 | Telesto | 613 | trojan | 16.3 × 11.8 × 9.8 | 12.353 | 2.6e-4 (est.) | 1.0 | 1.011, 1.000, 0.964 | synchronous | elements 4 d |
| 22 | Polydeuces | 634 | trojan | 1.5 × 1.2 × 1 | 1.216 | 2.5e-7 (est.) | 0.7 | 1.011, 1.000, 0.964 | synchronous | elements 4 d |
| 23 | Helene | 612 | trojan | 22.5 × 19.6 × 13.3 | 18.034 | 0.00048 | 1.67 | 1.011, 1.000, 0.964 | synchronous | elements 4 d |
| 24 | Paaliaq | 620 | irregular | 12.5 (sphere) | 12.5 | 8.2e-4 (est.) | 0.06 | 1.125, 0.982, 0.816 | assumed pole, P = 18.75 h | cartesian 4 d |
| 25 | Albiorix | 626 | irregular | 14.3 (sphere) | 14.3 | 1.2e-3 (est.) | 0.06 | 1.125, 0.982, 0.816 | assumed pole, P = 13.32 h | cartesian 4 d |
| 26 | Siarnaq | 629 | irregular | 19.6 (sphere) | 19.6 | 3.2e-3 (est.) | 0.06 | 1.125, 0.982, 0.816 | assumed pole, P = 10.188 h | cartesian 4 d |
| 27 | Ymir | 619 | irregular | 9.5 (sphere) | 9.5 | 3.6e-4 (est.) | 0.06 | 1.034, 0.994, 0.955 | assumed pole, P = 11.92 h | cartesian 8 d |

Sources:
* **Shapes** (the radii above; for Pan, Daphnis, Atlas, Prometheus, Pandora, Epimetheus and Janus only the
  fallback and the shadow spheres — they are rendered with the measured shape models of section 6): IAU WGCCRE 2015
  report (Archinal et al. 2018, *CMDA* 130:22) as implemented in NAIF `pck00011.tpc`
  (`BODY6xx_RADII`), which includes the Thomas 2010 (*Icarus* 208:395), Thomas et al. 2013 (*Icarus* 226:999; Methone,
  Pallene, Polydeuces, Aegaeon) and Buratti et al. 2019 (*Science* 364; Pan, Daphnis, Atlas, Pandora) results. a = axis
  toward Saturn (body +x), b = along-orbit (+y), c = polar (+z). Irregulars: spheres of the radiometric/assumed-albedo
  sizes (Grav et al. 2015; Denk et al. 2018).
* **GM**: JPL SSD planetary-satellite physical parameters (SAT441/SAT415 solutions, Jacobson); Daphnis from its ring
  edge waves (Weiss et al. 2009, 8.4×10¹³ kg). "(est.)" = volume × assumed density (500 kg/m³; Methone 310 kg/m³ from its
  equilibrium shape, Thomas et al. 2013; irregulars 1500 kg/m³).
* **p_V** (visual geometric albedo, `MoonState.albedo`): Verbiscer et al. 2007 (*Science* 315:815) for Mimas–Rhea and
  the co-orbital/Lagrangian moons; ring moons Verbiscer et al. 2007 / Buratti et al. 2019; Titan 0.22, Hyperion 0.3, Phoebe
  0.081 (JPL SSD/Horizons); the tiny moons and irregulars are assumptions (0.5 / 0.06). **Iapetus 0.31** is the
  area-weighted mean normal albedo of its calibrated texture (dark leading side 0.04, bright trailing side 0.55), so that
  `albedo × L/meanLinear` reproduces both hemispheres.
* **Tint** (`MoonState.color`): linear-RGB reflectance relative to the Sun (sunlight = (1,1,1)), unit luminance (so
  albedo × tint keeps the V-band albedo). Computed (`scripts/data/moons/colors.mjs`) from disk-integrated B−V and
  Cousins V−R colour indices relative to the Sun's (0.653 / 0.356, Ramírez et al. 2012): reflectance piecewise linear
  through 440/550/640 nm, solar (5772 K) spectrum, CIE 1931 CMFs (Wyman et al. 2013 fit) → linear sRGB, white-balanced to
  the Sun. The indices (±~0.05 mag) are from the literature compilations (e.g. Buratti & Veverka; Grav et al. 2003 for
  irregulars); only Titan (orange) and the slightly red ring moons/irregulars depart visibly from neutral.

### Rotation models (`MoonState.orient`, body → SEF; body frame per `src/moons/types.ts`)
* **Synchronous** (all regular moons except Hyperion): body **+x points toward Saturn along the mean direction**
  (−û with û the unit vector at the moon's *mean* longitude in the instantaneous orbit plane), **+z = orbit normal**,
  +y = z × x (trailing hemisphere). Uniform rotation at the mean motion therefore produces the real optical libration
  (±2e: Mimas ±2.25°, Titan ±3.3°, Iapetus ±3.2°); librations of the *orbital* longitude (Trojans, Janus/Epimetheus swaps)
  are followed adiabatically, as a tidally locked body does. Measured forced physical librations are added as a rotation
  about +z by −A sin M (assumed anti-phase with the optical libration, as for ω₀ < n): Mimas A = 0.84° (Tajeddine et al.
  2014), Enceladus 0.12° (Thomas et al. 2016), Epimetheus 5.9° (Tiscareno et al. 2009). Verified: Mimas's body +x stays
  within 3.094° of the Saturn direction over an orbit (2e + A = 3.09°) and +z is the orbit normal to 1e-6.
  The +x direction is the mean sub-Saturn point, which is the IAU 0° meridian of these bodies to within the accuracy of
  their cartographic longitude systems.
* **IAU** (Phoebe): pole α₀ = 356.90°, δ₀ = 77.80°, W = 178.58° + 931.639°·d (WGCCRE 2015; P = 9.27354 h): +z = pole,
  +x = prime meridian. The four irregulars use their light-curve periods (Denk & Mottola 2019) with an *assumed* pole
  (ICRF north) — they are 10–40 km point-like bodies.
* **Hyperion — chaotic**: rigid-body Euler equations, homogeneous-ellipsoid moments of the 180.1×133.0×102.7 km shape
  (A:B:C = b²+c² : a²+c² : a²+b²), Saturn's gravity-gradient torque 3GM/r³ (r̂ × I r̂) along the fitted orbit, RK4
  (h = 0.005 d) from an illustrative initial state on 2005-09-26 (|ω| = 72°/d, Thomas et al. 2007; spin axis 35° from the
  long axis; 40° from SEF +Z). Checkpoints every 4 d (1995–2055, `hyperion_rotation.f32`); at run time the state is
  re-integrated (RK4, ≤ 0.05 d substeps, Saturn direction from a 5-point interpolation of the orbit) from the **nearest**
  checkpoint (≤ 2 d forward or backward), so the orientation is a pure function of t: cheap at any warp, identical in
  reversed time (verified: jump at checkpoint switch points 9×10⁻⁶°, revisits identical). Outside 1995–2055 the time is
  wrapped periodically into the span (jumps only at the wrap instants). Mean spin rate over the span: 60°/d. Because the
  rotation is chaotic, the true present-day orientation is unknowable — this is a physically correct *kind* of motion,
  not a prediction.

## 2. Moon ephemerides

**Source**: JPL Horizons API (`https://ssd.jpl.nasa.gov/api/horizons.api`), geometric (`VEC_CORR=NONE`) ICRF state
vectors relative to Saturn's centre (`500@699`), TDB. Ephemerides: `sat441l` (major moons, Helene, Telesto, Calypso,
Methone, Polydeuces; coverage 1750–2250), `sat415_merged_DE437` (Pan, Daphnis, Atlas, Prometheus, Pandora, Janus,
Epimetheus, Pallene, Anthe, Aegaeon; 1950–2050; **Daphnis only 1990-06-15 – 2018-01-17**), `sat456` (irregulars;
1750–2150). Data: JPL/NASA, freely usable.

**Model** (`scripts/data/moons/model.mjs` = `src/moons/orbitModel.ts`), per moon, τ = days since 2025-01-01 0h TDB:
1. A fixed reference frame R (Laplace plane: Saturn's equator for the inner moons; fitted small tilt for Rhea/Titan;
   JPL SSD Laplace plane for Hyperion/Iapetus (14.8°); flipped Laplace plane for retrograde Phoebe; Saturn's orbital plane
   for the irregulars).
2. **Mean elements**: λ = λ₀ + nτ + Σ libration series; (k, h) = e·exp(iϖ) rotating at ϖ̇ (+ eccentricity-vector
   libration terms); (q, p) = tan(i/2)·exp(iΩ) rotating at Ω̇; optional a-libration terms. Libration series (period,
   harmonics, frequency all fitted): Mimas–Tethys 4:2 resonance (70.5 yr, Mimas ±43.8°, Tethys ±2.1°, carried by Methone,
   Anthe, Aegaeon, Telesto, Calypso), Enceladus–Dione 2:1 (11.0 yr), **Janus/Epimetheus co-orbital cycle (8.00 yr period,
   15 harmonics in λ, a and e-vector; Epimetheus ±114°, Janus ±31.7°, ratio = mass ratio 3.6)**, Trojan tadpoles
   (Telesto/Calypso 696 d, Helene 768 d ±14.8°, Polydeuces 792 d ±25.8°), corotation-resonance librations (Methone 520 d,
   Anthe 762 d, Aegaeon 1279 d), Hyperion–Titan 4:3 (640 d), solar terms (5380 d) for Phoebe/irregulars. Fitted by
   Levenberg–Marquardt to sparse Horizons positions over the whole Horizons coverage (Daphnis: 2011–2018 only, see below).
   Initialisation is data-driven (periodogram of the unwrapped longitude; precession rates by frequency scans of the
   radial/vertical signal) because several SSD apsidal periods mix the ϖ and ω conventions.
3. **Residual table**, 1995-01-01 – 2055-04-01 (clipped to coverage), 4-point Lagrange interpolation, faded out by a
   smoothstep over the first/last 365 d so the model reverts *continuously* to the mean elements outside:
   * `elements` tables (ΔΛ, Δa, Δk, Δh, Δq, Δp) for all regular moons, steps 3–16 d, fitted by banded Gauss–Newton to
     ~7 Horizons positions per step (sampling with a golden-ratio orbital-phase advance so every step sees all phases);
     stored as int16 with per-field scales (quantisation changes the errors by < 5 %).
   * `cartesian` tables (Δx, Δy, Δz SEF, float32) for Phoebe and the irregulars, sampled exactly at the nodes. These
     moons are fitted in **barycentric** coordinates (Horizons `500@6`) because their Saturn-centred positions contain
     Saturn's reflex motion (Titan-dominated, 290 km amplitude, 16-d period) that a coarse table cannot follow; at run time
     Saturn's offset W = Σ μᵢrᵢ/(1+Σμ) (Mimas…Iapetus, μ = GM/GM_Saturn) is added back (Phoebe error 296 km → 2.4 km).
4. Position = equinoctial Kepler ellipse (Broucke & Cefola 1972); velocity = central difference (±2 s) of the full model,
   so it is exactly consistent with the positions.

**Accuracy** — runtime TypeScript `MoonSystem` vs. *fresh* Horizons queries at 40 random epochs 2020–2035 per moon (not
used in the fit) plus 2026-11-07 00:00/12:00 TDB (`scripts/data/moons/verify_runtime.ts`; along-track = longitude error
seen from Saturn):

| moon | along-track max (°) | rms (°) | \|dr\| max (km) | max error (km) | rel. velocity error | 2026-11-07 00:00 / 12:00 (km) | mean model only, max (°) | outside the table: Saturn-centred angle error (°) |
|---|---|---|---|---|---|---|---|---|
| Mimas | 0.0016 | 0.0011 | 8.8 | 9.0 | 7e-5 | 4.9 / 4.6 | 0.26 | 1960 0.05, 1980 0.28, 2058 0.10, 2078 0.35, 2198 0.35 |
| Enceladus | 0.0049 | 0.0019 | 6.5 | 20 | 7e-5 | 12 / 8.0 | 0.21 | ≤ 0.18 (1960–2198) |
| Tethys | 0.0061 | 0.0025 | 8.5 | 31 | 7e-5 | 5.1 / 8.2 | 0.12 | ≤ 0.11 |
| Dione | 0.0042 | 0.0018 | 12 | 28 | 5e-5 | 3.5 / 4.1 | 0.065 | ≤ 0.03 |
| Rhea | 0.0016 | 0.0007 | 21 | 21 | 6e-5 | 3.0 / 17 | 0.068 | ≤ 0.06 |
| Titan | 0.00012 | 0.00007 | 4.3 | 4.6 | 1e-5 | 1.6 / 1.9 | 0.055 | ≤ 0.05 |
| Iapetus | 0.00005 | 0.00002 | 2.4 | 3.6 | 4e-5 | 1.3 / 1.5 | 0.45 | ≤ 0.42 |
| Hyperion | 0.00016 | 0.00005 | 10 | 11 | 5e-5 | 0.2 / 0.7 | 3.2 | 0.1–2.6 |
| Phoebe | 0.00001 | 0.000003 | 2.0 | 2.4 | 1e-5 | 0.4 / 0.6 | 0.75 | ≤ 0.48 |
| Pan | 0.0005 | 0.0002 | 0.4 | 1.2 | 6e-6 | 0.3 / 0.1 | 0.001 | 0.00 (1960–1993) |
| Daphnis | n/a — no Horizons ephemeris after 2018-01-17 | | | | | | | 1993: 4.5 |
| Atlas | 0.0014 | 0.0004 | 1.0 | 3.4 | 2e-5 | 0.8 / 0.7 | 3.0 | 0.2–1.1 |
| Prometheus | 0.0009 | 0.0004 | 1.5 | 2.3 | 2e-5 | 1.8 / 1.0 | 1.2 | 0.1–0.8 |
| Pandora | 0.0011 | 0.0004 | 2.7 | 3.2 | 3e-5 | 2.2 / 0.7 | 1.7 | 0.2–1.2 |
| Janus | 0.0009 | 0.0005 | 3.5 | 3.6 | 4e-5 | 2.5 / 3.3 | 0.26 | 0.16–0.33 |
| Epimetheus | 0.0011 | 0.0006 | 5.0 | 5.0 | 5e-5 | 2.5 / 4.4 | 1.8 | 0.20–0.43 |
| Aegaeon | 0.0014 | 0.0006 | 1.7 | 4.2 | 2e-5 | 0.7 / 0.6 | 0.12 | ≤ 0.06 |
| Methone | 0.0078 | 0.0023 | 5.1 | 27 | 1e-4 | 5.4 / 7.4 | 1.0 | 0.1–1.6 |
| Anthe | 0.0041 | 0.0013 | 3.5 | 14 | 7e-5 | 3.9 / 3.7 | 0.74 | ≤ 0.68 |
| Pallene | 0.0048 | 0.0021 | 6.7 | 18 | 7e-5 | 5.3 / 4.9 | 0.16 | ≤ 0.42 |
| Calypso | 0.0054 | 0.0024 | 9.0 | 28 | 8e-5 | 3.6 / 7.0 | 0.11 | ≤ 0.09 |
| Telesto | 0.0053 | 0.0021 | 8.1 | 28 | 7e-5 | 19 / 23 | 0.11 | ≤ 0.09 |
| Polydeuces | 0.0049 | 0.0014 | 14 | 32 | 7e-5 | 8.2 / 11 | 0.63 | ≤ 0.55 |
| Helene | 0.0038 | 0.0016 | 9.7 | 25 | 6e-5 | 14 / 7.5 | 0.21 | ≤ 0.17 |
| Paaliaq | 0.0004 | 0.0001 | 53 | 69 | 2e-4 | 0.8 / 1.1 | 32 | 5–32 |
| Albiorix | 0.0001 | 0.00002 | 5.0 | 14 | 3e-4 | 0.2 / 0.2 | 21 | 0.7–12 |
| Siarnaq | 0.00007 | 0.00001 | 26 | 26 | 8e-5 | 0.2 / 0.2 | 29 | 2–22 |
| Ymir | 0.00003 | 0.000006 | 13 | 14 | 4e-5 | 4.0 / 5.8 | 34 | 14–41 |

Worst along-track error over all moons 2020–2035: **0.0078°** (target was < 0.5°). Robustness: 14 epochs from 3000 BC to
5000 AD give finite, bounded orbits for every moon (largest |r/a−1| = 0.51 for Albiorix, e = 0.48). Outside the table
the regular moons degrade to the mean-element accuracy above (≤ 0.4° except Hyperion ~2.5°, Daphnis); the irregulars'
mean models are rough (they are strongly solar-perturbed) but stay on realistic orbits.

**Janus/Epimetheus**: swap epochs from the fitted model (minimum mean-longitude separation, 5.4° ≈ 14,000 km):
1998-01-22, 2002-01-22, 2006-01-21, 2010-01-21, 2014-01-22, 2018-01-23, 2022-01-22, **2026-01-22**, next **2030-01-20**,
2034-01-18, 2038-01-14, 2042-01-12, 2046-01-10; at each, Janus's semi-major axis changes by 21 km (151,462 ↔ 151,441 km)
and Epimetheus's by 77 km (151,413 ↔ 151,490 km), as angular-momentum exchange requires
(`scripts/data/moons/coorbital_swaps.mjs`). They are inside the residual table and reproduced to 3–5 km; the 15-harmonic
co-orbital series alone gives 0.2–0.4° in 1960–1993 and keeps the cycle going after Horizons ends (2050). **Trojans** (Telesto/Calypso at Tethys L4/L5, Helene/Polydeuces at Dione L4/L5):
their tadpole librations are explicit series in the mean model and fully captured by the tables (≤ 32 km).

**Daphnis** (known limitation): Horizons ends 2018-01-17 and its sat415 orbit changes mean motion around 2010, so the mean
model is fitted to 2011–2018 only and *extrapolated*; the table reproduces 1995–2018. Hindcast tests (fit 2011–2014,
predict onward) show the along-track error growing by ~0.1–0.15°/yr after the fit window, i.e. **~1° by 2026 and 2–3° by
2035** relative to whatever a future JPL solution would give. Daphnis stays inside the Keeler gap (a, e, i are fitted), only
its phase is uncertain.

Not modelled: light-time to the observer (an in-system camera; ≤ 13 s), Saturn's pole precession (fixed SEF pole, as
everywhere in the app).

## 3. Sun from Saturn (`public/data/ephemeris/sun_from_saturn.json`)

Horizons, Sun (10) relative to Saturn's centre (500@699), ICRF, geometric, DE441; 5-day step, 1989-12-22 – 2060-01-16
(5119 epochs; format exactly as `loadSunTable` expects: `{frame, center, target, start_jd_tdb, step_days, pos_km}` +
`count, source, notes`). Built by `scripts/data/ephemeris/build_sun.mjs`.
Verified through the real `sunFromSaturnSef` with the table loaded, against 62 fresh Horizons epochs 1990–2060
(incl. 2026-11-07): **max direction error 0.010″ (2.8×10⁻⁶°)**, max distance error 68 km (Saturn's 290-km Titan reflex
is below the 5-d sampling; irrelevant for direction). The built-in **Standish fallback** errs by up to **0.33°** over
1990–2060 (0.074° over 2020–2035). The direction is geometric; stellar aberration from Saturn's 9.6 km/s orbital motion
would shift the apparent Sun by ≤ 6.6″.

## 4. Stars (`public/data/stars/stars.{json,bin}`)

* **Source**: Yale Bright Star Catalogue, 5th revised ed. (Hoffleit & Warren 1991; CDS V/50; downloaded from the
  Harvard TDC mirror `http://tdc-www.harvard.edu/catalogs/bsc5.dat.gz`), **public domain**. 9096 stars, complete to
  V ≈ 6.5 (faintest entry 7.96) — everything the naked eye sees. 310 stars without B−V get a class-typical value.
* **Fainter stars were not added**: Hipparcos/Tycho (ESA) and Gaia are distributed under **CC BY-NC 3.0 IGO**
  (non-commercial; see cosmos.esa.int/web/hipparcos/catalogues and /web/gaia-users/license), i.e. not freely licensed.
  `node scripts/data/stars/build_stars.mjs --with-hipparcos 8.5` can build an *opt-in* extension (Hipparcos to V ≤ 8.5,
  ~40 k stars, cross-matched against BSC5) into `stars_hip_nc.{bin,json}` — not generated, not shipped; load it with
  `loadStarCatalog('data/stars/stars_hip_nc')` only if the NC licence is acceptable.
* **Format** (`stars.bin`): 12-byte little-endian records, sorted by V (brightest first): float32 RA, float32 Dec (rad,
  ICRS, **epoch J2026.0** — BSC5 J2000 proper motions applied), int16 V×1000, int16 (B−V)×1000. `stars.json`: count,
  epoch, magLimit, completeTo, source, license, and Bayer/Flamsteed names of the 490 stars with V < 4 (`named: [index,
  name]`).
* **Loader output**: `dir` (SEF unit vectors via `ICRF_TO_SEF`), `irradiance`, `color`, `vmag`, `bv`, `names`.
* **Irradiance calibration** (consistent with the renderer's sunlight): a star of magnitude V delivers the V-band flux
  10^(−0.4(V − V☉)) times the Sun's at 1 AU; in the renderer's units (solar-spectrum-equivalent W/m², total solar
  irradiance `SOLAR_IRRADIANCE_1AU` = 1361 W/m² at `SUN_APPARENT_MAG_1AU` = −26.74):
  **E = 1361 × 10^(−0.4(V + 26.74)) = 2.741×10⁻⁸ W/m² × 10^(−0.4 V)** (Sirius: 1.05×10⁻⁷ W/m²). Stars are at infinite
  distance, so the value at Saturn equals the one at Earth (no extinction; the 9.5-AU parallax moves α Cen by < 8″).
* **Colour**: blackbody at T_eff(B−V) (Ballesteros 2012, EPL 97:34008), CIE 1931 (Wyman et al. 2013 fit) → linear sRGB,
  divided channel-wise by a solar-colour star (B−V = 0.653 → 5767 K) so sunlight-coloured stars are exactly white,
  unit luminance (irradiance × colour keeps the V brightness). B−V = −0.3 → (0.69, 1.00, 1.91); 1.5 → (1.33, 0.95, 0.53).

## 5. Surface maps (`public/data/textures/manifest.json`, `textures/moons/<key>.jpg`)

Seven global maps, 2048×1024 JPEG (sRGB-tagged), all in **one layout**: equirectangular, full sphere, **image centre =
0° longitude, east longitude increasing to the right** (= IAU west longitude increasing to the left), north up, top row
+90°, planetocentric latitude. In the manifest: `lon0Center: 0`, `lonDirection: "east"`, `latitude: "planetocentric"`.
For a body-frame direction (x, y, z) (`types.ts`): lonE = atan2(y, x), lat = asin(z), **u = fract(0.5 + lonE/360°),
v_top = 0.5 − lat/180°** (from the top row; flip if the texture origin is bottom-left).

**Manifest format** — a flat object keyed by `MoonState.textureKey`:
`{ "<key>": { file, width, height, projection, lon0Center, lonDirection, latitude, latTop, uFromLon, vFromLat, encoding,
meanLinear, relMin, relMax, source, sourceLayout, license, [calibration, meanNormalAlbedo, noData, note] } }`.
`lon0Center` = longitude at the image's horizontal centre (deg); `lonDirection` = the direction in which longitude
increases to the right (`"east"` here for every map); `file` is relative to the site root (use `dataUrl(file)`).
Keys present: mimas, enceladus, tethys, dione, rhea, iapetus, phoebe (no Saturn entry, see below; other moons → procedural).
**Pixel semantics**: decode with the sRGB transfer function to linear L; L is proportional to reflectance (source DN
taken as linear in I/F); `L / meanLinear` has area-weighted mean 1 and multiplies `MoonState.albedo`.

| key | source (public domain) | source layout → verification |
|---|---|---|
| mimas | NASA Photojournal **PIA17214** "Mimas Global Map – June 2017" (NASA/JPL-Caltech/SSI), 5760×2880 | centre 0°: Herschel crater lands at 113°W (IAU ≈ 112°W) |
| enceladus | USGS Astrogeology *Enceladus Cassini Global Mosaic 110m* (14401×7201) | ISIS SimpleCylindrical, CenterLongitude 180 PositiveWest, UpperLeftCornerX 0 → centre 0° |
| tethys | USGS *Tethys Cassini Global Mosaic 293m* (= PIA14931) | ISIS Equirectangular, centre 0° PositiveEast; Odysseus at 129.6°W 30.6°N (IAU 128.9°W 32.8°N) |
| dione | USGS *Dione Cassini-Voyager Global Mosaic 154m* | Equirectangular centre 0° PositiveEast; wispy chasmata centred on 270°W |
| rhea | USGS *Rhea Cassini-Voyager Global Mosaic 417m* (= PIA14928) | SimpleCylindrical, CenterLongitude 180 PositiveWest, ULX 0 → centre 0° |
| iapetus | NASA Photojournal **PIA18436** "Color Maps of Iapetus – 2014" (Schenk/LPI; NASA/JPL-Caltech/SSI/LPI), 11741×5871 | source centre **180°** (Cassini Regio at x = 0.75) → rolled by 180°; luminance only |
| phoebe | NASA Photojournal **PIA07775** "Map of Phoebe – Dec 2005" (NASA/JPL/SSI), annotated chart 3228×1900 | axes 180…0…180 (west increasing leftward); data rectangle 2880×1440 at (191,183) located from the axis ticks (8.0 px/deg) |

Processing (`scripts/data/textures/build_textures.mjs`): `sips` resampling; DN-0 no-data pixels (≤ 0.2 %; Phoebe 30 %:
the never-imaged north beyond ~60°N, deep baked-in shadows, the flat filler band south of −81°) filled by smooth
push-pull interpolation; values re-encoded as sRGB over linear reflectance; 99.9th percentile → white.
**Iapetus calibration**: the CICLOPS/USGS grayscale Iapetus mosaics are photometrically normalised and lose the 10×
leading/trailing albedo dichotomy, so the Schenk 2014 colour mosaic is used (luminance only; it is an enhanced-colour
product), two-point calibrated: equatorial apex (90°W) mean → normal albedo 0.04, antapex (270°W) → 0.55, linear in
between; area-weighted mean 0.307 (→ `MoonState.albedo` 0.31).
Caveats: the grayscale mosaics are photometrically normalised (hemispheric albedo contrasts such as Dione's darker
trailing side are suppressed) and contain baked-in topographic shading; Phoebe's map is from a single 2004 flyby.
**No Titan map** (its visible surface is hidden by haze; ISS 938-nm surface maps exist at USGS but are not what the eye
sees). **No Saturn map**: no public-domain Cassini full-globe cylindrical map was found (Photojournal has only tile
mosaics such as PIA06193); Saturn's bands rotate differentially, so a static map would be inaccurate anyway.

## 6. Measured shapes of the small inner moons (`public/data/moons/shapes.{json,u16}`)

**Source**: P. C. Thomas, J. Joseph & T. Ansty (2018), *Saturn Small Moon Shape Models V1.0*, NASA Planetary Data
System, Small Bodies Node, `urn:nasa:pds:saturn_satellite_shape_models::1.0`, **doi:10.26033/ewy3-jy61**
(`https://sbnarchive.psi.edu/pds4/cassini/saturn_satellite_shape_models_V1_0/`): 30k-plate models (13–14 k vertices,
km) from Cassini ISS NAC stereo control points and limb fits, including the 2016–17 ring-grazing close flybys (Pan
2017-03-07 at 24,500 km, Daphnis 2017-01-16, Atlas 2017-04-12 at 12,700 km, Pandora 2016-12-18, Epimetheus 2017-01/02).
**Licence**: NASA PDS data (US-government work), no copyright restrictions; cite the data set. The bundle also holds
Telesto, Calypso, Helene and Hyperion (not used yet). Frame: +X Saturn-facing prime meridian, +Y opposite to the orbital
motion (trailing), +Z north spin pole, origin = centre of figure (±20–90 m) — identical to `MoonState`'s body frame.

**Processing** (`scripts/data/moons/build_shapes.mjs`): each model is verified star-shaped about the origin (every
plate faces outward and the plates' solid angles sum to 4π to 1e-12, so each direction meets the surface once); the
radial function r(lat, lonE) is sampled by exact ray-plate intersection on a 1° grid, 360 × 181, rows from the south to
the north pole (both included, constant) and **a row on the equator** — the ridge crests of Pan, Atlas and Daphnis
are a vertex chain at z = 0, kept sharp; uint16 (r = value × scaleKm = r_max/65535: 0.09 m for Daphnis … 1.6 m for
Janus). Reconstruction error of the bilinear interpolant against the mesh (40,000 random directions): rms 0.4–14 m
(≤ 3 % of the models' stated radius uncertainties), worst single points 8–178 m on sharp creases (Prometheus 178 m vs
its 0.2–0.4 km). 1.5° would give rms 0.8–25 m (397 KiB), 0.5° rms 0.2–5 m (3.5 MB).

| moon | R_vol (km) model / published | r_min–r_max (km) | extents x / y / z (km) | best-fit ellipsoid (km) | `moons.json` (IAU) | map rms / max (m) | model uncertainty (km) |
|---|---|---|---|---|---|---|---|
| Pan | 13.70 / 14.0 ± 1.2ᵃ, 13.7 ± 0.3ᵇ | 10.36–20.40 | −20.16..20.41 / −16.20..15.27 / −10.50..11.05 | 17.51 × 14.13 × 10.30 | 17.2 × 15.4 × 10.4 | 3.1 / 78 | 0.2–0.3 |
| Daphnis | 3.89 / 3.8 ± 0.8ᵃ, 3.9 ± 0.5ᵇ | 2.67–5.61 | −5.59..5.59 / −4.77..4.94 / −3.10..2.79 | 4.96 × 4.31 × 2.74 | 4.6 × 4.5 × 2.8 | 0.4 / 8 | 0.2–0.7 |
| Atlas | 14.93 / 15.1 ± 0.8ᵃ, 14.9 ± 0.2ᵇ | 9.17–24.16 | −24.16..23.38 / −20.40..20.88 / −10.07..9.40 | 20.79 × 19.14 × 8.33 | 20.5 × 17.8 × 9.4 | 2.6 / 39 | 0.1–0.3 |
| Prometheus | 42.76 / 43.1 ± 1.2ᵃ | 26.28–72.69 | −72.69..70.02 / −41.73..41.71 / −29.76..29.13 | 67.89 × 40.23 × 28.43 | 68.2 × 41.6 × 28.2 | 7.1 / 178 | 0.2–0.4 |
| Pandora | 40.04 / 40.6 ± 1.5ᵃ | 29.24–56.94 | −56.88..55.48 / −40.87..41.85 / −33.36..32.68 | 51.65 × 39.60 × 31.25 | 52.2 × 40.8 × 31.5 | 5.6 / 61 | 0.2–0.3 |
| Epimetheus | 58.59 / 58.2 ± 1.2ᵃ | 44.30–75.37 | −75.36..70.78 / −58.63..54.18 / −53.27..54.57 | 71.34 × 53.76 × 51.99 | 64.9 × 57.3 × 53.0 | 7.5 / 74 | 0.15–0.3 |
| Janus | 88.98 / 89.2 ± 0.8ᵃ | 67.70–106.79 | −106.73..99.97 / −93.50..96.31 / −78.05..75.19 | 102.23 × 91.74 × 74.64 | 101.7 × 93.0 × 76.3 | 13.8 / 173 | 0.3–1.3 |

ᵃ Thomas et al. 2013 (*Icarus* 226:999, Table 1; its a, b, c are exactly the `moons.json` radii, i.e. pre-2016 limb-fit
ellipsoids). ᵇ Thomas & Helfenstein 2020 (*Icarus* 344:113355) as tabulated by Rambaux et al. 2022 (*A&A* 667:A78).
Best-fit ellipsoid: centre fixed, radial least squares over directions uniform in solid angle (informational).
Uncertainties: the bundle's `<moon>_document.pdf`. All volume-equivalent radii agree with the published means; the
equatorial **ridges reach well beyond the ellipsoids** (Pan 20.4 vs a = 17.2 km, Atlas 24.2 vs 20.5 km), which is why
the far pass bounds with r_max and the cameras use the shape. Epimetheus's model x-extent (146 km) exceeds the 2013
limb-fit a (129.8 km) though volume, b and c agree — the outline is broad, not a few bad vertices; the 2018 model is
used as published. `MoonState.meanRadius` keeps the IAU value (shadow spheres, labels).

**Runtime**: `shapes.json` holds the grid and per moon `offset, count, scaleKm, rMaxKm, rMinKm, slopeOverRmin` (max
arc-length slope of the map over r_min: the Lipschitz bound of |p| − r(p̂), i.e. the sphere-tracing step factor
1/√(1 + (L/r_min)²)) plus the statistics above. `MoonShape` interpolates bilinearly in (lon, lat) exactly as the shader;
the far pass packs radius/r_max and the tangential gradient (central differences; one-sided on an equatorial crest
whose flanks differ by > 20°, so the crest stays sharp — two texture layers, picked by hemisphere) into an RGBA32F
array. Validation against Cassini frames (geometry from the documents' image tables; `scripts/test/specs/moon-shapes.json`):
with the time set so the app's sub-solar W longitude equals the table's, the sub-solar latitude matches to 0.01° for
all 9 frames; the time offsets this needs relative to SCLK ≈ seconds since 1958 UTC grow smoothly from −27 min
(2005) to −70 min (2017), the same for every moon of an epoch (clock drift, not the rotation models). Rotated by the
frames' `noraz`, the renders reproduce the silhouettes and ridge features of N1867606643 (Pan), N1870699307 (Atlas),
N1504613650 (Pandora) and N1575363139 (Epimetheus).

## 7. Reproduce

```sh
node scripts/data/ephemeris/build_sun.mjs                       # Sun table (1 Horizons request)
node scripts/data/moons/build_moons.mjs                         # fits + validation, all moons (~15 min; Horizons cache in data-raw/horizons)
node scripts/data/moons/build_moons.mjs Titan:8 Rhea            #   ... or selected moons (optional table step override)
node scripts/data/moons/assemble_moons.mjs                      # -> public/data/moons/* (+ data-raw/moons_fit/accuracy.md)
node scripts/data/stars/build_stars.mjs                         # -> public/data/stars/*
node scripts/data/textures/download.mjs data-raw/textures/usgs <USGS mosaic URLs>   # asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/...
node scripts/data/textures/download.mjs data-raw/textures/photojournal <assets.science.nasa.gov PIA URLs>
node scripts/data/textures/build_textures.mjs                   # -> public/data/textures/*
node scripts/data/moons/build_shapes.mjs [--profiles]           # PDS shape models -> public/data/moons/shapes.* (downloads to data-raw/moon_shapes/pds, ~15 MB; ~5 s)
node scripts/data/moons/render_shape_model.mjs pan out.png --lat 39.21 --lonW 216.71 --sunLat 26.71 --sunLonW 199.29   # raw-mesh reference render
# runtime verification of the TypeScript modules against fresh Horizons queries:
node_modules/.bin/rolldown scripts/data/moons/verify_runtime.ts --file <tmp>/verify.mjs --format esm --platform node
SV_ROOT=$PWD node <tmp>/verify.mjs
```
Helper/provenance scripts: `probe_spans.mjs` (Horizons coverage), `ssd_tables.mjs`, `fetch_objdata.mjs`,
`explore_batch.mjs` (residual spectra), `daphnis_extrap.mjs` (extrapolation skill), `coorbital_swaps.mjs` (Janus/Epimetheus
swap epochs), `textures/fetch_labels.mjs` (USGS ISIS
labels), `textures/check_phoebe_ticks.mjs`, `textures/list_usgs.mjs`, `textures/scan_pia.mjs`.

## 8. Files and sizes

| file | size | content |
|---|---|---|
| `public/data/moons/moons.json` | 51 KB | catalogue, rotation and orbit models, accuracy |
| `public/data/moons/shapes.json` / `shapes.u16` | 7 KB / 891 KiB | measured shapes of 7 small moons (1° radius maps, uint16) |
| `public/data/moons/moon_tables.i16` | 1.2 MB | element residual tables (int16 × per-field scale) |
| `public/data/moons/moon_tables.f32` | 258 KB | Cartesian residual tables (Phoebe, irregulars) |
| `public/data/moons/hyperion_rotation.f32` | 154 KB | 5500 rotation checkpoints |
| `public/data/ephemeris/sun_from_saturn.json` | ~200 KB | Sun table |
| `public/data/stars/stars.bin` / `.json` | 107 KB / 9 KB | BSC5 |
| `public/data/textures/moons/*.jpg` | 0.3–1.0 MB each, 5.3 MB total | 7 maps |
