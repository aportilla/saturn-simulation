# Browser regression tests and tools

Everything here drives the **real app** in headless Google Chrome on the machine's GPU (ANGLE/Metal) through
`puppeteer-core`, reads numbers through the runtime hooks (`window.__sv`, see CLAUDE.md → Runtime hooks) and
fails loudly. **Check this file before writing a new browser tool** — extend an existing one where possible, and
follow [Adding a tool](#adding-a-tool) so the next session can run it too.

| command | what it checks | runtime* |
|---|---|---|
| `npm test` | smoke + physics + counts + seam (incl. handover) + exposure + edges + moonflux + particles + propellers against one private dev server; summary table | ~9 min |
| `npm run test:smoke` | every place loads and renders cleanly (errors, fallbacks, NaN / negative pixels) | ~1.5 min |
| `npm run test:physics` | Sun ephemeris, orbital frequencies, near-field particle kinematics | ~15 s |
| `npm run test:counts` | drawn particle counts vs the analytic expectation, HUD count line, radius sampler | ~30 s |
| `npm run test:seam` | near field + medium vs medium alone (seams/arcs), particle flux vs render scale, the medium's wake representations vs a reference field across the march → sheet handover | ~3.2 min |
| `npm run test:fps` | uncapped fps table: places × particle quality (informational) | ~2.5 min |
| `npm run test:exposure` | the camera-pinned astronaut doesn't change the auto exposure (meter mask) | ~45 s |
| `npm run test:edges` | gap edges perturbed by moonlets and the B-ring edge modes (streamline map): gaps empty, rendered edges = model, near field follows | ~50 s |
| `npm run test:moonflux` | point-source flux of unresolved moons = resolved brightness (measured shapes + ellipsoid control) | ~10 s |
| `npm run test:particles` | resolved-particle photometry and shape contract: GLSL vs CPU mirrors, factor LUT, relief area / photometry | ~20 s |
| `npm run test:propellers` | propeller moonlets and the sub-km τ texture: named positions vs Tiscareno 2010 Table 1, texture statistics, footprint prefilter, GPU τ vs the CPU model, near-field presence and its cost gate, moonlet bodies | ~1 min |
| `node scripts/shot.mjs …` / `node scripts/shots.mjs …` | screenshots (one / batch spec) | — |
| `node scripts/img.mjs profile\|mean\|crop\|rotate …` | PNG brightness profiles, region ratios, contrast-stretched zooms, rotate/scale | — |

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
   samples), with τ_macro × the 2-D modulation M of `sv_ringStructure` at each sample (sub-km texture, propellers:
   CPU mirror `structure.tauModAt`; presence follows τ0 J M). Tolerance 1 ± max(4/√expected, 0.04) for the
   `--classes 4` classes with the most expected particles (≥ 300). Measured ratios 0.997 … 1.031 (Poisson-consistent).
2. **HUD count line** (`near.count`) starts with `complete` at those places; above the dense B ring
   (`--heights 100,1000,5000` m) it states the status explicitly — `complete…` or `DEFICIT: ~x% …` (measured: a
   9.2 % deficit at 100 m with the 12M-slot cap binding — 0.3 % before the sub-km texture raised the allocation
   bound by its maximum factor 1.43 in the B-ring core — complete at 1 and 5 km).
3. **radius sampler**: the per-class radius/box sampler (`RingLod.pieceP/pieceB`, mirrored from `nearRadiusBox`
   in `nearCommon.glsl`) reproduces the target density τmax a⁻ᵠ/(π I₂) in every radius bin: |ratio − 1| ≤ 0.02
   when the slot cap does not bind (measured 2e-5).

### seam — `scripts/test/seam.mjs` (`--only seam,flux,handover`, `--views id,…`)
1. **seam**: per view, mean HDR radiance (`hdrRT`, after the ring layer and before glare / tone mapping, so
   exposure doesn't matter) in horizontal strips over the view's ring rows, averaged over `--realizations 6`
   particle / wake realizations (the frame anchor id is bumped to re-seed), with the near field on and off
   (`nearField=0`: the medium carries all optical depth). Checks: every strip ratio in [0.85, 1.15]; the largest
   step between neighbouring strips ≤ 0.06 (an arc / seam is a step the medium-only image does not have; the arc
   fixed in Nov 2026 was ≈ 0.1); blue/green-dominated pixels in the ring rows ≤ 0.2 %. Screenshots
   `<view>-near.png` / `<view>-medium.png`.

   | view | rows | measured ratios | max step (limit) | notes |
   |---|---|---|---|---|
   | `arc-repro` | 0.42–1.0 | 1.000 … 1.015 | 0.006 (0.06) | the user-reported arc: 2 km above the unlit A ring, yaw 60, pitch −22 |
   | `a-ring-1km` | 0.25–1.0 | 0.899 … 0.985 | 0.024 (0.06) | preset; particles 2–10 % darker than the medium (see below) |
   | `a-ring-30m` | 0.35–0.78, 6 strips | 0.913 … 1.022 | 0.095 (0.10) | few large particles per strip → realization noise ±5 %; grazing far strip ~9 % particle deficit (below) |
   | `lit-500m` | 0.0–0.55 | 0.887 … 0.945 | 0.021 (0.06) | 500 m below the lit A ring looking up; particles 5–11 % darker than the medium |
   | `under-rings` | 0.0–0.45 | 0.959 … 1.011 | 0.016 (0.09) | unlit face from below (the former +5–8 % particle excess is gone, limit kept) |

   Measured 2026-11-08 after the sun-path fix (before: arc-repro 0.972 … 1.005 / 0.012, a-ring-1km 0.928 … 1.035 /
   0.044, a-ring-30m 0.952 … 1.019 / 0.056, lit-500m 0.914 … 0.967 / 0.019, under-rings 0.974 … 1.080 / 0.075). The
   particles' and the medium's statistical sun paths used 2 fixed wake-density samples that brightened both by up to
   ~25 % (most for mid-plane boulders); with the shared stratified nodes both are unbiased, the unlit-face particle
   excess vanished, and what remains on the lit face (particles darker than the medium) is mostly the clipmap
   prefilter excess of the medium's explicit field (handover, known residual 1); in the grazing far strip of
   `a-ring-30m` the medium barely changed (its visible top layer has short sun paths) while the boulders darkened
   ~22 %.
2. **flux**: particle-only flux (ring layer pass disabled) in the near strips of `a-ring-30m` at render scale
   0.5 vs 1, 4 realizations: sub-pixel particles are rasterized differently at the two scales but the expected
   flux must not change — ratio 1 ± 0.08 (measured 0.983).
3. **handover** (`--only handover`, `--hviews id,…`, `--hstrips 13`, `--hreal 1`): the medium's own wake
   representations, near field and far field off, each forced through the ring-layer pass's test hook
   (`uRlForce` in rlMarch.glsl, installed after the pass's update every frame): `explicit` (march, clipmap wake field
   with the prefilter correction), `stat` (march, statistical branch), `sheet` (far-field sheet everywhere),
   `default` (production blend) and `reference` (the shared `wakeDensity` evaluated at every march step and at 12
   stratified sun-path nodes: no clipmap prefilter — the field the particles follow). Per view, 13 strips × two
   column regions (left / right half: typically along / across the wakes): reflected radiance L (debug view 0,
   far pass off) and transmission T (debug view 2); the march weight wM (debug view 12) marks the **handover band**
   (0.02 < wM < 0.98), strips outside the clipmap's coverage (wake source from debug view 12) are excluded. Checks in
   the band: sheet / reference within 1 ± 0.08 (L) and 0.06 (T); explicit / reference T within 0.06, L within 0.22
   (known prefilter excess, below); stat / sheet within 0.03; production / reference step between neighbouring band
   strips ≤ 0.04 (a seam where the representations meet). Per-view overrides (with their reason) in
   `HANDOVER_VIEWS`. ~55 s.

   | view (region) | L sheet/ref | L expl/ref | L stat/sheet | L step | T sheet/ref | T expl/ref | T stat/sheet | T step |
   |---|---|---|---|---|---|---|---|---|
   | `a-ring-1km` along | 0.988 … 1.001 | 1.082 … 1.128 | 1.001 … 1.002 | 0.031 | 1.010 … 1.032 | 1.000 … 1.016 | 0.998 … 1.001 | 0.016 |
   | `a-ring-1km` across | 1.040 … 1.048 | 1.027 … 1.033 | 1.002 … 1.003 | 0.008 | 0.983 … 1.049 | 0.895 … 0.980 (0.12) | 0.986 … 1.010 | 0.030 |
   | `a-1km-yaw120` left | 1.144 … 1.170 (0.18) | 1.052 … 1.068 | 0.940 … 0.992 (0.07) | 0.029 | 0.870 … 1.009 (0.15) | 0.873 … 0.982 (0.15) | 0.987 … 1.017 | 0.041 (0.05) |
   | `a-1km-yaw120` right | 1.034 … 1.053 | 1.133 … 1.196 | 0.996 … 0.999 | 0.038 | 1.004 … 1.022 | 1.030 … 1.049 | 0.996 … 1.002 | 0.015 |
   | `unlit-2km` left | 0.912 … 0.965 (0.12) | 1.093 … 1.113 | 1.006 … 1.007 | 0.019 | 1.010 … 1.051 | 0.998 … 1.009 | 1.000 … 1.001 | 0.012 |
   | `unlit-2km` right | 0.998 … 1.021 | 1.073 … 1.088 | 1.002 … 1.007 | 0.016 | 1.039 … 1.068 (0.08) | 0.980 … 0.992 | 0.999 … 1.001 | 0.024 |

   Measured 2026-11-08 (limits in parentheses where a view overrides the default). Before the Nov 2026 fix (same
   view, diagnostic probes): the explicit field was 15–26 % brighter than a 32-node sun-path reference (two fixed
   sun-path samples: through the convexity of exp(−τWs/μ0) their variance leaks into the mean), the statistical
   transmission 0.60–0.87 of the explicit one across the wakes (the two-column means decorrelated far too fast),
   the clipmap's explicit transmission 0.57–0.97 of the unfiltered field (density prefilter), and `wakeDensity`
   carried only ~88 % of the particles' mass (folds of the forward map missed by the single-branch inverse).
   **Known residuals**: (1) the clipmap's density prefilter makes the explicit field's *reflection* 3–20 % too bright
   — the wake cores are ~4 m wide (0.1 λ), so even 2–4 m texels spread core material into well-lit gap edges (the
   sub-texel anti-correlation of density and illumination is lost; with the density taken directly and the sun
   path from the clipmap the excess disappears, 0.993–0.996): a fix needs resolved cores or a sub-texel model;
   (2) the two-column *reflection* model (uRlWakeHeff) is within ~5 % at low phase but 10–17 % off at high phase
   along the wakes (yaw120) and on the unlit face along them; (3) at the band's grazing far end the homogeneous
   march and sheet already differ by up to ~6 % at high phase (base radiative transfer).

The near-field photometry offsets in the seam table (particles 2–11 % darker than the medium on the lit face, ~9 %
in the grazing far strip of `a-ring-30m`) and the handover residuals are the current state, not targets: tighten
the limits when they are fixed.

### fps — `scripts/test/fps.mjs` (informational unless `--min-fps N`)
`--presets` (overview, a-ring-1km, a-ring-30m, a-ring-inside, b-ring-inside, c-ring-inside) × `--qualities
high,medium,low`, **one fresh page per cell** with `?fps=0` in a browser without vsync / frame-rate limit (the app
caps at 30 fps by default), 1920×1080, warm-up `--warmup 2500` ms, then requestAnimationFrame callbacks counted for
`--secs 4`. Writes `<out>/fps.json`. Numbers drop when another browser uses the GPU — compare runs made under the
same conditions. Reference (2026-11-07, 1920×1080, render scale 0.5, high / medium / low): overview ~695,
a-ring-1km 171 / 178 / 178, a-ring-30m 104 / 107 / 113, a-ring-inside 120 / 132 / 143, b-ring-inside
73 / 83 / 94, c-ring-inside 279 / 283 / 290 fps.

**A/B mode** (`--ab-off "<js>" --ab-on "<js>"`, `--rounds 6`, `--ab-settle 400`): the cost of a feature toggle in
the same page — rounds of off / on in ABBA order, each measured for `--secs`; prints ms per frame off / on and the
difference ± its standard error. Steadier than comparing fresh pages on a shared GPU. Example (sub-km texture and
propellers): `--ab-off "s=__sv.pipeline.ctx.structure;s.texture.amp=0;s.propellers.scale=0"` /
`--ab-on "…amp=1;…scale=1"`; add `;__sv.pipeline.lastModKey='force'` to both and `--ab-settle 3000` to include
the near-field allocation bound (the local LOD re-fits within 60 frames).

### exposure — `scripts/test/exposure.mjs` (`--presets id,…`, `--tol EV`, `--settle ms`)

The astronaut is left out of the auto-exposure meter: `AstronautPass` writes `ctx.meterMask` (its visible pixels)
and PostPass's meter reads the scene mirrored across the astronaut's bounding box for those pixels, so the
pixel population is as if it weren't there. For each preset the app is loaded with `astronaut=1` and `=0` (fresh
pages, paused, `t=` fixed, 1920×1080) and post.EV compared. Checks: |EV on − EV off| ≤ 0.1 EV (the meter's
half-stop histogram is interpolated, so residuals are ≲ 0.1), mask live only while shown, no errors. Measured
2026-11-07: 0.00 EV at overview, a-ring-30m, enceladus, cloud-tops (default set) and at a-ring-inside,
b-ring-inside, a-ring-1km, shadow, rings-above; 0.10 at under-rings. ~45 s.

### edges — `scripts/test/edges.mjs` (`--views keeler-0,keeler-out,keeler-in,encke-out,encke-in,b-edge-90,b-edge-180,near-crest`, `--t ISO`)

The Encke / Keeler gap edges perturbed by Pan / Daphnis and the B-ring outer edge's normal modes through the shared
streamline map (`sv_ringStructure`, docs/ring-physics.md §8–9), at `t` = 2026-11-08T12:00Z. Seven views look straight
down (`cam=ring`, sheet regime, `scale=1`, near field and wakes off, sub-km texture and propellers off:
`structure.texture.amp = 0`, `structure.propellers.scale = 0`): centred on Daphnis (both
edges, encounter region), one wavelength downstream on either side, Pan's outer / inner edge 375 km downstream, and
the B-ring edge at longitudes 90° / 180° (where the modes move it by +72 / −77 km). The ring-layer
debug views 7 and 9 give (r, τ, θ) per pixel, compared with the CPU mirror (`__sv.pipeline.ctx.structure`):

| check | tolerance | measured (2026-11-08) |
|---|---|---|
| τ inside the gap, a' > 1.5 km from the unperturbed edges | ≤ 0.05, and ≤ 0.01 above the profile's own τ0(a') J there (gap floor ≤ 0.015, dusty Encke-gap ringlets ≤ 0.025; the old Eulerian lookup: ~0.5 slivers) | max 0.008–0.025, excess ≤ 0.0085 |
| median τ_rendered / (τ0(a') J) in the ring (> 1.5 km from the edges) | 0.95 … 1.05 | 0.9999–1.004 |
| edge RMS(rendered − model ξ(a'_edge, θ)) per azimuth bin | ≤ max(0.25 km, 1.5 footprints) | Keeler 0.05–0.08 km (fp 0.13), Encke 0.16 / 0.39 km (fp 0.39) |
| edge max \|rendered − model\| | ≤ 0.75 km + 2 footprints | Keeler ≤ 0.17 km, Encke ≤ 0.45 km |
| displacement range rendered / model (where the model range ≥ 1 km) | 0.85 … 1.15 | 0.93–1.01 |
| peak outer Keeler edge displacement, first ~80 km behind Daphnis | 2.5 … 4.0 km (Hill response at b = 3.5: 3.2–3.5 km circular moonlet) | 2.71 km (model 2.76) |
| B-ring outer edge (`b-edge-90`, `b-edge-180`, 3,000 km above, footprint 3.9 km): de-projected edge at the mean radius; \|displacement\| rendered / model (S&P 2010 modes) | 0.9 … 1.1; RMS ≤ 1.5 footprints | edge 117,568.00 km; 73.2 / 72.5 km (1.01) and 80.2 / 77.6 km (1.03); RMS 3.9 / 1.6 km |
| NaN / negative pixels (normal render), console / GL errors, passes ok | none | none |
| near-crest: particles ≥ 1 px over material displaced 2.8 km into the unperturbed gap, 30 m above | ≥ 1000 | 53.5k |
| near-crest: the same with straight edges (`edgeWaveScale` 0, camera then over the gap) / with the map | ≤ 0.05 | 0 |
| near-crest: lower-half radiance near field + medium / medium alone | 0.8 … 1.25 — checked once `nearDraw.vert.glsl` lights particles through `ringSampleLocal` (informational before) | 2.44 now; 1.11 with that one-line change |

Screenshots `<view>.png`, `near-crest.png`, `near-crest-straight-edges.png`; per-view numbers in `results.json`. ~50 s.

### moonflux — `scripts/test/moonflux.mjs` (`--moons Pan,…`, `--tol`, `--tol-ellipsoid`, `--px`, `--t ISO`)
A moon below ~1–2.5 px radius is a point source whose irradiance `far/MoonPoints.ts` integrates with sunflower rays
over the moon's bounding disk through the resolved renderer's shading (256 rays for measured shapes, 64 for
ellipsoids). Per moon (default: the 7 measured shapes + Mimas as ellipsoid control): a resolved view (~120 px radius,
10° fov, 70° below the ring plane so Saturn and the rings stay out of the frame; ring layer, near field, stars off)
with the resolved/point cross-fade weight forced to 0.5 so the flux step runs; E_res = far-pass sceneRT radiance
integrated over the bounding circle / 0.5, E_flux = the moon's flux-target row sum. Checks: ratio within 1 ± 0.08
(measured shapes) / 1 ± 0.10 (ellipsoids: the pre-existing 64-ray sampling); no errors. Measured 2026-11-08: Pan
0.9995, Daphnis 0.970, Atlas 1.026, Prometheus 0.972, Pandora 0.973, Epimetheus 0.967, Janus 0.986, Mimas 1.070. It
guards the bounding radius r_max (Pan's / Atlas's ridges reach 3–4 km beyond their IAU ellipsoids) and the ray count.

### particles — `scripts/test/particles.mjs` (`--only regolith,relief,photometry,anisotropy`, `--bodies`, `--dirs`)
The near field's resolved particles (regolith law, factor LUT, relief: `src/render/near/NearRegolith.ts`,
`NearRelief.ts`, `nearCommon.glsl`). The CPU mirrors run in the page (dynamic `import()` through the Vite server), the
GLSL in a separate WebGL2 context of the same page (the chunks compiled as raw GLSL), so both sides are the shipped
code.
1. **regolith**: on a 64×64 grid, GLSL `ringRegolithIF` vs the CPU `regolithIF` (rel. ≤ 1e-3 where I/F > 1e-3;
   measured 4.3e-6), `extendedSourceCosine` (abs. ≤ 2e-4; 3e-7), `nearRegolithFactor` = the LUT lookup (rel. ≤ 3e-3,
   the GPU's 8-bit filter weights; 4e-4). The contract between the LUT nodes: f(α, A)·4Φ_w(α)/ringParticlePhase(α) − 1
   at phase angles off the nodes and albedos between the rows, with the interpolated w the shader uses: ≤ 0.3% for
   α < 120° (measured 0.29%, at A = 0.13), ≤ 1.5% for 120–160° (0.50%); beyond 160° (P < 0.1% of its peak) printed
   only. Also prints f·A_s for an A-ring particle (1 = the regolith sphere alone has the power law: 1.18 / 1.08 / 0.98 /
   0.96 / 1.02 / 1.36 at 0 / 10 / 30 / 60 / 90 / 120°) and the LUT build time (~130 ms).
2. **relief**: GPU `nearRelief` vs the CPU mirror (abs. ≤ 3e-3 radii; 1.3e-4). Orientation-averaged projected area
   of the displaced bodies with the GLSL κ relative to their ellipsoids, for three size ensembles (0.05 / 0.4 / 1.5 m,
   their clast weights and shapes), amp 0.25–1: |ratio − 1| ≤ 0.01 (measured ≤ 0.0062; without κ up to +7%). Prints
   the least-squares κ coefficients — paste them into `NR_K0..3` (nearCommon.glsl) when the relief changes — the
   h bounds and the base ellipsoids' mean area / πa² (1.000–1.004, Knud Thomsen).
3. **photometry**: CPU ray tracer mirroring the fragment shader (regolith law, relief normals, visible-normal clamp,
   macro-normal guard, self-shadowing): disk-integrated brightness of the two relief paths relative to smooth
   ellipsoids, as the correction table (1/ratio) at 0–160° × clast weight 0 / 0.5 / 1. Check: the stored
   `RELIEF_PHOT` (NearRelief.ts) equals the measurement within 2% for α ≤ 120° (deterministic, so it fails exactly
   when the relief or the shader logic changed — paste the printed table then). Measured corrections: ≤ 4% for the
   analytic path up to 100°, ray-marched clumpy boulders 1.06 / 1.12 / 1.24 / 1.44 at 60 / 80 / 100 / 120°.
4. **anisotropy** (informational): mean cross-section / πa² of the principal-axis rotators vs view elevation (spin
   axes near the orbit normal for large particles): 0.987 edge-on … 1.026 from above for a ≥ 0.6 m (NR_ISO 0.8;
   0.92 … 1.14 with the full shape spread).

### propellers — `scripts/test/propellers.mjs` (`--only positions,texture,prefilter,structure,presence,bodies`)
The 2-D τ modulation of `sv_ringStructure` (docs/ring-physics.md §10–11): the sub-km texture (`src/rings/ringTexture.ts`
+ `shaders/ringTexture.glsl`) and the propeller moonlets (`src/rings/propellers.ts` + `shaders/ringPropellers.glsl`,
bodies `PropellerMoonletPass`). CPU mirrors run in the page (`__sv.pipeline.ctx.structure.texture / .propellers`),
the GLSL through ring-layer and near-field read-backs; t = 2026-11-08T12:00Z.

| section | check | tolerance | measured (2026-11-08) |
|---|---|---|---|
| positions | the 11 named giants' longitudes at 2009-06-01 and 2026-11-08 vs an independent propagation of Tiscareno et al. 2010 Table 1 (epoch 2007-01-01 12:00 UTC, + Blériot's sinusoid) | ≤ 1e-9 rad | 1.8e-12 / 1.5e-11 rad |
| | model radius (flow model Ω = fitted n) − fitted a | ≤ 50 m | −5 … −15 m |
| | longitude convention: Mimas' SEF longitude at JED 2454256.9 vs the B-ring edge's forced m = 2 minimum + lag (7.2° + 2.9°, mod 180°) | ≤ 5° | 3.4° (Mimas at 13.46°; its equation of centre is 2.2°) |
| texture | variance of F / the former radial noise (`rlFineFactor`) | 0.85 … 1.15 | 1.024 |
| | radial correlation length (ACF = ½) / the former's | 0.7 … 1.4 | 190.3 / 190.0 m |
| | azimuthal / radial correlation length | 5 … 30 | 10.1 (1,923 m) |
| | trailing streaks: correlation ridge at Δx = +50 m; pitch | Δy < 0; 2 … 20° | −465 m; 6.1° |
| | correlation at a co-moving point after one coherence time T (12.94 h) / after T/20 | < 0.35 / > 0.8 | −0.017 / 0.988 |
| prefilter | mean over random footprint centres of the prefiltered transmission (`rlApplyTauMod`) / the ensemble ⟨e^{−Mτ/μ}⟩ (120,000 points): B ring (A 0.62, τ 1.2 and 3), A ring (A 0.32, τ 0.65), μ = 1, 0.3, 0.09, footprints 2 km / 300 m | ± 2 % (T > 1e-3), ± 6 % (1e-4 … 1e-3) | 0.997 … 1.002; 1.031 / 1.043 at T ≈ 1.3e-4 |
| | mean preserved: E[m(x)], ensemble ⟨M⟩ | 1 ± 0.005 | 0.9988 … 1.0000; 0.9987 |
| | variance split (var m + E[v]) / var M | 1 ± 0.05 | 1.007 |
| structure | looking straight down (debug views 7 / 9: r, τ, θ) at a belt-3 propeller (12 km up, footprint 15.5 m) and at Blériot (60 km, 77.6 m), texture off: median τ_GPU / (τ0(a') J M_CPU) | 0.97 … 1.03 | 1.000 / 1.000 |
| | share of pixels within ± 8 % | ≥ 0.95 | 0.998 / 1.000 |
| | deepest gap τ / τ0 (gaps present) | ≤ 0.65 | 0.433 / 0.502 |
| | the belt view with the texture on: median τ_GPU / (τ0 J M_CPU); share within ± 8 %; rms of the modulation GPU / CPU | 0.97 … 1.03; ≥ 0.9; 0.9 … 1.1 | 1.000; 0.998; 0.998 (rms 0.110) |
| presence | near-field particles ≥ 1 px of the busiest class, 400 m above a belt propeller's outer partial gap, grouped by the CPU M at each particle's drawn position: drawn / expected (counts.mjs Monte Carlo of n_k τ0 M with frustum, layer, radii; 4M samples) — gap (M < 0.75), flank (0.75–0.95), undisturbed / enhanced (≥ 0.95) | 1 ± max(0.08, 4/√n) | 1.002 (3,039) / 0.975 (3,927) / 1.026 (9,970) — presence is decided at the guiding centre, the classification uses the drawn (wake- and epicycle-displaced) position, which moves a few % across the group boundaries |
| | near-field cost gate (`uRpNearMask`): present particles (count and position checksum) with the CPU class mask vs the enumeration forced for every class, in the presence view and at `a-ring-30m` | identical | identical (inside a belt no class is gated: the gate saves work outside the belts) |
| bodies | presets `propeller-bleriot`, `propeller-belt`: moonlets drawn (pass stats); opaque distance at the projected centre of the largest-looking body in view − its distance, in units of R | ≥ 1; −1.4 … 0.1 | 1 / 113 drawn; −0.93 / −0.89 |
| all | console / GL errors, passes ok, NaN / negative pixels (structure views, presets) | none | none |

Screenshots `structure-belt.png`, `structure-bleriot.png`, `presence.png`, `propeller-bleriot.png`,
`propeller-belt.png`. ~1 min. The texture statistics are deterministic (CPU mirror); the prefilter and presence
Monte Carlos vary by ~0.3 % / ~2 % between runs.

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
  −136° in Aug 2009). `scripts/test/specs/moon-shapes.json`: the measured small-moon shapes — 9 Cassini frames
  reproduced from the PDS shape-model documents' image tables (the first shot defines `window.__mv(o)`: SCLK → time,
  calibrated so the app's sub-solar W longitude equals the table's; camera at the sub-spacecraft lat / W lon and range;
  NAC-like fov below the UI's 20° minimum), generic views of all 7 reshaped moons on 2026-11-08 and a camera-clearance
  check 20 m above Pan's ridge (eval prints the clamped distance vs the surface radius). Compare with the raw frames
  (`https://opus.pds-rings.seti.org/opus/api/files/co-iss-<frame>.json` → `_full.png`) rotated by the frame's
  `noraz` (clockwise); renders are north-up. `scripts/test/specs/particle-look.json`: before/after views of the resolved particles at render
  scale 1 — A/B ring inside (fov 35 and 12), 30 m above the A ring, each with the astronaut for scale, the relief
  debug view (33: red = ray-marched) and the former Lambert law (32) in the same frame, and medium / low quality.
  `scripts/test/specs/propellers.json`: Cassini comparisons of the propellers — Earhart as in PIA12790 (lit face,
  81° below the ring plane, phase 82°, 2008-04-11, 2 km/px), Santos-Dumont as in PIA12791 (unlit, 45° above, phase
  121°, 2008-08-19), Blériot as in Tiscareno et al. 2010 Fig. 1b (2008-04-12, 1.7 km/px) and a belt propeller as in
  PIA07792 (SOI, 2004-07-01, 52 m/px), each with and without the propellers (`structure.propellers.scale = 0`),
  plus the two propeller presets. The first shot defines `window.__pv(o)` (target = a named giant or the largest
  belt moonlet near a longitude; camera elevation / phase angle / range / km per px solved for the date).
  `scripts/test/specs/ring-texture.json`: the sub-km τ texture at every scale (render scale 1, 2026-11-08) — the
  A ring 30 m and 1 km above (presets), 3 / 20 / 100 km oblique and 60 / 300 km straight down at 129,000 km
  (inside a propeller belt), the B ring 200 km down, and from under the rings — for before/after comparisons of
  the medium's fine structure.
- `scripts/img.mjs profile <x0> <x1> <y0> <y1> <step> a.png b.png …` — vertical brightness + texture profile of
  a column strip in several screenshots side by side (find seams); `mean a.png b.png "x0,y0,x1,y1" …` — region
  means and ratio; `crop out.png x0 y0 w h scale gain a.png b.png …` — stacked, upscaled, contrast-stretched
  crops (gain 3 makes 1 % seams visible); `rotate in.png out.png cwDeg scale W H [cx cy]` — rotate/scale about a
  point (north-up render → a Cassini frame's `noraz` orientation and m/px). View PNGs with the Read tool.
- `scripts/data/moons/render_shape_model.mjs <moon> <out.png> --lat --lonW [--sunLat --sunLonW --kmPerPx --mode]` —
  independent orthographic render of the raw PDS plate model (not the app's radius map), north up: the reference
  for checking the app's measured-shape rendering and for comparisons with Cassini frames.
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
