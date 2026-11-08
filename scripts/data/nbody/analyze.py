#!/usr/bin/env python3
"""Wake and packing statistics of an N-body run (sheet.py) or a synthetic procedural run (procedural.py synth).

usage ($PY = the venv python, see README.md):
  $PY scripts/data/nbody/analyze.py data-raw/nbody/A128-ident [--from ORBIT] [--to ORBIT] [--every K]
      [--json PATH] [--plots DIR] [--raycast N] [--granola N] [--quick]
  defaults: --from = the run's fine_from (start of the 0.05-orbit snapshots), all snapshots after it, results to
  scripts/data/nbody/results/<run>.json, plots (PNG) to data-raw/nbody/plots/<run>/ (not committed).

Both kinds of runs go through the same pipeline on a physical grid of cell h = lambda_T/32 over the box:
  * fields: particle masses, cross-sections (tau_dyn), mid-plane chords pi (a^2 - z^2) (filling factor), m z^2,
    per-size-bin numbers / masses and momenta are deposited (cloud-in-cell) and Gaussian-smoothed with sigma_s in
    PHYSICAL coordinates. N-body: the box is shear-periodic, so the deposit is done on the doubly periodic sheared grid
    (x, y + D x / Lx) and smoothed by FFT with the physical wavevector (kx' + ky D / Lx, ky) (exact); synthetic:
    the box plus a margin (1 lambda) is deposited and smoothed with scipy.ndimage, then cropped. D = Sigma / <Sigma>
    is the surface-density factor (the quantity WakeField's wakeDensity() models).
  * statistics (per snapshot; uncertainties = standard error of 1-orbit block means):
    pdf        quantiles of D at sigma_s = lambda/16 and lambda/8, histogram
    granola    wake/gap split at D = 1 and at the Otsu threshold: area fraction f_B, mass fraction, mean D and tau_dyn
               in wakes / gaps, widths W_wake = f_B lambda_w, W_gap = (1 - f_B) lambda_w
    spectrum   Hann-windowed 2-D power spectrum of D (sigma lambda/32), time-averaged: peak -> spacing lambda_w and
               pitch (crest angle from the azimuthal direction, trailing > 0); peak widths (parallel/perpendicular)
    acf        windowed autocorrelation: central-peak ellipse at 1/e and 1/2 (along-crest correlation length L_par,
               across-crest L_perp, orientation), first side peak (spacing, height = regularity)
    orient     structure-tensor crest orientation per pixel inside wakes: pitch distribution (mean, median, std)
    skeleton   crests of D > 1 (sigma lambda/16), skeletonized: end points and branch points per lambda^2, crest length
               per lambda^2, mean filament length 2 L / n_end, segment lengths between nodes
    temporal   shearing-frame autocorrelation C(dt) = corr(D(x, y, t), D(x, y - 1.5 Omega x dt, t + dt)), fitted
               A exp(-dt / t_c) for dt >= 0.1 orbit (sigma lambda/8; the procedural one uses the exact field)
    vertical   rms z per size bin (number weighted) overall and in gaps (D < 1), wakes (D > 1), cores (top 10 % area);
               local mass-weighted rms z vs D (log-log slope beta: sigma_z ~ D^beta)
    filling    mid-plane volume filling factor FF = sum pi (a^2 - z^2) / area (sigma lambda/16 and lambda/32):
               mean, mean in cores, 99th percentile, max; FF vs D
    sizes      per size bin: participation p = cov(n_b, D_-b) / var(D_-b) (D_-b = density without the bin), contrast
               <n_b>_wake / <n_b>_gap, mean D_-b at the particles; velocity dispersion (global and relative to the local
               mean flow at lambda/8)
    raycast    (every --raycast N snapshots) normal photometric optical depth by Monte-Carlo vertical rays through
               the spheres: tau_phot = -ln T overall, in gaps and in wakes
    granola-fit (every --granola N snapshots) transmission T(B, phi) for slant rays (B = 10..90 deg, phi = 0..165 deg),
               fitted with the Colwell et al. (2006) granola-bar model T = max(0, (S - H |sin(phi - phi_w)| cot B) /
               lambda_w) exp(-tau_G / sin B): S/W, H/W, tau_G, phi_w
"""
import argparse
import math
import os
import sys
import time

import numpy as np
from scipy import ndimage, optimize
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nbcommon as nb  # noqa: E402

SIZE_EDGES = np.array([0.1, 0.2, 0.35, 0.6, 1.0, 1.75, 3.0, 5.0, 7.0])
QUANT = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.999]


# ------------------------------------------------------------------ run / fields
class Run:
    def __init__(self, run_dir):
        self.dir = os.path.abspath(run_dir)
        self.name = os.path.basename(self.dir.rstrip('/'))
        self.params, self.r, self.m, self.snaps = nb.load_run(run_dir)
        cfg, d = self.params['config'], self.params['derived']
        self.cfg, self.d = cfg, d
        self.kind = 'procedural' if 'procedural' in cfg else 'nbody'
        self.periodic = d.get('periodic', True)
        self.lam = d['lambda_T']
        self.Lx, self.Ly = d['Lx'], d['Ly']
        self.Om, self.P = d['Omega'], d['P']
        self.h = d.get('grid_h', self.lam / 32)
        self.nx, self.ny = int(round(self.Lx / self.h)), int(round(self.Ly / self.h))
        self.hx, self.hy = self.Lx / self.nx, self.Ly / self.ny
        self.margin = d.get('margin', 0.0)
        self.nm = int(round(self.margin / self.h))
        self.dens = sorted(os.path.join(self.dir, f) for f in os.listdir(self.dir) if f.startswith('dens_'))
        # size bins
        a0, a1 = self.r.min(), self.r.max()
        if a1 / a0 < 1.01:
            self.bins = np.array([a0 * 0.999, a1 * 1.001])
        else:
            e = SIZE_EDGES[(SIZE_EDGES > a0 * 1.0001) & (SIZE_EDGES < a1 * 0.9999)]
            self.bins = np.concatenate([[a0 * 0.999], e, [a1 * 1.001]])
        self.bin_of = np.clip(np.digitize(self.r, self.bins) - 1, 0, len(self.bins) - 2)

    def times(self):
        return [float(np.load(s)['t']) for s in self.snaps]


def cic(nx, ny, u, v, weights, periodic):
    """Cloud-in-cell deposit; u, v in cell units (cell centres at integers). Returns list of [nx, ny] grids."""
    i0 = np.floor(u).astype(np.int64)
    j0 = np.floor(v).astype(np.int64)
    fx, fy = u - i0, v - j0
    out = [np.zeros(nx * ny) for _ in weights]
    for di, dj, w in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
        ii, jj = i0 + di, j0 + dj
        if periodic:
            ii %= nx
            jj %= ny
            ok = slice(None)
        else:
            ok = (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < ny)
        flat = (ii * ny + jj)[ok]
        for o, wt in zip(out, weights):
            o += np.bincount(flat, weights=(w * wt)[ok], minlength=nx * ny)
    return [o.reshape(nx, ny) for o in out]


class Fields:
    """Smoothed physical fields of one snapshot (see the module docstring)."""

    def __init__(self, run, snap, weights, offset=None):
        self.run = run
        self.t = snap['t']
        pos = snap['pos']
        R = run
        if R.periodic:
            self.Dw = nb.wrap_offset(snap['D'], R.Ly) if offset is None else offset
            x, y = pos[:, 0], pos[:, 1]
            ys = y + self.Dw * x / R.Lx
            u = (x + R.Lx / 2) / R.hx - 0.5
            v = (ys + R.Ly / 2) / R.hy - 0.5
            self.gnx, self.gny = R.nx, R.ny
            self.raw = dict(zip(weights.keys(), cic(R.nx, R.ny, u, v, list(weights.values()), True)))
            kx = 2 * np.pi * np.fft.fftfreq(R.nx, R.hx)[:, None]
            ky = 2 * np.pi * np.fft.fftfreq(R.ny, R.hy)[None, :]
            self.k2 = (kx + ky * self.Dw / R.Lx) ** 2 + ky ** 2
        else:
            n0x, n0y = R.nx + 2 * R.nm, R.ny + 2 * R.nm
            u = (pos[:, 0] + R.Lx / 2 + R.margin) / R.h - 0.5
            v = (pos[:, 1] + R.Ly / 2 + R.margin) / R.h - 0.5
            self.gnx, self.gny = n0x, n0y
            self.raw = dict(zip(weights.keys(), cic(n0x, n0y, u, v, list(weights.values()), False)))
        self.cell = R.hx * R.hy
        self.cache = {}
        self.fft = {}

    def add_native(self, name, grid):
        self.raw[name] = grid

    def smooth(self, name, sigma):
        key = (name, round(sigma, 6))
        if key in self.cache:
            return self.cache[key]
        g = self.raw[name] / self.cell
        if sigma <= 0:
            s = g
        elif self.run.periodic:
            if name not in self.fft:
                self.fft[name] = np.fft.fft2(g)
            s = np.real(np.fft.ifft2(self.fft[name] * np.exp(-0.5 * sigma * sigma * self.k2)))
        else:
            s = ndimage.gaussian_filter(g, sigma / self.run.h, mode='nearest', truncate=4.0)
        self.cache[key] = s
        return s

    def at(self, name, sigma, x, y):
        """Field at physical points (bilinear)."""
        R = self.run
        g = self.smooth(name, sigma)
        if R.periodic:
            u = (x + R.Lx / 2) / R.hx - 0.5
            v = (y + self.Dw * x / R.Lx + R.Ly / 2) / R.hy - 0.5
            i0, j0 = np.floor(u).astype(np.int64), np.floor(v).astype(np.int64)
            fx, fy = u - i0, v - j0
            i0 %= R.nx
            j0 %= R.ny
            i1, j1 = (i0 + 1) % R.nx, (j0 + 1) % R.ny
        else:
            u = np.clip((x + R.Lx / 2 + R.margin) / R.h - 0.5, 0, self.gnx - 1.000001)
            v = np.clip((y + R.Ly / 2 + R.margin) / R.h - 0.5, 0, self.gny - 1.000001)
            i0, j0 = np.floor(u).astype(np.int64), np.floor(v).astype(np.int64)
            fx, fy = u - i0, v - j0
            i1, j1 = i0 + 1, j0 + 1
        return (g[i0, j0] * (1 - fx) * (1 - fy) + g[i1, j0] * fx * (1 - fy) + g[i0, j1] * (1 - fx) * fy + g[i1, j1] * fx * fy)

    def box(self, name, sigma, pad=0):
        """Field on the physical grid over the box (+ pad cells on every side)."""
        R = self.run
        if not R.periodic:
            g = self.smooth(name, sigma)
            p = min(pad, R.nm)
            return g[R.nm - p:R.nm + R.nx + p, R.nm - p:R.nm + R.ny + p]
        xs = -R.Lx / 2 + (np.arange(-pad, R.nx + pad) + 0.5) * R.hx
        ys = -R.Ly / 2 + (np.arange(-pad, R.ny + pad) + 0.5) * R.hy
        X, Y = np.meshgrid(xs, ys, indexing='ij')
        return self.at(name, sigma, X, Y)


def particle_weights(run, snap):
    r, m = run.r, run.m
    z = snap['pos'][:, 2]
    vel = snap['vel']
    vy = vel[:, 1] + 1.5 * run.Om * snap['pos'][:, 0]
    w = dict(mass=m, area=np.pi * r * r, ff=np.pi * np.maximum(0.0, r * r - z * z), mz2=m * z * z,
             mvx=m * vel[:, 0], mvy=m * vy, mvz=m * vel[:, 2])
    nb_ = len(run.bins) - 1
    if nb_ > 1:
        for b in range(nb_):
            sel = (run.bin_of == b).astype(np.float64)
            w[f'n{b}'] = sel
            w[f'm{b}'] = sel * m
    return w


# ------------------------------------------------------------------ helpers
def block_stats(values, times, P, block=1.0):
    """mean and standard error of 1-orbit block means (values: list of numbers or arrays)."""
    v = np.asarray(values, dtype=np.float64)
    t = np.asarray(times) / P
    if len(v) == 0:
        return None
    b = np.floor((t - t.min()) / block).astype(int)
    means = np.array([v[b == k].mean(axis=0) for k in np.unique(b) if (b == k).sum() > 0])
    m = v.mean(axis=0)
    se = means.std(axis=0, ddof=1) / math.sqrt(len(means)) if len(means) > 1 else np.full_like(m, np.nan)
    return m, se


def ms(pair, nd=4):
    """[mean, se] rounded for JSON."""
    if pair is None:
        return None
    m, s = pair
    if np.ndim(m) == 0:
        return [round(float(m), nd), round(float(s), nd) if np.isfinite(s) else None]
    return [[round(float(a), nd) for a in np.atleast_1d(m)], [round(float(a), nd) if np.isfinite(a) else None for a in np.atleast_1d(s)]]


def otsu(values, nbin=256):
    lv = np.log(np.clip(values, 1e-3, None))
    hist, edges = np.histogram(lv, nbin)
    c = 0.5 * (edges[1:] + edges[:-1])
    w0 = np.cumsum(hist)
    w1 = w0[-1] - w0
    m0 = np.cumsum(hist * c) / np.maximum(w0, 1)
    m1 = (np.sum(hist * c) - np.cumsum(hist * c)) / np.maximum(w1, 1)
    between = w0 * w1 * (m0 - m1) ** 2
    return float(np.exp(c[np.argmax(between)]))


def hann2(nx, ny):
    return np.outer(np.hanning(nx), np.hanning(ny))


# ------------------------------------------------------------------ spectrum / ACF / orientation / skeleton
class SpecAcc:
    """Accumulates the windowed power spectrum and autocorrelation of D - 1 over snapshots."""

    def __init__(self, run, pad=2):
        self.R = run
        self.Mx, self.My = pad * run.nx, pad * run.ny
        self.win = hann2(run.nx, run.ny)
        wf = np.fft.fft2(self.win, (self.Mx, self.My))
        self.wacf = np.real(np.fft.ifft2(np.abs(wf) ** 2))
        self.P = np.zeros((self.Mx, self.My))
        self.A = np.zeros((self.Mx, self.My))
        self.n = 0
        self.kx = 2 * np.pi * np.fft.fftfreq(self.Mx, run.hx)
        self.ky = 2 * np.pi * np.fft.fftfreq(self.My, run.hy)
        self.blocks = {}

    def add(self, D, t):
        f = (D - D.mean()) * self.win
        F = np.fft.fft2(f, (self.Mx, self.My))
        p = np.abs(F) ** 2
        a = np.real(np.fft.ifft2(p))
        self.P += p
        self.A += a
        self.n += 1
        b = int(math.floor(t / self.R.P))
        P, A, n = self.blocks.get(b, (0, 0, 0))
        self.blocks[b] = (P + p, A + a, n + 1)
        return peak(self, p)


def peak(acc, p):
    """Spectral peak in the half plane ky >= 0 within 0.33 .. 3 x the Toomre wavenumber: (lambda_w, pitch_deg)."""
    R = acc.R
    KX, KY = np.meshgrid(acc.kx, acc.ky, indexing='ij')
    k = np.hypot(KX, KY)
    k0 = 2 * np.pi / R.lam
    sel = (k > k0 / 3) & (k < 3 * k0) & (KY >= 0)
    pp = np.where(sel, p, -1)
    i, j = np.unravel_index(np.argmax(pp), pp.shape)
    # centroid over the neighbourhood above half the peak
    ii = (np.arange(i - 3, i + 4)) % acc.Mx
    jj = (np.arange(j - 3, j + 4)) % acc.My
    sub = p[np.ix_(ii, jj)]
    w = np.where(sub > 0.5 * p[i, j], sub, 0)
    kxc = (w * KX[np.ix_(ii, jj)]).sum() / w.sum()
    kyc = (w * KY[np.ix_(ii, jj)]).sum() / w.sum()
    if kyc < 0:
        kxc, kyc = -kxc, -kyc
    lam_w = 2 * np.pi / math.hypot(kxc, kyc)
    pitch = math.degrees(math.atan2(kyc, kxc))   # crest angle from the azimuth: atan(ky / kx); trailing: kx, ky > 0
    if pitch > 90:
        pitch -= 180
    return lam_w, pitch, kxc, kyc


def spectrum_widths(acc, P, kxc, kyc):
    """rms width of the spectral peak along k (radial-ish, spacing irregularity) and across k (crest length)."""
    KX, KY = np.meshgrid(acc.kx, acc.ky, indexing='ij')
    kc = math.hypot(kxc, kyc)
    ex, ey = kxc / kc, kyc / kc
    dpar = (KX - kxc) * ex + (KY - kyc) * ey
    dper = -(KX - kxc) * ey + (KY - kyc) * ex
    sel = (np.hypot(dpar, dper) < 0.6 * kc)
    w = np.where(sel, P, 0)
    w2 = np.where(np.hypot(KX + kxc, KY + kyc) < 0.6 * kc, P, 0)   # the mirror peak
    W = w.sum()
    spar = math.sqrt((w * dpar ** 2).sum() / W)
    sper = math.sqrt((w * dper ** 2).sum() / W)
    kmean = float((w * np.hypot(KX, KY)).sum() / W)
    return spar / kc, sper / kc, float((w.sum() + w2.sum()) / P.sum()), 2 * np.pi / kmean


def acf_measures(acc, A):
    """Central-peak ellipse at 1/e and 1/2, side peak along the short axis. A: accumulated ACF numerator."""
    R = acc.R
    a = A / np.maximum(acc.wacf, 1e-12 * acc.wacf.max())
    a = a / a[0, 0]
    a = np.fft.fftshift(a)
    # restrict to lags where the window overlap is substantial
    ov = np.fft.fftshift(acc.wacf / acc.wacf[0, 0])
    a = np.where(ov > 0.05, a, np.nan)
    cx, cy = acc.Mx // 2, acc.My // 2
    lx = (np.arange(acc.Mx) - cx) * R.hx
    ly = (np.arange(acc.My) - cy) * R.hy
    LX, LY = np.meshgrid(lx, ly, indexing='ij')
    out = {}
    for lev, tag in ((1 / math.e, 'e'), (0.5, 'half')):
        m = np.nan_to_num(a, nan=-1) > lev
        lab, _ = ndimage.label(m)
        mm = lab == lab[cx, cy]
        w = mm.astype(float)
        Ixx = (w * LX ** 2).sum() / w.sum()
        Iyy = (w * LY ** 2).sum() / w.sum()
        Ixy = (w * LX * LY).sum() / w.sum()
        ev, evec = np.linalg.eigh(np.array([[Ixx, Ixy], [Ixy, Iyy]]))
        # uniform ellipse with semi-axes A, B: second moments A^2/4, B^2/4
        Lpar, Lper = 2 * math.sqrt(ev[1]), 2 * math.sqrt(max(ev[0], 0))
        vx, vy = evec[:, 1]
        # long axis = crest direction; pitch = angle from the y axis, trailing (dy/dx < 0 along the crest) positive
        if vy < 0:
            vx, vy = -vx, -vy
        pitch = math.degrees(math.atan2(-vx, vy))
        out[tag] = dict(L_par=Lpar, L_perp=Lper, pitch=pitch)
    # side peak along the short axis (across crests)
    pitch = math.radians(out['e']['pitch'])
    nx_, ny_ = math.cos(pitch), math.sin(pitch)        # unit vector across the crests (along k)
    s = np.arange(0, 3 * R.lam, R.hx / 2)
    px, py = cx + s * nx_ / R.hx, cy + s * ny_ / R.hy
    prof = ndimage.map_coordinates(np.nan_to_num(a, nan=0.0), [px, py], order=1)
    # first local minimum, then the first local maximum after it (the neighbouring crest), then the next ones
    def next_ext(p, start, rising):
        d = np.diff(p[start:])
        k = np.argmax(d < 0) if rising else np.argmax(d > 0)
        ok = (d < 0).any() if rising else (d > 0).any()
        return start + int(k) if ok else len(p) - 1
    dmin = next_ext(prof, 0, False)
    jmax = next_ext(prof, dmin, True)
    out['side_peak'] = dict(lag=float(s[jmax]), height=float(prof[jmax]), min_lag=float(s[dmin]), min=float(prof[dmin]))
    d2 = next_ext(prof, jmax, False)
    j2 = next_ext(prof, d2, True)
    if j2 < len(prof) - 1:
        out['second_peak'] = dict(lag=float(s[j2]), height=float(prof[j2]))
    # profile along the crest (long axis)
    ex_, ey_ = -math.sin(pitch), math.cos(pitch)
    px, py = cx + s * ex_ / R.hx, cy + s * ey_ / R.hy
    out['along_profile'] = [round(float(v), 4) for v in ndimage.map_coordinates(np.nan_to_num(a, nan=0.0), [px, py], order=1)[::8]]
    out['across_profile'] = [round(float(v), 4) for v in prof[::4]]
    out['profile_step_m'] = [float(R.hx / 2 * 8), float(R.hx / 2 * 4)]
    return out


def orientation_hist(D, h, lam):
    """Structure-tensor crest pitch per pixel in wakes (D > 1): histogram weighted by gradient energy x coherence."""
    gx = np.gradient(D, h, axis=0)
    gy = np.gradient(D, h, axis=1)
    st = lam / 8 / h
    Jxx = ndimage.gaussian_filter(gx * gx, st)
    Jyy = ndimage.gaussian_filter(gy * gy, st)
    Jxy = ndimage.gaussian_filter(gx * gy, st)
    tr = Jxx + Jyy
    det = np.sqrt((Jxx - Jyy) ** 2 + 4 * Jxy ** 2)
    coh = np.where(tr > 0, det / np.maximum(tr, 1e-30), 0) ** 2
    # dominant gradient direction theta (from x): tan 2theta = 2Jxy / (Jxx - Jyy); crest pitch = theta (angle of the
    # crest from the y axis equals the angle of its normal from the x axis), trailing when the normal has kx ky > 0
    theta = 0.5 * np.arctan2(2 * Jxy, Jxx - Jyy)
    pitch = np.degrees(theta)                 # in (-90, 90]
    w = tr * coh * (D > 1)
    e = core = None
    hist, e = np.histogram(pitch, bins=np.arange(-90, 91, 5), weights=w)
    return hist, e, pitch, w


def skeleton_stats(Dpad, pad, h, lam, thr):
    from skimage.morphology import skeletonize
    mask = Dpad > thr
    lab, nlab = ndimage.label(mask)
    if nlab:
        sizes = ndimage.sum(mask, lab, index=np.arange(1, nlab + 1))
        small = np.concatenate([[False], sizes * h * h < (lam / 4) ** 2])
        mask = mask & ~small[lab]
    sk = skeletonize(mask)
    # crossing number (Rutovitz): half the 0/1 transitions around the 8-neighbour ring; 1 = end, >= 3 = branch
    ring = [(-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1)]
    nbv = [np.roll(np.roll(sk, -di, 0), -dj, 1) for di, dj in ring]
    cn = sum((nbv[k] != nbv[(k + 1) % 8]).astype(int) for k in range(8)) // 2
    inner = np.zeros_like(sk)
    inner[pad:-pad, pad:-pad] = True
    ends = sk & (cn == 1) & inner
    br = sk & (cn >= 3)
    brl, nbr = ndimage.label(br & inner, structure=np.ones((3, 3)))
    area = (Dpad.shape[0] - 2 * pad) * (Dpad.shape[1] - 2 * pad) * h * h
    # length: half the summed distances to 8-neighbours
    L = 0.0
    sk_in = sk & inner
    for di, dj, dl in ((1, 0, 1), (0, 1, 1), (1, 1, math.sqrt(2)), (1, -1, math.sqrt(2))):
        sh = np.roll(np.roll(sk, -di, 0), -dj, 1)
        L += (sk_in & sh).sum() * dl * h
    # segments between nodes
    seg = sk & ~ndimage.binary_dilation(br, structure=np.ones((3, 3)))
    sl, ns = ndimage.label(seg, structure=np.ones((3, 3)))
    sizes = ndimage.sum(seg & inner, sl, index=np.arange(1, ns + 1)) * h
    sizes = sizes[sizes > 2 * h]
    n_end = int(ends.sum())
    return dict(n_end=n_end / area * lam * lam, n_branch=nbr / area * lam * lam, length=L / area * lam,
                filament=(2 * L / n_end / lam) if n_end else float('nan'),
                seg_median=float(np.median(sizes) / lam) if len(sizes) else float('nan'),
                seg_mean=float(np.mean(sizes) / lam) if len(sizes) else float('nan'),
                wake_area=float(mask[pad:-pad, pad:-pad].mean()))


# ------------------------------------------------------------------ ray casting
def physical_particles(run, snap, pad):
    """Particle (x, y, z, r) covering the box + pad (N-body: with shear-periodic images near the edges)."""
    pos, r = snap['pos'], run.r
    if not run.periodic:
        return pos[:, 0], pos[:, 1], pos[:, 2], r
    # image (ix, iy) of a particle at (x0, y0): (x0 + ix Lx, y0 - ix D + iy Ly), since f(x + Lx, y) = f(x, y + D);
    # with |D| <= Ly/2 and pad < Ly/2, iy in {-1, 0, 1} reaches every image inside the padded box
    D = nb.wrap_offset(snap['D'], run.Ly)
    xs, ys, zs, rs = [pos[:, 0]], [pos[:, 1]], [pos[:, 2]], [r]
    Lx, Ly = run.Lx, run.Ly
    for ix in (-1, 0, 1):
        for iy in (-1, 0, 1):
            if ix == 0 and iy == 0:
                continue
            x = pos[:, 0] + ix * Lx
            y = pos[:, 1] - ix * D + iy * Ly
            sel = (np.abs(x) < Lx / 2 + pad) & (np.abs(y) < Ly / 2 + pad)
            if sel.any():
                xs.append(x[sel]), ys.append(y[sel]), zs.append(pos[sel, 2]), rs.append(r[sel])
    return np.concatenate(xs), np.concatenate(ys), np.concatenate(zs), np.concatenate(rs)


def covered(px, py, cx, cy, cr, nclass=14):
    """Boolean: points (px, py) covered by any disc (cx, cy, cr)."""
    out = np.zeros(len(px), bool)
    lo, hi = cr.min(), cr.max()
    edges = np.geomspace(lo * 0.999, hi * 1.001, nclass + 1) if hi / lo > 1.01 else np.array([lo * 0.999, hi * 1.001])
    pts = np.stack([px, py], 1)
    for k in range(len(edges) - 1):
        s = (cr >= edges[k]) & (cr < edges[k + 1])
        n = int(s.sum())
        if n == 0:
            continue
        tree = cKDTree(np.stack([cx[s], cy[s]], 1))
        kk = min(6, n)
        d, i = tree.query(pts, k=kk, distance_upper_bound=edges[k + 1])
        if kk == 1:
            d, i = d[:, None], i[:, None]
        rad = np.append(cr[s], 0.0)[np.minimum(i, n)]
        out |= np.any(d < rad, axis=1)
    return out


def raycast_vertical(run, snap, F, npts, rng, sig):
    x, y, z, r = physical_particles(run, snap, run.r.max() + 1)
    px = rng.uniform(-run.Lx / 2, run.Lx / 2, npts)
    py = rng.uniform(-run.Ly / 2, run.Ly / 2, npts)
    cov = covered(px, py, x, y, r)
    Dp = F.at('mass', sig, px, py) / F.mean_mass
    out = dict(T=float(1 - cov.mean()), T_gap=float(1 - cov[Dp < 1].mean()), T_wake=float(1 - cov[Dp >= 1].mean()))
    q90 = np.quantile(Dp, 0.9)
    out['T_core'] = float(1 - cov[Dp >= q90].mean())
    return out


def raycast_slant(run, snap, B_deg, phi_deg, npts, rng):
    """Transmission for parallel rays at elevation B (deg above the ring plane) and azimuth phi (deg, from the radial
    +x direction toward +y). A sphere blocks the ray through the mid-plane point P if |P - c_proj| < r in the metric
    stretched by sin B along the azimuth (c_proj = centre shifted by -z cot B along the azimuth)."""
    B, ph = math.radians(B_deg), math.radians(phi_deg)
    cotB = 1 / math.tan(B)
    reach = 4 * float(np.std(snap['pos'][:, 2])) * cotB + run.r.max() / math.sin(B) + 1
    x, y, z, r = physical_particles(run, snap, min(reach, 0.49 * min(run.Lx, run.Ly)))
    ex, ey = math.cos(ph), math.sin(ph)
    cx, cy = x - z * cotB * ex, y - z * cotB * ey
    px = rng.uniform(-run.Lx / 4, run.Lx / 4, npts)   # central part: images cover the reach
    py = rng.uniform(-run.Ly / 4, run.Ly / 4, npts)

    def tr(ax, ay):
        par = ax * ex + ay * ey
        per = -ax * ey + ay * ex
        return par * math.sin(B), per
    a1, b1 = tr(cx, cy)
    a2, b2 = tr(px, py)
    cov = covered(a2, b2, a1, b1, r)
    return float(1 - cov.mean())


def granola_model(p, B, phi):
    """Colwell et al. 2006: opaque wakes of height H and width W, gaps of width S with optical depth tau_G, wake
    orientation phi_w (azimuth of the crest normal). p = (S/lambda, H/lambda, tau_G, phi_w)."""
    s, hh, tg, pw = p
    proj = s - hh * np.abs(np.sin(phi - pw)) / np.tan(B)
    return np.maximum(proj, 0) * np.exp(-tg / np.sin(B))


def fit_granola(B, phi, T):
    best = None
    for pw0 in np.radians(np.arange(0, 180, 15)):
        p0 = [0.4, 0.15, 0.1, pw0]
        try:
            res = optimize.least_squares(lambda p: granola_model(p, B, phi) - T, p0,
                                         bounds=([0.01, 0.0, 0.0, -np.pi], [0.99, 2.0, 3.0, 2 * np.pi]))
        except Exception:
            continue
        if best is None or res.cost < best.cost:
            best = res
    s, hh, tg, pw = best.x
    W = 1 - s
    return dict(S_over_lambda=float(s), H_over_lambda=float(hh), tau_G=float(tg), S_over_W=float(s / W),
                H_over_W=float(hh / W), phi_w_deg=float(math.degrees(pw) % 180), rms=float(np.sqrt(np.mean(best.fun ** 2))))


# ------------------------------------------------------------------ temporal coherence
def temporal_procedural(run, lags_orb, nt=24):
    import procedural as pr
    sc = run.cfg['procedural']
    wf = pr.WakeFieldPort(run.cfg.get('seed_proc', 12345), m0x=sc['m0x'], m0y=sc['m0y'], t_life=sc['t_life'], rc=sc['rc'])
    wf.configure(sc['lambda_m'], sc['strength'], sc['gamma'], sc['spread_par'], sc['spread_perp'], sc['omega'])
    xs = -run.Lx / 2 + (np.arange(0, run.nx, 2) + 0.5) * run.hx
    ys = -run.Ly / 2 + (np.arange(0, run.ny, 2) + 0.5) * run.hy
    X, Y = np.meshgrid(xs, ys, indexing='ij')
    t0 = run.cfg['t0']
    res = []
    rng = np.random.default_rng(3)
    t1s = t0 + rng.uniform(0, 6, nt) * run.P
    base = []
    for t1 in t1s:
        wf.update(t1)
        base.append(wf.density(X, Y))
    for lag in lags_orb:
        cs = []
        for t1, b in zip(t1s, base):
            dt = lag * run.P
            wf.update(t1 + dt)
            f2 = wf.density(X, Y - 1.5 * run.Om * X * dt)
            cs.append(np.corrcoef(b.ravel(), f2.ravel())[0, 1])
        res.append((lag, float(np.mean(cs)), len(cs)))
    return res


def fit_decay(res, min_lag=0.1):
    lag = np.array([r[0] for r in res])
    c = np.array([r[1] for r in res])
    sel = (lag >= min_lag) & np.isfinite(c) & (c > 0.02)
    if sel.sum() < 3:
        return None
    pf = np.polyfit(lag[sel], np.log(c[sel]), 1)
    tc = -1 / pf[0] if pf[0] < 0 else float('inf')
    half = float('nan')
    below = np.where(c < 0.5)[0]
    if len(below):
        k = below[0]
        half = float(np.interp(0.5, [c[k], c[k - 1]], [lag[k], lag[k - 1]])) if k > 0 else float(lag[k])
    return dict(t_c_orbits=float(tc), A=float(math.exp(pf[1])), half_orbits=half)


# ------------------------------------------------------------------ main analysis
def analyze(args):
    R = Run(args.run)
    times = R.times()
    t_from = (args.from_orbit if args.from_orbit is not None else R.cfg.get('fine_from', 0.0)) * R.P
    t_to = (args.to_orbit if args.to_orbit is not None else 1e9) * R.P
    idx = [i for i, t in enumerate(times) if t_from - 1 <= t <= t_to + 1][::args.every]
    if args.quick:
        idx = idx[::4]
    lam, h = R.lam, R.hx
    s16, s8, s32 = lam / 16, lam / 8, lam / 32
    nbins = len(R.bins) - 1
    print(f'{R.name} ({R.kind}): {len(idx)} snapshots, t = {times[idx[0]] / R.P:.2f} .. {times[idx[-1]] / R.P:.2f} orbits, '
          f'N = {len(R.r)}, box {R.Lx:.1f} m, lambda_T {lam:.2f} m, grid {R.nx}x{R.ny}, size bins {np.round(R.bins, 3).tolist()}')
    acc = SpecAcc(R, pad=2 if R.Lx / lam >= 6 else 4)
    rng = np.random.default_rng(11)
    per = {k: [] for k in ('t', 'lamw', 'pitch', 'q16', 'q8', 'otsu', 'gr1', 'gro', 'ff16', 'ff32', 'skel', 'zr', 'zr_gap',
                           'zr_wake', 'zr_core', 'p_part', 'contrast', 'envD', 'cvel', 'cvel_loc', 'zr_m', 'thick',
                           'ffD', 'dens_q16', 'dens_skel', 'dens_consist', 'ray', 'gran')}
    hist_edges = np.linspace(-3, 3, 121)
    hist16 = np.zeros(len(hist_edges) - 1)
    hist16_dens = np.zeros(len(hist_edges) - 1)
    ohist = np.zeros(36)
    ohist_dens = np.zeros(36)
    snaps_keep = []
    acc_dens = SpecAcc(R, pad=acc.Mx // R.nx) if R.dens else None
    Dbins = np.geomspace(0.1, 10, 21)
    thick_num = np.zeros(len(Dbins) - 1)
    thick_den = np.zeros(len(Dbins) - 1)
    ffD_num = np.zeros(len(Dbins) - 1)
    ffD_den = np.zeros(len(Dbins) - 1)
    t_start = time.time()
    for n, i in enumerate(idx):
        s = nb.load_snapshot(R.snaps[i])
        t = s['t']
        F = Fields(R, s, particle_weights(R, s))
        F.mean_mass = R.m.sum() / (R.Lx * R.Ly) if R.periodic else F.raw['mass'].sum() / (F.gnx * F.gny * F.cell)
        mean_area = (np.pi * R.r ** 2).sum() / (R.Lx * R.Ly) if R.periodic else F.raw['area'].sum() / (F.gnx * F.gny * F.cell)
        D16 = F.box('mass', s16) / F.mean_mass
        D8 = F.box('mass', s8) / F.mean_mass
        D32 = F.box('mass', s32) / F.mean_mass
        per['t'].append(t)
        lw, pt, kxc, kyc = acc.add(D32, t)
        per['lamw'].append(lw)
        per['pitch'].append(pt)
        per['q16'].append(np.quantile(D16, QUANT).tolist() + [float(D16.max()), float(D16.std())])
        per['q8'].append(np.quantile(D8, QUANT).tolist() + [float(D8.max()), float(D8.std())])
        hist16 += np.histogram(np.log(np.clip(D16, 1e-6, None)), hist_edges)[0]
        thr_o = otsu(D16)
        per['otsu'].append(thr_o)
        T16 = F.box('area', s16) / mean_area
        for key, thr in (('gr1', 1.0), ('gro', thr_o)):
            w = D16 > thr
            per[key].append([w.mean(), D16[w].mean() if w.any() else np.nan, D16[~w].mean(), (D16 * w).sum() / D16.sum(),
                             T16[w].mean() if w.any() else np.nan, T16[~w].mean()])
        oh, oe, _, _ = orientation_hist(D32, h, lam)
        ohist += oh
        pad = 32 if R.periodic else min(32, R.nm)
        Dpad = F.box('mass', s16, pad=pad) / F.mean_mass
        sk = skeleton_stats(Dpad, pad, h, lam, 1.0)
        per['skel'].append([sk['n_end'], sk['n_branch'], sk['length'], sk['filament'], sk['seg_median'], sk['seg_mean'], sk['wake_area']])
        # filling factor
        FF16 = F.box('ff', s16)
        FF32 = F.box('ff', s32)
        core = D16 >= np.quantile(D16, 0.9)
        per['ff16'].append([FF16.mean(), FF16[core].mean(), np.quantile(FF16, 0.99), FF16.max()])
        per['ff32'].append([FF32.mean(), FF32[core].mean(), np.quantile(FF32, 0.99), FF32.max()])
        dbin = np.clip(np.digitize(D16, Dbins) - 1, 0, len(Dbins) - 2)
        ffD_num += np.bincount(dbin.ravel(), FF16.ravel(), len(Dbins) - 1)
        ffD_den += np.bincount(dbin.ravel(), minlength=len(Dbins) - 1)
        # local thickness vs D (mass-weighted rms z of the column)
        MZ2 = F.box('mz2', s16)
        M16 = F.box('mass', s16)
        thick_num += np.bincount(dbin.ravel(), MZ2.ravel(), len(Dbins) - 1)
        thick_den += np.bincount(dbin.ravel(), M16.ravel(), len(Dbins) - 1)
        # particle-level
        x, y, z = s['pos'][:, 0], s['pos'][:, 1], s['pos'][:, 2]
        if not R.periodic:
            inb = (np.abs(x) < R.Lx / 2) & (np.abs(y) < R.Ly / 2)
        else:
            inb = np.ones(len(x), bool)
        Dp = F.at('mass', s16, x, y) / F.mean_mass
        q90 = np.quantile(D16, 0.9)
        zr, zg, zw, zc, cv, cvl = [], [], [], [], [], []
        vx, vy, vz = s['vel'][:, 0], s['vel'][:, 1] + 1.5 * R.Om * x, s['vel'][:, 2]
        Mloc = F.at('mass', s8, x, y)
        mvx = F.at('mvx', s8, x, y) / Mloc
        mvy = F.at('mvy', s8, x, y) / Mloc
        mvz = F.at('mvz', s8, x, y) / Mloc
        for b in range(nbins):
            sb = (R.bin_of == b) & inb
            zb = z[sb]
            db = Dp[sb]
            rms = lambda a: float(np.sqrt(np.mean(a * a))) if len(a) else float('nan')  # noqa: E731
            zr.append(rms(zb))
            zg.append(rms(zb[db < 1]))
            zw.append(rms(zb[db >= 1]))
            zc.append(rms(zb[db >= q90]))
            cv.append([rms(vx[sb]), rms(vy[sb]), rms(vz[sb])])
            cvl.append([rms(vx[sb] - mvx[sb]), rms(vy[sb] - mvy[sb]), rms(vz[sb] - mvz[sb])])
        per['zr'].append(zr)
        per['zr_gap'].append(zg)
        per['zr_wake'].append(zw)
        per['zr_core'].append(zc)
        per['cvel'].append(cv)
        per['cvel_loc'].append(cvl)
        wm = R.m[inb] / R.m[inb].sum()
        per['zr_m'].append([float(np.sqrt((wm * z[inb] ** 2).sum()))])
        if nbins > 1:
            pp, cc, ee = [], [], []
            Mtot = F.box('mass', s16)
            area_native = R.Lx * R.Ly if R.periodic else F.gnx * F.gny * F.cell
            for b in range(nbins):
                nbx = F.box(f'n{b}', s16)
                mbx = F.box(f'm{b}', s16)
                mean_rest = F.mean_mass - F.raw[f'm{b}'].sum() / area_native   # mean density of all other bins
                Dm = (Mtot - mbx) / mean_rest
                nn = nbx / nbx.mean() if nbx.mean() > 0 else nbx
                pp.append(float(np.cov(nn.ravel(), Dm.ravel())[0, 1] / Dm.var()))
                wk = Dm >= 1
                cc.append(float(nn[wk].mean() / max(nn[~wk].mean(), 1e-9)))
                sb = (R.bin_of == b) & inb
                Dmp = (F.at('mass', s16, x[sb], y[sb]) - F.at(f'm{b}', s16, x[sb], y[sb])) / mean_rest
                ee.append(float(Dmp.mean()))
            per['p_part'].append(pp)
            per['contrast'].append(cc)
            per['envD'].append(ee)
        # noise-free procedural density (synthetic runs)
        if R.dens:
            dd = np.load(R.dens[i])
            F.add_native('dens', dd['dens'].astype(np.float64) * F.cell)
            P16 = F.box('dens', s16)
            P32 = F.box('dens', s32)
            per['dens_q16'].append(np.quantile(P16, QUANT).tolist() + [float(P16.max()), float(P16.std())])
            hist16_dens += np.histogram(np.log(np.clip(P16, 1e-6, None)), hist_edges)[0]
            acc_dens.add(P32, t)
            oh2, _, _, _ = orientation_hist(P32, h, lam)
            ohist_dens += oh2
            Ppad = F.box('dens', s16, pad=pad)
            sk2 = skeleton_stats(Ppad, pad, h, lam, 1.0)
            per['dens_skel'].append([sk2['n_end'], sk2['n_branch'], sk2['length'], sk2['filament'], sk2['seg_median'], sk2['seg_mean'], sk2['wake_area']])
            per['dens_consist'].append([float(np.corrcoef(P16.ravel(), D16.ravel())[0, 1]), float(D16.mean()), float(P16.mean())])
        if args.raycast and n % args.raycast == 0:
            rc = raycast_vertical(R, s, F, args.rays, rng, s16)
            rc['t'] = t
            per['ray'].append(rc)
        if args.granola and n % args.granola == 0:
            Bs = np.array([10, 15, 20, 30, 45, 60, 90.0])
            phis = np.arange(0, 180, 15.0)
            rows = []
            for Bd in Bs:
                for pd in (phis if Bd < 90 else [0.0]):
                    rows.append((Bd, pd, raycast_slant(R, s, Bd, pd, args.rays // 4, rng)))
            per['gran'].append(rows)
        F.cache.clear()
        F.fft.clear()
        if n % 10 == 0:
            print(f'  {n + 1}/{len(idx)} t = {t / R.P:.2f} orbits  lambda_w {lw:.1f} m  pitch {pt:.1f}  ({time.time() - t_start:.0f} s)', flush=True)
        snaps_keep.append(dict(t=t, F=None))
    T = np.array(per['t'])
    out = dict(run=R.name, kind=R.kind, note=R.cfg.get('note'),
               params=dict(a_km=R.cfg['a_km'], sigma=R.cfg['sigma'], tau_full=R.cfg['tau'],
                           tau_sim=R.d.get('tau_sim', R.d.get('tau_sim_expected')), tau_deficit=R.d.get('tau_deficit'),
                           lambda_T=lam, box_m=R.Lx, box_lambda=R.Lx / lam, N=len(R.r), rho=R.d.get('rho'), r_h=R.d.get('r_h'),
                           a_min=float(R.r.min()), a_max=float(R.r.max()), q=R.cfg.get('q'), radius=R.cfg.get('radius'),
                           Omega=R.Om, P_s=R.P, size_bins=[round(float(b), 4) for b in R.bins], procedural=R.cfg.get('procedural')),
               window=dict(from_orbit=float(T.min() / R.P), to_orbit=float(T.max() / R.P), snapshots=len(T)))
    # spectrum (time average) and per-snapshot peaks
    lw, pt, kxc, kyc = peak(acc, acc.P)
    spar, sper, frac, lmean = spectrum_widths(acc, acc.P, kxc, kyc)
    blk = []
    for b, (Pb, Ab, nb_) in sorted(acc.blocks.items()):
        l2, p2, _, _ = peak(acc, Pb)
        a2 = acf_measures(acc, Ab)
        blk.append([l2, p2, a2['e']['L_par'], a2['e']['L_perp'], a2['e']['pitch'], a2['side_peak']['lag'], a2['side_peak']['height'],
                    a2['half']['L_par'], a2['half']['L_perp']])
    blk = np.array(blk)
    se = blk.std(0, ddof=1) / math.sqrt(len(blk)) if len(blk) > 1 else np.full(blk.shape[1], np.nan)
    acf = acf_measures(acc, acc.A)
    out['spectrum'] = dict(lambda_w=[lw, se[0]], lambda_w_over_lambda_T=[lw / lam, se[0] / lam], pitch_deg=[pt, se[1]],
                           lambda_mean_k=lmean, lambda_mean_k_over_lambda_T=lmean / lam,
                           width_par=spar, width_perp=sper, power_in_peaks=frac,
                           per_snapshot=dict(lambda_w=[float(np.mean(per['lamw'])), float(np.std(per['lamw']))],
                                             pitch_deg=[float(np.mean(per['pitch'])), float(np.std(per['pitch']))],
                                             pitch_quartiles=np.quantile(per['pitch'], [0.25, 0.5, 0.75]).tolist()))
    pts = np.array(per['pitch'])
    if len(pts) > 10:
        pa = pts - pts.mean()
        ac = [np.mean(pa[:-k] * pa[k:]) / pa.var() for k in range(1, min(40, len(pts) // 2))]
        dt_s = np.median(np.diff(T)) / R.P
        k1 = next((k for k, v in enumerate(ac, 1) if v < 1 / math.e), None)
        out['spectrum']['pitch_autocorr_orbits'] = k1 * dt_s if k1 else None
    out['acf'] = dict(L_par_e=[acf['e']['L_par'], se[2]], L_perp_e=[acf['e']['L_perp'], se[3]], pitch_e=[acf['e']['pitch'], se[4]],
                      L_par_half=[acf['half']['L_par'], se[7]], L_perp_half=[acf['half']['L_perp'], se[8]],
                      L_par_e_over_lambda=acf['e']['L_par'] / lam, L_perp_e_over_lambda=acf['e']['L_perp'] / lam,
                      side_peak_lag=[acf['side_peak']['lag'], se[5]], side_peak_lag_over_lambda=acf['side_peak']['lag'] / lam,
                      side_peak_height=[acf['side_peak']['height'], se[6]], first_min=acf['side_peak']['min'],
                      spacing_from_first_min_over_lambda=2 * acf['side_peak']['min_lag'] / lam,
                      second_peak=acf.get('second_peak'), along_profile=acf['along_profile'], across_profile=acf['across_profile'],
                      profile_step_m=acf['profile_step_m'])
    oc = 0.5 * (oe[1:] + oe[:-1])
    def ostats(hh):
        w = hh / hh.sum()
        mean = float((w * oc).sum())
        cdf = np.cumsum(w)
        med = float(np.interp(0.5, cdf, oc))
        return dict(mean=mean, median=med, std=float(math.sqrt((w * (oc - mean) ** 2).sum())),
                    frac_trailing=float(w[oc > 0].sum()), q25=float(np.interp(0.25, cdf, oc)), q75=float(np.interp(0.75, cdf, oc)),
                    hist_5deg=[round(float(v), 4) for v in w])
    out['orientation'] = ostats(ohist)
    q16 = block_stats(per['q16'], T, R.P)
    q8 = block_stats(per['q8'], T, R.P)
    labels = [f'p{q * 100:g}' for q in QUANT] + ['max', 'std']
    out['pdf'] = dict(sigma_lambda_16={k: [round(float(q16[0][j]), 4), round(float(q16[1][j]), 4)] for j, k in enumerate(labels)},
                      sigma_lambda_8={k: [round(float(q8[0][j]), 4), round(float(q8[1][j]), 4)] for j, k in enumerate(labels)},
                      hist_lnD_edges=[-3, 3, 120], hist_lnD_16=[round(float(v), 6) for v in hist16 / hist16.sum()])
    ot = block_stats(per['otsu'], T, R.P)
    g1 = block_stats(per['gr1'], T, R.P)
    go = block_stats(per['gro'], T, R.P)
    tau_sim = out['params']['tau_sim']

    def gran(g, thr):
        fB = g[0][0]
        return dict(threshold=thr, f_B=[g[0][0], g[1][0]], D_wake=[g[0][1], g[1][1]], D_gap=[g[0][2], g[1][2]],
                    mass_in_wakes=[g[0][3], g[1][3]], tau_dyn_wake=[g[0][4] * tau_sim, g[1][4] * tau_sim],
                    tau_dyn_gap=[g[0][5] * tau_sim, g[1][5] * tau_sim], W_wake_m=fB * lw, W_gap_m=(1 - fB) * lw,
                    W_wake_over_lambda_w=fB, S_over_W=(1 - fB) / fB if fB > 0 else None)
    out['granola'] = dict(D_gt_1=gran(g1, 1.0), otsu=gran(go, float(ot[0])), otsu_threshold=ms(ot))
    sk = block_stats(per['skel'], T, R.P)
    out['skeleton'] = dict(zip(['n_end_per_lambda2', 'n_branch_per_lambda2', 'crest_length_per_lambda2', 'filament_length_over_lambda',
                                'segment_median_over_lambda', 'segment_mean_over_lambda', 'wake_area_fraction'],
                               [[round(float(a), 4), round(float(b), 4)] for a, b in zip(*sk)]))
    # temporal coherence
    lags = [0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0]
    if R.kind == 'procedural':
        tr = temporal_procedural(R, lags)
    else:
        sub = idx[::max(1, len(idx) // 60)] if not args.quick else idx[::8]
        snaps_t = []
        all_t = np.array(times)
        want = set()
        for i in sub:
            want.add(i)
            for lag in lags:
                j = int(np.argmin(np.abs(all_t - (all_t[i] + lag * R.P))))
                if abs(all_t[j] - all_t[i] - lag * R.P) < 0.01 * R.P:
                    want.add(j)
        cache = {}
        for j in sorted(want):
            s = nb.load_snapshot(R.snaps[j])
            F = Fields(R, s, dict(mass=R.m))
            F.mean_mass = R.m.sum() / (R.Lx * R.Ly)
            cache[j] = dict(t=s['t'], F=F)
        # pairs: base snapshots `sub`, partners from the cache
        xs = -R.Lx / 2 + (np.arange(R.nx) + 0.5) * R.hx
        ys = -R.Ly / 2 + (np.arange(R.ny) + 0.5) * R.hy
        X, Y = np.meshgrid(xs, ys, indexing='ij')
        tr = []
        for lag in lags:
            cs = []
            for i in sub:
                j = int(np.argmin(np.abs(all_t - (all_t[i] + lag * R.P))))
                if j not in cache or abs(all_t[j] - all_t[i] - lag * R.P) > 0.01 * R.P:
                    continue
                dt = all_t[j] - all_t[i]
                b = cache[i]['F'].box('mass', s8) / cache[i]['F'].mean_mass
                f2 = cache[j]['F'].at('mass', s8, X, Y - 1.5 * R.Om * X * dt) / cache[j]['F'].mean_mass
                cs.append(np.corrcoef(b.ravel(), f2.ravel())[0, 1])
            tr.append((lag, float(np.mean(cs)) if cs else float('nan'), len(cs)))
    out['temporal'] = dict(lags_orbits=[r[0] for r in tr], C=[round(r[1], 4) for r in tr], n_pairs=[r[2] for r in tr],
                           fit=fit_decay(tr), smoothing='lambda/8 (N-body) / exact field (procedural)')
    # vertical / sizes
    bins = [[round(float(R.bins[b]), 4), round(float(R.bins[b + 1]), 4)] for b in range(nbins)]
    counts = np.bincount(R.bin_of, minlength=nbins).tolist()
    zr = block_stats(per['zr'], T, R.P)
    zg = block_stats(per['zr_gap'], T, R.P)
    zw = block_stats(per['zr_wake'], T, R.P)
    zc = block_stats(per['zr_core'], T, R.P)
    zm = block_stats(per['zr_m'], T, R.P)
    thick = np.sqrt(thick_num / np.maximum(thick_den, 1e-30))
    Dc = np.sqrt(Dbins[1:] * Dbins[:-1])
    okb = thick_den > 0.002 * thick_den.sum()
    beta = float(np.polyfit(np.log(Dc[okb]), np.log(thick[okb]), 1)[0]) if okb.sum() > 3 else None
    okw = okb & (Dc > 1)
    beta_w = float(np.polyfit(np.log(Dc[okw]), np.log(thick[okw]), 1)[0]) if okw.sum() > 2 else None
    out['vertical'] = dict(size_bins_m=bins, counts=counts, zrms_m=ms(zr, 3), zrms_gap_m=ms(zg, 3), zrms_wake_m=ms(zw, 3),
                           zrms_core_m=ms(zc, 3), zrms_mass_weighted_m=ms(zm, 3),
                           thickness_vs_D=dict(D=[round(float(v), 3) for v in Dc[okb]], sigma_z_mass_m=[round(float(v), 3) for v in thick[okb]],
                                               beta_all=beta, beta_wakes=beta_w))
    ff16 = block_stats(per['ff16'], T, R.P)
    ff32 = block_stats(per['ff32'], T, R.P)
    ffD = ffD_num / np.maximum(ffD_den, 1)
    okf = ffD_den > 0.002 * ffD_den.sum()
    out['filling'] = dict(sigma_lambda_16=dict(zip(['mean', 'core_mean', 'p99', 'max'], [ms((a, b)) for a, b in zip(*ff16)])),
                          sigma_lambda_32=dict(zip(['mean', 'core_mean', 'p99', 'max'], [ms((a, b)) for a, b in zip(*ff32)])),
                          vs_D=dict(D=[round(float(v), 3) for v in Dc[okf]], FF=[round(float(v), 4) for v in ffD[okf]]))
    cv = block_stats(per['cvel'], T, R.P)
    cvl = block_stats(per['cvel_loc'], T, R.P)
    out['velocity'] = dict(size_bins_m=bins, c_xyz_mm_s=[[round(1e3 * v, 4) for v in row] for row in cv[0]],
                           c_xyz_local_mm_s=[[round(1e3 * v, 4) for v in row] for row in cvl[0]],
                           c_xyz_se_mm_s=[[round(1e3 * v, 4) if np.isfinite(v) else None for v in row] for row in cv[1]])
    # mass-weighted radial dispersion -> Toomre Q
    w = np.bincount(R.bin_of, R.m, nbins) / R.m.sum()
    cxm = math.sqrt(float((w * cv[0][:, 0] ** 2).sum()))
    out['velocity']['c_r_mass_mm_s'] = 1e3 * cxm
    out['velocity']['Q'] = cxm * R.Om / (3.36 * nb.G * R.cfg['sigma'])
    if nbins > 1:
        pp = block_stats(per['p_part'], T, R.P)
        cc = block_stats(per['contrast'], T, R.P)
        ee = block_stats(per['envD'], T, R.P)
        out['sizes'] = dict(size_bins_m=bins, participation=ms(pp, 3), contrast_wake_gap=ms(cc, 3), mean_D_at_particles=ms(ee, 3))
    if per['ray']:
        tau = lambda T_: -math.log(max(T_, 1e-9))  # noqa: E731
        rr = per['ray']
        out['raycast'] = dict(n_snapshots=len(rr), tau_phot=float(np.mean([tau(r['T']) for r in rr])),
                              tau_phot_std=float(np.std([tau(r['T']) for r in rr])),
                              tau_phot_gap=float(np.mean([tau(r['T_gap']) for r in rr])),
                              tau_phot_wake=float(np.mean([tau(r['T_wake']) for r in rr])),
                              tau_phot_core=float(np.mean([tau(r['T_core']) for r in rr])), tau_dyn=tau_sim)
    if per['gran']:
        rows = np.array([r for g in per['gran'] for r in g])
        Bs = np.radians(rows[:, 0])
        ph = np.radians(rows[:, 1])
        Tm = rows[:, 2]
        # average the snapshots per geometry
        keys = {}
        for Bd, pd, tv in rows:
            keys.setdefault((Bd, pd), []).append(tv)
        geo = np.array([[k[0], k[1], np.mean(v)] for k, v in sorted(keys.items())])
        fit = fit_granola(np.radians(geo[:, 0]), np.radians(geo[:, 1]), geo[:, 2])
        fit['lambda_w_m'] = lw
        fit['W_m'] = (1 - fit['S_over_lambda']) * lw
        fit['H_m'] = fit['H_over_lambda'] * lw
        out['granola_fit'] = dict(fit=fit, geometry=[[float(a), float(b), round(float(c), 4)] for a, b, c in geo],
                                  n_snapshots=len(per['gran']), note='phi = azimuth of the line of sight from the radial direction')
    if R.dens:
        P = R.params['config']['procedural']
        lw2, pt2, kx2, ky2 = peak(acc_dens, acc_dens.P)
        sp2, se2, fr2, lm2 = spectrum_widths(acc_dens, acc_dens.P, kx2, ky2)
        acf2 = acf_measures(acc_dens, acc_dens.A)
        q = block_stats(per['dens_q16'], T, R.P)
        sk2 = block_stats(per['dens_skel'], T, R.P)
        dc = block_stats(per['dens_consist'], T, R.P)
        out['noise_free'] = dict(
            note='the analytic wakeDensity() field (no particle noise)',
            spectrum=dict(lambda_w=lw2, lambda_w_over_lambda_T=lw2 / lam, pitch_deg=pt2, width_par=sp2, width_perp=se2, power_in_peaks=fr2,
                          lambda_mean_k_over_lambda_T=lm2 / lam),
            acf=dict(L_par_e=acf2['e']['L_par'], L_perp_e=acf2['e']['L_perp'], pitch_e=acf2['e']['pitch'],
                     L_par_e_over_lambda=acf2['e']['L_par'] / lam, L_perp_e_over_lambda=acf2['e']['L_perp'] / lam,
                     L_par_half=acf2['half']['L_par'], L_perp_half=acf2['half']['L_perp'],
                     side_peak_lag_over_lambda=acf2['side_peak']['lag'] / lam, side_peak_height=acf2['side_peak']['height'],
                     spacing_from_first_min_over_lambda=2 * acf2['side_peak']['min_lag'] / lam,
                     first_min=acf2['side_peak']['min'], second_peak=acf2.get('second_peak'),
                     along_profile=acf2['along_profile'], across_profile=acf2['across_profile']),
            orientation=ostats(ohist_dens),
            pdf_sigma_lambda_16={k: [round(float(q[0][j]), 4), round(float(q[1][j]), 4)] for j, k in enumerate(labels)},
            hist_lnD_16=[round(float(v), 6) for v in hist16_dens / max(hist16_dens.sum(), 1)],
            skeleton=dict(zip(['n_end_per_lambda2', 'n_branch_per_lambda2', 'crest_length_per_lambda2', 'filament_length_over_lambda',
                               'segment_median_over_lambda', 'segment_mean_over_lambda', 'wake_area_fraction'],
                              [[round(float(a), 4), round(float(b), 4)] for a, b in zip(*sk2)])),
            particles_vs_field=dict(corr=dc[0][0], mean_D_particles=dc[0][1], mean_D_field=dc[0][2]),
            model=P)
    path = args.json or os.path.join(nb.RESULTS_DIR, f'{R.name}.json')
    nb.write_json(path, out)
    print(f'wrote {path} ({time.time() - t_start:.0f} s)')
    if args.plots is not False:
        plots(R, idx, args.plots or os.path.join(nb.RAW_DIR, 'plots', R.name), acc, per)
    return out


def plots(R, idx, outdir, acc, per):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    os.makedirs(outdir, exist_ok=True)
    picks = [idx[0], idx[len(idx) // 3], idx[2 * len(idx) // 3], idx[-1]]
    fig, axs = plt.subplots(1, len(picks), figsize=(4.2 * len(picks), 4.4))
    for ax, i in zip(axs, picks):
        s = nb.load_snapshot(R.snaps[i])
        F = Fields(R, s, dict(mass=R.m))
        F.mean_mass = R.m.sum() / (R.Lx * R.Ly) if R.periodic else F.raw['mass'].sum() / (F.gnx * F.gny * F.cell)
        D = F.box('mass', R.lam / 16) / F.mean_mass
        ax.imshow(np.log(np.clip(D, 0.05, None)).T, origin='lower', cmap='magma', vmin=np.log(0.1), vmax=np.log(6),
                  extent=[-R.Lx / 2 / R.lam, R.Lx / 2 / R.lam, -R.Ly / 2 / R.lam, R.Ly / 2 / R.lam])
        ax.set_title(f'{R.name} t={s["t"] / R.P:.2f} orb')
        ax.set_xlabel('x / lambda_T (radial)')
        ax.set_ylabel('y / lambda_T (azimuthal)')
    fig.tight_layout()
    fig.savefig(os.path.join(outdir, 'density.png'), dpi=90)
    plt.close(fig)
    if R.dens:
        fig, axs = plt.subplots(1, len(picks), figsize=(4.2 * len(picks), 4.4))
        for ax, i in zip(axs, picks):
            dd = np.load(R.dens[i])
            g = dd['dens'][R.nm:R.nm + R.nx, R.nm:R.nm + R.ny]
            ax.imshow(np.log(np.clip(g, 0.05, None)).T, origin='lower', cmap='magma', vmin=np.log(0.1), vmax=np.log(6),
                      extent=[-R.Lx / 2 / R.lam, R.Lx / 2 / R.lam, -R.Ly / 2 / R.lam, R.Ly / 2 / R.lam])
            ax.set_title(f'wakeDensity t={float(dd["t"]) / R.P:.2f} orb')
        fig.tight_layout()
        fig.savefig(os.path.join(outdir, 'wakeDensity.png'), dpi=90)
        plt.close(fig)
    fig, ax = plt.subplots(1, 2, figsize=(10, 4.5))
    a = acc.A / np.maximum(acc.wacf, 1e-12 * acc.wacf.max())
    a = np.fft.fftshift(a / a[0, 0])
    cx, cy = acc.Mx // 2, acc.My // 2
    n = int(2 * R.lam / R.hx)
    ax[0].imshow(a[cx - n:cx + n, cy - n:cy + n].T, origin='lower', cmap='RdBu_r', vmin=-0.5, vmax=1, extent=[-2, 2, -2, 2])
    ax[0].set_title('ACF of D (lags / lambda_T)')
    Pk = np.fft.fftshift(acc.P)
    kx = np.fft.fftshift(acc.kx) * R.lam / (2 * np.pi)
    ky = np.fft.fftshift(acc.ky) * R.lam / (2 * np.pi)
    sel = (np.abs(kx) < 3)
    selb = (np.abs(ky) < 3)
    ax[1].imshow(np.log(Pk[np.ix_(sel, selb)] + 1e-9).T, origin='lower', extent=[kx[sel][0], kx[sel][-1], ky[selb][0], ky[selb][-1]])
    ax[1].set_title('log power (k lambda_T / 2 pi)')
    fig.tight_layout()
    fig.savefig(os.path.join(outdir, 'acf_spectrum.png'), dpi=90)
    plt.close(fig)


def main(argv):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('run')
    p.add_argument('--from', dest='from_orbit', type=float)
    p.add_argument('--to', dest='to_orbit', type=float)
    p.add_argument('--every', type=int, default=1)
    p.add_argument('--json')
    p.add_argument('--plots', nargs='?', const=None, default=None)
    p.add_argument('--no-plots', dest='plots', action='store_false')
    p.add_argument('--raycast', type=int, default=10, help='vertical ray casting every N snapshots (0: off)')
    p.add_argument('--granola', type=int, default=0, help='slant-ray granola-bar fit every N snapshots (0: off)')
    p.add_argument('--rays', type=int, default=400000)
    p.add_argument('--quick', action='store_true', help='every 4th snapshot (testing)')
    a = p.parse_args(argv)
    analyze(a)


if __name__ == '__main__':
    main(sys.argv[1:])
