# Saturn — the ring system at true scale

A real-time, physically based simulation of Saturn, its rings and 28 moons in the browser (Three.js, WebGL2).
Everything is at true scale and in SI units, from the whole system (Iapetus orbits 3.56 million km out) down to
**individual ring particles** a few millimetres to ten metres across, inside a particle layer only ~10 m thick
that orbits Saturn at 17 km/s. You can fly into the rings, co-orbit with them, and watch the motion as it really
happens: Keplerian shear, epicycles, vertical oscillation, self-gravity wakes, Saturn's shadow sweeping past.

At 1× time the rings look almost frozen, and that is correct: neighbours 100 m away drift past at 2 cm/s and
random motions are fractions of a mm/s. Speed time up (`L`) to watch the dynamics.

## Running

```sh
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # typecheck + production build into dist/
npm run typecheck
```

Needs a WebGL2 browser with float render targets (`EXT_color_buffer_float`; `EXT_float_blend` recommended) and a
reasonable GPU. Developed on Chrome / Apple M-series. Default time is **now**, real time.

**Defaults are tuned for a quiet machine:** frame rate capped at **30 fps** and **render scale 0.5×** (the
scene is rendered at half the display resolution — 960×540 for a 1080p window — and upsampled smoothly). For a sharper image raise **Settings (`O`) → Render scale** (1× = display resolution, capped at
~2.4 MP so Retina screens aren't rendered at 4× the pixels) and **Frame rate** (30 / 60 / Max). The number of
ring particles is never a setting: every particle at least one display pixel across is drawn, at its true
position and size (millimetre grains right next to you, 10 m boulders out to ~20 km). **Particle quality**
(High / Medium / Low) only changes how finely they are rendered — lumpy spinning ellipsoids with shadows cast
by their neighbours, smooth spheres with shadows, or smooth spheres with statistical shadows. For reference, at
render scale 1, High particle quality and uncapped on an Apple M5 Max at 1920×1080: ~77 fps inside the A ring,
~50 fps inside the B ring (the heaviest view), 200–340 fps for Saturn and the moons (at the default render scale
0.5: 106–124 fps in and above the A ring, 70 fps in the B ring). Settings persist in the browser.

`data-raw/` (git-ignored, ~1.3 GB) holds the original archive downloads and is only needed to rebuild
`public/data/` with `scripts/data/**`; it can be deleted.

## Controls

| | |
|---|---|
| **Places** | `M` menu · `1`–`9`, `0` jump to a place (A ring inside the layer, 30 m above, 1 km above, B ring, C ring, Cassini Division, Saturn's shadow, under the rings, Encke/Keeler gaps, F ring, moons, cloud tops…) |
| **Orbit mode** | drag to rotate · wheel / pinch / `W` `S` to zoom · click a moon label to fly there |
| **Co-orbit mode** (in the rings) | drag or arrows to look · `Q` `E` roll · `W` `A` `S` `D` fly · `R`/`Space` up · `F`/`Ctrl` down · wheel or `[` `]` speed (1 mm/s – 100 km/s; `Shift` ×10, `Alt` ×0.1) |
| | `B` ballistic: let go and orbit freely like a ring particle (exact Hill-frame solution) · `C` switch orbit ⇄ co-orbit |
| **Time** | `P` pause · `K` / `L` slower / faster (1× … 10⁶×) · `J` reverse · `N` now |
| **Other** | `O` settings · `I` "what you're seeing" · `H` hide HUD · `V` hide / show the astronaut · `?` help · `Esc` cancel a fly-to |

URL parameters: `preset=<place>`, `t=<ISO time|now>`, `warp=<n>`, `paused=1`, `fov=<deg>`, `quality=high|medium|low`,
`scale=<0.25–2>`, `fps=<30|60|0 (uncapped)>`, `ev=<EV offset>`, `exposure=auto|manual`, `bloom=`, `wakes=0`, `dustRings=0`, `stars=0`,
`labels=0`, `nearField=0`, `astronaut=0`, `hud=0`. Example: `/?preset=a-ring-30m&warp=1000`.

The HUD shows live physics for where you are: optical depth, surface density, layer thickness, particle size
range and counts per m², spacing, shear, epicyclic and vertical periods, Toomre wavelength, mean free path,
transmission up/down/to the Sun, Saturn's shadow and time to the next eclipse.

## What is simulated

**Frames and time.** Saturn-centred inertial frame on the IAU 2015 pole; J2/J4/J6-corrected orbital, epicyclic
and vertical frequencies (Cassini Grand Finale gravity field); System III rotation. Sun direction from a JPL
Horizons table (1990–2060, Standish elements outside it). Time in TDB seconds from J2000, real time by default.

**Ring structure.** Normal optical depth on a 0.25 km grid from Cassini radio occultation (RSS Rev 7, X band)
rescaled to visible wavelengths with six UVIS stellar occultations of β Centauri, which also supply the opaque
B-ring core. Gaps, ringlets, plateaus, density waves and sharp edges are where the data put them. Per-zone
particle size distributions (power laws, e.g. A ring 2 cm–5 m, B ring 5 cm–2 m, C ring 4 mm–10 m), layer
thickness (C 5 m, A 10 m, B 10–15 m), surface density calibrated to density waves, albedo and colour. The
implied ring mass, 1.34×10¹⁹ kg, matches Cassini's measured 1.54 ± 0.49×10¹⁹ kg. Details and references:
[`docs/ring-physics.md`](docs/ring-physics.md).

**Particles.** Around the camera, millions of individual particles are drawn from the local size distribution
with the exact column density. Each follows the exact linearised orbit in the co-orbiting frame — guiding-centre
drift −qΩx (Keplerian shear), epicycles at κ with the 2:1 shape, vertical oscillation at ν — in closed form, so it
is exact at any time warp, including in reverse. Self-gravity wakes (Toomre wavelength ≈ 40 m in the A ring,
trailing at ~20°) are transient sheared clumps.

**An astronaut for scale.** A spacesuited companion, 1.9 m tall, floats a few metres in front of you, lower
right, wherever you go (`V` hides it). It is lit exactly like the ring particles around it — sunlight through
the layer, the shadows of nearby boulders, the glow of the rings, Saturnshine — so it is a twilight figure inside
the B ring, mostly hidden by the particles drifting between you, and goes dark in Saturn's shadow. Its gold visor
mirrors the Sun and Saturn. It sways slowly in wall-clock time, so it stays calm at any time warp. The camera's
exposure ignores it — the scene looks exactly as it would without it, so in full sunlight the white suit may clip.

**The ring medium.** Particles too small or too far to draw are carried by a continuous medium with *exactly*
the remaining optical depth (a shared level-of-detail contract), so the two blend without seams. The medium is
ray-marched inside and near the layer and analytic further away, with ray-differential antialiasing of the
radial structure. Light: power-law particle phase function (Dones et al. 1993), interparticle shadow hiding
(opposition surge), two-stream multiple scattering, Saturn's shadow with penumbra, moon shadows, Saturnshine on
both faces. Calibrated low-phase I/F: B ring ≈ 0.45, A ≈ 0.29, Cassini Division ≈ 0.06. Dusty rings (D, F, G, E,
Janus/Epimetheus, Roche Division) scatter forward; the F ring is eccentric and precessing with strands, clumps
and Prometheus channels; spokes, Encke- and Keeler-gap edge waves.

**What it is like in there** (mid A ring): ~37 particles larger than 1 cm per m² of ring, one larger than 1 m per
~50 m²; typical spacing of 10 cm bodies 1.6 m; you can see ~46 m along the layer; 72 % of the sky is visible from
the mid-plane; one orbit takes 13 h; about one collision per orbit. In the B-ring core you can see ~8 m and no
direct sunlight reaches the mid-plane; the C ring is sparse, with ~140 m visibility.

**Saturn.** Ray-traced oblate globe with a seasonal (2025–27) cloud palette, zonal winds (445 m/s equatorial jet)
advecting the cloud detail, the polar hexagon, vortices and storms, limb darkening and haze, ring shadows on the
clouds, ringshine on the night side. Rendered geometric albedo matches observations to ~2 %.

**Moons.** 28 moons fitted to JPL Horizons (worst error 0.008° over 2020–2035; Janus/Epimetheus swaps,
Trojans, Mimas–Tethys resonance), IAU shapes, measured albedos and colours, librations, Hyperion's chaotic
rotation integrated from Euler's equations. The small inner moons — Pan, Daphnis, Atlas, Prometheus, Pandora,
Epimetheus, Janus — have their real Cassini shapes (PDS shape models, ray-marched with self-shadowing): Pan's
"ravioli" and Atlas's "flying saucer" equatorial ridges, Daphnis's thin ridge, the irregular shepherds and
co-orbitals. Cassini global maps for Mimas, Enceladus, Tethys, Dione, Rhea,
Iapetus and Phoebe; procedural features elsewhere; Titan's haze. Unresolved moons are drawn as point sources with
their exact flux.

**Sky and camera.** Yale Bright Star Catalogue (9,096 stars) at physical brightness, the Sun at true size, an
auto-exposure "camera" (glare, ACES tone mapping) that adapts like an eye: stars only appear when nothing sunlit
is in view.

## Project layout

```
src/core      constants, time, ephemeris, frames, co-orbiting ring anchor, frame state
src/rings     ring zone table, radial profile, level-of-detail contract, wake field
src/moons     moon ephemerides and rotation          src/sky   star catalogue
src/render    pipeline (far → near → astronaut → ring layer → post), shared GLSL, passes:
              far/ (Saturn, moons, stars) · near/ (particles) · astronaut/ · rings/ (ring medium) · PostPass (camera)
src/app, src/camera, src/ui    application, camera rig and controllers, HUD
public/data   ring optical depth, ephemerides, stars, moon maps (built by scripts/data/**)
sandbox/      per-subsystem test pages (ringplot.html plots the ring profile against the raw occultations)
docs/         ARCHITECTURE.md (contracts), ring-physics.md, data-sources.md
```

## Data sources and licences

* Ring occultations — Cassini RSS and UVIS via the NASA PDS Ring-Moon Systems Node (public domain, NASA).
* Ephemerides — JPL Horizons (NASA/JPL); body shapes from NAIF `pck00011` (IAU 2015).
* Small-moon shape models — Thomas, Joseph & Ansty (2018), Saturn Small Moon Shape Models V1.0, NASA PDS Small
  Bodies Node, doi:10.26033/ewy3-jy61 (Cassini ISS; public domain, NASA).
* Stars — Yale Bright Star Catalogue, 5th ed. (Hoffleit & Warren 1991), via CDS / NASA ADC (public domain).
* Moon maps — USGS Astrogeology and NASA Photojournal mosaics (NASA/JPL-Caltech/Space Science Institute, LPI;
  public domain).

Full provenance, formats and accuracy: [`docs/data-sources.md`](docs/data-sources.md). The scripts in
`scripts/data/` rebuild every data file from the original archives.

## Known limitations

* Density and bending waves render as concentric ripples (no spiral phase); eccentric ringlets are a 2005 snapshot.
* Particle shapes and surface detail are procedural; light reflected from one part of the rings onto another is
  not modelled.
* Daphnis's orbit is extrapolated (Horizons coverage ends in 2018); Hyperion's actual present-day orientation is
  unknowable (chaotic rotation).
* Only the seven small inner moons have measured shapes, and only at the models' ~2° resolution (finer relief is
  procedural); the other moons are ellipsoids (PDS models of Telesto, Calypso, Helene and Hyperion exist but are not
  used yet). Saturn has no global map (none exists in the public domain), so its clouds are procedural.
