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
- Screenshots on the real GPU (headless Chrome, ANGLE/Metal); console errors and page errors are printed:
  - one page: `node scripts/shot.mjs "<url>" <out.png> --until "window.__svReady===true" --wait 3000 [--w --h --dpr --eval "<js>"]`
  - batch: `node scripts/shots.mjs <spec.json> <outDir> [--w --h] [--uncapped]` (spec format in the file header;
    shots with the same URL reuse the page, so `eval` can change settings between shots)
  - put screenshots in the session scratchpad, not the repo; view PNGs with the Read tool
- Useful URLs: `/?preset=<place>` (ids in `src/app/presets.ts`: overview, rings-above, edge-on, a-ring-inside,
  a-ring-30m, a-ring-1km, b-ring-inside, c-ring-inside, cassini-division, shadow, under-rings, encke-gap,
  keeler-gap, f-ring, enceladus, titan, mimas, iapetus, cloud-tops) plus `t=<ISO>` (fix the time for
  reproducible shots), `hud=0`, `labels=0`, `paused=1`, `warp=`, `fps=0` (uncapped), `scale=`, `debug=<n>`,
  feature toggles (`wakes=0`, `nearField=0`, …). Full list: ARCHITECTURE.md → "The app".
- Sandbox pages for one subsystem in isolation: `sandbox/{far,rings,near,moons,ringplot,pipeline,app}.html`
  (`ringplot.html` plots the ring optical-depth profile against the raw occultations).

## Runtime hooks (from `eval` in the screenshot tools)
`window.__sv = { app, frame, pipeline, clock, world, renderer, camera, anchor, presets, goto(name,{instant}),
setTime(iso), setWarp(n), info(), toggleCoorbit(), toggleBallistic(), flyTo(name) }`; `window.__svReady` turns
true 8 frames after loading. `__sv.pipeline.stats()` gives per-pass numbers (particles allocated/drawn, ring
mode, exposure EV, …). Passes are wrapped: `__sv.pipeline.passes.{far,near,rings,post}.inner` — set
`.enabled = false` to measure a pass's cost. Read HDR radiance with
`__sv.renderer.readRenderTargetPixels(__sv.pipeline.ctx.hdrRT, x, y, 1, 1, buf)`.

## Where things live (task → files)
| task | files |
|---|---|
| time, frames, Sun, Saturn rotation, constants, co-orbiting (Hill) frame | `src/core/*` (`ephemeris.ts`, `RingAnchor.ts`, `constants.ts`, `FrameState.ts`) |
| ring optical depth, zones (sizes q/aMin/aMax, thickness H, Σ, albedo, wakes, dust), features | `src/rings/ringRegions.ts`, `src/rings/RingProfile.ts`; data `public/data/rings/` |
| LOD contract (which particles are drawn vs. carried by the medium), self-gravity wakes | `src/rings/RingLod.ts` + `shaders/ringLod.glsl`, `src/rings/WakeField.ts` + `shaders/wakes.glsl` (CPU/GLSL mirrors) |
| individual ring particles (near field) | `src/render/passes/NearFieldPass.ts`, `src/render/near/*` |
| ring medium at all scales, outer rings, spokes | `src/render/passes/RingLayerPass.ts`, `src/render/rings/*` |
| Saturn, moons, stars, Sun | `src/render/passes/FarFieldPass.ts`, `src/render/far/*` |
| exposure, glare, tone mapping | `src/render/PostPass.ts` |
| shared shader code (camera rays, log depth, Saturn, ring profile, lighting/phase functions) | `src/render/shaders/*.glsl`, `chunks.ts` |
| pass order, render targets, local-ring LOD updates | `src/render/Pipeline.ts`, `SharedUniforms.ts` |
| moon ephemerides and rotation | `src/moons/*`; data `public/data/moons/`, rebuilt by `scripts/data/moons/*` |
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
  fidelity (shading, shape, shadows, resolution) may be reduced for performance. Sub-pixel material is carried by
  the continuous medium with exactly the remaining optical depth.
- **One contract, two renderers**: the near field (particles) and the ring layer (medium) must share the LOD
  functions (`ringLod.glsl`) and the particle phase function (`ringParticlePhase` power law in
  `lighting.glsl`); the CPU mirrors (`RingLod.ts`, `WakeField.ts`, `render/rings/phase.ts`, `far/Ringshine.ts`)
  must stay in sync with the GLSL.
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
- Performance: measure with `scripts/shots.mjs --uncapped` and `?fps=0`, **one fresh page load per
  measurement** (several navigations in one tab leave old WebGL contexts alive and roughly halve the fps); GPU
  timer queries are unreliable on ANGLE/Metal. Another agent's browser on the same GPU also skews numbers.
- Vite reloads the page when a GLSL/TS file changes, so screenshots taken while files are being edited can catch
  the loading screen.
- `data-raw/` is git-ignored and not needed at runtime (only by `scripts/data/**`); `public/data/` is committed.
