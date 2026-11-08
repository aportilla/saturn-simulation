# N-body calibration of self-gravity wakes and particle packing

Offline, CPU-only reference for the simulator's procedural wake model (`src/rings/WakeField.ts`,
`src/render/shaders/wakes.glsl`) and its vertical law (`src/rings/RingLod.ts`): local shearing-sheet N-body runs
with self-gravity and inelastic collisions (REBOUND), the same statistics computed for a bit-exact Python port of
the procedural field, and a calibration of the model's own parameters against the N-body numbers. Results and
recommendations: `docs/ring-physics.md` §10 "N-body calibration". Nothing here touches the app.

## Setup

```sh
python3 -m venv data-raw/nbody/venv            # data-raw/ is git-ignored
data-raw/nbody/venv/bin/pip install rebound numpy scipy matplotlib scikit-image
PY=data-raw/nbody/venv/bin/python
```

Tested with Python 3.14, REBOUND 5.2.2 (wheel, single-threaded), numpy 2.5, scipy 1.18, scikit-image 0.26, on an
M5 Max. `procedural.py --verify` additionally needs `node` and the repo's `node_modules` (rolldown); in a git worktree
symlink the main checkout's `node_modules`. Raw outputs (snapshots, plots, checkpoints) go to `data-raw/nbody/`;
only the small result JSONs in `results/` are committed.

## Tools

| file | what |
|---|---|
| `sheet.py` | the simulation: `--preset <case>` or explicit `--a-km --sigma --tau --radius / --q --a-min --a-max --box --orbits`; `--list-presets`, `--bench N` (time N steps), `--check-mf` (verifies the image mean field and its correction), `--resume`, `--restore-tau` (proxy particles carry the omitted cross-section) |
| `procedural.py` | Python port of WakeField.ts + wakes.glsl (+ RingLod's vertical law): the app's model (local-wavenumber map, composite circle map with a separate gap γ, plateau envelope with local asynchrony, Newton inverse) and, with `--legacy`, the model before Nov 2026; `--verify` compares it with the TypeScript (bundles `wakefield_ref.ts` with rolldown, runs it in node: texels of both texture layers and of the asynchrony texture, the wake set, every uniform); `synth --like <run>` writes a synthetic run in the N-body format (same box, particle sizes and number density, particles placed like the near field draws them; model overrides `--gamma --gamma-gap --spread-par --spread-perp --rc --t-life --m0 --env-w --async-d --async-ell --strength --newton`); `check-inverse` measures how well `wakeDensity()` matches the exact density of the forward displacement map, per area (cloud-in-cell binning of a fine mapped lattice) and per particle (`pointwise_check`: mapped random points vs 1/det of the forward map's Jacobian; also the share of particles in folds) |
| `analyze.py` | identical statistics for N-body and synthetic runs: spectrum, ACF, crest orientation (pooled, per snapshot and drift), skeleton, density PDF, granola-bar split and slant-ray fit, shearing-frame coherence and the pattern's internal shear rate, vertical structure (per size, vs local density), filling factor at λ/32–λ/4, size participation (split-sample estimator), velocity dispersion, ray-cast and continuum τ. `--field tau` uses the cross-section field. Writes `results/<run>.json`, plus PNG maps under `data-raw/nbody/plots/<run>/` |
| `calibrate.py` | coordinate search over the procedural model's parameters (core γ, gap γ, tile scale, spreadPar, spreadPerp, R_C with rescaled γ, T_LIFE with the birth mode m0, plateau envelope width env_w, asynchrony depth and correlation length), scored against an N-body result plus a penalty for particles in folds of the forward map (`wakeDensity` is single-branch). `--start` continues from a previous result, `--strength` searches at another wake strength, `--legacy-defaults` also scores the model before Nov 2026, `--stages ''` scores only the defaults (the app at that site). Writes `results/calib_<name>.json` |
| `compare.py` | side-by-side markdown tables from result JSONs (used for docs/ring-physics.md §10) |
| `nbcommon.py` | shared constants (Saturn GM, J2–J6 as in `src/core/constants.ts`), presets, I/O helpers |
| `wakefield_ref.ts` | dumps reference values of the real `WakeField` / `zoneParamsAtKm` for `procedural.py --verify` |

### Simulation model (`sheet.py`)

* Hill's approximation in SI units at orbital radius a: SEI integrator (Rein & Tremaine 2011) with Ω from the
  J2–J6 mean motion (κ = Ω_z = Ω in Hill's equations), shear-periodic boundaries, Barnes–Hut tree gravity
  (monopole, θ² = 0.5) over 3×3 shear-periodic images, hard-sphere collisions found with the tree, frictionless, with
  the frost-ice restitution law ε(v_n) = min(1, (v_n / 0.0077 cm/s)^−0.234) (Bridges et al. 1984). Time step
  P/1000 (P/800 for the 1 m identical particles). Initial state: uniform, Gaussian z (3 m), no overlaps.
* **Image mean-field correction.** REBOUND sums gravity over a *box-centred* set of images, so away from the box
  centre the uniform background pulls particles toward the centre (≈ 0.85 GΣ at the box edge for one image ring).
  In azimuth that pull makes corotating orbits drift away exponentially (rate √(3k) ≈ 0.15–0.2 Ω). `sheet.py`
  subtracts the analytic in-plane field of the uniform image sheet every step (`--check-mf` shows the binned tree
  forces of an unstructured state: uncorrected they follow the analytic field to ±0.1 GΣ; corrected the residual is
  ≲ 0.1 GΣ, the realization noise).
* **Truncated size distributions.** Particles below `a_min` (0.1–0.2 m) are omitted; the number per area of
  each simulated size is that of the full distribution at the zone's τ, and the internal density is set so that the
  realization has exactly the zone's Σ. The simulated optical depth is therefore lower (the "τ deficit" in
  params.json). `--restore-tau` adds proxy particles of radius a_min that carry the omitted cross-section with the
  omitted population's mass, to test how much the missing collisional damping matters.
* r_h = R_Hill(pair)/(2r) = (a/2)(8πρ/(9M))^(1/3) for two equal particles (Salo et al. 2004 notation; independent of
  size).

### How the procedural model is compared (`procedural.py synth`, `analyze.py`)

The synthetic run uses the N-body run's box, Toomre wavelength (with κ = Ω, as in the N-body run), particle sizes and
number density, and the wake parameters the simulator would use at that site (`simulator_config`: zone wake strength,
`wakeShapeFor(τ)`, the λ/aMax test). Particles are placed like the near field draws them: uniform epicyclic
positions displaced by `wakeDisplacement`, z Gaussian with RingLod's σ_z = sigZFrac(aEff) H, velocities from RingLod's
kinematics. So the comparison includes the same Poisson noise. The noise-free `wakeDensity()` field is written next to
the particles (`dens_*.npz`) and analysed as well (`noise_free` in the JSON).

## Reproducing everything

```sh
$PY scripts/data/nbody/procedural.py --verify                       # port == TypeScript (texels, uniforms, zone)
$PY scripts/data/nbody/sheet.py --preset A128-ident --check-mf --box 6 # image mean field and correction
for p in A128-ident A128-sd A135-sd B105-sd; do $PY scripts/data/nbody/sheet.py --preset $p; done   # in parallel
$PY scripts/data/nbody/sheet.py --preset A128-sd --name A128-sd10 --a-min 0.1 --box 4 --orbits 12 --fine-from 6
$PY scripts/data/nbody/sheet.py --preset A135-sd --name A135-sd10 --a-min 0.1 --box 4 --orbits 12 --fine-from 6
$PY scripts/data/nbody/sheet.py --preset A135-sd --name A135-amax3 --a-max 3 --orbits 12 --fine-from 6
$PY scripts/data/nbody/sheet.py --preset A128-sd --name A128-sdtau --restore-tau --box 3 --orbits 8 --fine-from 4
# A128-sd, A128-sd10 and B105-sd were stopped early (at orbits 12, 10 and 6); analyze.py measures from the run's
# fine_from to the last snapshot (--from / --to override)
for r in A128-ident A128-sd A135-sd B105-sd; do
  $PY scripts/data/nbody/procedural.py synth --like data-raw/nbody/$r --orbits 6
  $PY scripts/data/nbody/analyze.py data-raw/nbody/$r --raycast 10 --granola 20
  $PY scripts/data/nbody/analyze.py data-raw/nbody/$r-proc --raycast 10 --granola 20
done
for r in A128-sd A128-sd-proc A135-sd A135-sd-proc B105-sd B105-sd-proc; do   # cross-section field -> results/$r.tau.json
  $PY scripts/data/nbody/analyze.py data-raw/nbody/$r --field tau --raycast 0
done
for r in A128-sd10 A128-sdtau A135-sd10 A135-amax3; do $PY scripts/data/nbody/analyze.py data-raw/nbody/$r; done
$PY scripts/data/nbody/procedural.py synth --like data-raw/nbody/A128-ident --name A128-ident-reco --orbits 6 \
    --gamma 0.1002 --rc 0.8 --t-life 7 --m0 1,6 --env-w 0.1          # the recommended parameters (§10.9)
$PY scripts/data/nbody/analyze.py data-raw/nbody/A128-ident-reco --raycast 10 --granola 20

# calibration
R=scripts/data/nbody/results
calib() { $PY scripts/data/nbody/calibrate.py --orbits 2 --jobs 4 "$@"; }
calib --target $R/A128-ident.json --like data-raw/nbody/A128-ident --name A128-ident \
    --stages contrast,spacing,morphology,time,contrast2,morphology
calib --target $R/A128-ident.json --like data-raw/nbody/A128-ident --name A128-ident-2 \
    --start $R/calib_A128-ident.json --stages generations,dislocations,morphology,contrast2
calib --target $R/A128-ident.json --like data-raw/nbody/A128-ident --name A128-ident-3 \
    --start $R/calib_A128-ident-2.json --stages envelope,morphology,dislocations,contrast2
calib --target $R/A128-ident.json --like data-raw/nbody/A128-ident --name A128-ident-4 \
    --start $R/calib_A128-ident-2.json --stages envelope,envelope2,time,dislocations,contrast2
calib --target $R/A128-sd.json --like data-raw/nbody/A128-sd --name A128-sd \
    --start $R/calib_A128-ident-4.json --stages contrast2,envelope2,dislocations,morphology,contrast2 \
    --exclude pitch_med,pitch_iqr,pitch_iqr_inst,pitch_drift --pitch-target 21
calib --target $R/B105-sd.json --like data-raw/nbody/B105-sd --name B105-sd --strength 1.0 \
    --start $R/calib_A128-ident-4.json --stages contrast,spacing,envelope2,dislocations,morphology,contrast2,time \
    --exclude pitch_spec            # the 4 lambda_T box quantises the spectral pitch
$PY scripts/data/nbody/procedural.py synth --like data-raw/nbody/B105-sd --name B105-sd-reco --orbits 6 --strength 1 \
    --gamma 0.1358 --spread-par 2.4 --spread-perp 9 --rc 0.45 --t-life 6 --m0 2,6 --env-w 0.2   # the B optimum
$PY scripts/data/nbody/analyze.py data-raw/nbody/B105-sd-reco --raycast 10 --granola 20

$PY scripts/data/nbody/compare.py $R/A128-ident.json $R/A128-ident-proc.json $R/A128-ident-reco.json
$PY scripts/data/nbody/compare.py --runs data-raw/nbody/A128-ident data-raw/nbody/A128-sd ...   # the runs table below
$PY scripts/data/nbody/procedural.py check-inverse --json $R/check_inverse_A128.json
$PY scripts/data/nbody/procedural.py check-inverse --a-km 105000 --tau 2.5 --sigma 600 --strength 0.5 --box 4 \
    --json $R/check_inverse_B105.json
```

(The shell loops are for reading; run one command per process when you want them in parallel.)
`calib_A128-ident`, `-2` and `-3` were scored with an earlier 19-metric set (without the within-snapshot pitch
spread and drift); their scores are not comparable with `-4` and `calib_A128-sd`. The γ grid of the `contrast` stage
ended at 0.32 for the A-ring calibrations; it was extended to 0.63 for the weaker B-ring contrast.

## Runs and runtimes (M5 Max, one core per run, 4–6 runs in parallel)

| run | site | Σ (kg/m²) | τ zone / simulated | radii (m), q | ρ (kg/m³) / r_h | box | N | orbits (measured from) | wall time |
|---|---|---|---|---|---|---|---|---|---|
| A128-ident | 128,000 km | 284 | 0.6 / 0.60 | 1 (identical) | 355 / 0.77 | 8 λ_T = 329 m | 20,694 | 20 (8) | 21.3 min |
| A128-sd | 128,000 km | 284 | 0.66 / 0.42 | 0.2–5, q 2.9 | 322 / 0.75 | 8 λ_T = 329 m | 51,051 | 12.05 (6) | 89 min |
| A128-sd10 | 128,000 km | 284 | 0.66 / 0.49 | 0.1–5, q 2.9 | 328 / 0.75 | 4 λ_T = 165 m | 47,709 | 10 (6) | 89 min |
| A128-sdtau | 128,000 km | 284 | 0.66 / 0.65 | 0.2–5, q 2.9 + 28,116 proxies of 0.2 m | 312 / 0.74 | 3 λ_T = 123 m | 35,295 | 8 (4) | 57.8 min |
| A135-sd | 135,000 km | 186 | 0.6 / 0.26 | 0.2–7, q 3.05 | 302 / 0.77 | 8 λ_T = 253 m | 20,395 | 14 (6) | 27.8 min |
| A135-sd10 | 135,000 km | 186 | 0.6 / 0.31 | 0.1–7, q 3.05 | 339 / 0.80 | 4 λ_T = 127 m | 21,126 | 12 (6) | 31.5 min |
| A135-amax3 | 135,000 km | 186 | 0.6 / 0.23 | 0.2–3, q 3.05 | 625 / 0.98 | 8 λ_T = 253 m | 22,568 | 12 (6) | 24.6 min |
| B105-sd | 105,000 km | 600 | 2.5 / 1.34 | 0.2–2, q 3.2 | 469 / 0.69 | 4 λ_T = 191 m | 95,631 | 6 (4) | 118 min |

(`compare.py --runs`; "τ zone / simulated": the zone's τ and that of the simulated particles, see "Truncated size
distributions" above.)

Cost scales roughly with N × (collisions per particle): 49 ms/step for 21k identical 1 m particles, 120 ms for 29k
particles of 0.2–5 m, 0.8 s/step for the 96k-particle B ring at the start and 1.1–1.4 s/step once it has settled at
~200–250 collisions per particle per orbit (≈ 20 min per orbit with other runs in parallel). `--bench 40` estimates a
run before starting it. Analysis: ~1–3 min per run (`--granola` adds ~2 min; the B ring ~10 min), calibration
~20–40 min with 4 workers for the A ring (2-orbit candidates), ~12 min with 6 workers for the B ring (4 λ_T box).

## Results files (`results/`)

| file | content |
|---|---|
| `<run>.json` | analysis of an N-body run (surface-mass-density field), `<run>.tau.json` the same for the cross-section field |
| `<run>-proc.json` | the same statistics for the procedural counterpart (with `noise_free`: the exact `wakeDensity()` field) |
| `<run>-reco.json` | the procedural counterpart with the recommended parameters (docs/ring-physics.md §10.9) |
| `calib_<name>.json` | calibration: target metrics, the app's defaults and their score, every candidate, the best parameters |
| `check_inverse_<site>.json` | `wakeDensity()` vs the exact density of the forward displacement map |

The files are strict JSON; undefined values (e.g. no side peak in an ACF) are `null`. Most statistics are
`[mean, standard error of 1-orbit block means]`. Main numbers and the recommendations derived from them:
`docs/ring-physics.md` §10.
