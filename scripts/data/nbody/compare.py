#!/usr/bin/env python3
"""Side-by-side markdown table of N-body and procedural wake statistics (from analyze.py result JSONs).

usage ($PY = the venv python, see README.md):
  $PY scripts/data/nbody/compare.py scripts/data/nbody/results/A128-sd.json scripts/data/nbody/results/A128-sd-proc.json ...
      [--rows all|wake|packing|sizes] [--labels "N-body,procedural"]
Values are "mean ± standard error of 1-orbit block means" where the analysis provides one.
"""
import argparse
import json
import math
import os
import sys


def pm(v, nd=2):
    if v is None:
        return '–'
    if isinstance(v, list) and len(v) == 2 and not isinstance(v[0], list):
        m, s = v
        if m is None or (isinstance(m, float) and math.isnan(m)):
            return '–'
        if s is None or (isinstance(s, float) and math.isnan(s)):
            return f'{m:.{nd}f}'
        return f'{m:.{nd}f} ± {s:.{nd}f}'
    if isinstance(v, (int, float)):
        return '–' if isinstance(v, float) and math.isnan(v) else f'{v:.{nd}f}'
    return str(v)


def g(d, *path, default=None):
    for p in path:
        if d is None:
            return default
        if isinstance(p, int):
            d = d[p] if isinstance(d, list) and len(d) > p else None
        else:
            d = d.get(p) if isinstance(d, dict) else None
    return default if d is None else d


def temporal_at(r, lag):
    t = r.get('temporal')
    if not t:
        return None
    try:
        return t['C'][t['lags_orbits'].index(lag)]
    except ValueError:
        return None


WAKE_ROWS = [
    ('spectral peak spacing / λ_T', lambda r: g(r, 'spectrum', 'lambda_w_over_lambda_T'), 2),
    ('power-weighted spacing 2π/⟨k⟩ / λ_T', lambda r: g(r, 'spectrum', 'lambda_mean_k_over_lambda_T'), 2),
    ('ACF spacing (2 × first-minimum lag) / λ_T', lambda r: g(r, 'acf', 'spacing_from_first_min_over_lambda'), 2),
    ('pitch: crest orientation median (IQR) [deg]',
     lambda r: f"{g(r, 'orientation', 'median'):.1f} ({g(r, 'orientation', 'q25'):.0f}–{g(r, 'orientation', 'q75'):.0f})", None),
    ('pitch: spectral peak / ACF axis [deg]',
     lambda r: f"{g(r, 'spectrum', 'pitch_deg', 0):.1f} / {g(r, 'acf', 'pitch_e', 0):.1f}", None),
    ('share of crest energy trailing', lambda r: g(r, 'orientation', 'frac_trailing'), 2),
    ('along-crest correlation length (1/e) / λ_T', lambda r: g(r, 'acf', 'L_par_e_over_lambda'), 2),
    ('across-crest correlation length (1/e) / λ_T', lambda r: g(r, 'acf', 'L_perp_e_over_lambda'), 3),
    ('ACF across crests: first minimum / next maximum',
     lambda r: f"{g(r, 'acf', 'first_min'):+.2f} / {g(r, 'acf', 'side_peak_height', 0):+.2f}", None),
    ('crest end points per λ_T²', lambda r: g(r, 'skeleton', 'n_end_per_lambda2'), 2),
    ('crest branch points per λ_T²', lambda r: g(r, 'skeleton', 'n_branch_per_lambda2'), 2),
    ('mean filament length 2L/n_end / λ_T', lambda r: g(r, 'skeleton', 'filament_length_over_lambda'), 1),
    ('D quantiles p5 / p25 / p50 / p75 / p95 / p99 (λ/16)',
     lambda r: ' / '.join(f"{g(r, 'pdf', 'sigma_lambda_16', k, 0):.2f}" for k in ('p5', 'p25', 'p50', 'p75', 'p95', 'p99')), None),
    ('wakes (D > 1): area fraction f_B', lambda r: g(r, 'granola', 'D_gt_1', 'f_B'), 3),
    ('mean D in wakes / gaps', lambda r: f"{g(r, 'granola', 'D_gt_1', 'D_wake', 0):.2f} / {g(r, 'granola', 'D_gt_1', 'D_gap', 0):.2f}", None),
    ('mass fraction in wakes', lambda r: g(r, 'granola', 'D_gt_1', 'mass_in_wakes'), 2),
    ('τ_dyn in wakes / gaps', lambda r: f"{g(r, 'granola', 'D_gt_1', 'tau_dyn_wake', 0):.2f} / {g(r, 'granola', 'D_gt_1', 'tau_dyn_gap', 0):.2f}", None),
    ('vertical τ_phot: all / gaps / wakes / cores',
     lambda r: (f"{g(r, 'raycast', 'tau_phot'):.2f} / {g(r, 'raycast', 'tau_phot_gap'):.2f} / {g(r, 'raycast', 'tau_phot_wake'):.2f} / "
                f"{g(r, 'raycast', 'tau_phot_core'):.2f}") if r.get('raycast') else '–', None),
    ('τ_dyn (simulated particles)', lambda r: g(r, 'params', 'tau_sim'), 3),
    ('granola fit (slant rays): S/W, H/W, τ_G, pitch',
     lambda r: (f"{g(r, 'granola_fit', 'fit', 'S_over_W'):.2f}, {g(r, 'granola_fit', 'fit', 'H_over_W'):.2f}, "
                f"{g(r, 'granola_fit', 'fit', 'tau_G'):.2f}, {g(r, 'granola_fit', 'fit', 'phi_w_deg') - 90:.0f}°") if r.get('granola_fit') else '–', None),
    ('shearing-frame correlation C(0.1 / 0.2 / 0.3 / 0.5 orbit)',
     lambda r: ' / '.join(f'{temporal_at(r, lag):.2f}' for lag in (0.1, 0.2, 0.3, 0.5)), None),
    ('correlation half-life [orbits]', lambda r: g(r, 'temporal', 'fit', 'half_orbits'), 2),
]
PACK_ROWS = [
    ('mid-plane filling: mean', lambda r: g(r, 'filling', 'sigma_lambda_16', 'mean'), 3),
    ('filling in wake cores (top 10 %), λ/32 / λ/16 / λ/8',
     lambda r: ' / '.join(f"{g(r, 'filling', f'sigma_lambda_{n}', 'core_mean', 0):.2f}" for n in (32, 16, 8)), None),
    ('filling 99.9th percentile, λ/32 / λ/16 / λ/8 / λ/4',
     lambda r: ' / '.join(f"{g(r, 'filling', f'sigma_lambda_{n}', 'p99.9', 0):.2f}" for n in (32, 16, 8, 4)), None),
    ('mass-weighted rms z [m]', lambda r: g(r, 'vertical', 'zrms_mass_weighted_m', 0, 0), 2),
    ('column σ_z vs D: slope β (D > 1)', lambda r: g(r, 'vertical', 'thickness_vs_D', 'beta_wakes'), 2),
    ('radial velocity dispersion (mass-weighted) [mm/s]', lambda r: g(r, 'velocity', 'c_r_mass_mm_s'), 2),
    ('Toomre Q', lambda r: g(r, 'velocity', 'Q'), 2),
]


def size_table(results, labels):
    out = []
    for lab, r in zip(labels, results):
        bins = g(r, 'vertical', 'size_bins_m')
        if not bins:
            continue
        out.append(f'\n**{lab}** ({r["run"]})\n')
        out.append('| radius bin (m) | N | rms z (m) all / gaps / wakes / cores | c_x, c_y, c_z (mm/s) | local c_x (mm/s) | participation p | n_wake/n_gap |')
        out.append('|---|---|---|---|---|---|---|')
        z = g(r, 'vertical', 'zrms_m', 0)
        zg = g(r, 'vertical', 'zrms_gap_m', 0)
        zw = g(r, 'vertical', 'zrms_wake_m', 0)
        zc = g(r, 'vertical', 'zrms_core_m', 0)
        cv = g(r, 'velocity', 'c_xyz_mm_s')
        cl = g(r, 'velocity', 'c_xyz_local_mm_s')
        pp = g(r, 'sizes', 'participation', 0)
        ct = g(r, 'sizes', 'contrast_wake_gap', 0)
        for k, b in enumerate(bins):
            f = lambda a, i: '–' if a is None or a[i] is None or (isinstance(a[i], float) and math.isnan(a[i])) else f'{a[i]:.2f}'  # noqa: E731
            out.append(f"| {b[0]:.2f}–{b[1]:.2f} | {r['vertical']['counts'][k]} | {f(z, k)} / {f(zg, k)} / {f(zw, k)} / {f(zc, k)} | "
                       f"{cv[k][0]:.2f}, {cv[k][1]:.2f}, {cv[k][2]:.2f} | {cl[k][0]:.2f} | {f(pp, k) if pp else '–'} | {f(ct, k) if ct else '–'} |")
    return '\n'.join(out)


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('json', nargs='+')
    ap.add_argument('--rows', default='all', choices=['all', 'wake', 'packing', 'sizes'])
    ap.add_argument('--labels')
    a = ap.parse_args(argv)
    results = []
    for p in a.json:
        with open(p) as f:
            results.append(json.load(f))
    labels = a.labels.split(',') if a.labels else [os.path.basename(p).replace('.json', '') for p in a.json]
    rows = (WAKE_ROWS if a.rows in ('all', 'wake') else []) + (PACK_ROWS if a.rows in ('all', 'packing') else [])
    if rows:
        print('| statistic | ' + ' | '.join(labels) + ' |')
        print('|---|' + '---|' * len(labels))
        for lab, fn, nd in rows:
            cells = []
            for r in results:
                try:
                    v = fn(r)
                    cells.append(pm(v, nd) if nd is not None else str(v))
                except Exception:
                    cells.append('–')
            print(f'| {lab} | ' + ' | '.join(cells) + ' |')
    if a.rows in ('all', 'sizes'):
        print(size_table(results, labels))


if __name__ == '__main__':
    main(sys.argv[1:])
