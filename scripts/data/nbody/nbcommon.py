"""Shared helpers for scripts/data/nbody (imported by sheet.py, procedural.py, analyze.py).

Saturn constants and orbital frequencies mirror src/core/constants.ts; the run presets are the N-body reference
cases of docs/ring-physics.md, section "N-body calibration". SI units throughout.
"""
import json
import math
import os

import numpy as np

G = 6.6743e-11            # m^3 kg^-1 s^-2 (CODATA 2018)
GM_SAT = 3.79312062e16    # m^3 s^-2 (Saturn alone)
M_SAT = 5.6834e26         # kg
R_GRAV_REF = 60330e3      # m, reference radius of the zonal harmonics
J2, J4, J6 = 16290.573e-6, -935.314e-6, 86.34e-6   # Iess et al. 2019

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
RAW_DIR = os.path.join(REPO, 'data-raw', 'nbody')
RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')


def orbital_frequencies(r):
    """Mean motion, epicyclic and vertical frequency (rad/s) at radius r (m), J2-J6 (src/core/constants.ts)."""
    n2 = GM_SAT / r ** 3
    x2 = (R_GRAV_REF / r) ** 2
    x4, x6 = x2 * x2, x2 * x2 * x2
    om2 = n2 * (1 + 1.5 * J2 * x2 - 15 / 8 * J4 * x4 + 35 / 16 * J6 * x6)
    ka2 = n2 * (1 - 1.5 * J2 * x2 + 45 / 8 * J4 * x4 - 175 / 16 * J6 * x6)
    nu2 = n2 * (1 + 4.5 * J2 * x2 - 75 / 8 * J4 * x4 + 245 / 16 * J6 * x6)
    return math.sqrt(om2), math.sqrt(ka2), math.sqrt(nu2)


def toomre_lambda(sigma, kappa):
    """Toomre critical wavelength 4 pi^2 G Sigma / kappa^2 (m)."""
    return 4 * math.pi ** 2 * G * sigma / kappa ** 2


def pint(lo, hi, p):
    """Integral of a^p da over [lo, hi]."""
    if hi <= lo:
        return 0.0
    if abs(p + 1) < 1e-12:
        return math.log(hi / lo)
    return (hi ** (p + 1) - lo ** (p + 1)) / (p + 1)


def hill_rh(a_orbit, rho):
    """r_h = R_Hill(pair) / (r1 + r2) for two equal particles of internal density rho (Salo et al. 2004 notation):
    R_Hill = a ((m1 + m2) / (3 M))^(1/3)  ->  r_h = (a / 2) (8 pi rho / (9 M))^(1/3), independent of size."""
    return 0.5 * a_orbit * (8 * math.pi * rho / (9 * M_SAT)) ** (1 / 3)


def sample_powerlaw(rng, n, a0, a1, q):
    """n radii from dN/da ~ a^-q on [a0, a1]."""
    u = rng.random(n)
    if abs(q - 1) < 1e-12:
        return a0 * (a1 / a0) ** u
    e = 1 - q
    return (a0 ** e + u * (a1 ** e - a0 ** e)) ** (1 / e)


# N-body reference cases. tau = optical depth of the FULL size distribution [a_min_full, a_max] (the zone's
# value); the simulation omits particles below a_min (tau deficit documented in params.json), keeping Sigma.
PRESETS = {
    # classic identical-particle case (Salo 1992 type): wake morphology reference
    'A128-ident': dict(a_km=128000, sigma=284.0, tau=0.6, radius=1.0, box=8.0, orbits=20.0, fine_from=8.0, spo=800,
                       note='A ring mid (128,000 km), identical r = 1 m, tau_dyn 0.6, Sigma 284 kg/m^2'),
    # the simulator's A-mid size distribution (zone A_in: q 2.9, 2 cm - 5 m), truncated at 20 cm
    'A128-sd': dict(a_km=128000, sigma=284.0, tau=0.66, q=2.9, a_min_full=0.02, a_max=5.0, a_min=0.2,
                    box=8.0, orbits=14.0, fine_from=6.0, spo=1000,
                    note='A ring mid (128,000 km), q 2.9, 0.2-5 m of a 2 cm - 5 m distribution, tau 0.66, Sigma 284'),
    # outer A ring (zone A_out: q 3.05, 5 mm - 7 m), truncated at 20 cm
    'A135-sd': dict(a_km=135000, sigma=186.0, tau=0.6, q=3.05, a_min_full=0.005, a_max=7.0, a_min=0.2,
                    box=8.0, orbits=14.0, fine_from=6.0, spo=1000,
                    note='A ring outer (135,000 km), q 3.05, 0.2-7 m of a 5 mm - 7 m distribution, tau 0.6, Sigma 186'),
    # B-ring-like case (zones B2/B3: q 3.2, 5 cm - 2 m), truncated at 20 cm
    'B105-sd': dict(a_km=105000, sigma=600.0, tau=2.5, q=3.2, a_min_full=0.05, a_max=2.0, a_min=0.2,
                    box=4.0, orbits=10.0, fine_from=4.0, spo=1000,
                    note='B ring (105,000 km), q 3.2, 0.2-2 m of a 5 cm - 2 m distribution, tau 2.5, Sigma 600'),
}


def load_run(run_dir):
    """params.json, particle radii/masses and the sorted list of snapshot files of a run directory."""
    with open(os.path.join(run_dir, 'params.json')) as f:
        params = json.load(f)
    pd = np.load(os.path.join(run_dir, 'particles.npz'))
    snaps = sorted(fn for fn in os.listdir(run_dir) if fn.startswith('snap_') and fn.endswith('.npz'))
    return params, pd['r'].astype(np.float64), pd['m'].astype(np.float64), [os.path.join(run_dir, s) for s in snaps]


def load_snapshot(path):
    s = np.load(path)
    return dict(t=float(s['t']), D=float(s['D']), pos=s['pos'].astype(np.float64), vel=s['vel'].astype(np.float64))


def wrap_offset(D, Ly):
    """Shear offset reduced to (-Ly/2, Ly/2]."""
    return D - Ly * math.floor(D / Ly + 0.5)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(obj, f, indent=1, default=lambda o: o.tolist() if hasattr(o, 'tolist') else float(o))
        f.write('\n')
