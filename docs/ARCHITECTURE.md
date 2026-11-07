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
  ~10–20 m thick across a 70,000 km span; particles are 1 cm–10 m; Iapetus orbits at 3.56 million km.
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
  parameters (`cam=orbit|ring|look`, `t=`, `warp=`, `fov=`, `detail=`, `ev=`, `debug=`). `window.__sv`
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
  Lambert-shaded × `ringParticleLambertFactor(cosα)`, which makes each sphere's disk-integrated phase function
  equal `ringParticlePhase` — so an *ensemble of resolved particles has the same brightness as the medium*
  (no seams). JS mirrors: `src/render/rings/phase.ts` (model 1), `far/Ringshine.ts`.
* `FrameState.timeWarp` is 0 while paused.

## Frame flow
`SimClock.tick` → `World.update(frame)` (Sun, Saturn W, moons) → camera rig sets `camPos/camQuat/fovY` and
`RingAnchor.fill(frame.ring, …)` → `updateCameraDerived(frame)` → `Pipeline.render(frame)` → HUD.

## Render pipeline (`src/render/Pipeline.ts`)
| step | pass (file, class) | reads | writes |
|---|---|---|---|
| 0 | clear (internal) | | sceneRT = (0,0,0, SKY_DIST), depth = 1 |
| 1 | **far** `passes/FarFieldPass.ts` `FarFieldPass` | shared uniforms | sceneRT rgb + a(=distance m) + log depth |
| 2 | **near** `passes/NearFieldPass.ts` `NearFieldPass` | sceneRT depth (depth-tested) | sceneRT rgb + a + depth |
| 3 | **rings** `passes/RingLayerPass.ts` `RingLayerPass` | sceneRT (rgb, distance) | hdrRT (radiance) |
| 3b | late HDR hooks (`far/lateHooks.ts`, run at the start of PostPass) | sceneRT.a | hdrRT (additive) |
| 4 | **post** `PostPass.ts` `PostPass` | hdrRT | screen |

* Late HDR hooks exist for **sub-pixel sources** (unresolved moons): a single opaque distance per pixel can't
  represent a sub-pixel point in front of the rings, so the far pass registers a hook that adds them to hdrRT
  after the ring layer, with an analytic ring transmission and an occlusion test against sceneRT.a.
* **Auto exposure** (`PostPass`): highlight meter (per-cell peak/extended brightness, Sun excluded, isolated
  point sources ≤ 64× key) for small bright bodies on black sky; when lit material (> 1e-4 W m⁻² sr⁻¹) covers
  most of the frame it blends to the 90th percentile of the lit pixels (highlights may clip ≤ 32×) so the
  inside of the B ring or an eclipse is exposed like an eye would adapt. 0.5 s log-space adaptation; async readback.
* **Ring layer** (`RingLayerPass`): analytic sheet in the far field; inside/near the slab
  (|z| < `ringSlabHalfThickness(H)`) an adaptive ray-march (half resolution inside the layer and below 1.5 km,
  depth-validated upsample) using a per-frame 256×64 LUT of the shared `ringExtinction`/`ringLayerTauBeyond`
  (medium = σ_unres). Own τ pyramid storing ⟨e^{−τ/m}⟩ for path factors m = 1…0.008 (exact footprint-averaged
  transmission at any angle), granola-bar wakes in the sheet, a 6-level wake-density clipmap near the camera.
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
* `PipelineContext`: `{ renderer, shared, profile, lod, wakes, sceneRT, hdrRT, width, height }`.

### Shared uniforms & GLSL (`src/render/SharedUniforms.ts`, `src/render/shaders/*.glsl`)
Spread `ctx.shared.u` into your material's uniforms; start shaders with `SV_HEADER_ALL` (from `chunks.ts`) or
include the chunks you need, in order: `sv_common`, `sv_saturn`, `sv_ringProfile`, `sv_lighting`, `sv_ringLod`, `sv_wakes`.
* `sv_common`: camera ray `cameraRayDir(uv)`, `viewDepth`, `logDepth01`, `logDepthClipZ`, PCG hashes, value noise/fbm, `erfApprox`; Sun uniforms.
* `sv_saturn`: `saturnIntersect(ro, rd)`, `saturnNormal(pc)`, `saturnSunVisibility(p)` (penumbra).
* `sv_ringProfile`: `RingSample ringSample(r, footprint)` / `ringSampleIdx(idx0, footprint)` (1-D mip
  pyramid: tau, H, Σ, wake, albedo rgb, dust), local Hill-frame helpers, `ringSunTransmission(p, footprint)`.
* `sv_lighting`: `phaseLambertSphere`, `phaseHG`, `ringPhase(cosα, dust)`, `saturnshine(p, out dir)`,
  `diskOverlapFraction`, `moonsSunVisibility(p, skip)`, `sunVisibility(p)`; moon spheres `uMoonPosR[32]`.
* `sv_ringLod` (mirror of `src/rings/RingLod.ts`): size classes, `lodDrawProb(a,k,s)`,
  `ringExtinction(s, z, tau, H, W, out sigTot, out sigUnres)`, `ringLayerTauBeyond(z, tau, H, dirSign)`,
  `ringSlabHalfThickness(H)`, `ringLayerProfile`, `ringLayerColumn`, `ringLayerSegmentTau`. The part of τ in
  particles below the smallest class (aMin < 1 cm: C ring, Cassini Division, outer A ring) is a never-drawn
  sub-cm layer (`uLodTauSub`, σ_z = `uLodSigZSub` ≈ 0.4 H) included in all of these, so the medium total always
  equals the local τ. The top class absorbs any aMax > 10.24 m.
* `sv_wakes` (mirror of `src/rings/WakeField.ts`): `wakeDisplacement(q)`, `wakeDensity(x)` (local frame, m;
  range [γ^s, γ^−s]), `wakeDensityFiltered(x, footprint)`, `wakeMinDensity()`. Two transient sheared
  generations (`uWakeGen[0..1]` = amplitude, shear, offsets; sin² envelopes, lifetime 3/Ω), narrow-band random
  fields with phase dislocations and a non-shell-crossing profile (`uWakeShape` = ln γ, 1/Rc², Wmin, Wmax).
  Spacing at peak = Toomre λ (≈ 40 m mid-A, 51–55 m in B), pitch ≈ 20° trailing; contrast γ = 0.16 (A), 0.24 (B);
  no wakes in the C ring / Cassini Division.
* **Near-field photometry contract** (`NearFieldPass`): sub-pixel particles use `ringParticlePhase`, resolved
  ones Lambert × `ringParticleLambertFactor`; multiple scattering by the same two-stream solution as the medium
  with `phaseTables(1)` back-scatter fractions; shadow hiding exp(b·min(τ_sun, τ_view)) on the statistical part
  of the sun path; the sun path through the layer samples the wake density at the same two points the medium
  uses; a 2048×1024 sun-aligned shadow map resolves particle-on-particle shadows near the camera (the statistical
  transmission keeps only what the map cannot resolve).

## The ring model (physics)
* **Radial profile** (`src/rings/RingProfile.ts`): 0.25 km grid, 66,000–139,500 km. Optical depth from
  Cassini occultation data if present, else procedural. Other quantities from the zone table
  `src/rings/ringRegions.ts` (q, aMin, aMax, H, Σ/τ, albedo, wake, dust).
* **Particles** (near field): power-law sizes dN/da ∝ a^-q in [aMin, aMax] with column density fixed by τ;
  10 octave classes from 1 cm. Vertical Gaussian, std = `sigZFrac(a)·H` (small particles ride higher).
  Kinematics in the Hill frame (exact linear solution): guiding center x_g, y_g(t) = y_g0 − qΩx_g t;
  epicycle x = x_g + A cos(κt+φ), y = … − 2A(Ω/κ) sin(κt+φ); vertical z = B cos(νt+ψ);
  plus wake displacement `wakeDisplacement(guidingCenter)`.
* **LOD contract** (`RingLod`): a particle of radius a at distance s is drawn with probability
  P = clamp((a/(s·pixelAngle·rhoMin))², 0, 1)·window_k(s); the continuous medium carries exactly the
  remaining optical depth (`ringExtinction`). Both passes must use these functions.
* **Wakes** (`WakeField`): Toomre λ = 4π²GΣ/κ², pitch ≈ 20° trailing, transient sheared generations.
* **Outer rings**: F ring (eccentric, a = 140,221 km), G, E (vertical torus around Enceladus), D — analytic
  in the ring-layer pass (`OUTER_RINGS` in `ringRegions.ts`).

## Data formats (`public/data/…`)
* `rings/tau_main.json` + `rings/tau_main.f32`: `{ source, r0_km, dr_km, n, notes }` + n little-endian
  float32 normal optical depths at r = r0_km + i·dr_km. NaN allowed = no data (procedural used there).
* `ephemeris/sun_from_saturn.json`: `{ frame:"ICRF", center:"699", target:"10", start_jd_tdb, step_days, pos_km:[x0,y0,z0,…] }`.
* `moons/…`, `stars/…`, `textures/…`: defined by the moons/sky data agent (documented in `docs/data-sources.md`).

## The app (`src/app/**`, `src/camera/**`, `src/ui/**`)
* `App.ts` frame loop; `passes.ts` loads each pass by dynamic import inside a `GuardedPass` (a throw in
  import/init/update/render disables the pass and falls back to `passes/stubs/*`, or a minimal tone mapper for
  post; `renderer.debug.onShaderError` names the offending pass and GLSL lines).
* URL parameters: `preset` (place id), `t` (ISO or `now`), `warp`, `paused`, `fov`, `detail`, `scale`, `ev`,
  `exposure`, `bloom`, `wakes`/`dustRings`/`stars`/`labels`/`nearField`/`hud`, `debug`, and the sandbox-style
  `cam=orbit|ring|look` parameters.
* Test hooks: `window.__sv = { app, frame, pipeline, clock, world, renderer, camera, anchor, presets,
  goto(name, {instant}), setTime(iso), setWarp(n), info(), toggleCoorbit(), toggleBallistic(), flyTo(name) }`;
  `window.__svReady` becomes true 8 frames after the loading screen hides. `sandbox/app.html` = the app on stub
  passes. Batch screenshots: `node scripts/shots.mjs <spec.json> <outDir>` (format in its header).

## File ownership (parallel development — historical; all modules are now maintained together)
| owner | files |
|---|---|
| orchestrator | `src/core/**`, `src/render/Pipeline.ts`, `SharedUniforms.ts`, `fullscreen.ts`, `shaders/{common,saturn,ringProfile,lighting}.glsl`, `shaders/chunks.ts`, `src/rings/RingProfile.ts`, `src/render/passes/stubs/**`, `sandbox/common.ts`, `scripts/shot.mjs`, `docs/ARCHITECTURE.md` |
| ring science & data | `public/data/rings/**`, `scripts/data/rings/**`, `src/rings/ringRegions.ts` (values), `docs/ring-physics.md` |
| moons & sky data | `public/data/{moons,stars,textures,ephemeris}/**`, `scripts/data/{moons,stars,textures,ephemeris}/**`, `src/moons/**` (except `types.ts`), `src/sky/**`, `docs/data-sources.md` |
| far field | `src/render/passes/FarFieldPass.ts`, `src/render/far/**`, `src/render/PostPass.ts`, `sandbox/far.*` |
| ring layer | `src/render/passes/RingLayerPass.ts`, `src/render/rings/**`, `sandbox/rings.*` |
| near field | `src/render/passes/NearFieldPass.ts`, `src/render/near/**`, `src/rings/RingLod.ts`, `src/rings/WakeField.ts`, `shaders/{ringLod,wakes}.glsl`, `sandbox/near.*` |
| app | `index.html`, `src/main.ts`, `src/app/**`, `src/camera/**`, `src/ui/**`, `sandbox/app.*` |

Don't edit files you don't own. If you need a change in a shared file, work around it locally and describe
the needed change in your final report. In your sandbox use `passes/stubs/*` for other agents' passes so their
in-progress work can't break yours.
