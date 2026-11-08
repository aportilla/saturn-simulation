# Saturn ring system simulator — agent guide

Real-time, physically based Three.js (WebGL2) simulation of Saturn, its rings and 28 moons at true scale, in SI
units. The point of the project is **realism of the rings from the inside**: true particle sizes, counts,
positions, layer thickness and motion (Keplerian shear, epicycles, vertical oscillation, self-gravity wakes),
with physically based light. Visual polish is secondary to physical correctness.

**Read `docs/ARCHITECTURE.md` before changing rendering or physics code** — it holds the contracts (frames,
units, pipeline, depth, shared GLSL, LOD contract, photometry). Science and data provenance:
`docs/ring-physics.md`, `docs/data-sources.md`. User-facing overview and controls: `README.md`.

## Commands
- `npm run dev` → http://127.0.0.1:5173 (often already running; check with `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/`)
- `npm run typecheck` (tsc --noEmit) and `npm run build` (typecheck + vite build) — keep both clean
- **Regression suite** (real GPU, starts its own private Vite server unless `--base` answers; ~9 min):
  `npm test` = `test:smoke` (every preset: console/page/GL errors, pass fallbacks, NaN/negative pixels) +
  `test:physics` (ephemeris, J2–J6 frequencies, particle kinematics vs the exact Hill solution) +
  `test:counts` (drawn particles vs the analytic expectation, HUD "complete") + `test:seam` (near field +
  medium vs medium alone, incl. the old arc repro; `--only handover`: the medium's explicit wake field, its
  statistics and the sheet vs a reference explicit field across the march -> sheet handover) + `test:exposure`
  (the astronaut doesn't change the auto exposure) + `test:edges` (moonlet gap edges and B-ring edge modes: gaps
  empty, rendered edges = streamline model, near field follows) + `test:moonflux` (unresolved-moon point flux =
  resolved brightness, measured shapes) + `test:particles` (resolved-particle regolith law / factor LUT / relief:
  GLSL vs CPU mirrors, projected-area and photometry contracts; prints new constants when the relief changes) +
  `test:propellers` (named propellers vs Tiscareno 2010 Table 1, sub-km texture statistics and footprint prefilter,
  GPU τ vs the CPU model, near-field presence follows the modulation, moonlet bodies).
  `npm run test:fps` = informational fps table per preset × quality. Details, tolerances, measured values and the
  shared helpers: `scripts/test/README.md`.
- Screenshots on the real GPU (headless Chrome, ANGLE/Metal); console errors and page errors are printed:
  - one page: `node scripts/shot.mjs "<url>" <out.png> --until "window.__svReady===true" --wait 3000 [--w --h --dpr --eval "<js>"]`
  - batch: `node scripts/shots.mjs <spec.json> <outDir> [--w --h] [--uncapped] [--base URL] [--keep-storage]`
    (spec format in the file header; relative URLs work — a private server is started if needed, e.g.
    `scripts/test/specs/*.json`; same-URL shots reuse the page, so `eval` can change settings between shots;
    localStorage is cleared before every page load, so pin settings in the URL)
  - image utilities: `node scripts/img.mjs profile|mean|crop|rotate …` (PNG brightness profiles, region means, crops,
    rotate/scale e.g. to a Cassini frame's orientation)
  - exposure debugging: `node scripts/meter-debug.mjs "?preset=…&t=…"` (auto-exposure meter intermediates)
  - put screenshots in the session scratchpad, not the repo; view PNGs with the Read tool
- Useful URLs: `/?preset=<place>` (ids in `src/app/presets.ts`: overview, rings-above, edge-on, a-ring-inside,
  a-ring-30m, a-ring-1km, b-ring-inside, c-ring-inside, cassini-division, shadow, under-rings, encke-gap,
  keeler-gap, propeller-bleriot, propeller-belt, f-ring, enceladus, titan, mimas, iapetus, cloud-tops) plus `t=<ISO>` (fix the time for
  reproducible shots), `hud=0`, `labels=0`, `paused=1`, `warp=`, `fps=0` (uncapped), `scale=` (render scale),
  `quality=high|medium|low` (particle render fidelity), `debug=<n>`, feature toggles (`wakes=0`, `nearField=0`,
  `astronaut=0` (the camera-pinned astronaut, key V), …). Full list: ARCHITECTURE.md → "The app".
- Sandbox pages for one subsystem in isolation: `sandbox/{far,rings,near,moons,ringplot,pipeline,app}.html`
  (`ringplot.html` plots the ring optical-depth profile against the raw occultations).

## Tools and tests live in the repo (standing rule)
Session scratchpads are deleted after the session, so anything worth running again must be committed:
- **Browser tests / regression checks** → `scripts/test/` (shared helpers in `scripts/test/lib.mjs`), registered
  as `npm run test:*` in `package.json`, listed in `scripts/test/README.md`; regression checks also join
  `npm test`. **General utilities** (screenshots, image comparison, inspection) → `scripts/`.
  **Data build/verification** → `scripts/data/<topic>/`.
- **Check `scripts/test/README.md` before writing a new tool** — extend an existing one where possible; its
  "Adding a tool" section has the template, the `lib.mjs` helpers to reuse and how to register a tool.
- When you write a script to measure or verify something that could regress or be useful again (a
  photometry/seam/count check, a perf table, a bug repro, a physics validation), finish it as a reusable tool:
  CLI arguments instead of hard-coded paths/URLs, an output-dir argument (default under the OS temp dir), a
  usage header comment, documented expected values/tolerances. Then add it to `scripts/test/README.md` and keep
  this file's commands in sync. Only true one-off experiments may stay in a scratchpad.
- **Subagents follow the same rule** — say so in their brief, and fold their tools into the repo when they report.
- Run the relevant `npm run test:*` (at least `test:smoke`) after rendering or physics changes, and report the
  results.

## Runtime hooks (from `eval` in the screenshot tools)
`window.__sv = { app, frame, pipeline, clock, world, renderer, camera, anchor, presets, goto(name,{instant}),
setTime(iso), setWarp(n), info(), toggleCoorbit(), toggleBallistic(), flyTo(name) }`; `window.__svReady` turns
true 8 frames after loading. `__sv.pipeline.stats()` gives per-pass numbers (particles allocated/drawn, ring
mode, exposure EV, …). Passes are wrapped: `__sv.pipeline.passes.{far,near,bodies,overlay,rings,post}.inner` — set
`.enabled = false` to measure a pass's cost. Read HDR radiance with
`__sv.renderer.readRenderTargetPixels(__sv.pipeline.ctx.hdrRT, x, y, 1, 1, buf)`.

## Where things live (task → files)
| task | files |
|---|---|
| time, frames, Sun, Saturn rotation, constants, co-orbiting (Hill) frame | `src/core/*` (`ephemeris.ts`, `RingAnchor.ts`, `constants.ts`, `FrameState.ts`) |
| ring optical depth, zones (sizes q/aMin/aMax, thickness H, Σ, albedo, wakes, dust), features | `src/rings/ringRegions.ts`, `src/rings/RingProfile.ts`; data `public/data/rings/` |
| LOD contract (which particles are drawn vs. carried by the medium), self-gravity wakes | `src/rings/RingLod.ts` + `shaders/ringLod.glsl`, `src/rings/WakeField.ts` + `shaders/wakes.glsl` (CPU/GLSL mirrors) |
| 2-D ring structure (streamline map: moonlet gap edges, normal modes of eccentric edges; hooks for relief and 2-D τ modulation) — every main-ring τ lookup goes through it | `src/rings/RingStructure.ts` + `src/rings/streamlines.ts` + `src/rings/ringModes.ts` (CPU) + `shaders/ringStructure.glsl`; table `public/data/rings/moonlet_response.*` from `scripts/data/rings/moonlet_response.mjs` |
| sub-km 2-D τ texture (sheared, evolving; footprint prefilter → `rlApplyTauMod` in `rlOptics.glsl`) | `src/rings/ringTexture.ts` + `shaders/ringTexture.glsl` (chunk `sv_ringTexture`, included by `sv_ringStructure`) |
| propeller moonlets (named giants, belts: positions, partial gaps / lobes / wakes, relief; moonlet bodies) | `src/rings/propellers.ts` + `shaders/ringPropellers.glsl` (chunk `sv_ringPropellers`), `src/render/passes/PropellerMoonletPass.ts` + `src/render/propellers/*`; presets `propeller-bleriot`, `propeller-belt`; Cassini views `scripts/test/specs/propellers.json` |
| individual ring particles (near field) | `src/render/passes/NearFieldPass.ts`, `src/render/near/*` |
| particle shape, spin, relief, regolith photometry (+ CPU mirrors) | `src/render/near/nearCommon.glsl` (`nearShape`, `nearOrientation`, `nearRelief`, `nearRegolithFactor`), `nearDraw.frag.glsl`, `NearRegolith.ts`, `NearRelief.ts`, `NearNoise.ts`; `ringRegolithIF` in `src/render/shaders/lighting.glsl` |
| astronaut companion (camera-pinned, 1.9 m, for scale; lit like the particles) | `src/render/passes/AstronautPass.ts`, `src/render/astronaut/*` |
| ring medium at all scales, outer rings, spokes | `src/render/passes/RingLayerPass.ts`, `src/render/rings/*` |
| Saturn, moons, stars, Sun | `src/render/passes/FarFieldPass.ts`, `src/render/far/*` |
| exposure, glare, tone mapping | `src/render/PostPass.ts` |
| shared shader code (camera rays, log depth, Saturn, ring profile, lighting/phase functions) | `src/render/shaders/*.glsl`, `chunks.ts` |
| pass order, render targets, local-ring LOD updates | `src/render/Pipeline.ts`, `SharedUniforms.ts` |
| moon ephemerides and rotation | `src/moons/*`; data `public/data/moons/`, rebuilt by `scripts/data/moons/*` |
| measured small-moon shapes (ridges of Pan/Atlas/Daphnis, shepherds, co-orbitals) | `src/moons/shapes.ts`, `traceShapedMoon` in `src/render/far/glsl/moons.ts`; data `public/data/moons/shapes.*` by `scripts/data/moons/build_shapes.mjs`; check `scripts/test/specs/moon-shapes.json` |
| app shell, places, settings, camera controllers, HUD, labels | `src/app/*`, `src/camera/*`, `src/ui/*` |
| data build scripts (download originals into git-ignored `data-raw/`, write `public/data/`) | `scripts/data/**` |

## Invariants — don't break these
- **SI units everywhere** (m, s, kg, rad, W m⁻² sr⁻¹). Time = TDB seconds since J2000 (double). Frame = SEF
  (Saturn-centred, +Z = Saturn's pole, rings in XY, prograde = counter-clockwise from +Z).
- **Precision**: doubles on the CPU; shaders are camera-relative float32. Near the camera use the ring-local
  Hill frame helpers (`ringLocalFromRel` etc.), never absolute SEF positions.
- **Depth**: log depth (`logDepth01`, `logDepthClipZ`) and `sceneRT.a` = distance in metres; never use three.js
  depth conventions. Passes use `RawShaderMaterial` + GLSL3.
- **Realism over prettiness**: at 1× time the rings look almost still (cm/s shear, mm/s random motions) and the
  B-ring interior is twilight — that is correct; don't speed up motion or brighten things. Exposure adapts like
  an eye (PostPass), it doesn't fake light.
- **Particle counts are physical, never a quality knob**: every particle ≥ 1 display pixel across is drawn at its
  true position, with sizes/counts from the zone's size distribution and the local optical depth; only render
  fidelity (shading, shape, shadows, resolution) may be reduced for performance. "Pixel" means a display
  (canvas) pixel — `FrameState.canvasPixelAngle`, not the internal render target — so render scale and
  `particleQuality` never change counts. Sub-pixel material is carried by the continuous medium with exactly
  the remaining optical depth. If the 12M-slot memory cap ever binds (B ring seen from above), the HUD reports
  the deficit (`near.count` in `pipeline.stats()`); never hide it.
- **One contract, two renderers**: the near field (particles) and the ring layer (medium) must share the LOD
  functions (`ringLod.glsl`) and the particle phase function (`ringParticlePhase` power law in
  `lighting.glsl`); the CPU mirrors (`RingLod.ts`, `WakeField.ts`, `render/rings/phase.ts`, `far/Ringshine.ts`)
  must stay in sync with the GLSL. Resolved particles keep it through the regolith law × the per-particle factor
  (`near/NearRegolith.ts` mirrors `ringRegolithIF` and builds the LUT); their shapes keep ⟨projected area⟩ = πa²
  (κ, `NR_K0..3`) and the relief photometry table `RELIEF_PHOT` (`near/NearRelief.ts`) — after changing the relief
  or the shading, run `npm run test:particles` and paste the constants it prints.
- Changing a default in `src/app/settings.ts` / `FrameState.defaultSettings()` needs a bump of the localStorage
  key in `settings.ts`, or users keep their old saved values.

## Gotchas (learned the hard way)
- A pass that throws (including a shader compile error) is swapped for a stub by `GuardedPass`
  (`src/app/passes.ts`) and the app keeps running — **always read the console output** of the screenshot tools;
  `renderer.debug.onShaderError` names the pass and the GLSL lines.
- The Vite dev server answers missing files with `index.html` (status 200): data loaders must check the
  content-type/size (see `loadTauData` in `src/rings/RingProfile.ts`, `loadSunTable` in `src/core/ephemeris.ts`,
  `src/render/far/textures.ts`).
- Integer render targets must be allocated before they are sampled, or three.js binds a float placeholder and
  the draw is dropped with `GL_INVALID_OPERATION` (see `NearShadow.prepare`).
- Performance: measure with `npm run test:fps` (or `scripts/shots.mjs --uncapped` and `?fps=0`), **one fresh
  page load per measurement** (several navigations in one tab leave old WebGL contexts alive and roughly halve the fps); GPU
  timer queries are unreliable on ANGLE/Metal. Another agent's browser on the same GPU also skews numbers.
- Vite reloads the page when a GLSL/TS file changes, so screenshots taken while files are being edited can catch
  the loading screen.
- `data-raw/` is git-ignored and not needed at runtime (only by `scripts/data/**`); `public/data/` is committed.
