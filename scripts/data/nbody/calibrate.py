#!/usr/bin/env python3
"""Calibrate the procedural wake model's parameters against an N-body result (same pipeline, same box and particles).

usage ($PY = the venv python, see README.md):
  $PY scripts/data/nbody/calibrate.py --target scripts/data/nbody/results/A128-sd.json --like data-raw/nbody/A128-sd
      [--name A128] [--orbits 2] [--stages contrast,morphology,time] [--jobs 6] [--out results/calib_A128.json]
      [--start results/calib_<other>.json] [--strength S] [--exclude pitch_med,pitch_iqr,...] [--pitch-target DEG]

Each candidate is a synthetic run (procedural.py synth: the port of WakeField.ts / wakes.glsl with overridden
parameters, particles drawn like the near field) analysed by analyze.py exactly like the N-body run. The score is
sum_i ((m_i - m_i^Nbody) / s_i)^2 over the metrics below (s_i = tolerance: max(15 % of the target, a floor)).
The app defaults are always scored first. Coordinate search over the stages given by --stages, in that order, each
starting from the best candidate so far:
  contrast    gamma (strength fixed at the zone value; only -ln(gamma) * strength matters)    -> D quantiles
  spacing     tile_scale (tile = lambda * 6 / sin 20 deg * tile_scale: crest spacing; 1 in the app) -> spectrum
  morphology  spreadPar x spreadPerp x R_C                                                    -> ACF, skeleton
  dislocations R_C 0.3-1.0 with ln(gamma) rescaled to keep the mean local strength 1/(1 + R_C^2), x spreadPerp +-25 %
  time        T_LIFE with the birth mode m0 = (m0x, 6) chosen so that the amplitude-weighted pitch stays near the
              N-body median (integer m0x keeps the texture tileable)                          -> C(dt), pitch
  envelope    model variant (not in the app): plateau envelope with crossfade width env_w x T_LIFE instead of sin^2,
              T_LIFE 4-7 with matching m0x; envelope2: T_LIFE -1..+2, env_w 0.05/best/0.2, m0x +-1 around the best
  generations model variant (not in the app): n_gen = 3, 4 overlapping generations born every T_LIFE/n_gen with
              amplitude (2/n_gen) sin^2 (sum = strength), T_LIFE 3-5 (uWakeGen already has a third, unused slot)
  contrast2   gamma x 0.8 .. 1.25 around the best
Metrics (21): spectral peak and power-weighted spacing / lambda, D quantiles p5 p25 p75 p95 p99 (lambda/16), ACF L_par
and L_perp (1/e) / lambda, first minimum and side-peak height across crests, skeleton end and branch points per
lambda^2 and filament length / lambda, spectral pitch, crest orientation median and IQR (pooled), mean within-snapshot
orientation IQR and the std of the snapshot median over time, temporal C at 0.1, 0.2, 0.3 orbit. --exclude drops
metrics: for size-distribution mass fields the structure-tensor orientation is noise-dominated (a few boulders), so
calib_A128-sd uses --exclude pitch_med,pitch_iqr,pitch_iqr_inst,pitch_drift --pitch-target 21. In a 4 lambda_T box
the spectral peak is quantised, so calib_B105-sd uses --exclude pitch_spec.
Candidates run for --orbits (2) orbits, so score differences below ~5 are not significant.
"""
import argparse
import itertools
import json
import math
import os
import shutil
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nbcommon as nb  # noqa: E402

def filament_length(r):
    """Mean filament length 2L/n_end / lambda. analyze.py averages the per-snapshot ratio, which is undefined when a
    snapshot has no crest end points (long procedural crests closing on themselves in a small periodic box); then use
    the ratio of the mean crest length and end-point density instead."""
    sk = r['skeleton']
    f = sk['filament_length_over_lambda'][0]
    if f is not None and math.isfinite(f):
        return f
    n_end = sk['n_end_per_lambda2'][0]
    return 2 * sk['crest_length_per_lambda2'][0] / n_end if n_end > 0 else float('nan')


METRICS = [
    # name, getter, floor
    ('lam_peak', lambda r: r['spectrum']['lambda_w_over_lambda_T'][0], 0.08),
    ('lam_mean', lambda r: r['spectrum']['lambda_mean_k_over_lambda_T'], 0.08),
    ('p5', lambda r: r['pdf']['sigma_lambda_16']['p5'][0], 0.03),
    ('p25', lambda r: r['pdf']['sigma_lambda_16']['p25'][0], 0.05),
    ('p75', lambda r: r['pdf']['sigma_lambda_16']['p75'][0], 0.08),
    ('p95', lambda r: r['pdf']['sigma_lambda_16']['p95'][0], 0.15),
    ('p99', lambda r: r['pdf']['sigma_lambda_16']['p99'][0], 0.25),
    ('L_par', lambda r: r['acf']['L_par_e_over_lambda'], 0.08),
    ('L_perp', lambda r: r['acf']['L_perp_e_over_lambda'], 0.01),
    ('acf_min', lambda r: r['acf']['first_min'], 0.04),
    ('acf_side', lambda r: r['acf']['side_peak_height'][0], 0.04),
    ('n_end', lambda r: r['skeleton']['n_end_per_lambda2'][0], 0.08),
    ('n_branch', lambda r: r['skeleton']['n_branch_per_lambda2'][0], 0.08),
    ('filament', filament_length, 0.3),
    ('pitch_spec', lambda r: r['spectrum']['pitch_deg'][0], 2.0),
    ('pitch_med', lambda r: r['orientation']['median'], 1.5),
    ('pitch_iqr', lambda r: r['orientation']['q75'] - r['orientation']['q25'], 1.5),
    ('pitch_iqr_inst', lambda r: r['orientation']['instantaneous']['iqr_mean'], 1.5),
    ('pitch_drift', lambda r: r['orientation']['instantaneous']['median_std_over_time'], 1.0),
    ('C0.1', lambda r: r['temporal']['C'][r['temporal']['lags_orbits'].index(0.1)], 0.04),
    ('C0.2', lambda r: r['temporal']['C'][r['temporal']['lags_orbits'].index(0.2)], 0.04),
    ('C0.3', lambda r: r['temporal']['C'][r['temporal']['lags_orbits'].index(0.3)], 0.04),
]


def metric_vector(res):
    """Metric values of an analysis result (null in a result file -> nan)."""
    out = {}
    for name, get, _ in METRICS:
        v = get(res)
        out[name] = float('nan') if v is None else float(v)
    return out


EXCLUDE = set()


def score(cand, target, se=None):
    s = 0.0
    parts = {}
    for name, get, floor in METRICS:
        if name in EXCLUDE:
            continue
        t = target[name]
        tol = max(0.15 * abs(t), floor, (se or {}).get(name, 0.0))
        d = (cand[name] - t) / tol
        parts[name] = d
        s += d * d
    return s, parts


def m0x_for(t_life, pitch_deg, m0y=6.0, q=1.5):
    """Integer m0x such that the pitch at the envelope peak (age T/2) is closest to pitch_deg."""
    ideal = m0y * (1 / math.tan(math.radians(pitch_deg)) - q * t_life / 2)
    best = None
    for c in (math.floor(ideal), math.ceil(ideal)):
        p = math.degrees(math.atan2(m0y, c + q * t_life / 2 * m0y))
        if best is None or abs(p - pitch_deg) < abs(best[1] - pitch_deg):
            best = (c, p)
    return float(best[0])


def evaluate(job):
    """Run one candidate (in a worker process). job: dict(params, like, workdir, orbits, seed)."""
    import procedural as pr
    import analyze as an
    p = job['params']
    wd = job['workdir']
    os.makedirs(wd, exist_ok=True)
    sargs = argparse.Namespace(like=job['like'], name=os.path.basename(wd), out=wd, orbits=job['orbits'], snap=0.05,
                               margin_lambda=1.0, gamma=p.get('gamma'), spread_par=p.get('spread_par'),
                               spread_perp=p.get('spread_perp'), rc=p.get('rc'), t_life=p.get('t_life'),
                               strength=p.get('strength'), tile_scale=p.get('tile_scale'), n_gen=p.get('n_gen'),
                               env_w=p.get('env_w'),
                               m0=f"{p['m0x']},{p.get('m0y', 6.0)}" if 'm0x' in p else None,
                               seed=job.get('seed', 12345), t0=None, particles=True)
    import contextlib
    import io
    with contextlib.redirect_stdout(io.StringIO()):
        pr.synth(sargs)
        aargs = argparse.Namespace(run=wd, from_orbit=None, to_orbit=None, every=1, json=os.path.join(wd, 'analysis.json'),
                                   plots=False, raycast=0, granola=0, rays=100000, quick=False, field=job.get('field', 'mass'))
        res = an.analyze(aargs)
    mv = metric_vector(res)
    if not job.get('keep'):
        for fn in os.listdir(wd):
            if fn.startswith(('snap_', 'dens_')):
                os.remove(os.path.join(wd, fn))
    return dict(params=p, metrics=mv, workdir=wd)


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--target', required=True, help='analysis JSON of the N-body run')
    ap.add_argument('--like', required=True, help='N-body run directory (box, lambda, particles)')
    ap.add_argument('--name')
    ap.add_argument('--orbits', type=float, default=2.0, help='length of each synthetic candidate run (orbits)')
    ap.add_argument('--stages', default='contrast,morphology,time')
    ap.add_argument('--jobs', type=int, default=6)
    ap.add_argument('--start', help='start from the best parameters of a previous calib_*.json (instead of the app defaults)')
    ap.add_argument('--strength', type=float, help='search with this wake strength instead of the zone value (the contrast '
                                                   'depends on -ln(gamma) * strength; the app defaults are scored unchanged)')
    ap.add_argument('--exclude', default='', help='comma-separated metrics to leave out of the score (e.g. the structure-'
                                                  'tensor orientation of boulder-dominated mass fields)')
    ap.add_argument('--pitch-target', type=float, help='pitch (deg) the time/envelope stages aim m0 at (default: the '
                                                       'target\'s orientation median)')
    ap.add_argument('--out')
    a = ap.parse_args(argv)
    EXCLUDE.update(m for m in a.exclude.split(',') if m)
    with open(a.target) as f:
        tres = json.load(f)
    target = metric_vector(tres)
    name = a.name or tres['run']
    with open(os.path.join(a.like, 'params.json')) as f:
        params = json.load(f)
    import procedural as pr
    sc = pr.simulator_config(params)
    pitch_target = a.pitch_target if a.pitch_target is not None else target['pitch_med']
    base = dict(gamma=sc['gamma'], strength=sc['strength'], spread_par=sc['spread_par'], spread_perp=sc['spread_perp'],
                rc=sc['rc'], t_life=sc['t_life'], m0x=sc['m0x'], m0y=sc['m0y'], tile_scale=sc['tile_scale'], n_gen=sc['n_gen'],
                env_w=sc['env_w'])
    work = os.path.join(nb.RAW_DIR, 'calib', name)
    os.makedirs(work, exist_ok=True)
    results = []
    counter = itertools.count()

    def run_batch(cands):
        jobs = []
        for c in cands:
            k = next(counter)
            jobs.append(dict(params=c, like=os.path.abspath(a.like), workdir=os.path.join(work, f'c{k:03d}'), orbits=a.orbits,
                             field=tres.get('field', '').startswith('cross') and 'tau' or 'mass'))
        with ProcessPoolExecutor(max_workers=a.jobs) as ex:
            out = list(ex.map(evaluate, jobs))
        for o in out:
            o['score'], o['parts'] = score(o['metrics'], target)
            if not math.isfinite(o['score']):
                o['score'] = float('inf')   # e.g. a metric undefined for this candidate
            results.append(o)
            pp = o['params']
            print(f"  score {o['score']:8.2f}  gamma {pp['gamma']:.3f} spreads {pp['spread_par']:.2f}/{pp['spread_perp']:.2f} "
                  f"Rc {pp['rc']:.2f} T {pp['t_life']:.1f} m0x {pp['m0x']:+.0f} tile x{pp['tile_scale']:.2f} "
                  f"n_gen {pp.get('n_gen', 2)} env_w {pp.get('env_w', 0.0):.2f}", flush=True)
        return min(out, key=lambda o: o['score'])

    print(f'calibrating against {a.target} ({name}); defaults: {base}')
    best = run_batch([dict(base)])
    print(f"simulator defaults: score {best['score']:.2f}")
    if a.strength is not None:
        # same mean contrast at the new strength: ln(gamma') = ln(gamma) * strength / strength'
        g2 = math.exp(math.log(base['gamma']) * base['strength'] / a.strength)
        sb = run_batch([dict(base, strength=a.strength, gamma=g2)])
        print(f"strength {a.strength} (gamma {g2:.3f}): score {sb['score']:.2f}")
        best = sb   # continue the search at this strength
    if a.start:
        with open(a.start) as f:
            prev = json.load(f)['best']['params']
        sb = run_batch([dict(base, **prev)])
        print(f"start ({a.start}): score {sb['score']:.2f}")
        if sb['score'] < best['score']:
            best = sb
    for stage in a.stages.split(','):
        b = dict(best['params'])
        if stage == 'contrast':
            cands = [dict(b, gamma=g) for g in (0.06, 0.09, 0.12, 0.16, 0.2, 0.25, 0.32, 0.4, 0.5, 0.63)
                     if abs(g - b['gamma']) > 1e-6]
        elif stage == 'morphology':
            cands = [dict(b, spread_par=sp, spread_perp=sq, rc=rc) for sp in (1.6, 2.4, 3.2) for sq in (5.0, 7.0, 9.0)
                     for rc in (0.45, 0.7, 1.0)]
        elif stage == 'time':
            cands = []
            for T in (3.0, 4.0, 5.0, 6.0, 7.0, 8.0):
                cands.append(dict(b, t_life=T, m0x=m0x_for(T, pitch_target), n_gen=2, env_w=0.0))
        elif stage == 'envelope':
            # model variant: plateau envelope (rise / fall smoothstep over env_w * T_LIFE, constant in between; the
            # two generations still sum to strength) - not in the app yet (app: sin^2)
            cands = [dict(b, n_gen=2, t_life=T, env_w=w, m0x=m0x) for T, w, m0x in
                     ((4.0, 0.15, 3.0), (5.0, 0.1, 2.0), (5.0, 0.15, 0.0), (5.0, 0.1, 1.0), (6.0, 0.1, 2.0), (6.0, 0.15, 0.0),
                      (6.0, 0.1, 1.0), (7.0, 0.1, 0.0))]
        elif stage == 'envelope2':
            # around a plateau-envelope optimum: longer lives, narrower / wider crossfades, birth mode +-1
            T0, w0, m0 = b['t_life'], max(b.get('env_w', 0.1), 0.05), b['m0x']
            cands = [dict(b, n_gen=2, t_life=T, env_w=w, m0x=m) for T in (T0 - 1, T0, T0 + 1, T0 + 2) for w in (0.05, w0, 0.2)
                     for m in (m0 - 1, m0, m0 + 1) if not (T == T0 and abs(w - w0) < 1e-9 and m == m0) and T >= 3]
        elif stage == 'generations':
            # model variant: n overlapping generations (born every T/n, amplitude (2/n) sin^2) - not in the app yet
            cands = [dict(b, n_gen=n, t_life=T, m0x=m0x_for(T, pitch_target)) for n in (3, 4) for T in (3.0, 4.0, 5.0)]
        elif stage == 'contrast2':
            cands = [dict(b, gamma=b['gamma'] * f) for f in (0.8, 0.9, 1.1, 1.25)]
        elif stage == 'spacing':
            cands = [dict(b, tile_scale=s) for s in (0.8, 1.0, 1.2, 1.4, 1.6, 1.8) if abs(s - b['tile_scale']) > 1e-6]
        elif stage == 'dislocations':
            # R_C with ln(gamma) rescaled so that the mean local strength <1 - exp(-|W|^2/Rc^2)> = 1/(1 + Rc^2)
            # (|W|^2 exponentially distributed, mean 1) times ln(gamma) stays the same
            f0 = 1 / (1 + b['rc'] ** 2)
            cands = []
            for rc in (0.3, 0.45, 0.6, 0.8, 1.0):
                if abs(rc - b['rc']) < 1e-6:
                    continue
                g = math.exp(math.log(b['gamma']) * f0 * (1 + rc * rc))
                for sq in (b['spread_perp'] * 0.75, b['spread_perp'], b['spread_perp'] * 1.25):
                    cands.append(dict(b, rc=rc, gamma=g, spread_perp=sq))
        else:
            raise SystemExit(f'unknown stage {stage}')
        print(f'stage {stage}: {len(cands)} candidates')
        bb = run_batch(cands)
        if bb['score'] < best['score']:
            best = bb
        print(f"  best so far: score {best['score']:.2f} {best['params']}")
    out = dict(target=os.path.relpath(a.target, nb.REPO), like=os.path.relpath(os.path.abspath(a.like), nb.REPO), name=name,
               simulator_defaults=dict(params=base, metrics=results[0]['metrics'], score=results[0]['score']),
               target_metrics=target, best=dict(params=best['params'], metrics=best['metrics'], score=best['score'],
                                                 parts={k: round(v, 3) for k, v in best['parts'].items()}),
               candidates=[dict(params=r['params'], score=round(r['score'], 3), metrics={k: round(v, 4) for k, v in r['metrics'].items()})
                           for r in results],
               orbits_per_candidate=a.orbits, metrics_doc=[m[0] for m in METRICS if m[0] not in EXCLUDE],
               excluded=sorted(EXCLUDE), pitch_target=pitch_target, stages=a.stages, start=a.start)
    path = a.out or os.path.join(nb.RESULTS_DIR, f'calib_{name}.json')
    nb.write_json(path, out)
    print(f'wrote {path}')
    shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main(sys.argv[1:])
