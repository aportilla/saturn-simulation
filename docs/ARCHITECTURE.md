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
`RingStructure.update`: moonlet states, the camera's streamline state; then the local LOD, shared uniforms, the
modulation cache `ModClipmap` (stale levels re-rendered), passes) → HUD.

## Render pipeline (`src/render/Pipeline.ts`)
| step | pass (file, class) | reads | writes |
|---|---|---|---|
| 0 | clear (internal) | | sceneRT = (0,0,0, SKY_DIST), depth = 1 |
| 1 | **far** `passes/FarFieldPass.ts` `FarFieldPass` | shared uniforms | sceneRT rgb + a(=distance m) + log depth |
| 2 | **near** `passes/NearFieldPass.ts` `NearFieldPass` | sceneRT depth (depth-tested) | sceneRT rgb + a + depth |
| 2a | **bodies** `passes/PropellerMoonletPass.ts` `PropellerMoonletPass` (propeller moonlets ≥ 0.25 px) | sceneRT depth | sceneRT rgb + a + depth; shadow spheres `uShadowSph` |
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
  by all passes through `settings.debugView`: ring layer 1–12 and 23–26 (relief), near field 11–22 and 31–34,
  far-field moons 40–44, propeller moonlets 45 = normals.)
* **Propeller moonlets** (`PropellerMoonletPass`, shaders `src/render/propellers/`): the bodies of the propellers'
  moonlets (named giants and the hash-grid belts, `src/rings/propellers.ts`) — the MAX_MOONS (32) sphere list can't
  hold them. Every 30 frames (or after the camera moved > max(0.1 |z|, 2 km)) the CPU mirror lists the moonlets within
  3,000 km that are ≥ 0.25 display px; each frame they are positioned at their live radius / longitude (and vertical
  phase), frustum-culled, sorted and drawn as instanced boxes ray-traced as ellipsoids (Hill-lobe proportions
  1 : 0.667 : 0.638 scaled to the moonlet radius, long axis toward Saturn, low-frequency relief on the normal),
  `gl_FragDepth` = log depth. Lit with the regolith law × the factor LUT at the body's phase angle, Saturn's and the
  moons' shadows, the ring column toward the Sun and Saturn, the two-stream diffuse ring light and Saturnshine. The
  8 nearest are published as shadow spheres (`uShadowSph`, `sv_lighting`) for the medium and the astronaut.
* **Auto exposure** (`PostPass`): highlight meter (per-cell peak/extended brightness, Sun excluded, isolated
  point sources ≤ 64× key) for small bright bodies on black sky; when lit material (> 1e-4 W m⁻² sr⁻¹) covers
  most of the frame it blends to the 90th percentile of the lit pixels (interpolated within its half-stop
  histogram bin; highlights may clip ≤ 32×) so the inside of the B ring or an eclipse is exposed like an eye
  would adapt. 0.5 s log-space adaptation; async readback. Camera-pinned overlays (`ctx.meterMask`: the
  astronaut's visible pixels) are metered as the scene they hide — each masked pixel reads the pixel mirrored
  across the nearer side of the overlay's screen box — so the exposure is the same with or without them (glare
  and tone mapping still include them; the suit may clip in full sun).
* **Ring layer** (`RingLayerPass`): analytic sheet in the far field; inside/near the slab
  (|z| < `ringSlabHalfThickness(H)`, heights above the local mid-plane) an adaptive ray-march (half resolution inside
  the layer and below 1.5 km, depth-validated upsample; where relief is near, blocks whose transmissions differ by > 0.5
  — the layer's edge against the sky over a tilted mid-plane — are marched at full resolution) using a per-frame
  vertical-structure LUT of the shared `ringLodChannels` (medium = σ_unres): 512 heights (asinh-spaced, u = z/H =
  0.25 sinh t, out to the slab `uLodSlabK`) × 64 log distances × 3 bands — participating classes (density, unresolved,
  column above, aligned share), all classes (the same), along the Sun (Sun-weighted columns) — so the march applies the
  wake density and the packing ceiling to the participating band only (z/m) and the spin-aligned anisotropy to the
  aligned channels. Own τ pyramid storing ⟨e^{−τ/m}⟩ for path factors m = 1…0.008 (exact footprint-averaged
  transmission at any angle) in two halves: τ_dyn (the medium's extinction with wakes) and τ_iso (wakes off, and the
  two-stream layer; `uRlTauHalf` / `uRlIsoHalf`); its wake channel is wake × p̄. Granola-bar wakes in the sheet, a
  6-level wake-density clipmap near the camera. The multiply-scattered source is the two-stream (τ_iso) source per
  unit of the medium's τ in the march, the sheet and for the particles; the sheet's Saturnshine beams take no
  shadow-hiding surge (an extended source: ring-physics.md §10.12).
  **Wake representations** (must agree in the mean; `npm run test:seam -- --only handover` compares them with a
  reference explicit field): the march's explicit field (clipmap, ≥ 5 px per wake spacing at the slab crossing),
  its statistical branch and the sheet (two wake columns fB/Wb/Wg; ≤ 2.5 px), blended over 5 → 2.5 px. The sun
  path's wake density is the mean at the shared stratified column nodes (`ringSunNodeRise`); the statistical
  transmission is a per-column Gamma model of the path density with class means/variances/floors measured on the
  live field (path-statistics probe every 60 frames and on re-anchoring, `uRlKerT/F` vs χ = H|dir·n|/(|dir_z| λ); read
  back asynchronously through pixel-pack buffers + a fence, applied a frame or two later); the explicit transmission is
  corrected for the clipmap's density prefilter (χ_eff = √(χ² + (0.5 d/λσ̄)²), contrast fade); Saturnshine uses the
  same two columns. `npm run test:seam -- --only base` checks the two representations' base radiative transfer with
  the wakes off. Known residuals (scripts/test/README.md): the prefilter correction overshoots the B ring's
  transmission (+17 % in T over the reference field at τ ≈ 4; `test:lod`); across the wakes at high phase the
  sheet's reflection is up to 4 % above the march's statistics.
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
* `PipelineContext`: `{ renderer, shared, profile, lod, wakes, structure, modClip, sceneRT, hdrRT, width, height }`, plus
  optional shares set by passes for later ones: `nearShadow` (NearFieldPass's sun shadow map: uniforms, the frame it was
  last rendered, `prepare()`), `ringshineTable` (FarFieldPass's ringshine-on-Saturn texture), `meterMask`
  (AstronautPass's visible pixels for PostPass: texture, frame, screen columns) and `wakeClip` (RingLayerPass's wake-density
  clipmap: texture, level states as rendered, level count — read by the near field before the ring layer refreshes it:
  the occlusion cull's line-of-sight wake density and the particles' sun-path nodes). `modClip` (`ModClipmap`, owned by
  the pipeline, rendered before any pass): the cache of the 2-D modulation around the camera (`sv_ringModClip`, below).

### Shared uniforms & GLSL (`src/render/SharedUniforms.ts`, `src/render/shaders/*.glsl`)
Spread `ctx.shared.u` into your material's uniforms; start shaders with `SV_HEADER_ALL` (from `chunks.ts`) or
include the chunks you need, in order: `sv_common`, `sv_saturn`, `sv_ringProfile`, `sv_ringRelief`, `sv_ringStructure`,
`sv_ringReliefShade`, `sv_lighting`, `sv_ringLod`, `sv_wakes` (`sv_ringRelief` holds the relief sources that
`sv_ringStructure`'s hooks call; `sv_ringReliefShade` the consumers' helpers that need the streamline map).
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
  `RingStream ringStream(dr, dth, fp)` → `.da` (a' − r), `.J`, `.tauMod` (M at the footprint), `.tauVar` (variance of
  M below the footprint), `.wakeMod` (self-gravity-wake strength factor, < 1 in material stirred by a propeller
  moonlet), `.daGrad` (for caching);
  `ringStreamRelief(dr, dth, fp)` adds `.zeta` (mid-plane height of the material, m) and `.slope` (∂ζ/∂r, ∂ζ/(r∂θ));
  `vec3 ringStreamXi(aL, dth, fp)` = (ξ, ζ, J) at a Lagrangian offset aL = a' − r0 (the near field displaces its
  particles, which carry a'); `RingSample ringSampleStream(dr, dth, fp)` / `ringSampleLocal(l, fp)` = the lighting lookup
  (profile at a', τ and Σ × J × the LIGHT part of M, below; footprint × J); `ringSampleLagrangian(aL, fp)`; `ringSampleIdxPrecise(I, sub, fp)`
  (integer + fraction index: `uRingIdx0 + dr/uRingDr0` rounds to 7.8 m in the outer A ring, which stair-steps
  displaced edges; the ring layer has the same as `rlSampleP`); `ringSunTransmissionStream(p, fp)`. Hooks (one
  function per source, so work packages fill different functions): `ringStructureRelief(aL, dth, fp)` → (height,
  ∂/∂a', ∂/∂S) = `rsReliefWaves` (bending waves, the C-ring corrugation) + `rsReliefSites` (B-ring-edge region A,
  S/2009 S1) (both chunk `sv_ringRelief`, included before `sv_ringStructure`) + `rsReliefPropellers(aL, dth, fp)` (the
  sunlit half of the propellers' stirred-region thickening, prefiltered to fp; `#define RS_PROPELLER_RELIEF`, CPU
  `PROPELLER_RELIEF` in RingStructure.ts; `gRsPropRelief = false` leaves it out of one lookup). **Currently OFF**
  (both switches): with the packed-layer photometry of the N-body size rules, the sheet and the march disagree by up
  to 15 % in a view across a propeller belt (`test:seam` base / handover `a-1km-yaw120`), it costs +13–17 ms at
  `a-ring-1km`, and it changes the Cassini propeller comparisons by only 0.1–0.5 %; `test:relief` skips its propeller
  checks while it is off (`structure.propellerRelief`). Everything below holds when it is switched on. It is in the relief
  bounds (`ringReliefBound(dr, fp, proc)` / `rpReliefBound`; CPU: `uRpTF.w` = `PropellerSystem.nearReliefBound` near
  the camera, added to `reliefBoundCam` / `uRrCamN`), the relief shadows (`ringReliefSunVis` → `rpReliefSunVis`:
  opaque prefiltered ridges, the giants with a reach extended by their shadow length) and the near field's heights;
  the sheet's ray / surface search leaves the procedural propellers out (`gRpProcRelief = false`: ≤ 160 m, the hit
  then evaluates them). Cost: `rsInvert` sets `gRpAlsoRelief` when it wants ζ, so `rsPropellersMod` enumerates the
  τ factor and the relief in ONE pass (`rpEnumerate` mode 3, result cached in `gRpRel` for `rsReliefPropellers` at
  the same (aL, dth, fp)); a relief lookup also lists the procedural propellers it found (`gRpList*`, ≤ 6) and
  `rpReliefSunVis` at the same point reuses that list instead of a third enumeration; classes whose prefiltered
  relief is < 0.5 m (or whose shadow is < half a footprint) are skipped; `nearUpdate.glsl` takes the relief from the
  presence lookup's enumeration (mode 3) after the presence test, so absent particles pay nothing;
  `vec3 ringStructureMod(aL, dth, fp)` → (mean M, variance of M below the footprint, wake factor) combines
  `rsTauModTexture` (chunk `sv_ringTexture`, `src/render/shaders/ringTexture.glsl`, CPU `src/rings/ringTexture.ts`:
  the sub-km 2-D sheared texture) and `rsPropellersMod` (chunk `sv_ringPropellers`, `ringPropellers.glsl`, CPU
  `src/rings/propellers.ts`) as a product of independent factors (mean m_a m_b, variance v_a m_b² + v_b m_a² +
  v_a v_b); `ringStructureTauModStat` = its (mean, variance), `ringStructureTauMod` = the mean. Both chunks are
  `#include`d inside `sv_ringStructure` (three.js resolves nested includes; they use `rsTab`, declared by prototype
  and defined later in the same chunk). Consumers: the sheet folds (m, v) into its τ pyramid
  (`rlApplyTauMod`: transmission-preserving, second-order cumulants with a 3σ floor) and scales its wakes by the
  wake factor; the march evaluates the texture per step at its footprint and caches the propeller term
  (refreshed after 4 m radial / 16 m azimuthal travel or a 2× footprint change), mixing its explicit and statistical
  wakes toward 1 by the wake factor; the near field multiplies presence by M at the particle's guiding centre
  (`fp` = 0) and its wake displacement by the wake factor (`nearUpdate.glsl`). **Cost rules** (the propellers'
  hash-grid enumeration is ~1,500 operations per lookup): `rsInvert` takes a modulation mode — `ringStream` /
  `ringStreamRelief` FULL (the sheet's final hit), `ringStreamMap` NONE (the march applies M per step itself, the
  propellers cached over 4 m radially / 16 m along the orbit), `ringStreamReliefGeom` NONE + relief (the sheet's
  ray / surface hit iterations, object heights), and `ringSampleStream` / `ringSampleLocal` / `ringSampleLocalRelief`
  (lighting and occlusion lookups, called per vertex by the particles, the astronaut and the moonlet bodies) LIGHT =
  none by default (`#define RS_LIGHT_TEXTURE` adds the texture at ≥ 64 m): the particles' number follows M, their
  lighting column is the undisturbed one. **Modulation cache** (`sv_ringModClip`, included at the end of
  `sv_ringStructure`; `src/render/rings/ModClipmap.ts`, `ctx.modClip`): (M, wake factor) = `ringStructureMod(aL, dth,
  fp).xz` on a camera-centred clipmap in Lagrangian polar coordinates (aL, S = r0 dth): levels of 512 × 128 texels of
  dr × 4 dr (the texture's and the propellers' structures are 5–10× longer along the orbit), dr = 1 m · 2^k, centred on
  the camera's Lagrangian position, up to 9 levels (the largest particle box × 1.5 + 600 m), RGBA32F, bilinear; texels
  prefiltered at fp = dr (identical to M at fp = 0 for dr ≤ 4 m — every texture octave resolved, the finest fades above
  5.2 m — a mean-preserving smoothing of sub-texel structure beyond); a point blends into the next level over the outer
  20 % of its level. Refreshed incrementally like the wake clipmap (anchor, model switches `texture.amp` /
  `propellers.scale`, recentring by 1/16 of a level, the pattern's drift of 1/8 azimuthal texel: shear up to the level's
  edge, propellers 4.7 km beyond; ≤ 3 levels per frame). `rsModCached(aL, S, out mw)` (false where no valid level
  covers the point: evaluate directly), `rsModCachedFine(aL, S, fpMax, out mw)` (only levels with texels ≤ fpMax). The
  near field's presence reads it (one bilinear lookup instead of the texture's 12 noise lookups + the propellers'
  enumeration per candidate slot — the candidates are a few % of the slots, scattered at random, so most SIMD groups paid
  the full evaluation); where no level covers a guiding centre it is evaluated directly, the propellers only for
  particles that may be drawn and in the size classes a propeller can reach this frame (`uRpNearMask`,
  `PropellerSystem.nearClassMask`, exact); shadow casters outside the view then take the texture only (shadow fidelity).
  The march reads it where its footprint and the cache's texels are ≤ 4 m (`RL_MC_FP`, near the camera). Its block
  maxima (16 × 16 texels + a one-texel ring, read back asynchronously) bound M over a particle box: the allocation bound
  below (`ModClipmap.maxNear`). Measured (test:propellers, cache section): texels = the CPU mirror to ≤ 1e-3 (float32),
  0.4–1 % of the drawn particles' presence differs from the direct evaluation (the prefiltered coarse levels).
  Sources of ξ / ζ: the
  moonlets Pan and Daphnis (Hill-problem response table, `public/data/rings/moonlet_response.*`) and the normal modes
  of eccentric edges (`src/rings/ringModes.ts` `EDGE_FEATURES`: the B-ring outer edge's four modes; uniforms
  `uRsMode[8]` = (A, m(φ0 − ϖ(t)), m, 1/L), `uRsModeF[8]` feature index, `uRsFeat[2]` = (a_edge − r0, material side,
  1/gap, reach)). The camera's
  streamline state is `uRsCam` = (ξ, ζ, J, near-field zone flag). Far-field shaders (`src/render/far/**`) include
  only `sv_ringProfile` (km-scale edge waves are below their footprints).
* **Vertical relief contract** (`sv_ringRelief`, `sv_ringReliefShade`; model and CPU mirror `src/rings/relief.ts`,
  owned by `RingStructure`; physics ring-physics.md §13). ONE height field z0(r, θ, t) = the moonlets' ζ + the relief
  sources, read through `ringStreamRelief(dr, dth, fp)` (`.zeta`, `.slope`) / `ringStreamXi(...).y` /
  `ringStructureRelief(aL, dth, fp)`, CPU `structure.streamAt(dr, dth, fp, true)` / `midPlaneAtSEF(r, θ)`. **Every
  consumer takes heights relative to the local mid-plane, z − z0**: the sheet intersects the displaced surface
  (`ringReliefHit`: bounded march over the relief slab + Illinois regula falsi, skipped where the relief moves the hit
  by < 0.3 footprints) and shades the layer in its tilted frame (`ringReliefNormal`, solar incidence on both faces from
  the extended disk `ringReliefSunMu`, transmission exp(−τ/|V·n|)); relief shadows `ringReliefSunVis(aL, dth, z0, τ,
  fp)` (bending-wave crests via their inverse phase tables, single peaks as opaque Gaussians, region A by a cell walk,
  the moonlet edges at three streamlines, the propellers' stirred regions as prefiltered ridges; footprint- and
  penumbra-averaged; the geometry is mirrored to the lit face, where the sites' and propellers' structures rise); the
  near-slab march follows z0 (LOD functions, two-stream and sun paths with the local tilt; its slab is widened by
  `uRrCamN.z`, the |z0| bound near the camera; z0 is re-evaluated every `RL_RELIEF_CACHE` = 15 m of horizontal travel
  inside the layer, every half the height above it outside, extrapolated with its slope in between; the relief
  shadows only within 4 H of the local mid-plane); near-field particles are
  displaced by z0 at their guiding centre and lit relative to the local mid-plane (`vLitN`); the astronaut's column and
  the HUD use the camera's mid-plane height `uRsCam.y` = `f.ring.zMid`. The ring frame stays in the SEF plane;
  ring-frame cameras keep their height above the local mid-plane (`FreeController.midPlane`, set by the app: station
  keeping includes the material's vertical motion). Uniforms `uRr*` (set per frame by `RingStructure.updateRelief`):
  `uRrWave[3]` (r_V − r0, forcing phase at the frame origin, m, scale), the wave tables `uRrTab` (4096 × 2 rows per
  wave: (A, φ, dA/dx, dφ/dx) and the inverse crest table), `uRrCorr*` / `uRrRip*` (corrugation), `uRrPeak*`,
  `uRrSite*` (region A), `uRrMlEdge` (moonlet gap edges), `uRrCamN` (camera slope, |z0| bound, relief-near flag).
  Debug views 23 (r − r0, θ − φ0, z of the ray at the sheet hit), 24 (z0, relief sun visibility, μ0), 25 (false colour
  z0 ±1 km × shadows), 26 (footprint, slopes); `?relief=` scales all relief sources (0 = flat, for A/B).
  `npm run test:relief` checks GPU vs CPU, the shadow geometry and the near field.
* `sv_lighting`: `phaseLambertSphere`, `phaseHG`, `ringPhase(cosα, dust)`, `ringParticleSurge(α)`,
  `ringRegolithIF(μ0, μ, cos g, w)` (resolved particles; CPU mirror `near/NearRegolith.ts`),
  `extendedSourceCosine(cosθ, sin σ)` (incidence cosine of an extended spherical source), `saturnshine(p, out dir)`,
  `diskOverlapFraction`, `moonsSunVisibility(p, skip)`, `sunVisibility(p)`; moon spheres `uMoonPosR[32]`; extra
  shadow spheres `uShadowSph[MAX_SHADOW_SPH = 8]` / `uShadowSphN` (published by later-loaded bodies — the propeller
  moonlets; reset to 0 every frame by `SharedUniforms.update`), `sphereSunVisibility(p, sph)`,
  `extraSunVisibility(p, skipIndex)` (also multiplied into `moonsSunVisibility`).
* `sv_ringLod` (mirror of `src/rings/RingLod.ts`): 14 octave size classes from 1 mm, `lodCarryParticle(a,k,s,dz)`
  (one particle's draw probability: count contract, display pixels via `uLodPixelAngle`), `lodCarry(a,k,s,dz)`
  (the share of class k the medium leaves out: exact class mean of the former; `a` unused), `ringExtinction(s, z, tau, H, W, out sigTot, out
  sigUnres)` (z and the camera's height `uRingCamLocal.z − uRsCam.y` above the local mid-plane),
  `ringLayerTauBeyond(z, tau, H, dirSign)`, `ringSlabHalfThickness(H)`, `ringLayerProfile`,
  `ringLayerColumn`, `ringLayerSegmentTau`, `ringColumnCentroid(qa, qb)` (column-centroid table `uLodColC` of the
  total profile, `RingLod.columnCentroidTable`) and `ringSunNodeRise(j, qs, hp)`: the `LOD_SUN_NODES` (6)
  stratified nodes along the sun path at which every pass averages the wake density (march, particles, astronaut;
  2 fixed nodes overestimated the sunlight by 15–26 % at 8° sun through the convexity of exp(−τWs/μ0)). The part of
  τ in particles below 1 mm (true dust: D ring, gaps,
  F/G/E rings, Roche Division) is a never-drawn layer (`uLodTauSub`, σ_z = `uLodSigZSub`) included in all of
  these, so the medium total always equals the local τ. The top class absorbs any aMax > 16.4 m.
  **Size rules** (ring-physics.md §10.12; per-class constants from `RingLod.configure`, the same for both renderers):
  `lodClassOf(a)`, `lodClassP(k)` (`uLodClassP`: the share of class k that follows the wakes — a mixture, so a class's
  density is exactly 1 + p (D − 1)), `lodClassF(k)` (`uLodClassF`: the spin-aligned share), `lodAniso(dir)` (`uLodAniso`:
  the aligned population's projected-area anisotropy G(μ) and the tidal term T(μ) cos 2ψ, CPU mirror
  `RingLod.anisoAt`), `lodTauDyn(tau)` (`uLodTauDyn`: τ_dyn/τ_profile vs τ at the anchor; the particles' presence
  and the medium follow τ_dyn), `lodPackM(tau, W)` (`uLodPack`: the packing ceiling's thickening of the participating
  classes at density W), `uLodTidal` = (tidally locked share, p̄, f̄, 1/g1), `ringSlabHalfThickness(H)` = `uLodSlabK`·H
  + 0.5 (the slab holds the layer thickened to the density cap), and `ringLodChannels(s, z, dz, H, Gs, out Bp, out Bt,
  out Bs)` — the three bands of the ring layer's LUT. σ_z per class from the zone's `sigZLaw` (`zoneSigZ`).
* `sv_wakes` (mirror of `src/rings/WakeField.ts`; Python port with a bit-exact `--verify`:
  `scripts/data/nbody/procedural.py`): `wakeDisplacement(q)` (particles, at their epicyclic position), `wakeDensity(x)`
  (local frame, m; the density of exactly those particles: mean 1, clamped to `uWakeBounds.xy` = [0.8 γ_gap^s,
  4 γ_core^−s]), `wakeDensityFiltered(x, footprint)`, `wakeMinDensity()` (true lower bound, for culling),
  `wakeDisplacementP(q, p)` (participation p of a size class), `wakeDensityTau(x)` = 1 + p̄ (D − 1) (`uWakePartTau` =
  `WakeField.participationTau` = the column's p̄, set per anchor; 1 with wakes off) and `wakeDisplacementJ(q, out Df)`
  (the displacement and the forward map's density at the particle: the packing ceiling). CPU mirror
  `WakeField.densityAt` / `displacementAt` (float64; behind τ_dyn's `WAKE_D_BINS`), checked against the GPU
  (`test:lod`) and the port (`--verify`). Two transient sheared
  generations half a lifetime apart (`uWakeGen[0..1]` = shear, offsets, texture layer); plateau handover within each
  half-cycle at the local phase φ − d·δ(x) (`uWakeClock`; δ an advected smooth random field re-drawn every cycle,
  `uWakeDelta` + layer 2 of `uWakeTex`: its 64² tile repeated 4 × 4, sampled at the tile coordinate / 4 — the same texels
  and filter weights as a texture of its own, one sampler unit fewer; local asynchrony); narrow-band random envelopes W
  with dislocations (`uWakeTex` layers 0, 1, RGBA32F: Re W, Im W and the regularised phase gradient). `uWakeOpt` (per frame,
  `WakeField.update`): once φ − d ≥ 2 envW the handover is complete for every δ (55 % of each cycle with the A set, 60 %
  with B) — the δ fetches and the zero (old) generation are skipped, bit-identical results (`npm run test:wakecost` checks
  it). Each generation's map displaces along its wave normal by
  (C(Θ) − Θ)/K with the LOCAL wave number K (≥ 0.65 of the mean: both generations together move ≤ tile/6, the near
  field's culling margin) and the composite circle map C = G_g∘M_γ (core density 1/γ_core, gap γ_gap); this map does
  not fold (the old one, with the mean wave number, folded where the local one exceeded it). The inverse: closed-form
  guess + 2 Newton steps per generation with central differences (10 texture fetches, 16 with asynchrony).
  Parameters per wake set (`WAKE_SETS` A / B, zone field `wakeB`, calibrated against N-body runs: ring-physics.md
  §10.11). Spacing at the envelope peak = Toomre λ (≈ 38 m mid-A, 49–55 m in B), pitch ≈ 15–20° trailing; no wakes in
  the C ring / Cassini Division. The ring-layer pass probes the field's window mean (`rings.wakeMean`, ≈ 1; a check, no
  correction).
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
  statistical part of the sun path; the sun path through the layer samples the wake density at the same stratified
  nodes the medium uses (`ringSunNodeRise`, over the participating column, thickened by the packing ceiling; the
  other classes are uniform), read from the ring layer's wake clipmap at the level the medium's march reads at the
  particle (`nfWakeLevelFor`: texels ≥ the display-pixel footprint / 1.5; near the camera its finest, 0.25–0.5 m
  texels) — one fetch per node and the medium's own sun-path field at the handover — and from `wakeDensity` outside
  the clipmap; a 2048×1024 sun-aligned shadow map resolves particle-on-particle shadows near the camera (the
  statistical transmission keeps only what the map cannot resolve). `scripts/test/particles.mjs` checks the GLSL
  against the CPU mirrors and the LUT / relief contracts.
* **Near-field frame and contact contract** (`NearFieldPass`, `near/NearContact.ts`). Steps: (1) the update pass
  writes every particle's analytic position (exact Hill-frame orbit + wake + streamline displacement) and flag into
  R0 (RGBA32F per slot: camera-relative xyz, w = +a drawn / −a present but not drawn / 0 absent; "not drawn" also covers
  the **statistical occlusion cull**: line-of-sight optical depth `nearLosTau(...)` > 5 (`near/nearOcclusion.glsl`, meant
  to be shared with the contact set's fade: the slab model between the camera and the particle's near side with the
  lowest of three τ samples along the path × 0.8, first × the emptiest-gap density `wakeMinDensity()`, then — where that
  cannot decide and a mean density ≤ 1.1 could — × the line of sight's own wake density: the ring layer's wake clipmap
  (`ctx.wakeClip`) at 4–24 nodes stratified in the column between the two heights, ≤ λ/8 apart, read from the level
  covering the particle, summed until the partial sum decides; since the Nov 2026 wake retune the bound alone (0.055 in
  the B ring) culled almost nothing: b-ring-inside 1.09 M → 0.10 M particles drawn, the image unchanged to 0.1 %,
  `npm run test:counts` section 4); (1b) **contact
  resolution** pushes the visibly resolved particles out of each other's overlaps and writes their positions back
  into R0; (2) HistoPyramid compaction of R0 into the point / quad / caster lists; (3) the sun shadow map (shared
  as `ctx.nearShadow`); (4) the draw. Everything after 1b sees the same positions. The contract of 1b:
  - *who*: present particles (drawn or not) weighted by smooth fades — resolved (4 → 6 render px radius: an overlap
    is typically ~0.3 of the smaller radius deep, about a pixel at 3–4 px), not statistically occluded (slab
    line-of-sight τ 4 → 5 above the camera's local mid-plane, with a conservative path τ as the update pass's cull:
    the lowest τ in range × `wakeMinDensity()` × 0.8, the floor read from the WakeField's `uWakeBounds.x`), near the
    view frustum (dilated by two contact distances, the reach of a push; within R0's out-of-view coverage rb + mw),
    and not around the camera (a body containing the camera is not drawn — the camera is a ghost — so it must not
    push its neighbours out of an empty hollow; fading over d/ρ 1 → 1.15). A pair is corrected with the smaller
    weight, so every correction fades in continuously.
  - *contact distance*: the sum of the drawn base shapes' radial extents along the centre line,
    ρ = a / √(nᵀM′n), M′ = R diag(1/shape²) Rᵀ (`nearShape` / `nearOrientation`: ellipsoids at high quality,
    spheres otherwise); the high-quality relief (±~0.1 a) interlocks with the neighbour's. **Shape mirror**: the
    shapes come from `nearShape` / `nearOrientation` directly; only the largest base semi-axis / a, `SHAPE_EXT_HIGH`
    (1.37, `NearContact.ts`), must follow when they change (grid cells, search reach; the test reads it back).
    Fully 3-D: a mid-plane tilted by the vertical relief changes nothing (`test:contact` mimas53 / titan views).
  - *solver*: per round (3) a hash grid (one level per size class, 16-entry buckets built in one stencil-routed
    point pass: deterministic, no atomics; sized to the list each frame), an 8-neighbour list per particle (smallest
    normalized surface gaps), then 8 Jacobi iterations with constraint averaging (24 in all, damped: ω = 0.7):
    mass-weighted shares (∝ a³) within a size class, the smaller particle yields entirely across classes; a small
    particle lying entirely inside a larger one is hidden and left alone (ejecting it would cascade).
  - *idle*: nothing runs when the camera is farther from the layer than the largest particles are resolved at; with
    an empty contact set only the list compaction runs, every 4th frame.
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
  a few metres). Vertical Gaussian, std = σ_z(a) of the zone's vertical law (`sigZLaw`; small particles ride
  higher), × the packing ceiling's m for the participating particles in dense wakes. Counts follow τ_dyn (the
  population's optical depth; the profile is photometric: ring-physics.md §10.12).
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
* **Particle shapes and spin** (`nearCommon.glsl`): triaxial ellipsoids (`nearShape`, full shape spread,
  ⟨projected area⟩ = πa²) in **principal-axis rotation** about their short axis (`nearOrientation`). Spin axes: a
  mixture per class — the share `lodClassF(k)` (`nearSpinAligned`, hash `NS_ALN`) spins about axes near the orbit
  normal (`nearSpinAxis`, mix(random, normal, 0.85)), the rest randomly — so a class's mean projected area along a
  direction is exactly πa² (1 + f_k G(μ)), the medium's (`lodAniso`; G = −0.075 edge-on … +0.138 face-on, measured
  from the shape and axis distributions and checked against the GLSL by `test:particles`). Tidal locking (long axis
  toward Saturn, synchronous) for the share `uLodTidal.x` of the aligned population (hash `NS_TID`); 0 in every
  main-ring zone (r_h < 1.1). The former stopgap `NR_ISO` (aligned bodies kept nearly round) is gone. At high quality
  the surface is r(u) = κ(1 + amp·h(u)) in the axis-scaled body frame:
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
  (10 m boulders are ≥ 1 px out to ~20 km at 1080p), each class generated at the largest presence factor τ0·M over its
  own box (+ 500 m): where the modulation cache covers the box, its joint maximum of τ0 × M (`ModClipmap.maxNear(…, 1)`
  × 1.02: each texel holds the largest τ0 over its bilinear support × its M, so the block maxima bound exactly what the
  presence test reads, texture × propellers jointly; M's local maximum is 1.18–1.42 in the A ring and ~1.26 in the
  B-ring core, depending on the box), else max τ0 × the analytic bound of M (`RingStructure.maxTauModNear`: texture
  1 + 0.70 A, i.e. 1.22 in the A ring and 1.43 in the B-ring core; a propeller's lobe factor 1.27 × its wake bound only
  where a propeller's band crosses the box — `prepareNear` / `nearBoundKey`, re-checked every 60 frames).
  `Pipeline.updateLocalRing` re-checks the bound every 15 frames: a class whose need exceeds
  its τ_max re-fits, and one whose need fell ≥ 10 % below it (`BOUND_REFIT_DOWN`; `RingLod.reallocRequested`) — the
  first allocation after loading / re-anchoring uses the analytic bound until the cache's maxima are read back. Presence
  then accepts τ0 J M / bound.
  Independent of the camera position (particles persist while flying) unless the total exceeds the 12M-slot
  cap (dense B ring, ~46M): then it is fitted to the camera height h (valid for [h/1.5, 1.5h], re-fit
  outside); above the layer the zoom-in margin and the band below h are given up first (down to 1.07× / 1.13×:
  they hold nothing drawn now, but re-fits come sooner), only then are the largest boxes clipped at a common
  radius; the stats report the visibility-weighted deficit (~0 inside the B ring, where the layer hides
  everything farther; B ring at 1080p: complete from ≥ 700 m above, ~3–30% short at 50–500 m; the texture's global
  allocation bound 1.43 raised the 1280×720 deficit at 100 m from 0.3 % to 9.2 %, the cache's local bound brought it to
  2.9 %, `npm run test:counts`). Vertical
  visibility is not used to thin it: every particle crosses the mid-plane, and wake gaps leave even the B ring
  at τ ~ 1. The near field is active while the camera is within the largest particles' reach. Seeds depend on
  the anchor id and class only; classes whose allocation is unchanged keep their particles across re-fits.
* **Wakes** (`WakeField`): Toomre λ = 4π²GΣ/κ², pitch ≈ 15–20° trailing, transient sheared generations with local
  asynchrony, calibrated against local N-body simulations (ring-physics.md §10); A-ring and B-ring parameter sets.
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
  material under the camera changes (ring ↔ gap) or after 20 km of Lagrangian drift. ζ is part of the vertical relief
  (rendered as geometry, see the relief contract above). Details and numbers: ring-physics.md §8.
* **Vertical relief** (`src/rings/relief.ts`): bending waves (Mimas 5:3 and 4:2, Titan −1:0; SCL83 linear theory,
  phases from the live ephemeris), the 1983 C-ring corrugation (Hedman et al. 2011, 2015), B-ring-edge region A and
  S/2009 S1 (Spitale & Porco 2010), plus the moonlets' ζ. ring-physics.md §13.
* **Sub-km texture** (`RingTexture`, `sv_ringTexture`; ring-physics.md §11): τ × M with M = 1 + A F, F a 2-D
  random field with the former radial noise's power spectrum (6 octaves, 500 → 15.6 m) and amplitude law, built
  from value noise on lattices that are isotropic at birth and advected by the Keplerian (+J2–J6) flow — trailing
  streaks (pitch ~6°, azimuthal correlation ~10× the radial), two overlapping generations of coherence time T =
  12.9 h. Octaves below the footprint fade into the variance the sheet folds into its pyramid; the mean is 1 at
  every footprint. The noise tile is a 256² R16F texture; lattice phases are passed per frame in double precision.
* **Propellers** (`PropellerSystem`, `sv_ringPropellers`; ring-physics.md §12): the 11 named giant propellers of the
  outer A ring (Tiscareno et al. 2010 Table 1 orbits, Blériot's 0.11° / 3.68 yr sinusoid) and four belt classes
  (Tiscareno et al. 2008 populations) placed by a deterministic hash grid in (mean motion, co-moving longitude)
  cells — each moonlet moves on its own orbit, longitudes exact in integer arithmetic. Structure per moonlet: two
  partial gaps at ±2 r_H trailing in opposite directions with Δℓ, depth and enhanced lobes from the Sremčević /
  Seiß scaling, moonlet wakes (Hill-response table), equinox relief; enumerated per lookup over a 3×3 cell
  neighbourhood (bounded cost), faded beyond 8–16 r_H footprints.
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
  `exposure`, `bloom`, `wakes`/`dustRings`/`stars`/`labels`/`nearField`/`astronaut`/`hud`, `debug`, `relief` (vertical
  relief multiplier, not persisted: 0 flat, 1 physical, > 1 exaggerated), and the sandbox-style `cam=orbit|ring|look`
  parameters (`cam=ring`'s `z` is the height above the local mid-plane).
* Test hooks: `window.__sv = { app, frame, pipeline, clock, world, renderer, camera, anchor, presets,
  goto(name, {instant}), setTime(iso), setWarp(n), info(), toggleCoorbit(), toggleBallistic(), flyTo(name) }`;
  `window.__svReady` becomes true 8 frames after the loading screen hides. `sandbox/app.html` = the app on stub
  passes. Batch screenshots: `node scripts/shots.mjs <spec.json> <outDir>` (format in its header).

## Stub passes
`src/render/passes/stubs/*` (`FarFieldStub`, `RingLayerStub`) are minimal, dependency-free versions of the far
and ring-layer passes. The app falls back to them when a real pass fails (`GuardedPass`), and sandbox pages can
use them to test one subsystem in isolation. Task → file map: `CLAUDE.md`.
