# Browser regression tests and tools

Everything here drives the **real app** in headless Google Chrome on the machine's GPU (ANGLE/Metal) through
`puppeteer-core`, reads numbers through the runtime hooks (`window.__sv`, see CLAUDE.md → Runtime hooks) and
fails loudly. **Check this file before writing a new browser tool** — extend an existing one where possible, and
follow [Adding a tool](#adding-a-tool) so the next session can run it too.

| command | what it checks | runtime* |
|---|---|---|
| `npm test` | refs + smoke + physics + counts + lod + seam (incl. handover, base) + exposure + edges + moonflux + particles + propellers + relief + contact + sources against one private dev server; summary table | ~15 min |
| `npm run check:refs` | bibliography ↔ docs sync, no browser: every author–year citation in README / ring-physics.md / data-sources.md / ARCHITECTURE.md has an entry in `src/app/references.ts`, every entry is cited; `-- --online` re-verifies DOIs / arXiv ids | ~1 s (online ~1 min) |
| `npm run test:sources` | the Sources panel (key G) and every place's Sources line in the explainer: keys, focus, filtering, links | ~20 s |
| `npm run test:smoke` | every place loads and renders cleanly (errors, fallbacks, NaN / negative pixels) | ~1.5 min |
| `npm run test:physics` | Sun ephemeris, orbital frequencies, near-field particle kinematics | ~15 s |
| `npm run test:counts` | drawn particle counts vs the analytic expectation, HUD count line, radius sampler, the occlusion cull removes only hidden particles, the presence skip changes no particle | ~1 min |
| `npm run test:lod` | the LOD contract's size rules: CPU mirror of the wake functions vs the GPU, the wake statistics behind τ_dyn, the medium's transmission vs the occultation τ | ~2 min |
| `npm run test:seam` | near field + medium vs medium alone (seams/arcs), particle flux vs render scale, the medium's wake representations vs a reference field across the march → sheet handover, their base radiative transfer without wakes | ~5 min |
| `npm run test:fps` | uncapped fps table: places × particle quality (informational); `--compare DIR` another checkout interleaved | ~2.5 min |
| `npm run test:framecost` | frame or stage cost (ms) of configurations in the same page, min / p20 over interleaved trials (informational) | ~1 min / view |
| `npm run test:exposure` | the camera-pinned astronaut doesn't change the auto exposure (meter mask) | ~45 s |
| `npm run test:edges` | gap edges perturbed by moonlets and the B-ring edge modes (streamline map): gaps empty, rendered edges = model, near field follows | ~50 s |
| `npm run test:moonflux` | point-source flux of unresolved moons = resolved brightness (measured shapes + ellipsoid control) | ~10 s |
| `npm run test:particles` | resolved-particle photometry and shape contract: GLSL vs CPU mirrors, factor LUT, relief area / photometry | ~20 s |
| `npm run test:propellers` | propeller moonlets and the sub-km τ texture: named positions vs Tiscareno 2010 Table 1, texture statistics, footprint prefilter, GPU τ vs the CPU model, near-field presence and its cost gate, moonlet bodies | ~1 min |
| `npm run test:relief` | the rings' vertical relief (one height field z0): model checks, GPU heights / slopes vs the CPU mirror, ray / height-field hits, equinox shadow length, near field and station keeping on the local mid-plane | ~1 min |
| `npm run test:contact` | near-field contact resolution: overlaps before / after (independent CPU pair search), displacement bound, R0 write-back and drawn flags, frame-to-frame smoothness, warp, tilted mid-planes; `--cost`: GPU time | ~65 s (`--cost` +3–5 min) |
| `npm run test:wakecost` | GPU cost of the shared wake functions (`wakeDensity`, `wakeDisplacement`) per call, in-page micro-benchmark (informational) | ~10 s |
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
   Each step also checks that the near-field allocation did not change (`lod.allocVersion`: a re-fit re-seeds every
   particle — an allocation bound that followed the texture's evolving local maximum did on every time step).

### counts — `scripts/test/counts.mjs`
1. **drawn vs expected** at `--places a-ring-30m,a-ring-1km,cassini-division` (astronaut off, statistical
   occlusion culling switched off for the comparison): particles of a class in the R0 read-back that are drawn
   and ≥ 0.5 display px in radius, vs a Monte Carlo of n_k(a) τ_macro(r) over the class box, the Gaussian layer
   height, the class's power-law radii and the view frustum with the same ≥ 1 px condition (`--mc 400000`
   samples), with τ_macro × the 2-D modulation M of `sv_ringStructure` at each sample (sub-km texture, propellers:
   CPU mirror `structure.tauModAt`; presence follows τ0 J M). τ_macro = τ_dyn (1 − dust): the particle population
   carries the dynamical optical depth (`RingLod.tauDynFactor`, ring-physics.md §10.12). Tolerance 1 ± max(4/√expected,
   0.04) for the `--classes 4` classes with the most expected particles (≥ 300). Measured ratios 0.993 … 1.042
   (Poisson-consistent; 0.997 … 1.031 before the size rules).
2. **HUD count line** (`near.count`) starts with `complete` at those places; above the dense B ring
   (`--heights 100,1000,5000` m) it states the status explicitly — `complete…` or `DEFICIT: ~x% …` (measured: a
   38 % deficit at 100 m with the 12M-slot cap binding — 9.2 % before the size rules, which raise the B ring's particle
   population to τ_dyn ≈ 2.2 τ_profile; 0.3 % before the sub-km texture raised the allocation bound by its maximum
   factor 1.43 in the B-ring core — complete at 1 and 5 km). The allocation bound must hold for all times: the
   texture's local maximum over a box varies by ±15 % within a day, and a bound that followed it re-fitted the
   allocation, i.e. re-seeded every particle, at each rise (test:physics checks the allocation across time steps).
3. **radius sampler**: the per-class radius/box sampler (`RingLod.pieceP/pieceB`, mirrored from `nearRadiusBox`
   in `nearCommon.glsl`) reproduces the target density τmax a⁻ᵠ/(π I₂) in every radius bin: |ratio − 1| ≤ 0.02
   when the slot cap does not bind (measured 2e-5).
4. **occlusion cull** (`--cull-views b-ring-inside,a-ring-inside,a-ring-30m`, render scale 1, astronaut off): the
   statistical-occlusion cull (`near/nearOcclusion.glsl` `nearLosTau`: line-of-sight τ > 5) may only remove particles
   the layer hides — the same frame (same particles) with the cull off and on, after the draw lists settled: mean HDR
   radiance on / off within 1 ± 0.005, pixels whose radiance changes by > 5 % ≤ 0.5 % (a culled particle that was
   visible leaves a hole; at the cull's τ ≥ 5/0.8 it is seen with probability ≤ e^−6.25 = 0.2 %). Measured 2026-11-08
   at 1280×720 (drawn ≥ 1 px off → on, ratio, pixels changed): b-ring-inside 877k → 86k, 0.9996, 0.059 %;
   a-ring-inside 235k → 57k, 1.0003, 0.12 %; a-ring-30m 204k → 180k, 1.0000, 0.008 %. At 1920×1080: b-ring-inside
   1.17 M → 0.10 M drawn, a-ring-inside 0.54 M → 0.10 M, a-ring-30m 0.49 M → 0.41 M; with the emptiest-gap bound alone,
   as before Nov 2026: 1.17 M, 0.35 M, 0.49 M. With the size rules (wake participation: the path's density bound
   1 + (W ≥ 1 ? p_min : p_max)(W − 1), uNfPart): b-ring-inside 1.01 M → 0.22 M, 1.0000, 0.11 %; a-ring-inside 243k →
   100k, 1.0000, 0.012 %; a-ring-30m 219k → 169k, 1.0000, 0.000 %.
5. **presence skip** (`--skip-views a-ring-1km,propeller-belt,b-ring-inside`): the update pass leaves the slots whose
   (slot-index-stratified) presence threshold lies above this frame's bound of τ_dyn M over their class's box
   (`ctx.presenceBound`, the modulation cache's block maxima) unevaluated — only the rows below them are rendered. The same
   frame with `NearFieldPass.presenceSkip` off / on: every present slot's R0 bit-identical, present and drawn counts
   identical, and the bound in use (below τ_max in ≥ 1 class). Measured: 0 slots differing at all three views; 22 % /
   21 % / 13 % of the slots skipped (bound / τ_max 0.74–0.82, 0.78–0.84, 0.87).

### seam — `scripts/test/seam.mjs` (`--only seam,flux,handover,base`, `--views id,…`)
1. **seam**: per view, mean HDR radiance (`hdrRT`, after the ring layer and before glare / tone mapping, so
   exposure doesn't matter) in horizontal strips over the view's ring rows, averaged over `--realizations 6`
   particle / wake realizations (the frame anchor id is bumped to re-seed the particles, and the test-only
   `WakeField.realization` draws an independent wake pattern at the same time and place), with the near field on and off
   (`nearField=0`: the medium carries all optical depth). Checks: every strip ratio in [0.85, 1.15]; the largest
   step between neighbouring strips ≤ 0.06 (an arc / seam is a step the medium-only image does not have; the arc
   fixed in Nov 2026 was ≈ 0.1); blue/green-dominated pixels in the ring rows ≤ 0.2 %. Screenshots
   `<view>-near.png` / `<view>-medium.png`.

   | view | rows | measured ratios | max step (limit) | notes |
   |---|---|---|---|---|
   | `arc-repro` | 0.42–1.0 | 1.002 … 1.014 | 0.005 (0.06) | the user-reported arc: 2 km above the unlit A ring, yaw 60, pitch −22 |
   | `a-ring-1km` | 0.25–1.0 | 0.921 … 0.990 | 0.026 (0.06) | preset; particles 1–8 % darker than the medium (see below) |
   | `a-ring-30m` | 0.35–0.78, 6 strips | 0.951 … 1.027 | 0.041 (0.08) | few large particles per strip → realization noise ±5 % (the 0.08 limit); contact brightening +1–3 % in the nearest strips (below) |
   | `lit-500m` | 0.0–0.55 | 0.922 … 0.978 | 0.021 (0.06) | 500 m below the lit A ring looking up; particles 2–8 % darker than the medium |
   | `under-rings` | 0.0–0.45 | 1.000 … 1.019 | 0.010 (0.06) | unlit face from below |

   Measured 2026-11-09 with the N-body size rules (docs/ring-physics.md §10.12: participation, τ_dyn, the vertical
   laws, the packing ceiling, spin alignment; two runs agree within 0.003). Limits restored with them: a-ring-30m's step
   0.11 → 0.08 (the grazing far strip's ~9 % particle deficit is gone: 0.982), under-rings 0.09 → 0.06 (the unlit-face
   excess vanished with the sun-path fix). Before (2026-11-08, re-calibrated wake field of §10.11, 6 patterns): arc-repro
   0.998 … 1.010 / 0.005, a-ring-1km 0.890 … 0.984 / 0.029, a-ring-30m 0.950 … 1.056 / 0.032, lit-500m 0.891 … 0.944 /
   0.023, under-rings 0.971 … 1.023 / 0.017; with the previous field, one pattern: arc-repro 1.000 … 1.015 / 0.006, a-ring-1km 0.899 … 0.985 / 0.024,
   a-ring-30m 0.913 … 1.022 / 0.095, lit-500m 0.887 … 0.945 / 0.021, under-rings 0.959 … 1.011 / 0.016). Before the
   sun-path fix: arc-repro 0.972 … 1.005 / 0.012, a-ring-1km 0.928 … 1.035 /
   0.044, a-ring-30m 0.952 … 1.019 / 0.056, lit-500m 0.914 … 0.967 / 0.019, under-rings 0.974 … 1.080 / 0.075. The
   particles' and the medium's statistical sun paths used 2 fixed wake-density samples that brightened both by up to
   ~25 % (most for mid-plane boulders); with the shared stratified nodes both are unbiased, the unlit-face particle
   excess vanished, and what remains on the lit face (particles darker than the medium) is mostly the clipmap
   prefilter excess of the medium's explicit field (handover, known residual 1); in the grazing far strip of
   `a-ring-30m` the medium barely changed (its visible top layer has short sun paths) while the boulders darkened
   ~22 %. **Contact brightening** (`a-ring-30m`, the only view with resolved particles in its strips): since the
   near-field contact step the resolved particles no longer interpenetrate, so they block more light than the
   medium's independently placed (Poisson) particles of the same τ (the hard-particle / filling-factor effect the
   medium does not model): near + medium with contact on / off in the same realizations ×1.003, 1.016, 1.008, 1.007,
   1.023, 1.036 (far → near strip); before it the view measured 0.920 … 1.027, step 0.093 (limit 0.10, now 0.11).
2. **flux**: particle-only flux (ring layer pass disabled) in the near strips of `a-ring-30m` at render scale
   0.5 vs 1, 4 realizations: sub-pixel particles are rasterized differently at the two scales but the expected
   flux must not change — ratio 1 ± 0.08 (measured 0.961 with the size rules and before; 0.970–0.983 with the
   previous wake field).
3. **handover** (`--only handover`, `--hviews id,…`, `--hstrips 13`, `--hreal 3`): the medium's own wake
   representations, near field and far field off, each forced through the ring-layer pass's test hook
   (`uRlForce` in rlMarch.glsl, installed after the pass's update every frame): `explicit` (march, clipmap wake field
   with the prefilter correction), `stat` (march, statistical branch), `sheet` (far-field sheet everywhere),
   `default` (production blend) and `reference` (the shared `wakeDensity` evaluated at every march step and at 12
   stratified sun-path nodes: no clipmap prefilter — the field the particles follow). Per view, 13 strips × two
   column regions (left / right half: typically along / across the wakes): reflected radiance L (debug view 0,
   far pass off) and transmission T (debug view 2); the march weight wM (debug view 12) marks the **handover band**
   (0.02 < wM < 0.98), strips outside the clipmap's coverage (wake source from debug view 12) are excluded. Checks in
   the band: sheet / reference within 1 ± 0.08 (L) and 0.06 (T); explicit / reference within 0.08 (L) and 0.06 (T);
   stat / sheet within 0.03; production / reference step between neighbouring band strips ≤ 0.04 (a seam where the
   representations meet). Per-view overrides (with their reason) in `HANDOVER_VIEWS` — since the size rules only
   yaw120's stat / sheet (0.05, residual 2 below). Strip means are averaged over `--hreal 3` independent wake patterns
   (`WakeField.realization`, bumped with the anchor id): the statistics describe the ensemble, and one pattern's strips
   (a few wake tiles each) scatter by ±5 % along the wakes with the re-calibrated field. ~2 min.

   | view (region) | L sheet/ref | L expl/ref | L stat/sheet | L step | T sheet/ref | T expl/ref | T stat/sheet | T step |
   |---|---|---|---|---|---|---|---|---|
   | `a-ring-1km` along | 1.000 … 1.003 | 1.009 … 1.019 | 1.002 … 1.005 | 0.005 | 0.992 … 1.010 | 0.985 … 1.002 | 0.991 … 0.996 | 0.009 |
   | `a-ring-1km` across | 1.005 … 1.011 | 0.998 … 1.001 | 0.994 … 1.000 | 0.004 | 0.995 … 1.005 | 0.968 … 0.994 | 0.994 … 1.005 | 0.010 |
   | `a-1km-yaw120` left | 1.025 … 1.031 | 1.002 … 1.004 | 0.986 … 0.990 | 0.009 | 0.987 … 1.007 | 0.978 … 0.994 | 0.988 … 1.012 | 0.006 |
   | `a-1km-yaw120` right | 1.011 … 1.040 | 1.009 … 1.015 | 0.971 … 0.993 (0.05) | 0.001 | 0.995 … 1.005 | 0.988 … 0.999 | 0.989 … 1.002 | 0.008 |
   | `unlit-2km` left | 0.944 … 0.967 | 1.002 … 1.012 | 0.999 … 1.012 | 0.010 | 0.988 … 0.998 | 0.995 … 1.001 | 1.005 … 1.007 | 0.010 |
   | `unlit-2km` right | 0.973 … 0.979 | 0.993 … 0.996 | 0.994 … 1.009 | 0.003 | 0.995 … 1.002 | 0.993 … 0.999 | 1.000 … 1.002 | 0.005 |

   Measured 2026-11-09 with the N-body size rules (ring-physics.md §10.12), the sheet's multiple scattering in the
   medium's τ metric and Saturnshine without the point-source shadow-hiding surge (70 of 70 checks; limits restored to
   the defaults: they were L 0.18 / T 0.15 / TE 0.15 / stat 0.07 / step 0.05 at yaw120, L 0.12 / T 0.08 on the unlit
   face, TE 0.12 at 1 km, LE 0.22 everywhere). Before them (2026-11-08, re-calibrated wake field of §10.11, 4 of 70
   failing): L sheet/ref 1.019 … 1.046 at 1 km, 1.164 … 1.186 at yaw120 left, 0.940 … 1.008 unlit; L expl/ref up to
   1.110; T sheet/ref across the wakes 0.980 … 1.116 (1 km) and 1.021 … 1.081 (unlit). With the previous field and one pattern: L sheet/ref 0.988 … 1.048 (lit),
   1.144 … 1.170 (yaw120 left), T sheet/ref 0.983 … 1.049 across the wakes at 1 km, 1.039 … 1.068 (unlit-2km right).
   With the anchor's λ in the statistics (residual 4) and 4 patterns, every check of `a-ring-1km` and `unlit-2km`
   passes (T sheet/ref 0.96 … 1.00 at 1 km, 0.98 … 1.01 at 2 km; steps ≤ 0.026). Before the Nov 2026 fix (same
   view, diagnostic probes): the explicit field was 15–26 % brighter than a 32-node sun-path reference (two fixed
   sun-path samples: through the convexity of exp(−τWs/μ0) their variance leaks into the mean), the statistical
   transmission 0.60–0.87 of the explicit one across the wakes (the two-column means decorrelated far too fast),
   the clipmap's explicit transmission 0.57–0.97 of the unfiltered field (density prefilter), and `wakeDensity`
   carried only ~88 % of the particles' mass (folds of the forward map missed by the single-branch inverse).
   **Residuals** — fixed in Nov 2026: (1) the clipmap's density prefilter made the explicit field's *reflection* 3–20 %
   too bright (the ~4 m wake cores' sub-texel anti-correlation of density and illumination); with participation (only
   the large particles follow the cores), τ_dyn and the packing ceiling it is ≤ 2 %; (3) the homogeneous march and
   sheet differed by up to 14 % in single scattering at high solar phase (yaw120, wakes off): the sheet lit its
   Saturnshine beams with the point-source shadow-hiding surge, an opposition peak of a few degrees applied to Saturn's
   half-disk of tens of degrees (now none, as in the march; `--only base` checks it); (4) the statistics took χ with the
   local Toomre λ (now the anchor's within the explicit field's reach, `rlWakeLambda`). Also new: the sheet's multiple
   scattering in the medium's τ metric (with τ_dyn ≠ τ_iso it was 3.5 % below the march's statistics on the unlit face).
   Open: (2) across the wakes at high phase (yaw120 right, rows 0.25–0.45, where the two-column reflection's path
   decorrelation sets in: the smoothstep of χ, uRlWakeHeff) the sheet is up to 4 % above the march's statistics, which
   match the reference within 1.5 % → stat / sheet 0.05 for that view; on the unlit face along the wakes the sheet is
   ~5 % below the reference (within the default limit).
4. **base** (`--only base`): the base radiative transfer of the medium's two representations with the wakes off
   (`wakes=0`): the march forced over the frame vs the sheet in the handover views' strips. Checks per view: L within
   1 ± 0.03 in every strip the layer fills, and T's slant optical depth −ln T within 3 % (the ratio of T within 3 %
   where T > 1/e). Measured L 0.994 … 1.027, T 0.986 … 1.035 (the 1.035 at T = 0.04: 1.1 % in τ). Before the
   Saturnshine fix the sheet's L at yaw120 was up to 1.110 (single scattering 1.165). ~25 s.

The near-field photometry offsets in the seam table (particles 1–8 % darker than the medium on the lit face) and the
handover residual 2 are the current state, not targets: tighten the limits when they are fixed.

### lod — `scripts/test/lod.mjs` (`--only wakes,bins,transmission`, `--n 64`, `--cycle 12`, `--treal 3`, `--ref`)
The size rules of the LOD contract where they rest on numbers measured from the app's own wake field
(docs/ring-physics.md §10.12).
1. **wakes**: the CPU mirror of the shared wake functions (`WakeField.densityAt` / `displacementAt`, float64 — behind
   `WAKE_D_BINS` and so τ_dyn; also checked against the Python port by `procedural.py --verify`, to 1e-13) vs the GPU
   (`wakeDensity` / `wakeDisplacement` in a fullscreen pass) on 64² points over 3 × 3 Toomre wavelengths around the
   camera at a-ring-1km (A set) and b-ring-inside (B set): median |ln(GPU/CPU)| ≤ 0.01, 99th percentile ≤ 0.1 (the
   cores are steep), mean ratio 1 ± 0.01, displacement rms ≤ 2e-3 λ. Measured: median 7e-5 / 7e-4, p99 0.0011 /
   0.0077, mean 1.0000 / 1.0001, displacement 1e-5 / 4e-5 λ.
2. **bins**: the pasted `WAKE_D_BINS` (`src/rings/WakeStats.ts`) vs a re-measurement with the current `WakeField`
   (`measureDensityBins`, ~0.1–0.2 s): the τ_dyn factor x(τ, c) from both within 1 ± 0.002 at τ 0.3 / 0.6 / 1.2 (A,
   c = 0.63) and 1.5 / 4 / 8 (B, c = 0.79), every bin within 1 % + 0.002. Fails when the wake model changes; the new
   bins are then written to `<out>/wake_d_bins.json` (paste them). Measured x = 1.072 / 1.134 / 1.239 (A), 1.651 /
   2.268 / 2.731 (B), bins identical. (The bin means are exact for the solve: the full sample gives the same x to 1e-4.)
3. **transmission**: the medium's transmission at normal incidence (6 km above the layer looking straight down, 10°
   field, near field and far pass off, texture and propellers off, debug view 2) vs exp(−τ_profile/μ) per pixel (the
   occultation τ at the pixel's radius), averaged over `--cycle 12` times through one generation cycle × `--treal 3`
   wake patterns, at 128,000 km (A) and 105,000 km (B). Checks: the effective τ −ln⟨T⟩ within 2 % (A) / 5 % (B) of the
   profile's; at A every frame within 0.02 τ + 0.01 of the CPU prediction from the live field
   (exp(−τ_dyn g (1 − p̄ + p̄ D)/μ) at each pixel's ground point); without wakes (control: the homogeneous τ_iso layer)
   within 0.005 τ + 0.005. Measured: A 1.000 (frames 0.990 … 1.009 of the live prediction), B 1.157 × exp(−τ) (−3.5 %
   in τ; frames 0.55 … 1.39: the B set's two generations hand over globally, ~+12 % effective τ for ~20 % of the
   cycle); wakes off 1.002 / 1.009. Before the size rules (photometric τ as the medium's mean): 1.15 (A) and 14.7 (B:
   effective τ 1.5 instead of 4.2). B-ring residual (`--ref`: the march with the reference field, `wakeDensity` per
   step): the clipmap prefilter correction overshoots where T is set by the emptiest gaps (production / reference
   +17 % in T), and the reference is ~8 % below the 2-D column prediction (the thickened wakes catch slightly oblique
   rays); the 36 frames over ~2 wake tiles scatter the B mean by ~±7 % in T.

~2 min.

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
the near-field allocation (the local LOD re-fits within 60 frames).

**Compare mode** (`--compare DIR|URL`, `--rounds 3`, `--label-a`, `--label-b`): this checkout (A) against another one
(B) — a directory holding another revision (`git archive <rev> -o x.tar`, untar into an empty directory, symlink
`node_modules`; a private Vite server is started for it, `startServer({ root })`) or a running server's URL. Per cell
`--rounds` rounds of one fresh page per tree in ABBA order, so both trees see the same slowly drifting GPU load; reports
mean ms per frame of A and B, B − A ± its standard error and the ratio. Presets the other tree lacks are `n/a`. With
other agents' browsers on the GPU, single fps numbers vary by 2× between runs; repeat and compare within a run.

### framecost — `scripts/test/framecost.mjs` (informational)
`--views a-ring-1km,b-ring-inside` (presets or `k=v&…` parameter sets) × configurations `--cfg "name::<setup js>"` or
`--cfg "name::<setup js>::<timed js>"` (repeatable). Per view one page; the app's frame loop is held; per trial every
configuration in turn (rotating order): its setup JavaScript runs, `--settle-frames` whole frames are rendered, then
`--reps` frames (`pipeline.render`) — or the timed snippet, e.g. one stage alone — are timed between synchronous 1-pixel
read-backs of every target a stage may write (hdrRT, sceneRT, the near field's R0: a read-back only waits for work on
its own target). `--trials 30`; reports min, 20th percentile and median per configuration and their differences to the
first. In scope: `sv`, `P` (pipeline), `near` / `rings` / `far` / `post` (the passes' inner objects), `S`
(`ctx.structure`), `f` (`sv.frame`), `ctx`. The setup must set everything it relies on (nothing is undone between
configurations). Examples:
```sh
# the near field's update pass alone, with and without the modulation cache
node scripts/test/framecost.mjs --views a-ring-30m \
  --cfg "mc::ctx.modClip.useInShaders=true;Object.assign(near.skip,{update:false,contact:true,compact:true,points:true,quads:true,shadow:true})::near.render(f,ctx)" \
  --cfg "direct::ctx.modClip.useInShaders=false;Object.assign(near.skip,{update:false,contact:true,compact:true,points:true,quads:true,shadow:true})::near.render(f,ctx)"
# whole frames, texture + propellers off / on
node scripts/test/framecost.mjs --views a-ring-1km --cfg "on::S.texture.amp=1;S.propellers.scale=1" --cfg "off::S.texture.amp=0;S.propellers.scale=0"
```
Far less noisy than fps counting on a shared GPU (another agent's browser triples the median; compare minima / p20 and
repeat runs). Measured with it (Nov 2026, 1920×1080, min ms): the near field's update pass a-ring-1km 5.4 → 2.0 with
the modulation cache, a-ring-30m 14.3 → 8.4, propeller-belt 6.1 → 2.1; the line-of-sight occlusion test costs
+0.4 ms (b-ring-inside) / +1.2 ms (a-ring-30m) in the update pass and saves 3.8 / 2.8 ms of the near field in
b-ring-inside / a-ring-inside; the slot-index-stratified presence threshold with the row-limited skip (`near.presenceSkip`)
took the update pass from 5.1 / 10.2 / 6.0 / 6.8 / 9.8 to 3.5 / 7.4 / 4.4 / 5.7 / 7.1 ms (a-ring-1km / a-ring-30m /
propeller-belt / b-ring-inside / a-ring-inside); the layer's own slab (`P.localSlab`) a-ring-30m 64.7 → 58.1 ms,
a-ring-inside 43.1 → 38.4 ms per frame.

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
| median τ_rendered / (τ0(a') J) in the ring (> 1.5 km from the edges; τ0 the medium's, `RingProfile.mediumTauAtKm`: τ_iso with the wakes off, ring-physics.md §10.12) | 0.95 … 1.05 | 0.9999–1.004 |
| edge RMS(rendered − model ξ(a'_edge, θ)) per azimuth bin | ≤ max(0.25 km, 1.5 footprints) | Keeler 0.05–0.08 km (fp 0.13), Encke 0.16 / 0.39 km (fp 0.39) |
| edge max \|rendered − model\| | ≤ 0.75 km + 2 footprints | Keeler ≤ 0.17 km, Encke ≤ 0.45 km |
| displacement range rendered / model (where the model range ≥ 1 km) | 0.85 … 1.15 | 0.93–1.01 |
| peak outer Keeler edge displacement, first ~80 km behind Daphnis | 2.5 … 4.0 km (Hill response at b = 3.5: 3.2–3.5 km circular moonlet) | 2.71 km (model 2.76) |
| B-ring outer edge (`b-edge-90`, `b-edge-180`, 3,000 km above, footprint 3.9 km): de-projected edge at the mean radius; \|displacement\| rendered / model (S&P 2010 modes) | 0.9 … 1.1; RMS ≤ 1.5 footprints | edge 117,568.00 km; 73.2 / 72.5 km (1.01) and 80.2 / 77.6 km (1.03); RMS 3.9 / 1.6 km |
| NaN / negative pixels (normal render), console / GL errors, passes ok | none | none |
| near-crest: particles ≥ 1 px over material displaced 2.8 km into the unperturbed gap, 30 m above | ≥ 1000 | 53.5k |
| near-crest: the same with straight edges (`edgeWaveScale` 0, camera then over the gap) / with the map | ≤ 0.05 | 0 |
| near-crest: lower-half radiance near field + medium / medium alone (near field: mean of 4 particle realizations — the strip is dominated by the few boulders closest to the camera; single realizations scatter 0.84–1.30) | 0.8 … 1.25 — checked once `nearDraw.vert.glsl` lights particles through `ringSampleLocal` (informational before) | 1.03 (with the vertical relief; realizations 1.30 / 0.89 / 0.89 / 1.03; without relief 0.97) |

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
4. **anisotropy**: the direction-dependent LOD contract of the spin-aligned population (ring-physics.md §10.12): the
   GLSL shapes and orientations (`nearShape`, `nearSpinAxis`, `nearOrientation`) of the aligned population, mean
   projected area / isotropic mean − 1 along elevations μ = 0, 0.5, 0.866, 1, vs the CPU table G(μ) that the medium
   uses (`ringDynamics.anisotropyTables`, `lodAniso`): |diff| ≤ 0.006 (measured ≤ 0.002; G = −0.075 edge-on …
   +0.138 face-on); random spin axes isotropic (≤ 0.006); the tidally locked population's cos 2ψ amplitude edge-on,
   GLSL vs CPU T(0) (≤ 0.006). Prints the per-size table 1 + f(a) G at elevations 0–90° (f(a) = the aligned share).
   (Before: `NR_ISO` 0.8 kept aligned bodies nearly round, 0.987 … 1.026, since the medium was isotropic.)

### sources — `scripts/test/sources.mjs` (`--place a-ring-inside`)
The in-app bibliography (`src/ui/SourcesPanel.ts`, data `src/app/references.ts`, per-place lists
`src/app/placeSources.ts`) with trusted key presses and clicks. Checks: every place (instant jumps) shows a Sources line
in its explainer — ≥ 3 citations for a place with its own list, ≥ 1 from the context defaults otherwise — each a link
with `target=_blank`, `rel=noopener` and a known `data-ref`; `G` opens the modal with every reference and focus in the
search field (the `g` is not typed into it); typing filters ("propeller" → 6 entries); keys pressed inside never reach
the app (`P` does not toggle pause); `Esc` closes, focus leaves the dialog and the app's keys work again; `G` closes it
from the list; clicking an explainer citation opens the panel focused and highlighted at that entry; every panel link
opens in a new tab, one `https://doi.org/` link per entry with a DOI; custom views (orbiting Tethys, 20 m above the B
ring; no place) cite exactly the context defaults of `contextSources`; no console / page errors. Measured 2026-11-08:
19/19 places (19 with their own list), 136 entries, 141 panel links (115 DOIs), 11/11 checks, ~16 s; after the
propeller / relief merge 22/22 places, 151 entries, 157 links (121 DOIs), 11/11, ~25 s. Before/after
screenshots: `node scripts/shots.mjs scripts/test/specs/sources.json <outDir> [--w 390 --h 844]` (explainer lines,
panel, entry focus, search, topic filter, an unverified entry, help).

### propellers — `scripts/test/propellers.mjs` (`--only positions,texture,prefilter,structure,presence,cache,bodies`)
The 2-D τ modulation of `sv_ringStructure` (docs/ring-physics.md §11–12): the sub-km texture (`src/rings/ringTexture.ts`
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
| structure | looking straight down (debug views 7 / 9: r, τ, θ) at a belt-3 propeller (12 km up, footprint 15.5 m) and at Blériot (60 km, 77.6 m), texture off: median τ_GPU / (τ0(a') J M_CPU) (τ0 the medium's: `RingProfile.mediumTauAtKm`, τ_iso with the wakes off) | 0.97 … 1.03 | 1.000 / 1.000 |
| | share of pixels within ± 8 % | ≥ 0.95 | 0.998 / 1.000 |
| | deepest gap τ / τ0 (gaps present) | ≤ 0.65 | 0.433 / 0.502 |
| | the belt view with the texture on: median τ_GPU / (τ0 J M_CPU); share within ± 8 %; rms of the modulation GPU / CPU | 0.97 … 1.03; ≥ 0.9; 0.9 … 1.1 | 1.000; 0.998; 0.998 (rms 0.110) |
| presence | near-field particles ≥ 1 px of the busiest class, 400 m above a belt propeller's outer partial gap, grouped by the CPU M at each particle's drawn position: drawn / expected (counts.mjs Monte Carlo of n_k τ0 M with frustum, layer about the local mid-plane z0 — the propeller's relief lifts the stirred material toward the Sun, i.e. toward this camera, which moves ~5 % of the particles across 1 px —, radii; 4M samples) — gap (M < 0.75), flank (0.75–0.95), undisturbed / enhanced (≥ 0.95) | 1 ± max(0.08, 4/√n) | 1.006 / 0.972 / 1.036 (~3,100 / 3,900 / 9,900 particles); without z0 in the expectation 1.063 / 1.024 / 1.074 — presence is decided at the guiding centre, the classification uses the drawn (wake- and epicycle-displaced) position, which moves a few % across the group boundaries |
| | near-field cost gate (`uRpNearMask`): present particles (count and position checksum) with the CPU class mask vs the enumeration forced for every class, in the presence view and at `a-ring-30m` | identical | identical (inside a belt no class is gated: the gate saves work outside the belts; since Nov 2026 presence reads the modulation cache, the gate only matters where no cache level covers a particle) |
| cache | the modulation cache presence reads (`ModClipmap`, `sv_ringModClip`) at `propeller-belt` and `a-ring-1km`: max / rms \|M cache − M CPU\| at texel centres, each level at its prefilter fp = texel; levels with texels ≤ 4 m vs fp = 0 | ≤ 4e-3 / ≤ 1e-3; ≤ 4e-3 | ≤ 6.6e-4 / ≤ 2.0e-4 (float32); ≤ 2.2e-3 (coarser levels vs fp = 0: rms 0.5 % at 8 m … 4 % at 128 m — the prefilter) |
| | the joint channel the presence bound reads (largest particle optical depth τ0 · τ_dyn(τ0)/τ0 over each texel's ±dr support × M) ≥ the same at the texel centre (CPU profile × `lod.tauDynFactor`) × M, every sampled texel | all | all |
| | drawn particles whose presence differs between the cache and the direct evaluation (same frame and particles) | ≤ 2 % | 0.90 % / 0.90 % (distant particles on prefiltered coarse levels; 0.04 % in b-ring-inside, all on ≤ 2 m levels); switched with `modClip.useInShaders` (also withdraws the presence bound: direct values at footprint 0 exceed a coarse level's prefiltered maxima) |
| bodies | presets `propeller-bleriot`, `propeller-belt`: moonlets drawn (pass stats); opaque distance at the projected centre of the largest-looking body in view − its distance, in units of R | ≥ 1; −1.4 … 0.1 | 1 / 113 drawn; −0.93 / −0.89 |
| all | console / GL errors, passes ok, NaN / negative pixels (structure views, presets) | none | none |

Screenshots `structure-belt.png`, `structure-bleriot.png`, `presence.png`, `propeller-bleriot.png`,
`propeller-belt.png`. ~1 min. The texture statistics are deterministic (CPU mirror); the prefilter and presence
Monte Carlos vary by ~0.3 % / ~2 % between runs.

### relief — `scripts/test/relief.mjs` (`--only model,gpu,shadow,near`, `--views mimas53,titan,cring,region-a,keeler,propeller`)
The rings' vertical relief: ONE height field z0 = moonlet ζ + bending waves + corrugation + B-ring-edge sites +
the propellers' stirred regions (`src/rings/relief.ts`, `sv_ringRelief` / `sv_ringReliefShade`, `rsReliefPropellers`
in `sv_ringPropellers`, docs/ring-physics.md §12–13) that every renderer takes heights relative to. The model part
imports the TypeScript sources in Node (type stripping, Node ≥ 23).

| check | tolerance (why) | measured |
|---|---|---|
| model: wave-table phase advance 4–12 W from the resonance / WKB (k = \|D'x\| / 2πGΣ), each wave | 0.99 … 1.01 (the local wavenumber of the exact linear profile oscillates by a few % around WKB; the advance over ~10 cycles must not) | 0.9988 (all three) |
| model: Mimas 5:3 peak height / maximum slope | 445–455 m (calibration to VIMS) / 7–11° (observed ~10°) | 450 m / 8.48° |
| model: Titan −1:0 maximum slope; \|h\| at 10 / 20 / 30 km | 44–46° (calibration) ; 500–1500 m (Sega & Stewart) | 45.0°; 1157 / 915 / 679 m |
| model: corrugation wavenumber, analytic (GLSL) / numerical d(Ω − ν)/dr | 1 … 1.005 | 1.0000 |
| model: region A at the PIA11668 frame time | inside the frame's ring footprint 165.8–168.4° | 168.22° |
| GPU vs CPU (views straight up at the sheet: Mimas 5:3 40 km inside r_V, Titan 20 km outside, C-ring corrugation, region A at the PIA11668 epoch, the Keeler gap), every 3rd pixel of debug views 23 / 24 / 26 vs `structure.streamAt(dr, dth, fp, true)`: max \|z0 GPU − CPU\| | ≤ 1 m + 1 % of the view's max \|z0\| (float32 phases) | 0.009 / 0.028 / 0.021 / 0.46 / 0.002 m (max \|z0\| 443 / 939 / 8 / 3284 / 455 m) |
| … max \|slope GPU − CPU\| | ≤ 0.002 + 2 % of the max slope | ≤ 2.0e-4 |
| … ray / height-field intersection: \|z0 − z_ray\| tan(zenith angle) at the hit > 0.3 footprints + 2 m | ≤ 0.5 % of the pixels (the search is skipped exactly where the relief moves the hit by less than 0.3 footprints) | 0 % (max 0.22 footprints) |
| … relief in view | max \|z0\| 100–2000 m (waves), 300–3600 m (region A): the views see the relief | see above |
| giant propeller Blériot (2008-04-12, 25 km above it, fp 41 m): the same GPU vs CPU checks; relief at the moonlet (CPU) × sign(Sun's elevation) / Z (Tiscareno et al. 2010 Table S3: 430 m) | 0.99 … 1.01 (the sunlit half of the thickening, toward the Sun) | 1.0000 |
| … max \|z0 GPU − CPU\|; slope; bad hits; rendered max \|z0\| / Z | as above; 0.8 … 1.05 (prefiltered, pixel sampling) | 0.0007 m; 3.6e-6; 0 % (max 0.27 fp); 0.915 (393 m) |
| S/2009 S1 at its NAC frame time (Sun 0.24°): rendered shadow end (relief visibility 0.5 on the anti-Sun axis) / (h / tan B = 35.9 km) | 0.97 … 1.03 | 0.983 (35.3 km) |
| … relief visibility halfway along the shadow | ≤ 0.1 | 0.000 |
| near field 30 m above the local mid-plane inside the Mimas 5:3 wave (mid-plane −364 m): 99 % of \|z_particle − z0(x, y)\| over the drawn particles (r0RT readback) | ≤ 40 m (the layer's vertical scatter; on the SEF plane it would be hundreds of m) | 4.7 m (6,033 particles; vs the camera's mid-plane: 458 m) |
| … z0 spread under the drawn particles | ≥ 50 m (the check sees relief) | 599 m |
| … HUD height above the local mid-plane; after 6,000 s of simulated time at warp 3000 (mid-plane moved ≥ 20 m), then paused | 29.5–30.5 m | 30.00 m; moved 47 m, 30.00 m |
| near field beside Blériot (30 m above the local mid-plane, 2 r_H outside its orbit, 0.3 d_B downstream; the propellers' relief in the near field: class mask, presence + relief enumeration): 99 % of \|z_particle − z0\|; z0 spread; HUD height | ≤ 40 m; ≥ 30 m; 29.5–30.5 m | 4.1 m (4,106 particles, z0 −425 … 0 m); 425 m; 30.00 m |
| every view: NaN / negative pixels, console / GL errors, passes ok | none | none |

Screenshots of every view in `<out>`; numbers per view in `results.json` (incl. the worst pixel). ~1 min.
Model numbers in full: `node scripts/data/rings/relief_check.mjs`.

### contact — `scripts/test/contact.mjs` (`--views b-inside,a-inside,a-30m,b-preset,mimas53,titan`, `--no-temporal`, `--cost [--cost-views …] [--reps 3] [--trials 12]`)
The contact step of the near field (`src/render/near/NearContact.ts`, contract in ARCHITECTURE.md → "Near-field frame
and contact contract"). Views (paused, `t=2026-11-08T12:00:00Z`, render scale 1, astronaut off): `b-inside` =
b-ring-inside at fov 35 (cassini-compare b-inside), `a-inside` = a-ring-inside at fov 35, `a-30m` = a-ring-30m,
`b-preset` = b-ring-inside at its fov 60 (other particle boxes than at fov 35: the camera lies inside a 1.8 m boulder;
no temporal part), and on a mid-plane tilted by the vertical relief (`cam=ring`, z = 0 above the local mid-plane, fov
35): `mimas53` (Mimas 5:3 bending wave, 131,850 km, local slope 2.3°; a dense zone: τ 0.92, a_max 5 m) and `titan`
(Titan −1:0 wave in the C ring, 77,545.5 km, local slope 17°). Per view the contact list (analytic positions, R0 slots,
weights, contact shapes), the result, the bound D_i and R0 are read back and evaluated on the CPU in the page:
1. **overlaps**: all pairs closer than their contact distance (the shader's ρ_i + ρ_j along the centre line), by a CPU
   multi-level grid search over the list, at the analytic and at the resolved positions. *Resolved pair* = both at
   weight 1 (≥ 6 render px radius, not occluded) and both drawn (R0 w > 0: an overlap with a particle out of view or
   culled behind the layer by the update pass cannot be seen); *hidden* = the smaller one entirely inside the larger
   (left alone by design); *visible beyond tolerance* = a visible overlap deeper than max(2 % of the contact distance,
   1 render px); *crowded* = a particle with ≥ 3 initial overlaps with listed particles of any weight (clusters, wake
   cores and the B ring's jammed mid-plane, whose analytic packing is too dense to resolve locally: the solver resolves
   every listed particle, so neighbours in the weights' fades jam a particle as much as resolved ones). Limits:
   residual / visible-before ≤ 0.2 (B) / 0.12 (A); uncrowded residual / resolved particles ≤ 0.012 (isolated pairs left
   unresolved: a solver fault, not jamming).
2. **bound**: max |x − x_analytic| / (clampK D_i) ≤ 1.0001 (float32: 4 ulps of the coordinates); D_i(GPU) ≥ D_i(CPU,
   first iteration) for ≥ 99.8 % of the particles with overlaps (the GPU search missed nothing that matters); hash
   bucket overflow (CPU simulation of the grid) ≤ 0.1 % of the list.
3. **write-back**: R0 at every list slot = the resolved position; present particles unchanged; drawn (R0 w > 0)
   with contact on − off = exactly the particles moved into view, ≤ 0.1 %; the HUD's ≥ 1 px count changes ≤ 0.1 %;
   bodies around the camera (not drawn) have contact weight 0 (b-preset: 1 such body); the wake-field bounds the step
   mirrors are sane — with wakes on 0 < density floor (= `wakeMinDensity()`) ≤ 1 ≤ core density 1/γ_core^s (the wake
   retune of Nov 2026 re-parameterized `uWakeShape`, and the old read turned the floor into 1/R_C² ≈ 1.6–2.8: the
   occlusion bound 30–50× too high, the contact set collapsed to a few metres).
4. **temporal**: the same paused frame twice is bit-identical; one frame later (t + 1/30 s) "pops" (displacement
   change > max(5 × the analytic motion, 1 render px)) / matched particles ≤ 2e-4 (B) / 1e-4 (A); +1 s and +10 s
   reported; warp ±1000 running: no NaN, residual ratio ≤ 1.5 × the paused limit.
5. **cost** (`--cost`, informational): the step alone, re-run on the captured frame between synchronous 1-px
   read-backs, the configurations interleaved within every trial (min over trials; stages cumulative; "step before" =
   the 2026-11-08 configuration: 3 → 6 px, the whole grid, 12 undamped iterations), and whole frames
   (`pipeline.render`) with the step off / on interleaved; plus an fps A/B (noisiest). b-default / a-default = the
   presets at the default render scale 0.5; optional views `b-fov12` (the B ring through a 12° fov at render scale 1,
   the largest contact set) and `a-1km` (an empty set: the step idles).

Measured with the size rules of the contract physics (ring-morphology a7e56a7: wake participation, τ_dyn, per-zone
vertical laws, the packing ceiling) + the contact update of Nov 2026 (fade-in 5 → 6 px, 48 iterations at ω 0.6;
deterministic, identical in every run):

| view | list | resolved | visible overlaps beyond tol. before → after (crowded) | deepest (× contact distance) | max displacement | moved into view | frame + 1/30 s pops (max px) |
|---|---|---|---|---|---|---|---|
| b-inside | 45.9k | 27.0k | 16308 → 2979 (2741): 0.183 | 0.925 → 0.872 | 8.9 a (bound 1.0000) | 104 | 7 (6.9 px) |
| a-inside | 4.3k | 2.5k | 480 → 7 (4): 0.015 | 0.936 → 0.664 | 3.0 a | 1 | 0 (0.13 px) |
| a-30m | 1.4k | 0.81k | 156 → 1 (0): 0.006 | 0.762 → 0.034 | 2.5 a | 0 | 0 (0.02 px) |
| b-preset | 25.2k | 14.1k | 9276 → 1292 (1190): 0.139 | 0.922 → 0.824 | 7.2 a | 65 | — |
| mimas53 | 6.9k | 4.2k | 1159 → 90 (85): 0.078 | 0.823 → 0.487 | 5.0 a | 4 | 0 (0.34 px) |
| titan | 0.49k | 0.32k | 5 → 0: 0 | 0.567 → 0.000 | 1.9 a | 0 | 0 (0.00 px) |

Uncrowded residual / resolved particles: b-inside 0.0088, b-preset 0.0073, a-inside / a-30m / mimas53 0.0012, titan 0.
GPU-missed 0, bucket overflow 0 (max bucket fill 3–13 of 16). Temporal, + 1 s / + 10 s: b-inside 476 / 330 pops (p99
1.5 / 8.9 px), a-inside 0 / 0, a-30m 1 / 2, mimas53 29 / 7, titan 0 / 0; warp +1000 / −1000 residual ratios 0.16 / 0.17
(b-inside), 0.03 / 0.01 (a-inside), 0.02 / 0.01 (a-30m), 0.07 / 0.08 (mimas53), 0 / 0 (titan). Relief on / flat
(`relief=0`, measured before the contract physics): mimas53 0.224 / 0.242, titan 0 / 0 — the tilted mid-plane changes
nothing (the grid, the contact distance and the camera fade are 3-D; the occlusion slab takes heights above the
camera's local mid-plane).

**The B ring at the packing limit.** With the packing ceiling binding, the B-ring mid-plane sits at a filling factor of
≈ 0.65 — random close packing — and the analytic (independent-orbit) positions overlap twice as much as before: 0.81
overlapping resolved pairs per resolved particle in b-inside (0.41 on b9dab72), 28 % of them crowded by the definition
above. On a7e56a7 as merged the check failed (residual 0.267 / 0.215, uncrowded 0.018 / 0.015 in b-inside / b-preset).
Of the uncrowded residual pairs then, 74 % had been created by the step itself (a particle pushed out of one overlap into a
neighbour: chains through the packing), 34 % had ≥ 3 overlaps with partial-weight neighbours (the resolved-only crowding
count missed them) and 17 % involved a particle the update pass does not draw (its cull now uses τ_dyn, the contact
bound still the photometric τ: mirror fixed, and such overlaps are invisible). The crowded residual is a trade-off, not
a floor: a looser, longer projection resolves more but jumps more, because at jamming the nearest non-overlapping
configuration changes discontinuously as the analytic one moves (b-inside, fade-in 4 → 6 px, residual / pops per frame /
pops per s): the setting as merged on a7e56a7 (24 iterations at ω 0.7) 0.272 / 12 / 458; clampK 8, yield 1.5 0.231 /
16 / 506; 48 iterations, 6 rounds 0.169 / 24 / 647; both 0.103 / 31 / 736; clampK 30, yield 5, 96 iterations, 8 rounds
0.047 / 26 (17.9 px) / 1084. The production setting (48 iterations at ω 0.6, fade-in 5 → 6 px) keeps the per-frame
jumps at the stable level (7) with residual 0.183; the per-second count (476, was 30 before the packing ceiling) is
informational.

Before the wake-mirror fix (b9dab72 as merged) the lists had collapsed to 1.4k (b-inside) / 2.5k (a-inside) and the
check failed on 3 pops in 1430 (0.0021) and 4 residual overlaps of 26 (0.154); with the fix alone (3 → 6 px, 12
iterations) b-inside listed 60.7k: residual 0.140, pops 6.6e-5; a-inside 0.068.
Cost (`--cost`, on a heavily shared GPU — b-inside frames of 134 ms without the step during the run), ms — step now /
step with the 2026-11-08 configuration (3 → 6 px, whole grid, 12 undamped iterations; interleaved): b-default (6.4k
list) 3.6 / 5.3, a-default (0.5k) 1.4 / 0.9, b-inside (45.9k) 14.7 / 18.0, a-inside (4.3k) 1.6 / 1.8; against the
setting as merged on a7e56a7 (24 iterations, 4 → 6 px) b-inside 16.2 / 17.7 (another interleaved run). The contract
physics doubled the B-ring contact list (τ_dyn: +25 % particles; the jammed mid-plane) and the search through it
(~100 cells per particle and round) dominates; the list compaction (a full R0 scan, 0.4–0.8) dominates small lists.

### wakecost — `scripts/test/wakecost.mjs` (`--preset id`, `--size N`, `--k K`, `--reps R`, `--trials T`, `--async D`)
In-page micro-benchmark of the shared self-gravity-wake functions on the real app state (the place's wake set and
generation clock): a fullscreen pass evaluates `wakeDensity` / `wakeDisplacement` K times per pixel at scattered points
over a size² float target, R times per trial, synchronised by a 1-pixel read-back; median of T trials minus the same
pass with a trivial expression → GPU throughput per call. The passes blend additively: an opaque full-screen pass
repeated R times is shaded only once on the tile-based GPU (hidden-surface removal), which made the time scale with
neither R nor K. `--async D` overrides the asynchrony depth (WakeField `shapeOverride`). Informational, no limits: for a
before/after comparison extract the old revision (`git archive <rev> -o x.tar`, untar, symlink `node_modules`), copy
this script into it and run both trees alternately (other GPU users skew single runs). Measured 2026-11-08 at
`a-ring-1km`, 1024² × 16 × 16: see docs/ring-physics.md §10.11 (cost). ~10 s.
One check (fails the run): the per-frame skips `uWakeOpt` (WakeField.update: in the part of each cycle where the
generations' handover is complete for every asynchrony phase δ the δ fetches and the zero generation are skipped) change
no result — both functions on a 512² grid with the flags as set vs every path forced on, bit for bit (max |diff| 0);
the cost with every path on is reported too. The cost depends on the cycle phase (printed): measured Nov 2026 at
t = 2026-11-08T12:00Z (phase 0.52, handover complete) wakeDensity 80 ps / wakeDisplacement 21 ps per call vs 110 / 45 with
every path on; at 15:30Z (phase 0.08, both generations and δ active) ~200–300 / ~50–80 ps, unchanged (single runs vary
by 2–4× with other agents' browsers on the GPU).

## Tools

- `scripts/check-refs.mjs [--online] [--only id,…] [--verbose] [--out DIR]` (`npm run check:refs`, part of `npm test`
  as `refs`) — keeps the bibliography `src/app/references.ts` (the in-app Sources panel, key G) in sync with the docs.
  No browser, ~1 s. Fails when: an entry is malformed (unique id, known type / topics, authors, year, title, venue,
  usedFor, DOI / arXiv syntax, a `verifiedBy` on every entry, a `note` on every unverified one, a licence on data
  products and software); an author–year citation in README.md, docs/ring-physics.md, docs/data-sources.md or
  docs/ARCHITECTURE.md does not resolve (inline "Surname 2010", "A & B (2010)", "A, B & C 2009", "P. C. Thomas,
  J. Joseph & T. Ansty (2018)", "Surname et al. 2007, 2013", "Surname et al., DPS 2022", "H&N 2016", and
  ring-physics.md's reference lists, matched on first author, author form and year / letter); a DOI, arXiv id, PDS
  volume id or Photojournal id in those docs belongs to no entry (`IGNORE_IDS`
  lists deliberate exceptions); an entry is cited nowhere (docs, `src/` comments — references.ts and placeSources.ts
  excluded — or a `placeSources.ts` list); a `placeSources.ts` id is unknown. Notes (not failures): ambiguous
  citations (an unlettered "Hedman et al. 2007" against 2007a/b), loose ones ("Verbiscer 2007" for Verbiscer et al.
  2007), places without their own list, and author–year citations in `src/` that are not in the bibliography
  (rendering techniques, standards). `--online` (~1 min, network) re-verifies every entry: DOIs against Crossref
  (DataCite for data DOIs: first author, year ±1, title, volume, first page), arXiv titles via the arXiv API, landing
  pages HTTP 2xx (`BOT_BLOCKED` hosts — BAAS, ADS — refuse scripted requests and are only noted). Measured 2026-11-08
  after the texture / propeller / relief merge: 151 entries (149 verified), 272 doc citations resolved (1 loose), every
  entry cited; online 136/136 then and the 16 new / changed entries agree. Adding a reference: an entry in references.ts (metadata from the publisher's record,
  `verified` / `verifiedBy`), a citation in the docs or code (or a place list), then `npm run check:refs -- --online
  --only <id>`.
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
  −136° in Aug 2009). Vertical relief (render at 1024×1024, `--w 1024 --h 1024`, for the NAC frames): Cassini NAC
  geometries (fov 0.35° set by `eval`, positions from the OPUS ring geometry of the frames; north up, so rotate
  before comparing) of PIA11668 (B-ring edge region A, 2009-07-26, with a `relief=0` twin), PIA11676 (A-ring shadows
  a week after equinox: Mimas 5:3 band, Daphnis' waves; `relief=0` twin), PIA11656 / PIA11655 (Daphnis' edge waves,
  April / May 2009: range, elevation and phase angle from the captions), the Titan −1:0 wave and the C-ring
  corrugation on the equinox day; oblique views of the Mimas 5:3 (`relief=0` twin) and Titan waves on 2026-11-08,
  and 30 m above the local mid-plane inside the Mimas 5:3 wave. `scripts/test/specs/moon-shapes.json`: the measured small-moon shapes — 9 Cassini frames
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
  `scripts/test/specs/contact.json`: the contact step's A/B at render scale 1 — the cassini-compare A/B-ring
  close-ups (fov 35), the b-ring-inside / a-ring-inside presets and 30 m above the A ring, each with the step on and
  then off in the same page (`*-nocontact`, so only the contact step differs).
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
| `startServer({ base, root })` | reuse `base` if it answers, else a private Vite server (no HMR / watching) on a free port, for this checkout or `root` (another revision) |
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
