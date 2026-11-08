#!/usr/bin/env python3
"""Local shearing-sheet N-body simulation of a self-gravitating, collisional ring patch (REBOUND).

Reference runs for the procedural self-gravity wake model of the simulator (src/rings/WakeField.ts,
src/render/shaders/wakes.glsl). Runs, runtimes and results: scripts/data/nbody/README.md.

usage (PY = a Python with rebound, numpy, scipy; see the README for the venv under data-raw/nbody/):
  $PY scripts/data/nbody/sheet.py --preset A128-ident [--out DIR] [--orbits N] [--seed S] [--resume]
  $PY scripts/data/nbody/sheet.py --name test --a-km 128000 --sigma 284 --tau 0.6 --radius 1 --box 4 --orbits 2
  $PY scripts/data/nbody/sheet.py --list-presets
  $PY scripts/data/nbody/sheet.py --preset A128-sd --bench 50      # time 50 steps, write nothing

Model (Hill's approximation, SI units):
  * co-rotating frame at orbital radius a: x radial (outward), y azimuthal (direction of motion), z vertical.
    Omega = mean motion of a circular equatorial orbit around oblate Saturn (J2-J6, src/core/constants.ts);
    Hill's equations then use kappa = Omega_z = Omega (Keplerian) and the shear v_y = -1.5 Omega x.
  * REBOUND (Rein & Liu 2012): SEI integrator (Rein & Tremaine 2011), shear-periodic boundaries, Barnes-Hut tree
    gravity (monopole) summed over (2 Ng + 1)^2 shear-periodic images of the box, hard-sphere collisions (tree
    search) with the normal coefficient of restitution eps(v_n) = min(1, (|v_n|/v_c)^-0.234), v_c = 0.0077 cm/s
    (frost-covered ice, Bridges et al. 1984), or a constant; no surface friction / spin.
  * Mean-field correction: REBOUND sums gravity over a BOX-centred set of images, so a particle away from the box
    centre feels the net pull of the uniform background toward the centre (~G Sigma ln 2 at the box edge for
    Ng = 1). In the azimuthal direction that pull destabilises corotating orbits (drift growth rate ~0.15-0.2
    Omega). The exact in-plane field of the uniform image sheet (one rectangle per image column, analytic) is
    subtracted every step (--no-mf-correction to disable).
  * Particles: identical radius (--radius), or a truncated power law dN/da ~ a^-q on [a_min, a_max] (--q,
    --a-min, --a-max) with the number per area of the FULL distribution [a_min_full, a_max] at optical depth tau.
    The simulated optical depth is therefore lower by the share of the omitted small particles (the "tau
    deficit", in params.json). The internal density rho is set so that the realization has exactly Sigma.
  * Initial state: uniform in x, y; Gaussian z (std 3 m), no overlaps; random velocities ~ Omega * 3 m. Wakes
    and the velocity dispersion reach a statistical steady state within ~2-3 orbits.
Outputs (OUT = data-raw/nbody/<name> by default):
  params.json   all input and derived parameters (Omega, P, lambda_T, rho, r_h, N, box, tau deficit, ...)
  particles.npz radius r (m) and mass m (kg) per particle (index order is fixed for the whole run)
  snap_#####.npz t (s), D (shear offset 1.5 Omega Lx t, m), pos (N,3), vel (N,3) in float32
  log.txt       progress: orbit, wall time, collisions, velocity dispersions, rms z, Toomre Q
  checkpoint.bin REBOUND binary of the latest state (for --resume)
"""
import argparse
import ctypes
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nbcommon as nb  # noqa: E402

try:
    import rebound
except ImportError:  # pragma: no cover
    sys.exit('rebound is not installed: python3 -m venv data-raw/nbody/venv && '
             'data-raw/nbody/venv/bin/pip install rebound numpy scipy  (see scripts/data/nbody/README.md)')

VC_BRIDGES = 0.0077e-2   # m/s (Bridges et al. 1984: eps = (v / 0.0077 cm/s)^-0.234)
EXP_BRIDGES = -0.234
PARTICLE_DOUBLES = 14    # sizeof(struct reb_particle) / 8 (11 doubles + 3 pointers)


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--preset', choices=sorted(nb.PRESETS), help='reference case (see --list-presets)')
    p.add_argument('--list-presets', action='store_true')
    p.add_argument('--name', help='run name (default: preset name)')
    p.add_argument('--out', help='output directory (default data-raw/nbody/<name>)')
    p.add_argument('--a-km', type=float, help='orbital radius (km)')
    p.add_argument('--sigma', type=float, help='surface density (kg/m^2)')
    p.add_argument('--tau', type=float, help='optical depth of the full size distribution (dynamical)')
    p.add_argument('--radius', type=float, help='identical particles of this radius (m)')
    p.add_argument('--q', type=float, help='size distribution index dN/da ~ a^-q')
    p.add_argument('--a-min-full', type=float, help='lower size of the full distribution (defines tau) (m)')
    p.add_argument('--a-min', type=float, help='smallest simulated radius (m)')
    p.add_argument('--a-max', type=float, help='largest radius (m)')
    p.add_argument('--box', type=float, help='box side in Toomre wavelengths (square box)')
    p.add_argument('--orbits', type=float, help='run length (orbital periods)')
    p.add_argument('--fine-from', type=float, help='orbit from which snapshots are written every --snap-fine')
    p.add_argument('--snap-every', type=float, default=0.25, help='snapshot interval before --fine-from (orbits)')
    p.add_argument('--snap-fine', type=float, default=0.05, help='snapshot interval from --fine-from on (orbits)')
    p.add_argument('--spo', type=int, help='time steps per orbit (default: preset, else 1000)')
    p.add_argument('--eps', default='bridges', help="'bridges' or a constant coefficient of restitution")
    p.add_argument('--ghost', type=int, default=1, help='gravity image rings Ng (images: (2Ng+1)^2)')
    p.add_argument('--theta2', type=float, default=0.5, help='Barnes-Hut opening angle squared')
    p.add_argument('--softening', type=float, help='gravitational softening (m; default 0.1 a_min)')
    p.add_argument('--no-mf-correction', action='store_true', help='do not subtract the image mean field')
    p.add_argument('--seed', type=int, default=1)
    p.add_argument('--checkpoint-every', type=float, default=1.0, help='orbits between checkpoints')
    p.add_argument('--resume', action='store_true', help='continue from OUT/checkpoint.bin')
    p.add_argument('--bench', type=int, default=0, help='only time this many steps (writes nothing)')
    p.add_argument('--check-mf', action='store_true',
                   help='verify the image mean field and its correction on the unstructured initial state')
    a = p.parse_args(argv)
    if a.list_presets:
        for k, v in nb.PRESETS.items():
            print(f'{k:12s} {v["note"]}')
        sys.exit(0)
    cfg = dict(nb.PRESETS[a.preset]) if a.preset else {}
    for k in ('a_km', 'sigma', 'tau', 'radius', 'q', 'a_min_full', 'a_min', 'a_max', 'box', 'orbits', 'fine_from',
              'spo'):
        v = getattr(a, k)
        if v is not None:
            cfg[k] = v
    cfg.setdefault('spo', 1000)
    for k in ('a_km', 'sigma', 'tau', 'box', 'orbits'):
        if k not in cfg:
            p.error(f'--{k.replace("_", "-")} is required without a preset')
    if 'radius' not in cfg and not all(k in cfg for k in ('q', 'a_min', 'a_max')):
        p.error('give --radius or --q/--a-min/--a-max')
    cfg.setdefault('fine_from', max(0.0, cfg['orbits'] - 6.0))
    cfg['name'] = a.name or a.preset or 'run'
    cfg['out'] = a.out or os.path.join(nb.RAW_DIR, cfg['name'])
    for k in ('snap_every', 'snap_fine', 'eps', 'ghost', 'theta2', 'softening', 'seed',
              'checkpoint_every', 'resume', 'bench', 'check_mf'):
        cfg[k] = getattr(a, k)
    cfg['mf_correction'] = not a.no_mf_correction
    cfg['preset'] = a.preset
    return cfg


def derive(cfg):
    """Orbital frequencies, Toomre wavelength, box, particle numbers (expected), tau deficit."""
    a = cfg['a_km'] * 1e3
    om, ka, nu = nb.orbital_frequencies(a)
    d = dict(a_m=a, Omega=om, kappa_true=ka, nu_true=nu, P=2 * math.pi / om)
    d['lambda_T'] = nb.toomre_lambda(cfg['sigma'], om)          # Hill problem: kappa = Omega
    d['lambda_T_true'] = nb.toomre_lambda(cfg['sigma'], ka)
    L = cfg['box'] * d['lambda_T']
    d['Lx'] = d['Ly'] = L
    if 'radius' in cfg:
        r = cfg['radius']
        d['n_per_m2'] = cfg['tau'] / (math.pi * r * r)
        d['tau_sim_expected'] = cfg['tau']
        d['a_min_sim'] = d['a_max_sim'] = r
    else:
        q, a0f, a0, a1 = cfg['q'], cfg['a_min_full'], cfg['a_min'], cfg['a_max']
        C = cfg['tau'] / (math.pi * nb.pint(a0f, a1, 2 - q))
        d['C'] = C
        d['n_per_m2'] = C * nb.pint(a0, a1, -q)
        d['tau_sim_expected'] = math.pi * C * nb.pint(a0, a1, 2 - q)
        d['mass_share_simulated'] = nb.pint(a0, a1, 3 - q) / nb.pint(a0f, a1, 3 - q)
        d['rho_full_distribution'] = cfg['sigma'] / (4 / 3 * math.pi * C * nb.pint(a0f, a1, 3 - q))
        d['a_min_sim'], d['a_max_sim'] = a0, a1
    d['tau_deficit'] = 1 - d['tau_sim_expected'] / cfg['tau']
    d['N'] = int(round(d['n_per_m2'] * L * L))
    return d


def initial_conditions(cfg, d, rng):
    N, L, om = d['N'], d['Lx'], d['Omega']
    if 'radius' in cfg:
        r = np.full(N, cfg['radius'])
    else:
        r = nb.sample_powerlaw(rng, N, cfg['a_min'], cfg['a_max'], cfg['q'])
    vol = 4 / 3 * math.pi * r ** 3
    rho = cfg['sigma'] * L * L / vol.sum()
    m = rho * vol
    sz0 = 3.0
    pos = np.empty((N, 3))
    pos[:, 0] = rng.uniform(-L / 2, L / 2, N)
    pos[:, 1] = rng.uniform(-L / 2, L / 2, N)
    pos[:, 2] = np.clip(rng.normal(0, sz0, N), -4 * sz0, 4 * sz0)
    # remove overlaps (periodic in x, y at t = 0; the box is L tall, z never wraps)
    from scipy.spatial import cKDTree
    rmax = r.max()
    for it in range(500):
        q = pos + np.array([L / 2, L / 2, L / 2])
        q[:, :2] %= L
        tree = cKDTree(q, boxsize=[L, L, 2 * L])
        pairs = tree.query_pairs(2 * rmax, output_type='ndarray')
        if len(pairs) == 0:
            break
        dv = q[pairs[:, 0]] - q[pairs[:, 1]]
        dv[:, :2] -= L * np.round(dv[:, :2] / L)
        dist = np.sqrt((dv ** 2).sum(1))
        bad = dist < (r[pairs[:, 0]] + r[pairs[:, 1]]) * 1.02
        if not bad.any():
            break
        pb = pairs[bad]
        # move the smaller particle of each overlapping pair (boulders stay where they are)
        redo = np.unique(np.where(r[pb[:, 0]] < r[pb[:, 1]], pb[:, 0], pb[:, 1]))
        pos[redo, 0] = rng.uniform(-L / 2, L / 2, len(redo))
        pos[redo, 1] = rng.uniform(-L / 2, L / 2, len(redo))
        pos[redo, 2] = np.clip(rng.normal(0, sz0, len(redo)), -4 * sz0, 4 * sz0)
    else:
        raise RuntimeError('could not remove initial overlaps')
    c0 = om * sz0
    vel = np.empty((N, 3))
    vel[:, 0] = rng.normal(0, c0, N)
    vel[:, 1] = -1.5 * om * pos[:, 0] + rng.normal(0, 0.5 * c0, N)
    vel[:, 2] = rng.normal(0, c0, N)
    return r, m, rho, pos, vel


class MeanFieldCorrection:
    """Subtracts the in-plane gravity of the uniform sheet formed by the box and its (2Ng+1)^2 shear-periodic
    images (what REBOUND's box-centred image sum adds on top of the local structure; zero for an infinite sheet).
    The image (i, j) of the box seen by a particle is offset by (-i Lx, -j Ly + shift_i(t)) (boundary.c,
    reb_boundary_get_ghostbox), so column i is one rectangle [-i Lx -+ Lx/2] x [shift_i -+ (Ng + 1/2) Ly].
    Field of a uniform rectangle (G Sigma = 1) at the origin, relative corners x1 < x2, y1 < y2:
      a_x = asinh(y2/|x1|) - asinh(y1/|x1|) - asinh(y2/|x2|) + asinh(y1/|x2|),  a_y likewise with x <-> y.
    Evaluated on a (ngrid x ngrid) node grid over the box every step (the field is smooth inside the box) and
    interpolated bilinearly to the particles."""

    def __init__(self, Lx, Ly, Ng, Gsigma, Omega, ngrid=33):
        self.Lx, self.Ly, self.Ng, self.GS, self.Om = Lx, Ly, Ng, Gsigma, Omega
        self.n = ngrid
        g = np.linspace(-0.5, 0.5, ngrid)
        self.X, self.Y = np.meshgrid(g * Lx, g * Ly, indexing='ij')

    def shift(self, i, t):
        Lx, Ly = self.Lx, self.Ly
        vy = -1.5 * i * self.Om * Lx
        if i == 0:
            return 0.0
        if i > 0:
            return -math.fmod(vy * t - Ly / 2, Ly) - Ly / 2
        return -math.fmod(vy * t + Ly / 2, Ly) + Ly / 2

    def grid_field(self, t):
        Lx, Ly, Ng = self.Lx, self.Ly, self.Ng
        tiny = 1e-9 * Lx
        ax = np.zeros_like(self.X)
        ay = np.zeros_like(self.X)
        for i in range(-Ng, Ng + 1):
            s = self.shift(i, t)
            x1 = -i * Lx - Lx / 2 - self.X
            x2 = -i * Lx + Lx / 2 - self.X
            y1 = s - (Ng + 0.5) * Ly - self.Y
            y2 = s + (Ng + 0.5) * Ly - self.Y
            ax1, ax2 = np.maximum(np.abs(x1), tiny), np.maximum(np.abs(x2), tiny)
            ay1, ay2 = np.maximum(np.abs(y1), tiny), np.maximum(np.abs(y2), tiny)
            ax += np.arcsinh(y2 / ax1) - np.arcsinh(y1 / ax1) - np.arcsinh(y2 / ax2) + np.arcsinh(y1 / ax2)
            ay += np.arcsinh(x2 / ay1) - np.arcsinh(x1 / ay1) - np.arcsinh(x2 / ay2) + np.arcsinh(x1 / ay2)
        return self.GS * ax, self.GS * ay

    def at(self, x, y, t):
        ax, ay = self.grid_field(t)
        n = self.n
        u = np.clip((x / self.Lx + 0.5) * (n - 1), 0, n - 1 - 1e-9)
        v = np.clip((y / self.Ly + 0.5) * (n - 1), 0, n - 1 - 1e-9)
        i0, j0 = u.astype(np.int64), v.astype(np.int64)
        fu, fv = u - i0, v - j0
        w00, w10, w01, w11 = (1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv

        def interp(f):
            return w00 * f[i0, j0] + w10 * f[i0 + 1, j0] + w01 * f[i0, j0 + 1] + w11 * f[i0 + 1, j0 + 1]
        return interp(ax), interp(ay)


def particle_view(simp_or_sim):
    """numpy (N, 14) float64 view of REBOUND's particle array (columns 0-10: x y z vx vy vz ax ay az m r)."""
    sim = simp_or_sim.contents if hasattr(simp_or_sim, 'contents') else simp_or_sim
    N = sim.N
    addr = ctypes.cast(sim._particles, ctypes.c_void_p).value
    return np.ctypeslib.as_array(ctypes.cast(addr, ctypes.POINTER(ctypes.c_double)), shape=(N, PARTICLE_DOUBLES))


def setup_simulation(cfg, d):
    sim = rebound.Simulation()
    sim.G = nb.G
    sim.integrator = 'sei'
    sim.OMEGA = d['Omega']
    sim.boundary = 'shear'
    sim.gravity = 'tree'
    sim.collision = 'tree'
    sim.opening_angle2 = cfg['theta2']
    sim.dt = d['P'] / cfg['spo']
    sim.root_size = d['Lx']
    sim.N_root_x = sim.N_root_y = sim.N_root_z = 1
    sim.N_ghost_x = sim.N_ghost_y = cfg['ghost']
    sim.N_ghost_z = 0
    return sim


def attach_callbacks(sim, cfg, d, state):
    """Collision resolution, coefficient of restitution, minimum separation speed, mean-field correction (function
    pointers are not stored in REBOUND binaries, so this runs again on --resume). `state` keeps the ctypes callback
    objects alive."""
    sim.collision_resolve = 'hardsphere'
    sim.softening = cfg['softening'] if cfg['softening'] is not None else 0.1 * d['a_min_sim']
    # REBOUND: separation speed of an approaching overlapping pair >= minimum_collision_velocity * overlap depth
    # (collision.c); 0.1/dt resolves a residual overlap in ~10 steps, e.g. 1 cm -> 0.02 mm/s (<< impact speeds)
    sim.minimum_collision_velocity = 0.1 / sim.dt
    if cfg['eps'] == 'bridges':
        vc, ex = VC_BRIDGES, EXP_BRIDGES

        def cor(simp, v):
            v = abs(v)
            return 1.0 if v <= vc else (v / vc) ** ex
    else:
        e = float(cfg['eps'])

        def cor(simp, v):
            return e
    sim.coefficient_of_restitution = cor
    state['cor'] = cor
    if cfg['mf_correction'] and cfg['ghost'] >= 0:
        mf = MeanFieldCorrection(d['Lx'], d['Ly'], cfg['ghost'], nb.G * cfg['sigma'], d['Omega'])
        state['mf'] = mf

        def addf(simp):
            pv = particle_view(simp)
            ax, ay = mf.at(pv[:, 0], pv[:, 1], simp.contents.t)
            pv[:, 6] -= ax
            pv[:, 7] -= ay
        sim.additional_forces = addf
        sim.force_is_velocity_dependent = 0
        state['addf'] = addf


def diagnostics(sim, d, m):
    N = sim.N
    xyz = np.zeros(3 * N)
    v = np.zeros(3 * N)
    sim.serialize_particle_data(xyz=xyz, vxvyvz=v)
    xyz = xyz.reshape(N, 3)
    v = v.reshape(N, 3)
    v[:, 1] += 1.5 * d['Omega'] * xyz[:, 0]
    w = m / m.sum()
    cm = np.sqrt((w[:, None] * v ** 2).sum(0))
    cn = np.sqrt((v ** 2).mean(0))
    return xyz, v, dict(cx_m=cm[0], cy_m=cm[1], cz_m=cm[2], cx_n=cn[0], cz_n=cn[2],
                        zrms_m=float(np.sqrt((w * xyz[:, 2] ** 2).sum())), zrms_n=float(np.sqrt((xyz[:, 2] ** 2).mean())))


def save_snapshot(out, k, sim, d):
    N = sim.N
    xyz = np.zeros(3 * N)
    v = np.zeros(3 * N)
    sim.serialize_particle_data(xyz=xyz, vxvyvz=v)
    D = 1.5 * d['Omega'] * d['Lx'] * sim.t
    np.savez(os.path.join(out, f'snap_{k:05d}.npz'), t=np.float64(sim.t), D=np.float64(D),
             pos=xyz.reshape(N, 3).astype(np.float32), vel=v.reshape(N, 3).astype(np.float32))


def schedule(cfg):
    """Step numbers at which snapshots are written."""
    spo = cfg['spo']
    total = int(round(cfg['orbits'] * spo))
    fine0 = int(round(cfg['fine_from'] * spo))
    c, f = max(1, int(round(cfg['snap_every'] * spo))), max(1, int(round(cfg['snap_fine'] * spo)))
    s = set(range(0, min(fine0, total) + 1, c))
    s.update(range(fine0, total + 1, f))
    s.add(total)
    return sorted(s), total


def check_mean_field(cfg, d):
    """Tree accelerations of the unstructured initial state, binned in x (for a_x) and y (for a_y), with and without
    the correction, against the analytic image mean field. Without the correction the binned means follow the
    analytic restoring field (~ -G Sigma ln 2 at the edges for Ng = 1); with it they scatter around 0."""
    rng = np.random.default_rng(cfg['seed'])
    r, m, rho, pos, vel = initial_conditions(cfg, d, rng)
    d['a_min_sim'] = r.min()
    nbin = 8
    L = d['Lx']
    edges = np.linspace(-L / 2, L / 2, nbin + 1)
    gs = nb.G * cfg['sigma']
    print(f'mean in-plane acceleration in {nbin} bands across the box, units of G Sigma = {gs:.3e} m/s^2 '
          f'(N = {len(r)}, Ng = {cfg["ghost"]})')
    for t_orb in (0.0, 0.37):
        rows = {}
        for corr in (False, True):
            c2 = dict(cfg, mf_correction=corr)
            st = {}
            sim = setup_simulation(c2, d)
            attach_callbacks(sim, c2, d, st)
            for i in range(len(r)):
                sim.add(m=m[i], r=r[i], x=pos[i, 0], y=pos[i, 1], z=pos[i, 2], vx=vel[i, 0], vy=vel[i, 1], vz=vel[i, 2])
            sim.t = t_orb * d['P']
            rebound.clibrebound.reb_simulation_update_acceleration(ctypes.byref(sim))
            pv = particle_view(sim).copy()
            ix = np.clip(np.digitize(pv[:, 0], edges) - 1, 0, nbin - 1)
            iy = np.clip(np.digitize(pv[:, 1], edges) - 1, 0, nbin - 1)
            rows[corr] = ([pv[ix == b, 6].mean() / gs for b in range(nbin)], [pv[iy == b, 7].mean() / gs for b in range(nbin)])
            if not corr:
                mf = MeanFieldCorrection(L, L, cfg['ghost'], gs, d['Omega'])
                ax, ay = mf.at(pv[:, 0], pv[:, 1], sim.t)
                rows['analytic'] = ([ax[ix == b].mean() / gs for b in range(nbin)], [ay[iy == b].mean() / gs for b in range(nbin)])
        print(f't = {t_orb} orbits')
        for key, lab in ((False, 'tree, uncorrected'), ('analytic', 'analytic image field'), (True, 'tree, corrected')):
            print(f'  a_x vs x  {lab:22s}', ' '.join(f'{v:+.3f}' for v in rows[key][0]))
            print(f'  a_y vs y  {lab:22s}', ' '.join(f'{v:+.3f}' for v in rows[key][1]))


def main(argv):
    cfg = parse_args(argv)
    d = derive(cfg)
    out = cfg['out']
    state = {}
    if cfg['check_mf']:
        check_mean_field(cfg, d)
        return
    if cfg['resume']:
        ck = os.path.join(out, 'checkpoint.bin')
        with open(os.path.join(out, 'params.json')) as f:
            prev = json.load(f)
        d = prev['derived']
        sim = rebound.Simulation(ck)
        attach_callbacks(sim, cfg, d, state)
        m = np.load(os.path.join(out, 'particles.npz'))['m'].astype(np.float64)
        print(f'resumed {out} at t = {sim.t / d["P"]:.3f} orbits')
    else:
        rng = np.random.default_rng(cfg['seed'])
        t0 = time.time()
        r, m, rho, pos, vel = initial_conditions(cfg, d, rng)
        d['rho'] = rho
        d['r_h'] = nb.hill_rh(d['a_m'], rho)
        d['tau_sim'] = float((math.pi * r ** 2).sum() / (d['Lx'] * d['Ly']))
        d['N'] = len(r)
        sim = setup_simulation(cfg, d)
        attach_callbacks(sim, cfg, d, state)
        for i in range(len(r)):
            sim.add(m=m[i], r=r[i], x=pos[i, 0], y=pos[i, 1], z=pos[i, 2], vx=vel[i, 0], vy=vel[i, 1], vz=vel[i, 2])
        d['softening'] = sim.softening
        d['dt'] = sim.dt
        print(f'{cfg["name"]}: N = {d["N"]}, box {d["Lx"]:.1f} m = {cfg["box"]} lambda_T ({d["lambda_T"]:.2f} m), '
              f'rho = {rho:.0f} kg/m^3, r_h = {d["r_h"]:.3f}, tau_sim = {d["tau_sim"]:.3f} (deficit '
              f'{100 * d["tau_deficit"]:.0f}%), setup {time.time() - t0:.1f} s')
        if cfg['bench'] <= 0:
            os.makedirs(out, exist_ok=True)
            nb.write_json(os.path.join(out, 'params.json'), dict(config=cfg, derived=d, rebound=rebound.__version__))
            np.savez(os.path.join(out, 'particles.npz'), r=r.astype(np.float32), m=m.astype(np.float32))
    if cfg['bench'] > 0:
        t0 = time.time()
        n0 = sim.collisions_log_n
        sim.steps(cfg['bench'])
        dtw = (time.time() - t0) / cfg['bench']
        print(f'bench: {1e3 * dtw:.1f} ms/step, {(sim.collisions_log_n - n0) / cfg["bench"]:.0f} collisions/step; '
              f'{cfg["orbits"]} orbits at {cfg["spo"]} steps/orbit ~ {dtw * cfg["spo"] * cfg["orbits"] / 3600:.2f} h')
        return
    snaps, total = schedule(cfg)
    step = int(round(sim.t / sim.dt))
    logf = open(os.path.join(out, 'log.txt'), 'a')
    k = sum(1 for s in snaps if s <= step)   # snapshot index after the one written at `step`
    if step == 0:
        save_snapshot(out, 0, sim, d)
        k = 1
    t_wall0 = time.time()
    step_wall0 = step
    next_ck = step + int(round(cfg['checkpoint_every'] * cfg['spo']))
    ncol0 = sim.collisions_log_n
    for s in snaps:
        if s <= step:
            continue
        sim.steps(s - step)
        nsteps = s - step
        step = s
        save_snapshot(out, k, sim, d)
        k += 1
        _, _, dg = diagnostics(sim, d, m)
        ncol = sim.collisions_log_n - ncol0
        ncol0 = sim.collisions_log_n
        Q = dg['cx_m'] * d['Omega'] / (3.36 * nb.G * cfg['sigma'])
        el = time.time() - t_wall0
        eta = el / max(1, step - step_wall0) * (total - step)
        line = (f'orbit {step / cfg["spo"]:7.3f}  wall {el / 60:7.1f} min  eta {eta / 60:6.1f} min  '
                f'coll/particle/orbit {ncol / d["N"] / (nsteps / cfg["spo"]):6.1f}  '
                f'c_x,y,z(mass) {1e3 * dg["cx_m"]:.3f} {1e3 * dg["cy_m"]:.3f} {1e3 * dg["cz_m"]:.3f} mm/s  '
                f'c_x(number) {1e3 * dg["cx_n"]:.3f}  z_rms(mass/number) {dg["zrms_m"]:.2f}/{dg["zrms_n"]:.2f} m  Q {Q:.2f}')
        logf.write(line + '\n')
        logf.flush()
        if step >= next_ck or step == total:
            ck = os.path.join(out, 'checkpoint.bin')
            if os.path.exists(ck):
                os.remove(ck)
            sim.save_to_file(ck)
            next_ck = step + int(round(cfg['checkpoint_every'] * cfg['spo']))
    logf.write(f'done: {total} steps, wall {(time.time() - t_wall0) / 60:.1f} min\n')
    logf.close()


if __name__ == '__main__':
    main(sys.argv[1:])
