# Saturn Ring Particle Simulator — Architecture & Contracts

## Goal (from the user)
A Three.js render of the Saturn system — rings and moons — moving in real time. **The rings matter most.**
Using current knowledge of ring particle sizes, composition, and distribution, the viewer must be able to
put the camera *inside* the rings, co-orbiting with them, and watch the dynamics as they really happen.
Procedural, since we can't simulate every particle. **Absolute realism in size, proportion, and motion
is the priority**; poly count / visual polish may be sacrificed for it. The point is a true sense of the
number, size, distribution, and thickness of the particles — what it would *feel like* to be there.

Implications:
* Everything is at true scale and in SI units: Saturn 60,268 km equatorial radius; the main rings are
  ~10–20 m thick across a 70,000 km span; particles are mm–10 m; Iapetus orbits at 3.56 million km.
* Motion is physical: Keplerian orbits (J2-corrected), Keplerian shear in the rings, epicycles, vertical
  oscillation, real moon ephemerides, Saturn's rotation and winds. Default time = **now, real time (1×)**,
  with warp. At 1× the rings look almost still (mm/s random velocities; 2 cm/s shear 100 m away) —
  that is correct and must not be "spiced up".
* Lighting is physical: solar irradiance at Saturn (~15 W/m²), real Sun direction for the date, Saturn's
  shadow (particles spend ~2 h of every orbit in it), ring self-shadowing, Saturnshine. An auto-exposure
  "camera" maps radiance to the display.

## Running
* `npm run dev` → http://127.0.0.1:5173 (a dev server is usually already running; `npx vite --port 5180` for your own).
* `npm run typecheck` (tsc --noEmit). Keep it clean.
* Screenshots (real GPU, Apple M5 Max via headless Chrome):
  `node scripts/shot.mjs "<url>" <out.png> --until "window.__svReady===true" --wait 3000 [--w 1280 --h 720] [--eval "<js>"]`
  Prints browser console output + page errors (shader compile errors show here). View PNGs with the Read tool.
  Put screenshots in the session scratchpad, not the repo.
* Sandbox pages (`sandbox/*.html`) use `sandbox/common.ts` (`startSandbox`) — see its header for URL camera
  parameters (`cam=orbit|ring|look`, `t=`, `warp=`, `fov=`, `quality=`, `ev=`, `debug=`). `window.__sv`
  exposes `{frame, pipeline, clock, world, anchor, setCamera}`.

## Conventions
* **Units**: meters, seconds, kilograms, radians, W/m², W m⁻² sr⁻¹ everywhere (JS and GLSL). Display
  strings may convert.
* **Time**: `t` = seconds since J2000.0 TDB (JS double). `src/core/time.ts`.
* **Frame (SEF)**: inertial, Saturn-centered; +Z = Saturn's north pole (IAU 2015, J2000, fixed); +X = ascending
  node of Saturn's equator on the ICRF equator. Rings lie in the XY plane, orbit counter-clockwise seen from +Z.
  `src/core/ephemeris.ts` has ICRF↔SEF, Sun vector, Saturn System III rotation angle W.
* **Precision**: JS positions are doubles. **Shaders are camera-relative**: the camera is at the shader
  origin; everything else is `pos_SEF - camPos_SEF` (float32). For precise near-camera ring geometry use the
  local Hill-frame uniforms in `sv_ringProfile` (`ringLocalFromRel`, `ringIdxFromLocal`, …).
* **Local ring frame** (`RingFrame` in `FrameState`, managed by `src/core/RingAnchor.ts`): origin on a
  circular orbit at `r0` with J2-corrected Ω; axes x = radial out, y = prograde azimuthal, z = north.
  A particle with guiding-center offset x drifts at `v_y = -q Ω x` (q ≈ 1.5). `anchorId` increments on
  re-anchoring → consumers re-initialize local state.
* **Moon body frame**: +x = 0° longitude (sub-Saturn point for synchronous moons), +z = north pole,
  +y = 90°E (trailing hemisphere). `MoonState.orient` is body→SEF.
* **Radiance & lighting** (see `sv_lighting`): Lambert surface L = A·E·cos i/π. Volume: dL = σ ϖ₀ P/(4π) E T ds
  with ∫P dΩ = 4π. Ring material phase = `ringPhase(cosα, dust)` = mix(`ringParticlePhase`, `ringDustPhase`).
  Macroscopic particles follow the **power law P = 5.697 (1 − α/π)^3.3** (Dones et al. 1993) with an intrinsic
  opposition surge: real regolith-covered particles back-scatter far more than Lambert spheres (P(0) 5.70 vs
  2.67), and only this reproduces the observed low-phase I/F with the measured albedos. Resolved particles are
  shaded with a **regolith surface law** (`ringRegolithIF`: Hapke 1984 macroscopic roughness θ̄ = 30°, Hapke 2002
  H functions, back-scattering grains ξ = −0.35, grain albedo w from the particle albedo) × a per-particle factor
  f(α) (`nearRegolithFactor`, LUT from `src/render/near/NearRegolith.ts`) that makes each sphere's
  disk-integrated phase function equal `ringParticlePhase` — so an *ensemble of resolved particles has the same
  brightness as the medium* (no seams). The rough regolith sphere alone already has nearly the power law
  (f ≈ 0.96–1.18 for α ≤ 90°; Lambert would need 0.68–2.1). JS mirrors: `src/render/rings/phase.ts` (model 1),
  `far/Ringshine.ts`, `near/NearRegolith.ts` (regolith law, disk integration).
* `FrameState.timeWarp` is 0 while paused.

## Frame flow
`SimClock.tick` → `World.update(frame)` (Sun, Saturn W, moons) → camera rig sets `camPos/camQuat/fovY` and
`RingAnchor.fill(frame.ring, …)` → `updateCameraDerived(frame)` → `Pipeline.render(frame)` (first
`RingStructure.update`: moonlet states, the camera's streamline state; then the local LOD, shared uniforms, passes) → HUD.

## Render pipeline (`src/render/Pipeline.ts`)
| step | pass (file, class) | reads | writes |
|---|---|---|---|
| 0 | clear (internal) | | sceneRT = (0,0,0, SKY_DIST), depth = 1 |
| 1 | **far** `passes/FarFieldPass.ts` `FarFieldPass` | shared uniforms | sceneRT rgb + a(=distance m) + log depth |
| 2 | **near** `passes/NearFieldPass.ts` `NearFieldPass` | sceneRT depth (depth-tested) | sceneRT rgb + a + depth |
| 2b | **overlay** `passes/AstronautPass.ts` `AstronautPass` (`settings.astronaut`) | sceneRT depth, near shadow map (`ctx.nearShadow`), ringshine table (`ctx.ringshineTable`) | sceneRT rgb + a + depth |
| 3 | **rings** `passes/RingLayerPass.ts` `RingLayerPass` | sceneRT (rgb, distance) | hdrRT (radiance) |
| 3b | late HDR hooks (`far/lateHooks.ts`, run at the start of PostPass) | sceneRT.a | hdrRT (additive) |
| 4 | **post** `PostPass.ts` `PostPass` | hdrRT | screen |

* **Astronaut** (`AstronautPass`, geometry/shaders in `src/render/astronaut/`): a procedural EVA-suited figure
  (1.9 m, ~24k triangles, per-vertex material ids) pinned to the camera — body centre at NDC (0.55, −0.3),
  3.75 m away at fov ≥ 60° (farther when needed so it stays fully in view), idle sway on wall-clock time. Opaque
  in sceneRT with per-vertex log depth (cm-sized triangles), so particles occlude / pass through it and the
  medium composites over it. Lighting in physical units with the particles' models: Sun × Saturn / moon
  shadows × ring column toward the Sun (Gaussian layer + wake samples, crossing-point τ; thin sheet far away)
  × the near-field shadow map when it was rendered this frame; diffuse ring light = two-stream field at its
  depth near the rings, `RingshineTable.irradianceVector` far away (blend 2,000–20,000 km); Saturnshine
  (sunlit + ring-lit clouds, ring-attenuated across Saturn's disc); gold visor (GGX glint, Saturn mirrored).
  A second cheap draw writes its visible pixels (fragment distance = sceneRT.a, so not where particles cover it)
  to an R8 mask, shared as `ctx.meterMask` (frame-stamped, with its screen columns) to keep it out of the
  exposure meter.
* Late HDR hooks exist for **sub-pixel sources** (unresolved moons): a single opaque distance per pixel can't
  represent a sub-pixel point in front of the rings, so the far pass registers a hook that adds them to hdrRT
  after the ring layer, with an analytic ring transmission and an occlusion test against sceneRT.a.
* **Moon shapes** (`far/glsl/moons.ts`): triaxial ellipsoids with analytic limb coverage, except the small inner
  moons with measured shapes (`MoonState.shape`, `src/moons/shapes.ts`; data: data-sources.md §6 — Pan, Daphnis,
  Atlas, Prometheus, Pandora, Epimetheus, Janus): `traceShapedMoon` sphere-traces the star-shaped radius map (1°
  lat-lon, bilinear) inside the bounding sphere r_max (step (|p| − r)·Lipschitz factor, floor 0.3 texel / half a
  pixel), refines the hit (guarded secant), takes limb coverage from the closest perpendicular gap or deepest
  penetration in pixels (a ridge in front of the core counts as covered), normals from the interpolated tangential
  gradient field (one-sided on the equatorial ridge crests) and self-shadowing from a soft-shadow march toward the Sun.
  The CPU `MoonShape.radiusAlong` is the same function (camera clearance via `moonSurfaceRadius`); MoonPoints
  integrates unresolved moons over the r_max disk with the same tracer. Debug views `?debug=40..44`: normal,
  self-shadow, cos i, march outcome, external shadows (r Saturn, g moons, b rings). (Debug-view numbers are shared
  by all passes through `settings.debugView`: ring layer 1–12, near field 11–22 and 31–34, far-field moons 40–44.)
* **Auto exposure** (`PostPass`): highlight meter (per-cell peak/extended brightness, Sun excluded, isolated
  point sources ≤ 64× key) for small bright bodies on black sky; when lit material (> 1e-4 W m⁻² sr⁻¹) covers
  most of the frame it blends to the 90th percentile of the lit pixels (interpolated within its half-stop
  histogram bin; highlights may clip ≤ 32×) so the inside of the B ring or an eclipse is exposed like an eye
  would adapt. 0.5 s log-space adaptation; async readback. Camera-pinned overlays (`ctx.meterMask`: the
  astronaut's visible pixels) are metered as the scene they hide — each masked pixel reads the pixel mirrored
  across the nearer side of the overlay's screen box — so the exposure is the same with or without them (glare
  and tone mapping still include them; the suit may clip in full sun).
* **Ring layer** (`RingLayerPass`): analytic sheet in the far field; inside/near the slab
  (|z| < `ringSlabHalfThickness(H)`) an adaptive ray-march (half resolution inside the layer and below 1.5 km,
  depth-validated upsample) using a per-frame 256×64 LUT of the shared `ringExtinction`/`ringLayerTauBeyond`
  (medium = σ_unres). Own τ pyramid storing ⟨e^{−τ/m}⟩ for path factors m = 1…0.008 (exact footprint-averaged
  transmission at any angle), granola-bar wakes in the sheet, a 6-level wake-density clipmap near the camera.
  **Wake representations** (must agree in the mean; `npm run test:seam -- --only handover` compares them with a
  reference explicit field): the march's explicit field (clipmap, ≥ 5 px per wake spacing at the slab crossing),
  its statistical branch and the sheet (two wake columns fB/Wb/Wg; ≤ 2.5 px), blended over 5 → 2.5 px. The sun
  path's wake density is the mean at the shared stratified column nodes (`ringSunNodeRise`); the statistical
  transmission is a per-column Gamma model of the path density with class means/variances/floors measured on the
  live field (path-statistics probe, `uRlKerT/F` vs χ = H|dir·n|/(|dir_z| λ)); the explicit transmission is
  corrected for the clipmap's density prefilter (χ_eff = √(χ² + (0.5 d/λσ̄)²), contrast fade); Saturnshine uses the
  same two columns. Known residual: the clipmap prefilter makes the explicit field's *reflection* 3–20 % too bright
  (the ~4 m wake cores' sub-texel anti-correlation of density and illumination is lost; scripts/test/README.md).
  Sandbox `sandbox/rings.html`: `debug=1–6` visual views, `debug=7–10` raw values, `phase=0` Lambert diagnostics,
  `half=0` full-resolution march, `near=1`/`far=real` to include the other passes; `window.__rl`.

* `sceneRT`: RGBA32F, NEAREST, `.texture.a` = Euclidean distance (m) from camera to the opaque surface
  (`SKY_DIST`=1e30 for sky), with a 24-bit depth texture holding **log depth**:
  `depth = log2(1+w)/log2(1+LOG_DEPTH_FAR)`, w = view-space depth. Fullscreen passes write
  `gl_FragDepth = logDepth01(w)`; rasterized passes set `gl_Position.z = logDepthClipZ(gl_Position.w)`
  (or write gl_FragDepth). Never use three.js' built-in depth conventions.
* `hdrRT`: RGBA32F LINEAR radiance. `PostPass` applies exposure (auto, from `frame.settings`), bloom, ACES, sRGB.
* `renderer.autoClear = false`. Passes render with `RawShaderMaterial` + `glslVersion: GLSL3`.
* Pass interface: `RenderPass { name, enabled, init(ctx), resize?(ctx), update?(frame, ctx), render(frame, ctx), stats?(), dispose? }`.
  Keep each pass's **file path and class name** stable — the app imports them.
* `PipelineContext`: `{ renderer, shared, profile, lod, wakes, structure, sceneRT, hdrRT, width, height }`, plus optional
  shares set by passes for later ones: `nearShadow` (NearFieldPass's sun shadow map: uniforms, the frame it was
  last rendered, `prepare()`), `ringshineTable` (FarFieldPass's ringshine-on-Saturn texture) and `meterMask`
  (AstronautPass's visible pixels for PostPass: texture, frame, screen columns).

### Shared uniforms & GLSL (`src/render/SharedUniforms.ts`, `src/render/shaders/*.glsl`)
Spread `ctx.shared.u` into your material's uniforms; start shaders with `SV_HEADER_ALL` (from `chunks.ts`) or
include the chunks you need, in order: `sv_common`, `sv_saturn`, `sv_ringProfile`, `sv_ringStructure`, `sv_lighting`,
`sv_ringLod`, `sv_wakes`.
* `sv_common`: camera ray `cameraRayDir(uv)`, `viewDepth`, `logDepth01`, `logDepthClipZ`, PCG hashes, value noise/fbm, `erfApprox`; Sun uniforms.
* `sv_saturn`: `saturnIntersect(ro, rd)`, `saturnNormal(pc)`, `saturnSunVisibility(p)` (penumbra).
* `sv_ringProfile`: `RingSample ringSample(r, footprint)` / `ringSampleIdx(idx0, footprint)` (1-D mip
  pyramid: tau, H, Σ, wake, albedo rgb, dust), local Hill-frame helpers, `ringSunTransmission(p, footprint)`.
  This is the **Lagrangian** (unperturbed-streamline) profile τ0(a'); near the camera don't call it directly for
  main-ring optical depth — go through `sv_ringStructure`.
* `sv_ringStructure` (uniforms owned by `src/rings/RingStructure.ts`, CPU mirror `src/rings/streamlines.ts`): the 2-D
  (r, θ, t) structure of the main rings. **Rule: every main-ring τ lookup goes through it** (ring-layer sheet and march,
  near-field presence and culling, the astronaut's ring column). Streamline map r = a' + ξ(a', θ, t), height ζ;
  Eulerian τ = τ0(a') J M with J = 1/(∂r/∂a') (density factor) and M the 2-D modulation hook; a'(r, θ) by Newton
  iteration. All arguments are offsets for float32 precision: `dr` = r − uRingR0 (`ringDrFromLocal`), `dth` = azimuth
  − frame-origin azimuth (`atan(l.y, uRingR0 + l.x)`), `fp` = radial footprint (m).
  `RingStream ringStream(dr, dth, fp)` → `.da` (a' − r), `.J`, `.tauMod`, `.daGrad` (for caching);
  `ringStreamRelief(dr, dth, fp)` adds `.zeta` (mid-plane height of the material, m) and `.slope` (∂ζ/∂r, ∂ζ/(r∂θ));
  `vec3 ringStreamXi(aL, dth, fp)` = (ξ, ζ, J) at a Lagrangian offset aL = a' − r0 (the near field displaces its
  particles, which carry a'); `RingSample ringSampleStream(dr, dth, fp)` / `ringSampleLocal(l, fp)` = THE lookup
  (profile at a', τ and Σ × J × M, footprint × J); `ringSampleLagrangian(aL, fp)`; `ringSampleIdxPrecise(I, sub, fp)`
  (integer + fraction index: `uRingIdx0 + dr/uRingDr0` rounds to 7.8 m in the outer A ring, which stair-steps
  displaced edges; the ring layer has the same as `rlSampleP`); `ringSunTransmissionStream(p, fp)`. Hooks for later
  work packages, identity now: `ringStructureRelief(aL, dth)` → (height, ∂/∂a', ∂/∂S) (bending waves, B-ring-edge
  structures, relief sources) and `ringStructureTauMod(aL, dth)` (azimuthal texture, propellers). Sources now: the
  moonlets Pan and Daphnis (Hill-problem response table, `public/data/rings/moonlet_response.*`) and the normal modes
  of eccentric edges (`src/rings/ringModes.ts` `EDGE_FEATURES`: the B-ring outer edge's four modes; uniforms
  `uRsMode[8]` = (A, m(φ0 − ϖ(t)), m, 1/L), `uRsModeF[8]` feature index, `uRsFeat[2]` = (a_edge − r0, material side,
  1/gap, reach)). The camera's
  streamline state is `uRsCam` = (ξ, ζ, J, near-field zone flag). Far-field shaders (`src/render/far/**`) include
  only `sv_ringProfile` (km-scale edge waves are below their footprints).
* `sv_lighting`: `phaseLambertSphere`, `phaseHG`, `ringPhase(cosα, dust)`, `ringParticleSurge(α)`,
  `ringRegolithIF(μ0, μ, cos g, w)` (resolved particles; CPU mirror `near/NearRegolith.ts`),
  `extendedSourceCosine(cosθ, sin σ)` (incidence cosine of an extended spherical source), `saturnshine(p, out dir)`,
  `diskOverlapFraction`, `moonsSunVisibility(p, skip)`, `sunVisibility(p)`; moon spheres `uMoonPosR[32]`.
* `sv_ringLod` (mirror of `src/rings/RingLod.ts`): 14 octave size classes from 1 mm, `lodCarryParticle(a,k,s,dz)`
  (one particle's draw probability: count contract, display pixels via `uLodPixelAngle`), `lodCarry(a,k,s,dz)`
  (the share of class k the medium leaves out: exact class mean of the former; `a` unused), `ringExtinction(s, z, tau, H, W, out sigTot, out
  sigUnres)`, `ringLayerTauBeyond(z, tau, H, dirSign)`, `ringSlabHalfThickness(H)`, `ringLayerProfile`,
  `ringLayerColumn`, `ringLayerSegmentTau`, `ringColumnCentroid(qa, qb)` (column-centroid table `uLodColC` of the
  total profile, `RingLod.columnCentroidTable`) and `ringSunNodeRise(j, qs, hp)`: the `LOD_SUN_NODES` (6)
  stratified nodes along the sun path at which every pass averages the wake density (march, particles, astronaut;
  2 fixed nodes overestimated the sunlight by 15–26 % at 8° sun through the convexity of exp(−τWs/μ0)). The part of
  τ in particles below 1 mm (true dust: D ring, gaps,
  F/G/E rings, Roche Division) is a never-drawn layer (`uLodTauSub`, σ_z = `uLodSigZSub`) included in all of
  these, so the medium total always equals the local τ. The top class absorbs any aMax > 16.4 m.
* `sv_wakes` (mirror of `src/rings/WakeField.ts`): `wakeDisplacement(q)`, `wakeDensity(x)` (local frame, m;
  range [γ^s, γ^−s]; mean 1: the single-branch inverse `wakeDensityRaw` misses the folds of the forward map in the
  wake cores, ~10 % of the mass, restored by scaling the excess over 1 with `uWakeMassK`, measured live by the
  ring-layer pass), `wakeDensityFiltered(x, footprint)`, `wakeMinDensity()`. Two transient sheared
  generations (`uWakeGen[0..1]` = amplitude, shear, offsets; sin² envelopes, lifetime 3/Ω), narrow-band random
  fields with phase dislocations and a non-shell-crossing profile (`uWakeShape` = ln γ, 1/Rc², Wmin, Wmax).
  Spacing at peak = Toomre λ (≈ 40 m mid-A, 51–55 m in B), pitch ≈ 20° trailing; contrast γ = 0.16 (A), 0.24 (B);
  no wakes in the C ring / Cassini Division.
* **Near-field photometry contract** (`NearFieldPass`): sub-pixel particles use `ringParticlePhase`; resolved
  ones the regolith law `ringRegolithIF` per pixel × `nearRegolithFactor` per particle (the Sun at the particle's
  phase angle; Saturnshine likewise at Saturn's centre direction, with `extendedSourceCosine` for its ~55° disc),
  at every particle quality. The factor LUT (`NearRegolith.ts`, RGBA32F 64 phase angles × 32 albedo rows, built at
  start-up in ~130 ms) is f(α) = P_power(α) / (4 Φ_w(α)), Φ_w = the regolith sphere's disk integral (Gauss-Legendre
  24 × 12 in photometric coordinates); the narrow surge is multiplied in GLSL; w per row inverts the regolith
  sphere's spherical albedo A_s(w) = A. At high quality the resolved relief (normals, self-shadowing) would change
  the disk-integrated brightness (× 0.75 at 120° for a ray-marched clumpy boulder: resolved roughness the power
  law already contains), so the Sun factor is also multiplied by `nearReliefPhotFix` (table `RELIEF_PHOT` in
  `NearRelief.ts`, measured by a CPU ray tracer mirroring the fragment shader). Diffuse ring light stays
  cosine-weighted (a near-isotropic field, as in the medium). Multiple scattering by the same two-stream solution
  as the medium with `phaseTables(1)` back-scatter fractions; shadow hiding exp(b·min(τ_sun, τ_view)) on the
  statistical part of the sun path; the sun path through the layer samples the wake density at the same two points
  the medium uses; a 2048×1024 sun-aligned shadow map resolves particle-on-particle shadows near the camera (the
  statistical transmission keeps only what the map cannot resolve). `scripts/test/particles.mjs` checks the GLSL
  against the CPU mirrors and the LUT / relief contracts.
* **Near-field frame and contact contract** (`NearFieldPass`, `near/NearContact.ts`). Steps: (1) the update pass
  writes every particle's analytic position (exact Hill-frame orbit + wake + streamline displacement) and flag into
  R0 (RGBA32F per slot: camera-relative xyz, w = +a drawn / −a present but not drawn / 0 absent); (1b) **contact
  resolution** pushes the visibly resolved particles out of each other's overlaps and writes their positions back
  into R0; (2) HistoPyramid compaction of R0 into the point / quad / caster lists; (3) the sun shadow map (shared
  as `ctx.nearShadow`); (4) the draw. Everything after 1b sees the same positions. The contract of 1b:
  - *who*: present particles (drawn or not) weighted by smooth fades — resolved (3 → 6 render px radius: an overlap
    is typically ~0.3 of the smaller radius deep, about a pixel at 3 px), not statistically occluded (slab
    line-of-sight τ 4 → 5 with a conservative path τ, as the update pass's cull), near the view frustum (dilated by
    two contact distances, the reach of a push; within R0's out-of-view coverage rb + mw), and not around the camera
    (a body containing the camera is not drawn — the camera is a ghost — so it must not push its neighbours out of
    an empty hollow; fading over d/ρ 1 → 1.15). A pair is corrected with the smaller weight, so every correction
    fades in continuously.
  - *contact distance*: the sum of the drawn base shapes' radial extents along the centre line,
    ρ = a / √(nᵀM′n), M′ = R diag(1/shape²) Rᵀ (`nearShape` / `nearOrientation`: ellipsoids at high quality,
    spheres otherwise); the high-quality relief (±~0.1 a) interlocks with the neighbour's.
  - *solver*: per round (3) a hash grid (one level per size class, 16-entry buckets built in one stencil-routed
    point pass: deterministic, no atomics), an 8-neighbour list per particle (smallest normalized surface gaps),
    then 4 Jacobi iterations with constraint averaging (12 in all): mass-weighted shares (∝ a³) within a size
    class, the smaller particle yields entirely across classes; a small particle lying entirely inside a larger
    one is hidden and left alone (ejecting it would cascade).
  - *bounds*: |x − x_analytic| ≤ 4 D_i (D_i = the particle's largest initial pair correction, raised by contacts
    that appear later only up to 0.5 a): no particle moves farther than overlaps require. Presence is never
    changed; drawn flags are kept, except that a present particle moved into the view frustum becomes drawn
    (count contract); the medium is untouched (it is statistical).
  - *time*: no per-particle state — a deterministic function of the frame's analytic positions (bit-identical
    frames when paused; time warp, reverse time and re-anchoring need nothing).
  - *photometry*: particles that no longer interpenetrate block more light than independently placed ones of the
    same τ (the hard-particle / filling-factor effect, which the medium's Poisson statistics leave out), so near the
    camera the near field is slightly brighter than the medium it hands over to: +0.3 … +3.6 % per strip 30 m above
    the A ring (`test:seam` a-ring-30m).
  `npm run test:contact` checks it against an independent CPU pair search (measured values: scripts/test/README.md).

## The ring model (physics)
* **Radial profile** (`src/rings/RingProfile.ts`): 0.25 km grid, 66,000–139,500 km. Optical depth from
  Cassini occultation data if present, else procedural. Other quantities from the zone table
  `src/rings/ringRegions.ts` (q, aMin, aMax, H, Σ/τ, albedo, wake, dust). Around eccentric edges with normal modes
  (`EDGE_FEATURES`) the 2005 snapshot is de-projected at load time to mean (Lagrangian) radii
  (`RingProfile.deprojectSnapshot`); the live modes move them back (`sv_ringStructure`). ring-physics.md §9.
* **Particles** (near field): power-law sizes dN/da ∝ a^-q in [aMin, aMax] with column density fixed by τ;
  14 octave classes from 1 mm (zones with aMin < 1 cm draw their mm particles where they are ≥ 1 px, i.e. within
  a few metres). Vertical Gaussian, std = `sigZFrac(a)·H` (small particles ride higher).
  Kinematics in the Hill frame (exact linear solution): guiding center x_g, y_g(t) = y_g0 − qΩx_g t;
  epicycle x = x_g + A cos(κt+φ), y = … − 2A(Ω/κ) sin(κt+φ); vertical z = B cos(νt+ψ);
  plus wake displacement `wakeDisplacement(guidingCenter)`. These orbits are independent, so neighbours would
  interpenetrate (B-ring mid-plane volume filling ~0.3–0.4); the visibly resolved ones are then moved apart per
  frame (`NearContact`, the near-field contact contract above) — geometry only, no collisional dynamics.
* **Count contract** (`RingLod`, `sv_ringLod`): every particle whose apparent diameter is ≥ 1 *display*
  pixel (ρ = a/(s·displayPixelAngle) ≥ 0.5 px; `FrameState.canvasPixelAngle`) is drawn individually at its true
  position and size — no thinning, no user-controlled count reduction; the render scale changes how particles
  are rasterized, never which ones are drawn. Below 1 px a narrow handover: the near field draws a particle
  with probability `lodCarryParticle` = smoothstep(0.4, 0.5, ρ), and the medium leaves out exactly the
  cross-section-weighted mean of that over each size class's radii (`lodCarry`, used by `ringExtinction` for
  σ_unres and by the sheet; closed form + 3-point Gauss-Legendre, so no size-within-class approximation).
  Particles smaller than half a *render* pixel are opaque discs of half a render pixel rasterized with
  probability (ρ_render/0.5)²·lodCarryParticle (stable per-particle threshold: expected coverage = true
  coverage, and the ring layer's march still stops at them). `particleQuality` (high/medium/low) only
  changes the rendering: relief-displaced ellipsoids + profiled shadow map / spheres + shadow map / spheres,
  statistical shadows (the regolith photometry is the same at every quality).
* **Particle shapes and spin** (`nearCommon.glsl`): triaxial ellipsoids (`nearShape`, ⟨projected area⟩ = πa²) in
  **principal-axis rotation** about their short axis (`nearOrientation`: spin axis near the orbit normal for large
  particles, random for small ones; a commented hook marks where a tidal-alignment term would go — not active:
  it makes the cross-section direction-dependent, an LOD-contract change). A body spinning about its short axis
  shows more area along the spin axis than across it, so the asphericity of the spin-aligned (large) particles is
  reduced (`NR_ISO` 0.8): their mean cross-section is 0.987–1.026 πa² from edge-on to face-on (1.14 face-on with
  the full shape spread). At high quality the surface is r(u) = κ(1 + amp·h(u)) in the axis-scaled body frame:
  `nearRelief` = gradient-noise irregularity + two cellular "clast" layers (sub-aggregates, union-of-spheres domes;
  weight 0 below ~10 cm to 1 above ~0.7 m) + finer layers; ray-marched (sphere tracing on value-only R16F
  textures, exact depth, soft self-shadowing) above `NR_PX0`–`NR_PX1` = 12–22 render px radius (amp fades in),
  below that the analytic ellipsoid with the relief as normal perturbation; absolute-scale regolith texture (4 cm
  pebbles, 8 mm grain clumps) on the shading normal where resolved. κ(amp, wc) keeps ⟨projected area⟩ = πa²
  (fit in `NR_K0..3`, residual ≤ 0.6%, `NearRelief.ts` measures it from the outline radius ρ(φ) of the projection).
  Shadow-map casters store a 24-sample outline profile ρ(φ) (second RGBA32UI attachment, `NEAR_SHADOW_PROFILE`
  lookups) so shadows follow the relief; the astronaut's lookups keep the plain ellipses.
* **Allocation** (`RingLod.configure`): each particle of radius a lives in its own shearing-periodic box of
  half-size D(a) = min(√((c·a)² − dz²), box[k]), c = 1.25/(displayPixelAngle·0.4): the horizontal distance at
  which it falls below the handover band (with zoom headroom) from the lowest camera height served (dz above
  the slab; 0 normally), so nothing is simulated where it could not be drawn; radii within a class are sampled
  from n(a)·D(a)² (≤ 6 power-law pieces, box a power of a on each: ~1% over the exact D), boxes up to 60 km
  (10 m boulders are ≥ 1 px out to ~20 km at 1080p), each class generated at the max τ over its own box.
  Independent of the camera position (particles persist while flying) unless the total exceeds the 12M-slot
  cap (dense B ring, ~46M): then it is fitted to the camera height h (valid for [h/1.5, 1.5h], re-fit
  outside); above the layer the zoom-in margin and the band below h are given up first (down to 1.07× / 1.13×:
  they hold nothing drawn now, but re-fits come sooner), only then are the largest boxes clipped at a common
  radius; the stats report the visibility-weighted deficit (~0 inside the B ring, where the layer hides
  everything farther; B ring at 1080p: complete from ≥ 700 m above, ~3–30% short at 50–500 m). Vertical
  visibility is not used to thin it: every particle crosses the mid-plane, and wake gaps leave even the B ring
  at τ ~ 1. The near field is active while the camera is within the largest particles' reach. Seeds depend on
  the anchor id and class only; classes whose allocation is unchanged keep their particles across re-fits.
* **Wakes** (`WakeField`): Toomre λ = 4π²GΣ/κ², pitch ≈ 20° trailing, transient sheared generations.
* **2-D structure** (`RingStructure`, `sv_ringStructure`): the profile is the Lagrangian τ0(a'); a streamline map
  r = a' + ξ(a', θ, t), ζ(a', θ, t) gives the Eulerian τ = τ0(a') J (J = 1/(∂r/∂a'), surface-density conservation)
  for every renderer. Moonlet edge waves: the universal Hill-problem response (Hénon & Petit 1986 units) of a
  particle passing the moonlet at b = |a' − a_moon| / r_H, tabulated by `scripts/data/rings/moonlet_response.mjs`
  (b 2.5–30, Hill time −30…72 from conjunction), with the moonlet's live radius at conjunction (its epicycle) and its
  vertical phase (linear vertical response). Collisional damping over 4 wavelengths and a streamline-crossing limiter
  are baked into the table; J is clamped at ≤ 5. **Near field:** the particle boxes are Lagrangian — the guiding
  centre is a', presence is tested at τ0(a'), the particle is drawn displaced by ξ(a') − ξ_cam, and the box
  is centred on the camera's Lagrangian position (`uRsCam.x`, `NearFieldPass` uCamOff); the local LOD is configured at
  the camera's Lagrangian radius (`Pipeline.updateLocalRing`), with the boxes' τ_max taken over the drift the map can
  cause under a co-orbiting camera (`RingStructure.maxDisplacementNear`), re-fitted on 1 km of camera travel, when the
  material under the camera changes (ring ↔ gap) or after 20 km of Lagrangian drift. ζ is computed and exposed (`ringStreamRelief`,
  `ringStreamXi`), not yet rendered geometrically (relief work package). Details and numbers: ring-physics.md §8.
* **Outer rings**: F ring (eccentric, a = 140,221 km), G, E (vertical torus around Enceladus), D — analytic
  in the ring-layer pass (`OUTER_RINGS` in `ringRegions.ts`).

## Data formats (`public/data/…`)
* `rings/tau_main.json` + `rings/tau_main.f32`: `{ source, r0_km, dr_km, n, notes }` + n little-endian
  float32 normal optical depths at r = r0_km + i·dr_km. NaN allowed = no data (procedural used there).
* `rings/moonlet_response.json` + `.f32` (`scripts/data/rings/moonlet_response.mjs`): `{ bLo, bHi, nb, t0, t1, dt, nt,
  envelope, moonlets: [{ id, name, gmKm3s2, aKm, rHillKm }], asymptotic, checks }` + float32 [3 groups][nb][nt][4]
  (texture width nt, height 3 nb): K = b²ξ/r_H, Wc = b³z_c, Ws = b³z_s, each (F, ∂F/∂t, ∂F/∂b, ∂²F/∂b∂t) for bicubic
  Hermite interpolation; b log-spaced, t = Hill time since conjunction (> 0 downstream).
* `ephemeris/sun_from_saturn.json`: `{ frame:"ICRF", center:"699", target:"10", start_jd_tdb, step_days, pos_km:[x0,y0,z0,…] }`.
* `moons/…`, `stars/…`, `textures/…`: defined by the moons/sky data agent (documented in `docs/data-sources.md`).

## The app (`src/app/**`, `src/camera/**`, `src/ui/**`)
* `App.ts` frame loop; `passes.ts` loads each pass by dynamic import inside a `GuardedPass` (a throw in
  import/init/update/render disables the pass and falls back to `passes/stubs/*`, or a minimal tone mapper for
  post; `renderer.debug.onShaderError` names the offending pass and GLSL lines).
* Resolution: the canvas runs at devicePixelRatio capped to ~2.4 MP; the pipeline renders at
  `renderScale` × that (default 0.5) and PostPass's final pass upsamples hdrRT bilinearly to the canvas.
  The frame loop skips display refreshes to honour `AppSettings.maxFps` (default 30; 0 = uncapped).
* URL parameters: `preset` (place id), `t` (ISO or `now`), `warp`, `paused`, `fov`, `quality` (high|medium|low), `scale`, `fps`, `ev`,
  `exposure`, `bloom`, `wakes`/`dustRings`/`stars`/`labels`/`nearField`/`astronaut`/`hud`, `debug`, and the sandbox-style
  `cam=orbit|ring|look` parameters.
* Test hooks: `window.__sv = { app, frame, pipeline, clock, world, renderer, camera, anchor, presets,
  goto(name, {instant}), setTime(iso), setWarp(n), info(), toggleCoorbit(), toggleBallistic(), flyTo(name) }`;
  `window.__svReady` becomes true 8 frames after the loading screen hides. `sandbox/app.html` = the app on stub
  passes. Batch screenshots: `node scripts/shots.mjs <spec.json> <outDir>` (format in its header).

## Stub passes
`src/render/passes/stubs/*` (`FarFieldStub`, `RingLayerStub`) are minimal, dependency-free versions of the far
and ring-layer passes. The app falls back to them when a real pass fails (`GuardedPass`), and sandbox pages can
use them to test one subsystem in isolation. Task → file map: `CLAUDE.md`.
