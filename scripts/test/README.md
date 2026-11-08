# Browser regression tests and tools

Everything here drives the **real app** in headless Google Chrome on the machine's GPU (ANGLE/Metal) through
`puppeteer-core`, reads numbers through the runtime hooks (`window.__sv`, see CLAUDE.md → Runtime hooks) and
fails loudly. **Check this file before writing a new browser tool** — extend an existing one where possible, and
follow [Adding a tool](#adding-a-tool) so the next session can run it too.

| command | what it checks | runtime* |
|---|---|---|
| `npm test` | smoke + physics + counts + seam + exposure + edges against one private dev server; summary table | ~6 min |
| `npm run test:smoke` | every place loads and renders cleanly (errors, fallbacks, NaN / negative pixels) | ~1.5 min |
| `npm run test:physics` | Sun ephemeris, orbital frequencies, near-field particle kinematics | ~15 s |
| `npm run test:counts` | drawn particle counts vs the analytic expectation, HUD count line, radius sampler | ~30 s |
| `npm run test:seam` | near field + medium vs medium alone (seams/arcs), particle flux vs render scale | ~2.2 min |
| `npm run test:fps` | uncapped fps table: places × particle quality (informational) | ~2.5 min |
| `npm run test:exposure` | the camera-pinned astronaut doesn't change the auto exposure (meter mask) | ~45 s |
| `npm run test:edges` | moonlet-perturbed gap edges (streamline map): gaps empty, rendered edges = model, near field follows | ~45 s |
| `node scripts/shot.mjs …` / `node scripts/shots.mjs …` | screenshots (one / batch spec) | — |
| `node scripts/img.mjs profile\|mean\|crop …` | PNG brightness profiles, region ratios, contrast-stretched zooms | — |

\* on an M-class Mac with the GPU to itself; another agent's browser on the same GPU slows everything down.

Exit code 0 = pass, 1 = a check failed (or the harness errored). Every test prints `PASS/FAIL <check> — <value>
(expected lo .. hi)` lines and a table, and writes `<out>/results.json` (all checks with their values) plus
screenshots where useful.

## Running

```sh
npm test                                   # the regression suite (what to run after rendering / physics changes)
npm run test:smoke -- --presets a-ring-30m,overview      # extra args go after `--`
npm run test:seam -- --views arc-repro --out /tmp/seam   # one view, chosen output dir
npm run test:fps -- --presets a-ring-30m --qualities high --secs 6
node scripts/test/physics.mjs --only kinematics --class 9
```

Common options (every test):

- `--base URL` — use a running dev server (e.g. `http://127.0.0.1:5173/`). **Default: none** — the test starts a
  private Vite dev server on a free port with **HMR and file watching off**, so edits by other agents can't reload
  the page mid-measurement (the code is frozen at server start; dependency cache in
  `<os tmp>/space-viz-test-vite-cache/<hash of the checkout path>`, one per checkout / git worktree, so agents
  testing in parallel worktrees don't race on Vite's optimizer cache). With `--base` pointing at the normal dev
  server a reload is possible; the harness retries a load once.
- `--out DIR` — output directory; default `<os tmp>/space-viz-test/<test>-<yyyymmdd-hhmmss>` (printed at start).
- `--w / --h` — browser viewport (display pixels; the app renders at its render scale, default 0.5).
- `--help` — usage line.

Requirements: Google Chrome at `/Applications/Google Chrome.app/…` or `CHROME_PATH`; `npm install` done
(puppeteer-core, vite). Tests use their own headless browser profile; localStorage is cleared before every page
load (see pitfalls).

## The tests

### smoke — `scripts/test/smoke.mjs`
Every preset in `__sv.presets` (or `--presets a,b`), fresh page each, `?preset=<id>&t=2026-11-07T20:00:00Z&
paused=1&hud=0&labels=0` (+ `--params "k=v&…"`), **default settings** otherwise (astronaut on, render scale 0.5,
quality high). After `--settle` ms (2500) it screenshots `<out>/<id>.png` and **fails** on: any console error or
warning (WebGL errors, shader compile errors and GuardedPass fallbacks are logged there), an uncaught page
error, a failed request / HTTP ≥ 400, `gl.getError() ≠ 0`, a pass not in state `ok` (`app.loaded.guards`), or
NaN / negative values in `sceneRT` / `hdrRT`. Reported per preset: where the camera is, `rings.mode`,
`near.drawn`, `near.count`, `post.EV`, the number of blue/green-dominated pixels in the displayed image
(informational — stars, the E ring and parts of Saturn are legitimately bluish) and pixels brighter than
1e3 W m⁻² sr⁻¹ (the Sun's disk and glints only). Expected: all presets clean (19/19 on 2026-11-07; the first
run caught tiny negative radiances from the F-ring line profiles, since fixed).

### physics — `scripts/test/physics.mjs` (`--only ephemeris,orbits,kinematics`)
1. **ephemeris**: Sun elevation above the ring plane (`asin(frame.sunDir.z)`): equinoxes 2009-08-11 and
   2025-05-06 → 0 ± 0.1° (measured 0.007°, 0.002°), solstice 2017-05-24 → 26.7 ± 0.3° (26.73°),
   2026-11-07T12Z → −8.205 ± 0.02° (regression value).
2. **orbits**: `frame.ring` Ω, κ, ν at the anchor vs an independent evaluation of the oblate-Saturn
   frequencies (GM, R_ref = 60,330 km, J2, J4, J6; relative error ≤ 1e-6), q vs −dlnΩ/dlnr (≤ 1e-4), and the
   orbital period at the orbits of Pan (133,584 km: 0.575050 d) and Daphnis (136,505 km: 0.594080 d) within
   2e-4 (measured 13.80114 h vs 13.80120 h, 14.25782 h vs 14.25792 h).
3. **kinematics** (`--place a-ring-30m`, `--class K` default: the class with the most slots and a box ≥ 50 m,
   `--dts 30,600,-600,20000`): near-field particle positions read back from the R0 texture at t₀ and t₀+dt with
   **wakes off** (`wakes=0` — the wake displacement field evolves and adds to dx, dy). Least-squares shear slope
   of dy vs x = −qΩdt (ratio 1 ± 0.002; measured 1.00000); rms radial / vertical / non-shear azimuthal
   displacement vs 2|sin(κdt/2)|σx, 2|sin(νdt/2)|σz, |qΩdt cos(κdt/2) − 4(Ω/κ) sin(κdt/2)| σx (the shear is
   removed at the instantaneous x but acts on the guiding centre) — ratios 0.95 … 1.05 (measured 0.994 … 1.002).
   For |qΩdt| > 0.25 the boxes wrap azimuthally, so only dx and dz are checked (dt = 20000 s: κdt ≈ 2.5 rad).

### counts — `scripts/test/counts.mjs`
1. **drawn vs expected** at `--places a-ring-30m,a-ring-1km,cassini-division` (astronaut off, statistical
   occlusion culling switched off for the comparison): particles of a class in the R0 read-back that are drawn
   and ≥ 0.5 display px in radius, vs a Monte Carlo of n_k(a) τ_macro(r) over the class box, the Gaussian layer
   height, the class's power-law radii and the view frustum with the same ≥ 1 px condition (`--mc 400000`
   samples). Tolerance 1 ± max(4/√expected, 0.04) for the `--classes 4` classes with the most expected particles
   (≥ 300). Measured ratios 0.989 … 1.033 (Poisson-consistent).
2. **HUD count line** (`near.count`) starts with `complete` at those places; above the dense B ring
   (`--heights 100,1000,5000` m) it states the status explicitly — `complete…` or `DEFICIT: ~x% …` (measured: a
   0.3 % deficit at 100 m with the 12M-slot cap binding, complete at 1 and 5 km).
3. **radius sampler**: the per-class radius/box sampler (`RingLod.pieceP/pieceB`, mirrored from `nearRadiusBox`
   in `nearCommon.glsl`) reproduces the target density τmax a⁻ᵠ/(π I₂) in every radius bin: |ratio − 1| ≤ 0.02
   when the slot cap does not bind (measured 2e-5).

### seam — `scripts/test/seam.mjs` (`--only seam,flux`, `--views id,…`)
1. **seam**: per view, mean HDR radiance (`hdrRT`, after the ring layer and before glare / tone mapping, so
   exposure doesn't matter) in horizontal strips over the view's ring rows, averaged over `--realizations 6`
   particle / wake realizations (the frame anchor id is bumped to re-seed), with the near field on and off
   (`nearField=0`: the medium carries all optical depth). Checks: every strip ratio in [0.85, 1.15]; the largest
   step between neighbouring strips ≤ 0.06 (an arc / seam is a step the medium-only image does not have; the arc
   fixed in Nov 2026 was ≈ 0.1); blue/green-dominated pixels in the ring rows ≤ 0.2 %. Screenshots
   `<view>-near.png` / `<view>-medium.png`.

   | view | rows | measured ratios | max step (limit) | notes |
   |---|---|---|---|---|
   | `arc-repro` | 0.42–1.0 | 0.972 … 1.005 | 0.012 (0.06) | the user-reported arc: 2 km above the unlit A ring, yaw 60, pitch −22 |
   | `a-ring-1km` | 0.25–1.0 | 0.928 … 1.035 | 0.044 (0.06) | preset |
   | `a-ring-30m` | 0.35–0.78, 6 strips | 0.952 … 1.019 | 0.056 (0.08) | few large particles per strip → realization noise ±5 % |
   | `lit-500m` | 0.0–0.55 | 0.914 … 0.967 | 0.019 (0.06) | 500 m below the lit A ring looking up; particles 3–9 % darker than the medium near the camera |
   | `under-rings` | 0.0–0.45 | 0.974 … 1.080 | 0.075 (0.09) | known: unlit-face particles ~5–8 % brighter than the medium → soft step where the particle range ends |
2. **flux**: particle-only flux (ring layer pass disabled) in the near strips of `a-ring-30m` at render scale
   0.5 vs 1, 4 realizations: sub-pixel particles are rasterized differently at the two scales but the expected
   flux must not change — ratio 1 ± 0.08 (measured 0.983).

The near-field photometry offsets in the table (particles a few % darker on the lit face near the camera,
5–8 % brighter on the unlit face) are the current state, not targets: tighten the limits when they are fixed.

### fps — `scripts/test/fps.mjs` (informational unless `--min-fps N`)
`--presets` (overview, a-ring-1km, a-ring-30m, a-ring-inside, b-ring-inside, c-ring-inside) × `--qualities
high,medium,low`, **one fresh page per cell** with `?fps=0` in a browser without vsync / frame-rate limit (the app
caps at 30 fps by default), 1920×1080, warm-up `--warmup 2500` ms, then requestAnimationFrame callbacks counted for
`--secs 4`. Writes `<out>/fps.json`. Numbers drop when another browser uses the GPU — compare runs made under the
same conditions. Reference (2026-11-07, 1920×1080, render scale 0.5, high / medium / low): overview ~695,
a-ring-1km 171 / 178 / 178, a-ring-30m 104 / 107 / 113, a-ring-inside 120 / 132 / 143, b-ring-inside
73 / 83 / 94, c-ring-inside 279 / 283 / 290 fps.

### exposure — `scripts/test/exposure.mjs` (`--presets id,…`, `--tol EV`, `--settle ms`)

The astronaut is left out of the auto-exposure meter: `AstronautPass` writes `ctx.meterMask` (its visible pixels)
and PostPass's meter reads the scene mirrored across the astronaut's bounding box for those pixels, so the
pixel population is as if it weren't there. For each preset the app is loaded with `astronaut=1` and `=0` (fresh
pages, paused, `t=` fixed, 1920×1080) and post.EV compared. Checks: |EV on − EV off| ≤ 0.1 EV (the meter's
half-stop histogram is interpolated, so residuals are ≲ 0.1), mask live only while shown, no errors. Measured
2026-11-07: 0.00 EV at overview, a-ring-30m, enceladus, cloud-tops (default set) and at a-ring-inside,
b-ring-inside, a-ring-1km, shadow, rings-above; 0.10 at under-rings. ~45 s.

### edges — `scripts/test/edges.mjs` (`--views keeler-0,keeler-out,keeler-in,encke-out,encke-in,near-crest`, `--t ISO`)

The Encke / Keeler gap edges perturbed by Pan / Daphnis through the shared streamline map (`sv_ringStructure`,
docs/ring-physics.md §8), at `t` = 2026-11-08T12:00Z. Five views look straight down on the gaps (`cam=ring`, sheet
regime, `scale=1`, near field and wakes off, sub-km fine noise off): centred on Daphnis (both edges, encounter
region), one wavelength downstream on either side, and Pan's outer / inner edge 375 km downstream. The ring-layer
debug views 7 and 9 give (r, τ, θ) per pixel, compared with the CPU mirror (`__sv.pipeline.ctx.structure`):

| check | tolerance | measured (2026-11-08) |
|---|---|---|
| τ inside the gap, a' > 1.5 km from the unperturbed edges | ≤ 0.05, and ≤ 0.01 above the profile's own τ0(a') J there (gap floor ≤ 0.015, dusty Encke-gap ringlets ≤ 0.025; the old Eulerian lookup: ~0.5 slivers) | max 0.008–0.025, excess ≤ 0.0085 |
| median τ_rendered / (τ0(a') J) in the ring (> 1.5 km from the edges) | 0.95 … 1.05 | 0.9999–1.004 |
| edge RMS(rendered − model ξ(a'_edge, θ)) per azimuth bin | ≤ max(0.25 km, 1.5 footprints) | Keeler 0.05–0.08 km (fp 0.13), Encke 0.16 / 0.39 km (fp 0.39) |
| edge max \|rendered − model\| | ≤ 0.75 km + 2 footprints | Keeler ≤ 0.17 km, Encke ≤ 0.45 km |
| displacement range rendered / model (where the model range ≥ 1 km) | 0.85 … 1.15 | 0.93–1.01 |
| peak outer Keeler edge displacement, first ~80 km behind Daphnis | 2.5 … 4.0 km (Hill response at b = 3.5: 3.2–3.5 km circular moonlet) | 2.71 km (model 2.76) |
| NaN / negative pixels (normal render), console / GL errors, passes ok | none | none |
| near-crest: particles ≥ 1 px over material displaced 2.8 km into the unperturbed gap, 30 m above | ≥ 1000 | 53.5k |
| near-crest: the same with straight edges (`edgeWaveScale` 0, camera then over the gap) / with the map | ≤ 0.05 | 0 |
| near-crest: lower-half radiance near field + medium / medium alone | 0.8 … 1.25 — checked once `nearDraw.vert.glsl` lights particles through `ringSampleLocal` (informational before) | 2.44 now; 1.11 with that one-line change |

Screenshots `<view>.png`, `near-crest.png`, `near-crest-straight-edges.png`; per-view numbers in `results.json`. ~45 s.

## Tools

- `scripts/shot.mjs <url> <out.png> [--until expr] [--eval expr] [--wait ms] [--w --h --dpr] [--keep-storage]` —
  one screenshot, prints every console message / page error / failed request; exit 2 on a page error.
- `scripts/shots.mjs <spec.json> <outDir> [--w --h] [--uncapped] [--base URL] [--keep-storage]` — batch: spec
  `{ base?, until, shots: [{ name, url, eval?, wait?, reload? }] }`; shots with the same URL reuse the page
  (`eval` can change settings between them). Without a reachable `base` (spec or `--base`) it starts a private
  server, so specs with relative URLs run anywhere. Example spec: `scripts/test/specs/astronaut.json` (the
  astronaut overlay in several places, fov 25/100, and the V key toggle). `scripts/test/specs/cassini-compare.json`:
  views matched to Cassini images for before/after checks of ring morphology — A/B-ring particle close-ups,
  the 1 km wake view with and without the near field, Daphnis in the Keeler gap with and without edge waves
  (`edgeWaveScale` 0), Daphnis and Pan close-ups, the Keeler gap and the B-ring edge at the 2009 equinox. The
  orbit-camera `az` values put the Sun ~30–40° to the side on those dates (Sun azimuth 61° on 2026-11-08,
  −136° in Aug 2009).
- `scripts/img.mjs profile <x0> <x1> <y0> <y1> <step> a.png b.png …` — vertical brightness + texture profile of
  a column strip in several screenshots side by side (find seams); `mean a.png b.png "x0,y0,x1,y1" …` — region
  means and ratio; `crop out.png x0 y0 w h scale gain a.png b.png …` — stacked, upscaled, contrast-stretched
  crops (gain 3 makes 1 % seams visible). View PNGs with the Read tool.
- `scripts/meter-debug.mjs "<url or ?query>" [--base URL] [--settle ms]` — auto-exposure meter intermediates for
  one view (scene-meter 90th percentile + lit coverage, highlight meter region / extended / peak, metered
  luminance, EV, share of the frame under the astronaut's meter mask). For tuning / debugging exposure.

## Library — `scripts/test/lib.mjs`

| helper | does |
|---|---|
| `withHarness(name, { bool, w, h, uncapped, usage }, async ({ args, out, rep, base, browser }) => …)` | arg parsing, output dir, server, browser, report, exit code — the skeleton of every test |
| `parseArgs(argv, { bool })` → `{ _, str, num, flag, list, has }` | CLI options (`--k v`, `--k=v`, boolean flags) |
| `outputDir(name, dir)`, `writeJson`, `table`, `fmt`, `Report` (`check`, `range`, `error`, `data`, `finish`) | output and bookkeeping (`results.json`) |
| `startServer({ base })` | reuse `base` if it answers, else a private Vite server (no HMR / watching) on a free port |
| `launchBrowser({ w, h, dpr, uncapped })` | headless Chrome on the GPU (`CHROME_ARGS`, `UNCAPPED_ARGS`) |
| `openApp(browser, base, params, { path, settle, keepStorage })` → `{ page, errs, url }` | fresh page (localStorage cleared), URL with params, waits for `__svReady`, retries once |
| `captureErrors(page, { ignore, echo, echoAll })`, `problems(page, errs)` | console errors/warnings, page errors, failed requests, HTTP ≥ 400, `gl.getError()`, passes not `ok` |
| `getStats`, `getInfo`, `passStatus`, `glErrors`, `waitFrames`, `simTime`, `setSimTime(page, tOrIso)` | in-page reads / time control (pauses the clock) |
| `setSetting(page, key, value)`, `setPassEnabled(page, 'near'\|'rings'\|…, on)`, `gotoPreset(page, id)` | change settings like the panel does, toggle passes via `.inner`, jump to a place |
| `hdrMeans(page, rects, channel)`, `strips(y0, y1, n)` | mean HDR radiance of screen rectangles (fractions, y from the top) from `pipeline.ctx.hdrRT` |
| `renderTargetScan(page)`, `canvasChroma(page, rect)` | NaN / negative / huge pixels in sceneRT, hdrRT; unnatural-hue pixels of the displayed image |
| `measureFps(browser, base, params, { secs, warmup })` | uncapped fps of one view on a fresh page |
| `decodePng`, `encodePng`, `pngLumaMean` | dependency-free PNG I/O for screenshot analysis |
| `retry(fn, { tries })`, `sleep`, `REPO`, `T_STD` | misc |

## Pitfalls (learned the hard way)

- **Pin everything in the URL** that a measurement depends on: `t=` (sun geometry), `paused=1`, `astronaut=0`
  for photometry / counts, `scale=`, `quality=`, `nearField=`, `wakes=`, `hud=0&labels=0`. Settings persist in
  localStorage (the V key saves the astronaut toggle) and pages of one browser share it — `openApp`, `shot.mjs`
  and `shots.mjs` clear it before each page load (opt out with `keepStorage` / `--keep-storage`).
- **fps**: `?fps=0` (the app caps at 30 fps) + an uncapped browser + **one fresh page per measurement** (several
  navigations in one tab leave old WebGL contexts alive and roughly halve the fps). GPU timer queries are
  unreliable on ANGLE/Metal. Another browser on the GPU skews numbers.
- Passes are wrapped in `GuardedPass`: pass internals are at `__sv.pipeline.passes.<name>.inner` (`near`,
  `rings`, `far`, `post`, `overlay` = astronaut). A failing pass is replaced by a stub and the app keeps running —
  that's why smoke fails on console errors and on `passStatus()` ≠ ok.
- Read **linear radiance** from `pipeline.ctx.hdrRT` (exposure-independent) rather than screenshots when comparing
  brightness; the render targets are at the render scale (default 0.5 × display). Screenshots are tone-mapped with
  auto exposure — two screenshots of different scenes are not comparable in absolute terms.
- Particle statistics are noisy near the camera: average over realizations (bump `__sv.anchor.anchorId` to
  re-seed particles and wakes) rather than over time (nearby particles barely move), and keep strips away from
  the few metre-sized boulders closest to the camera.
- After `__svReady`, allow ~1.5–2.5 s for the particle allocation, the wake clipmap and exposure to settle.

## Adding a tool

1. **Where**: browser tests / regression checks → `scripts/test/<name>.mjs`; general utilities (screenshots, image
   comparison, inspection) → `scripts/<name>.mjs`; data build / verification → `scripts/data/<topic>/`.
2. **Shape** (copy an existing test):
   ```js
   #!/usr/bin/env node
   // <What it checks, why, expected values / tolerances.>
   // usage: node scripts/test/<name>.mjs [--base URL] [--out DIR] [...own options]
   import { openApp, hdrMeans, strips, withHarness } from './lib.mjs';
   await withHarness('<name>', { usage: '...' }, async ({ args, out, rep, base, browser }) => {
     const { page, errs } = await openApp(browser, base, { preset: 'a-ring-1km', t: '2026-11-07T20:00:00Z', paused: 1, hud: 0, labels: 0, astronaut: 0 }, { settle: 2000 });
     const [v] = await hdrMeans(page, strips(0.5, 1, 1));
     rep.range('mean radiance of the lower half', v, 0.1, 1, ' W/m2/sr');
     rep.data.value = v;            // anything worth keeping goes to results.json
     await page.close();
   });
   ```
   CLI arguments instead of hard-coded paths / URLs, an `--out` directory (default under the OS temp dir via
   `withHarness`), a usage header comment, explicit expected values and tolerances with the reason for each, a
   printed table of the measured values. Use the lib helpers (don't re-implement browser launch, error capture,
   HDR readback or PNG decoding). Fail on what must not happen; keep informational numbers informational.
3. **Register**: add `"test:<name>": "node scripts/test/<name>.mjs"` to `package.json`; if it is a regression
   check that should run after every relevant change, add it to the default list in `scripts/test/run.mjs` (=
   `npm test`) — keep `npm test` passing on a correct tree and under ~10 min.
4. **Document**: a section in this README (what, how to run, tolerances, measured values, runtime) and a row in
   the table at the top; keep CLAUDE.md's command list in sync. Run it on the current code and report the numbers.
