# N-body calibration of self-gravity wakes and particle packing

Offline, CPU-only reference for the simulator's procedural wake model (`src/rings/WakeField.ts`,
`src/render/shaders/wakes.glsl`) and its vertical law (`src/rings/RingLod.ts`): local shearing-sheet N-body runs
with self-gravity and inelastic collisions (REBOUND), the same statistics computed for a bit-exact Python port of
the procedural field, and a calibration of the model's own parameters against the N-body numbers. Results and
recommendations: `docs/ring-physics.md` §8 "N-body calibration". Nothing here touches the app.

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
| `procedural.py` | Python port of WakeField.ts + wakes.glsl (+ RingLod's vertical law); `--verify` compares it with the TypeScript (bundles `wakefield_ref.ts` with rolldown, runs it in node); `synth --like <run>` writes a synthetic run in the N-body format (same box, particle sizes and number density, particles placed like the near field draws them); `check-inverse` measures how well `wakeDensity()` (one Newton step per generation) matches the exact density of the forward displacement map |
| `analyze.py` | identical statistics for N-body and synthetic runs (spectrum, ACF, crest orientation, skeleton, density PDF, granola-bar split and slant-ray fit, temporal coherence, vertical structure, filling factor, size participation, velocity dispersion, ray-cast τ); `--field tau` for the cross-section field; writes `results/<run>.json` (+ PNG maps under `data-raw/nbody/plots/<run>/`) |
| `calibrate.py` | coordinate search over the procedural model's parameters (γ, spreadPar, spreadPerp, R_C, T_LIFE with the birth mode m0) scored against an N-body result; writes `results/calib_<name>.json` |
| `compare.py` | side-by-side markdown tables from result JSONs (used for docs/ring-physics.md §8) |
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
for r in A128-ident A128-sd A135-sd B105-sd; do
  $PY scripts/data/nbody/procedural.py synth --like data-raw/nbody/$r --orbits 6
  $PY scripts/data/nbody/analyze.py data-raw/nbody/$r --raycast 10 --granola 20
  $PY scripts/data/nbody/analyze.py data-raw/nbody/$r-proc --raycast 10 --granola 20
done
$PY scripts/data/nbody/calibrate.py --target scripts/data/nbody/results/A128-sd.json --like data-raw/nbody/A128-sd \
    --name A128-sd --stages contrast,morphology,time,contrast2,morphology --jobs 4
$PY scripts/data/nbody/compare.py scripts/data/nbody/results/A128-sd.json scripts/data/nbody/results/A128-sd-proc.json
$PY scripts/data/nbody/procedural.py check-inverse --json scripts/data/nbody/results/check_inverse_A128.json
```

(The shell loops are for reading; run one command per process when you want them in parallel.)

## Runs and runtimes (M5 Max, one core per run, 4–6 runs in parallel)

README_RUNS

Cost scales roughly with N × (collisions per particle): 49 ms/step for 21k identical 1 m particles, 120 ms for 29k
particles of 0.2–5 m, 250 ms for the 58k-particle B ring at the start (later ~1 s/step at ~200 collisions per particle
per orbit). `--bench 40` estimates a run before starting it. Analysis: ~1–3 min per run (`--granola` adds ~2 min),
calibration ~20–40 min with 4 workers.

## Results files (`results/`)

| file | content |
|---|---|
| `<run>.json` | analysis of an N-body run (surface-mass-density field), `<run>.tau.json` the same for the cross-section field |
| `<run>-proc.json` | the same statistics for the procedural counterpart (with `noise_free`: the exact `wakeDensity()` field) |
| `calib_<name>.json` | calibration: target metrics, the app's defaults and their score, every candidate, the best parameters |
| `check_inverse_<site>.json` | `wakeDensity()` vs the exact density of the forward displacement map |

Main numbers and the recommendations derived from them: `docs/ring-physics.md` §8.
