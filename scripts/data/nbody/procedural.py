#!/usr/bin/env python3
"""Python port of the simulator's procedural self-gravity wake field, and synthetic "runs" drawn from it.

usage ($PY = the venv python, see README.md):
  $PY scripts/data/nbody/procedural.py --verify
      bundle + run scripts/data/nbody/wakefield_ref.ts (the real WakeField.ts / ringRegions.ts, via rolldown + node)
      and compare texture texels, lambda, tile, strength, the wake set and the uniforms with this port
  $PY scripts/data/nbody/procedural.py synth --like data-raw/nbody/A128-sd [--name A128-sd-proc] [--out DIR]
      [--orbits 6] [--snap 0.05] [--gamma G] [--gamma-gap G] [--spread-par P] [--spread-perp Q] [--rc R] [--t-life T]
      [--strength S] [--m0 1,6] [--env-w W] [--async-d D] [--async-ell L] [--legacy] [--seed 12345]
      [--particles/--no-particles]
      a synthetic run in the N-body run format (params.json, particles.npz, snap_*.npz) over the same box, with the
      same particle sizes and number density, placed the way the near field draws them (uniform epicyclic positions
      + wakeDisplacement; z Gaussian with RingLod's sigma_z(a) = sigZFrac(a_eff) H), plus the noise-free wakeDensity
      on the analysis grid (dens_*.npz). Not periodic: generated over the box plus a margin (params "margin").
      Default parameters: the app's at that site (zone wake set, strength); --legacy: the app before Nov 2026 (global
      wavenumber, sin^2 generations, one Newton step, gamma 0.16..0.24 with the B-ring "chaos").
  $PY scripts/data/nbody/procedural.py check-inverse [--a-km 128000 --tau 0.66 --sigma 284] [--strength S] [--legacy]
      [--newton N] [--box 6] [--sub 6] [--times 8] [--json PATH] [model overrides as for synth]
      wakeDensity() vs the exact density of the forward map that places the particles (fine Lagrangian lattice,
      cloud-in-cell deposit): share of the area where they differ, means, maxima (docs/ring-physics.md, 10.8 / 10.11)

What is ported (deterministic: same seed 12345, same RNG streams as the app):
  src/rings/WakeField.ts   mulberry32, hashFloat, the wake sets (WAKE_SETS: A and B ring calibrations) and their zone
                           selection, buildTexture (two 256x256 RGBA32F layers, one per envelope field W_A, W_B: (Re W,
                           Im W, G_u, G_v) with G = grad(arg W) regularised as Im(W* grad W) / max(|W|^2, G_EPS2); the
                           modes are Gaussian-weighted random complex amplitudes around m0, drawn in the same loop order;
                           the mode sums are inverse FFTs here instead of the TypeScript's separable sums, identical up
                           to float32 rounding), buildDeltaTexture (64x64: the asynchrony phase delta in [0, 1) and its
                           gradient), configure (lambda = 4 pi^2 G Sigma / kappa^2, tile = lambda * 6 / sin 20 deg,
                           sizeOk, strength), update (generation clock: two generations half a lifetime apart, shear
                           S = q * age, hashFloat offsets, field selection, the cycle phase and the delta frame).
  src/render/shaders/wakes.glsl  texture() with LinearFilter + RepeatWrapping (bilinear, texel centres at (i + 0.5)/N),
                           the local wave number K, the composite circle map (gap gamma), the local envelope (plateau
                           handover with the asynchrony phase), wakeGenDisp, wakeDisplacement, the Newton inverse,
                           wakeDensity (incl. its clamp). Evaluated in float64 (the GPU uses float32).
  src/rings/RingLod.ts     sigZFracForRadius and the octave classes' aEff (vertical law sigma_z = sigZFrac(aEff) H).
  src/rings/ringRegions.ts the zone values used here (A_in, A_out, B3) - checked by --verify.
Not ported: wakeDensityFiltered (footprint fade for distant views), the ring-layer wake clipmap.

The model (docs/ring-physics.md 10.11; WakeField.ts header): each of the two generations maps a Lagrangian point p to
x = p + n (C(Theta) - Theta) / K along its mean wave normal n, Theta = 2 pi m0.u + arg W the local phase, K the local wave
number along n (from the stored phase gradient, >= K_MIN of the mean), C the composite circle map
C = G_g o M_gamma (core density 1/gamma_core, gap density gamma_gap at full local strength a). With the LOCAL wave number
each local wavelength is compressed into its own core, so the map does not fold (the old global-k map folded where the
local wave number exceeded the mean by > gamma^a / (1 - gamma^a), and its single-branch inverse missed that mass).
wakeDensity inverts each generation by a closed-form guess (exact for a locally linear phase) plus Newton steps along n.
"""
import argparse
import json
import math
import os
import subprocess
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nbcommon as nb  # noqa: E402

N_TEX = 256
N_DTEX = 64
WAKE_FD_H = 1.5
TWO_PI = 2 * math.pi
G_EPS2 = 0.02          # regularisation of the stored phase gradient (|W|^2 normalised to mean 1)
DELTA_SIGMA = 2.5      # spectral width (modes per delta tile) of the asynchrony field
DELTA_KAPPA = 0.8      # delta = 0.5 + 0.5 tanh(kappa g), g the unit-variance Gaussian field
J_FLOOR = 0.05         # Newton: lower bound of the Jacobian in the step
K_SOFT = 0.1           # softness of the lower clamp of the local wave number (fraction of the mean)

# Wake sets of src/rings/WakeField.ts (WAKE_SETS): the A- and B-ring calibrations (docs/ring-physics.md 10.11).
WAKE_SETS = {
    'A': dict(gamma=0.132, gamma_gap=0.073, spread_par=1.6, spread_perp=5.0, rc=0.8, t_life=6.0, m0x=1.0, env_w=0.1,
              async_d=0.25, async_ell=2.0, tile_scale=1.2),
    'B': dict(gamma=0.126, gamma_gap=0.069, spread_par=1.2, spread_perp=9.0, rc=0.6, t_life=6.0, m0x=2.0, env_w=0.2,
              async_d=0.0, async_ell=3.0, tile_scale=1.0),
}
# model structure (not zone parameters): m0y, the pitch at the envelope peak that sets the tile, a tile scale for the
# calibration (1 in the app), the local wave number (False: the old global-k map), its clamp, Newton steps, and the clamp
# of wakeDensity: [clamp_lo gamma_gap^s, clamp_hi gamma_core^-s]
MODEL_DEFAULTS = dict(m0y=6.0, pitch_peak_deg=20.0, tile_scale=1.0, local_k=True, k_min=0.65, newton=2, clamp_lo=0.8,
                      clamp_hi=4.0, fd_central=True, j_min=0.06)
SET_KEYS = tuple(WAKE_SETS['A'].keys())
MODEL_KEYS = SET_KEYS + tuple(MODEL_DEFAULTS.keys())
# the app before Nov 2026 (results/*-proc.json, check_inverse_*.json "before"): gamma etc. from legacy_shape_for(tau)
LEGACY = dict(rc=0.45, t_life=3.0, m0x=3.0, env_w=0.0, async_d=0.0, async_ell=3.0, local_k=False, newton=1, clamp_lo=0.9,
              clamp_hi=1.1, fd_central=False, j_min=0.0)


def smooth(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def smooth_np(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def legacy_shape_for(tau):
    """wakeShapeFor(local) of WakeField.ts before Nov 2026 (the "chaos" toward the B ring)."""
    chaos = smooth(1.0, 2.5, tau)
    return dict(gamma=0.16 + 0.08 * chaos, gamma_gap=0.16 + 0.08 * chaos, spread_par=1.6 + 0.8 * chaos,
                spread_perp=5.0 + 1.0 * chaos)


# zone values of src/rings/ringRegions.ts used by the reference sites (checked against the TS by --verify);
# wakeB: 0 = A-ring wake set, 1 = B-ring wake set; legacy_wake: the zone's wake value before Nov 2026
ZONES = {
    'A_in': dict(q=2.9, aMin=0.02, aMax=5.0, H=10.0, wake=1.0, wakeB=0.0, legacy_wake=1.0),
    'A_out': dict(q=3.05, aMin=0.005, aMax=7.0, H=10.0, wake=0.6, wakeB=0.0, legacy_wake=0.6),
    'B3': dict(q=3.2, aMin=0.05, aMax=2.0, H=15.0, wake=1.0, wakeB=1.0, legacy_wake=0.5),
}


def zone_for_km(r_km):
    if 122050 <= r_km < 133423:
        return 'A_in'
    if 133745 <= r_km < 136770:
        return 'A_out'
    if 104000 <= r_km < 110000:
        return 'B3'
    raise ValueError(f'no zone table entry for {r_km} km (add it to ZONES)')


def wake_set_for(wake_b):
    """WakeField.wakeShapeFor: the zone's wake set, interpolated by the zone blend weight wakeB (continuous parameters;
    m0x rounded so the texture stays tileable). wakeB is 0 or 1 except within 40 km of a zone boundary, and no A-ring
    wake zone borders a B-ring wake zone (the Cassini Division lies between), so in practice the set is A or B."""
    a, b = WAKE_SETS['A'], WAKE_SETS['B']
    w = min(1.0, max(0.0, wake_b))
    out = {}
    for k in SET_KEYS:
        if k in ('gamma', 'gamma_gap'):
            out[k] = math.exp(math.log(a[k]) * (1 - w) + math.log(b[k]) * w)
        else:
            out[k] = a[k] * (1 - w) + b[k] * w
    out['m0x'] = float(round(out['m0x']))
    return out


# ------------------------------------------------------------------ RNG (WakeField.ts)
def _i32(x):
    x &= 0xFFFFFFFF
    return x - 0x100000000 if x & 0x80000000 else x


def _imul(a, b):
    return _i32((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF))


def mulberry32(seed):
    st = [_i32(int(seed))]

    def rnd():
        s = _i32(st[0] + 0x6D2B79F5)
        st[0] = s
        t = _imul(s ^ ((s & 0xFFFFFFFF) >> 15), 1 | s)
        t = _i32((t + _imul(t ^ ((t & 0xFFFFFFFF) >> 7), 61 | t)) ^ t)
        return ((t ^ ((t & 0xFFFFFFFF) >> 14)) & 0xFFFFFFFF) / 4294967296.0
    return rnd


def hash_float(n, salt):
    r = mulberry32(_i32(_i32(int(n) * 2654435761) ^ _i32(int(salt) * 40503)))
    r()
    return r()


def _signed_modes(N):
    i = np.arange(N)
    return np.where(i < N // 2, i, i - N).astype(np.float64)


def build_texture(seed, spread_par, spread_perp, m0x=1.0, m0y=6.0):
    """WakeField.buildTexture: float32 array [field, j, i, 4] (texel (s = i, t = j)), channels Re W, Im W, G_u, G_v.
    W = sum of Gaussian-weighted random modes around m0 (offsets (dx, dy) in modes per tile), renormalised to unit mean
    |W|^2 in float32; G = Im(W* dW/du) / max(|W|^2, G_EPS2) (radians per tile, from the float64 sums)."""
    N = N_TEX
    m0n = math.hypot(m0x, m0y)
    px, py = m0x / m0n, m0y / m0n
    sp, sq = spread_par, spread_perp
    R = math.ceil(3 * max(sp, sq)) + 1
    sm = _signed_modes(N)
    data = np.zeros((2, N, N, 4), np.float32)
    for field in range(2):
        rnd = mulberry32(seed + field * 977)
        C = np.zeros((N, N), np.complex128)   # [ky, kx]
        for dy in range(-R, R + 1):
            for dx in range(-R, R + 1):
                par = dx * px + dy * py
                perp = -dx * py + dy * px
                w = math.exp(-0.5 * (par * par / (sp * sp) + perp * perp / (sq * sq)))
                if w < 0.01:
                    continue
                ray = math.sqrt(-2 * math.log(max(1e-9, rnd())))
                ph = rnd() * math.pi * 2
                C[dy % N, dx % N] += w * ray * complex(math.cos(ph), math.sin(ph))
        W = np.fft.ifft2(C) * (N * N)          # W[j, i] = sum C[ky, kx] exp(2 pi i (kx i + ky j) / N)
        Wu = np.fft.ifft2(C * (2j * math.pi * sm[None, :])) * (N * N)
        Wv = np.fft.ifft2(C * (2j * math.pi * sm[:, None])) * (N * N)
        re32 = W.real.astype(np.float32)
        im32 = W.imag.astype(np.float32)
        r64, i64 = re32.astype(np.float64), im32.astype(np.float64)
        f = 1 / math.sqrt((r64 * r64 + i64 * i64).sum() / (N * N))
        data[field, :, :, 0] = (r64 * f).astype(np.float32)
        data[field, :, :, 1] = (i64 * f).astype(np.float32)
        f2 = f * f
        den = np.maximum((W.real * W.real + W.imag * W.imag) * f2, G_EPS2)
        data[field, :, :, 2] = ((W.real * Wu.imag - W.imag * Wu.real) * f2 / den).astype(np.float32)
        data[field, :, :, 3] = ((W.real * Wv.imag - W.imag * Wv.real) * f2 / den).astype(np.float32)
    return data


def build_delta_texture(seed, sigma=DELTA_SIGMA, kappa=DELTA_KAPPA):
    """WakeField.buildDeltaTexture: float32 [j, i, 4] = (delta, d delta/du, d delta/dv, 0) over one delta tile: a smooth
    isotropic random field (Gaussian spectrum of width sigma modes per tile, no mean), unit variance, mapped to [0, 1) by
    delta = 0.5 + 0.5 tanh(kappa g)."""
    N = N_DTEX
    R = math.ceil(3 * sigma) + 1
    sm = _signed_modes(N)
    rnd = mulberry32(seed + 3 * 977)
    C = np.zeros((N, N), np.complex128)
    for my in range(-R, R + 1):
        for mx in range(-R, R + 1):
            if mx == 0 and my == 0:
                continue
            w = math.exp(-0.5 * (mx * mx + my * my) / (sigma * sigma))
            if w < 0.01:
                continue
            ray = math.sqrt(-2 * math.log(max(1e-9, rnd())))
            ph = rnd() * math.pi * 2
            C[my % N, mx % N] += w * ray * complex(math.cos(ph), math.sin(ph))
    g = (np.fft.ifft2(C) * (N * N)).real
    gu = (np.fft.ifft2(C * (2j * math.pi * sm[None, :])) * (N * N)).real
    gv = (np.fft.ifft2(C * (2j * math.pi * sm[:, None])) * (N * N)).real
    s = 1 / math.sqrt((g * g).sum() / (N * N))
    t = np.tanh(kappa * g * s)
    out = np.zeros((N, N, 4), np.float32)
    out[:, :, 0] = (0.5 + 0.5 * t).astype(np.float32)
    dd = 0.5 * kappa * s * (1 - t * t)
    out[:, :, 1] = (dd * gu).astype(np.float32)
    out[:, :, 2] = (dd * gv).astype(np.float32)
    return out


def sig_z_frac(a):
    """RingLod.sigZFracForRadius."""
    t = np.clip(np.log2(np.asarray(a, dtype=np.float64) / 0.01) / 9, 0, 1)
    return 0.4 * (1 - t) + 0.15 * t


def lod_class_sigz(a, q, a_min, a_max, H, A0=0.001, n_classes=14):
    """sigma_z (m) of each particle as RingLod assigns it: octave class k = [A0 2^k, A0 2^(k+1)) clipped to
    [a_min, a_max], aEff = sqrt(Int a^(4-q) / Int a^(2-q)) over the class, sigma_z = max(sigZFrac(aEff) H, 0.02);
    the top class absorbs a > A0 2^14."""
    a = np.asarray(a, dtype=np.float64)
    k = np.clip(np.floor(np.log2(a / A0)).astype(int), 0, n_classes - 1)
    out = np.empty_like(a)
    for c in np.unique(k):
        lo = max(A0 * 2 ** c, a_min)
        hi = min(A0 * 2 ** (c + 1), a_max) if c < n_classes - 1 else a_max
        aeff = math.sqrt(nb.pint(lo, hi, 4 - q) / nb.pint(lo, hi, 2 - q)) if hi > lo else lo
        out[k == c] = max(float(sig_z_frac(aeff)) * H, 0.02)
    return out


def _bilinear(T, u, v):
    """texture() with LinearFilter + RepeatWrapping on a [N, N, C] float32 array (texel centres at (i + 0.5) / N)."""
    N = T.shape[0]
    x = u * N - 0.5
    y = v * N - 0.5
    i0 = np.floor(x)
    j0 = np.floor(y)
    fx = (x - i0)[..., None]
    fy = (y - j0)[..., None]
    i0 = i0.astype(np.int64) % N
    j0 = j0.astype(np.int64) % N
    i1 = (i0 + 1) % N
    j1 = (j0 + 1) % N
    return (T[j0, i0] * (1 - fx) * (1 - fy) + T[j0, i1] * fx * (1 - fy)
            + T[j1, i0] * (1 - fx) * fy + T[j1, i1] * fx * fy)


def composite_map(th, lg, lgg):
    """Composite circle map C = G_g o M_gamma at local logs lg = a ln(gamma), lgg = a ln(g) (wakes.glsl wakeCMap):
    M_gamma(th) = 2 atan(gamma tan(th / 2)) (core density 1/gamma at th = 0), G_g(phi) = atan(g tan(phi)) (g > 1 expands
    both the core and the gap of the result by g, compresses the flanks), so C'(0) = g gamma, C'(pi) = g / gamma.
    Returns C in (-pi, pi], C' and sin(2C)."""
    gm = np.exp(lg)
    g = np.exp(lgg)
    s, c = np.sin(th), np.cos(th)
    gm2 = gm * gm
    N = g * gm * s
    Dd = 0.5 * ((1 - gm2) + (1 + gm2) * c)
    E = 0.5 * ((1 + gm2) + (1 - gm2) * c)
    R2 = N * N + Dd * Dd
    return np.arctan2(N, Dd), g * gm * E / R2, 2 * N * Dd / R2


def composite_inv(X, lg, lgg):
    """Inverse of composite_map: M_gamma^-1(G_g^-1(X))."""
    gm = np.exp(lg)
    g = np.exp(lgg)
    phi = np.arctan2(np.sin(X), g * np.cos(X))
    return 2 * np.arctan2(np.sin(0.5 * phi), gm * np.cos(0.5 * phi))


def wrap_pi(a):
    return a - TWO_PI * np.floor(a / TWO_PI + 0.5)


class WakeFieldPort:
    """WakeField.ts + wakes.glsl. Positions are local Hill-frame metres (x radial, y azimuthal)."""

    def __init__(self, seed=12345, **over):
        self.seed = seed
        self.p = dict(WAKE_SETS['A'])
        self.p.update(MODEL_DEFAULTS)
        self.p.update({k: v for k, v in over.items() if v is not None and k in MODEL_KEYS})
        if self.p.get('gamma_gap') is None:
            self.p['gamma_gap'] = self.p['gamma']
        self.tex = None
        self.tex_key = None
        self.dtex = build_delta_texture(seed)

    def configure(self, lam, strength, omega, q_shear=1.5):
        p = self.p
        self.lam = lam
        self.tile = max(lam * p['m0y'] / math.sin(math.radians(p['pitch_peak_deg'])) * p['tile_scale'], 1.0)
        self.strength = strength
        self.omega = omega
        self.q_shear = q_shear
        lgc, lgg = math.log(p['gamma']), math.log(p['gamma_gap'])
        self.LG = 0.5 * (lgc + lgg)       # ln gamma of the circle map M_gamma
        self.LGG = 0.5 * (lgc - lgg)      # ln g of the gap map G_g
        self.inv_rc2 = 1 / (p['rc'] * p['rc'])
        key = (round(p['spread_par'], 6), round(p['spread_perp'], 6), p['m0x'], p['m0y'])
        if key != self.tex_key:
            self.tex = build_texture(self.seed, p['spread_par'], p['spread_perp'], p['m0x'], p['m0y'])
            self.tex_key = key
        # delta tile = tile / dscale: 1/e correlation length of the underlying Gaussian field = async_ell lambda
        self.dscale = self.tile / (math.pi * DELTA_SIGMA * p['async_ell'] * lam)
        self.wlo = p['clamp_lo'] * math.exp(lgg * strength)
        self.whi = p['clamp_hi'] * math.exp(-lgc * strength)
        self.wmin = math.exp(lgg * strength)      # gap density factor of the pattern at full local strength
        self.wmax = math.exp(-lgc * strength)     # core density factor
        k_lo = (TWO_PI / self.tile) * p['m0y']
        self.tmax = math.pi / (p['k_min'] * k_lo) if p['local_k'] else math.pi / k_lo

    def update(self, t):
        """Generation uniforms at sim time t (s): [(S, offU, offV, sel)] for the older (0) and the younger (1) generation,
        the cycle phase phi in [0, 1) (young age / (T_LIFE / 2)) and the delta frame (offU, offV, S_young)."""
        p = self.p
        tau = self.omega * t
        P = 0.5 * p['t_life']
        ny = math.floor(tau / P)
        self.phi = tau / P - ny
        gens = []
        for n in (ny - 1, ny):
            age = tau - n * P
            gens.append((self.q_shear * age, hash_float(n, 1), hash_float(n, 2), n % 2))
        self.gens = gens
        self.dframe = (hash_float(ny, 3), hash_float(ny, 4), self.q_shear * (tau - ny * P))
        return gens

    def e_young(self, delta):
        """Local envelope of the younger generation (the older one has 1 - e): the handover at local cycle phase
        phi - async_d delta. env_w > 0: plateau (smoothstep over 2 env_w of the cycle); 0: sin^2 (legacy)."""
        p = self.p
        w, d = p['env_w'], p['async_d']
        if w <= 0:
            x = np.clip((self.phi - d * delta) / (1 - d), 0.0, 1.0) if d > 0 else self.phi + 0 * delta
            return np.sin(0.5 * math.pi * x) ** 2
        return smooth_np(0.0, 2 * w, self.phi - d * delta)

    def env_mean(self, g):
        """Envelope at the median delta (HUD pitch, ring-layer mean wave normal)."""
        ey = float(self.e_young(0.5))
        return ey if g == 1 else 1 - ey

    def pitch_deg(self):
        """WakeField.pitchDeg: envelope-weighted mean pitch of the two generations."""
        p = self.p
        w = sum(self.env_mean(g) for g in range(2))
        if w <= 0:
            return 0.0
        return sum(self.env_mean(g) * math.degrees(math.atan2(p['m0y'], p['m0x'] + self.gens[g][0] * p['m0y']))
                   for g in range(2)) / w

    # ---- GLSL
    def _geom(self, g):
        p = self.p
        S = self.gens[g][0]
        kx = (p['m0x'] + S * p['m0y']) * TWO_PI / self.tile
        ky = p['m0y'] * TWO_PI / self.tile
        km = math.hypot(kx, ky)
        return kx / km, ky / km, km

    def _uv(self, g, x, y):
        S, ou, ov, _ = self.gens[g]
        return x / self.tile + ou, (y + S * x) / self.tile + ov

    def _delta(self, x, y):
        """Asynchrony phase delta at (x, y) and its gradient (per metre); 0 without asynchrony."""
        if self.p['async_d'] <= 0:
            z = np.zeros_like(x)
            return z, z, z
        ou, ov, S = self.dframe
        sd = self.dscale / self.tile
        t = _bilinear(self.dtex, sd * x + ou, sd * (y + S * x) + ov)
        return t[..., 0], sd * (t[..., 1] + S * t[..., 2]), sd * t[..., 2]

    def _amp(self, g, r2, delta):
        ey = self.e_young(delta)
        e = ey if g == 1 else 1 - ey
        return self.strength * e * (1 - np.exp(-r2 * self.inv_rc2))

    def _phase_k(self, g, T, u, v, nx, ny, km):
        p = self.p
        th = np.mod(p['m0x'] * u + p['m0y'] * v, 1.0) * TWO_PI + np.arctan2(T[..., 1], T[..., 0] + 1e-20)
        th = th - TWO_PI * np.floor(th / TWO_PI + 0.5)
        if p['local_k']:
            S = self.gens[g][0]
            r = 1 + (nx * (T[..., 2] + S * T[..., 3]) + ny * T[..., 3]) / (self.tile * km)
            # smooth lower clamp (no kink in dK/dn): 0.5 (r + m + sqrt((r - m)^2 + K_SOFT^2))
            m = p['k_min']
            K = km * 0.5 * (r + m + np.sqrt((r - m) ** 2 + K_SOFT * K_SOFT))
        else:
            K = km + 0 * th
        return th, K

    def gen_eval(self, g, x, y, nx, ny, km, delta=None):
        """(Theta, a, K) of generation g at (x, y): one texture fetch (+ the delta fetch unless delta is given)."""
        u, v = self._uv(g, x, y)
        T = _bilinear(self.tex[self.gens[g][3]], u, v)
        th, K = self._phase_k(g, T, u, v, nx, ny, km)
        if delta is None:
            delta, _, _ = self._delta(x, y)
        a = self._amp(g, T[..., 0] ** 2 + T[..., 1] ** 2, delta)
        return th, a, K

    def gen_eval_d(self, g, x, y, nx, ny, km, dl=None):
        """(Theta, a, K) at (x, y) and their derivatives along n: central differences over WAKE_FD_H (fetches at
        p -+ h/2 n; exact for the quadratic rise of the strength taper at a dislocation), the values at p the midpoint
        averages; delta and its gradient dl = (delta, d/dx, d/dy) given, or from one delta fetch. Two texture fetches."""
        S = self.gens[g][0]
        central = self.p['fd_central']
        hh = 0.5 * WAKE_FD_H if central else 0.0     # legacy: forward difference from p
        u, v = self._uv(g, x, y)
        du0 = nx * (hh / self.tile)
        dv0 = (ny + S * nx) * (hh / self.tile)
        du = nx * (WAKE_FD_H / self.tile)
        dv = (ny + S * nx) * (WAKE_FD_H / self.tile)
        L = self.tex[self.gens[g][3]]
        u0, v0 = u - du0, v - dv0
        T0 = _bilinear(L, u0, v0)
        T1 = _bilinear(L, u0 + du, v0 + dv)
        th0, K0 = self._phase_k(g, T0, u0, v0, nx, ny, km)
        _, K1 = self._phase_k(g, T1, u0 + du, v0 + dv, nx, ny, km)
        delta, gx, gy = self._delta(x, y) if dl is None else dl
        dd = WAKE_FD_H * (nx * gx + ny * gy)
        a0 = self._amp(g, T0[..., 0] ** 2 + T0[..., 1] ** 2, delta - (0.5 * dd if central else 0.0))
        a1 = self._amp(g, T1[..., 0] ** 2 + T1[..., 1] ** 2, delta + (0.5 * dd if central else dd))
        w0x, w0y, w1x, w1y = T0[..., 0], T0[..., 1], T1[..., 0], T1[..., 1]
        dphi = np.arctan2(w1y * w0x - w1x * w0y, w1x * w0x + w1y * w0y + 1e-20)
        th_n = km + dphi / WAKE_FD_H
        if not central:
            return th0, a0, K0, th_n, (a1 - a0) / WAKE_FD_H, (K1 - K0) / WAKE_FD_H
        return wrap_pi(th0 + hh * th_n), 0.5 * (a0 + a1), 0.5 * (K0 + K1), th_n, (a1 - a0) / WAKE_FD_H, (K1 - K0) / WAKE_FD_H

    def jac(self, th, a, K, th_n, a_n, K_n):
        """Jacobian determinant 1 + dD/dn of one generation's map, D = (C(Theta) - Theta) / K."""
        C, Cp, s2C = composite_map(th, a * self.LG, a * self.LGG)
        Ca = Cp * self.LG * np.sin(th) + 0.5 * self.LGG * s2C
        return 1 + ((Cp - 1) * th_n + Ca * a_n) / K - (C - th) * K_n / (K * K)

    def gen_disp(self, g, x, y):
        nx, ny, km = self._geom(g)
        th, a, K = self.gen_eval(g, x, y, nx, ny, km)
        C, _, _ = composite_map(th, a * self.LG, a * self.LGG)
        d = np.where(a < 1e-4, 0.0, (C - th) / K)
        return nx * d, ny * d

    def displacement(self, x, y):
        """wakeDisplacement(q): displacement (m) of particles whose undisplaced (epicyclic) position is (x, y).
        The maps are composed oldest first (x = M_young(M_old(q)))."""
        if self.strength <= 1e-3:
            return np.zeros_like(x), np.zeros_like(y)
        dx0, dy0 = self.gen_disp(0, x, y)
        dx1, dy1 = self.gen_disp(1, x + dx0, y + dy0)
        return dx0 + dx1, dy0 + dy1

    def gen_inverse(self, g, x, y, newton=None):
        """Lagrangian point and Jacobian of generation g's map at the Eulerian point (x, y): closed-form guess from the
        fields at x (exact for a locally linear phase), then Newton steps on t - D(x - t n) = 0 (t = displacement). The
        asynchrony phase is sampled at every Newton point (it is sheared with the flow: extrapolating it from x with its
        gradient put 2-15 % of the particles > 20 % off)."""
        nx, ny, km = self._geom(g)
        th, a, K = self.gen_eval(g, x, y, nx, ny, km)
        weak = a < 1e-4
        th0 = composite_inv(th, a * self.LG, a * self.LGG)
        t = np.clip((th - th0) / K, -self.tmax, self.tmax)
        th_e = a_e = K_e = th_n = a_n = K_n = None
        for _ in range(int(self.p['newton'] if newton is None else newton)):
            px, py = x - t * nx, y - t * ny
            thp, ap, Kp, th_n, a_n, K_n = self.gen_eval_d(g, px, py, nx, ny, km)
            C, _, _ = composite_map(thp, ap * self.LG, ap * self.LGG)
            D = (C - thp) / Kp
            J = self.jac(thp, ap, Kp, th_n, a_n, K_n)
            tn = np.clip(t - (t - D) / np.maximum(J, J_FLOOR), -self.tmax, self.tmax)
            dt = tn - t
            # fields at the refined point (phase, strength and wave number advance linearly along n)
            th_e, a_e, K_e = wrap_pi(thp - th_n * dt), np.maximum(ap - a_n * dt, 0.0), np.maximum(Kp - K_n * dt, 1e-6)
            t = tn
        J = self.jac(th_e, a_e, K_e, th_n, a_n, K_n)
        # floor of |J|: one generation's density <= 1 / J_MIN (rare near-folds; a fold's middle branch has J < 0 and
        # |J| gives the right order there); the legacy model used max(J, 1e-3)
        J = np.maximum(np.abs(J), self.p['j_min']) if self.p['j_min'] > 1e-3 else np.maximum(J, 1e-3)
        return np.where(weak, x, x - t * nx), np.where(weak, y, y - t * ny), np.where(weak, 1.0, J)

    def density(self, x, y, newton=None):
        """wakeDensity(x): Eulerian surface-density factor (mean 1)."""
        if self.strength <= 1e-3:
            return np.ones_like(x)
        qx, qy, J1 = self.gen_inverse(1, x, y, newton)
        _, _, J0 = self.gen_inverse(0, qx, qy, newton)
        return np.clip(1 / (J1 * J0), self.wlo, self.whi)


def port_from_config(sc, seed=12345):
    """A configured WakeFieldPort from a synthetic run's "procedural" config (simulator_config output)."""
    wf = WakeFieldPort(seed, **{k: sc.get(k) for k in MODEL_KEYS})
    wf.configure(sc['lambda_m'], sc['strength'], sc['omega'], sc.get('q_shear', 1.5))
    return wf


def site_config(a_km, tau, lam, omega, over=None, legacy=False):
    """Wake parameters the simulator uses at a site (zone wake set or the legacy model, strength from the zone's wake
    value, tau and the lambda/aMax test), with overrides."""
    zk = zone_for_km(a_km)
    zone = ZONES[zk]
    size_ok = min(1.0, max(0.0, (lam / max(zone['aMax'], 0.1) - 2) / 4))
    wake = (zone['legacy_wake'] if legacy else zone['wake']) * smooth(0.15, 0.4, tau)
    out = dict(lambda_m=lam, strength=min(1.0, wake * size_ok), tau=tau, zone=zk, H=zone['H'], q=zone['q'],
               aMin=zone['aMin'], aMax=zone['aMax'], omega=omega, legacy=legacy)
    out.update(MODEL_DEFAULTS)
    if legacy:
        out.update(LEGACY)
        out.update(legacy_shape_for(tau))
    else:
        out.update(wake_set_for(zone['wakeB']))
    for k, v in (over or {}).items():
        if v is not None:
            out[k] = v
    if out.get('gamma_gap') is None:
        out['gamma_gap'] = out['gamma']
    return out


def simulator_config(params, over=None, legacy=False):
    """Procedural wake parameters the simulator would use at an N-body run's site (its tau, lambda, zone)."""
    cfg, d = params['config'], params['derived']
    return site_config(cfg['a_km'], cfg['tau'], d['lambda_T'], d['Omega'], over, legacy)


def model_overrides(args):
    """Model parameter overrides from the synth / check-inverse command line."""
    over = dict(gamma=args.gamma, gamma_gap=getattr(args, 'gamma_gap', None), spread_par=args.spread_par,
                spread_perp=args.spread_perp, rc=args.rc, t_life=args.t_life, strength=args.strength,
                tile_scale=getattr(args, 'tile_scale', None), env_w=getattr(args, 'env_w', None),
                async_d=getattr(args, 'async_d', None), async_ell=getattr(args, 'async_ell', None),
                newton=getattr(args, 'newton', None), k_min=getattr(args, 'k_min', None),
                local_k=getattr(args, 'local_k', None))
    if getattr(args, 'm0', None):
        mx, my = (float(s) for s in args.m0.split(','))
        over.update(m0x=mx, m0y=my)
    return over


def synth(args):
    like = args.like
    with open(os.path.join(like, 'params.json')) as f:
        params = json.load(f)
    sc = simulator_config(params, model_overrides(args), legacy=getattr(args, 'legacy', False))
    cfg, d = params['config'], params['derived']
    name = args.name or (os.path.basename(os.path.normpath(like)) + '-proc')
    out = args.out or os.path.join(nb.RAW_DIR, name)
    os.makedirs(out, exist_ok=True)
    for fn in os.listdir(out):
        if fn.startswith(('snap_', 'dens_')):
            os.remove(os.path.join(out, fn))
    wf = port_from_config(sc, args.seed)
    Lx, Ly, lam = d['Lx'], d['Ly'], d['lambda_T']
    margin = args.margin_lambda * lam
    h = lam / 32
    nx = int(round((Lx + 2 * margin) / h))
    ny = int(round((Ly + 2 * margin) / h))
    gx = -Lx / 2 - margin + (np.arange(nx) + 0.5) * (Lx + 2 * margin) / nx
    gy = -Ly / 2 - margin + (np.arange(ny) + 0.5) * (Ly + 2 * margin) / ny
    GX, GY = np.meshgrid(gx, gy, indexing='ij')
    rng = np.random.default_rng(args.seed)
    # particles: the N-body run's size range and number density
    area = (Lx + 2 * margin) * (Ly + 2 * margin)
    npart = int(round(d['n_per_m2'] * area)) if args.particles else 0
    if 'radius' in cfg:
        r = np.full(npart, cfg['radius'])
        sz = np.full(npart, max(float(sig_z_frac(cfg['radius'])) * sc['H'], 0.02))
    else:
        r = nb.sample_powerlaw(rng, npart, cfg['a_min'], cfg['a_max'], cfg['q'])
        sz = lod_class_sigz(r, sc['q'], sc['aMin'], sc['aMax'], sc['H'])
    m = 4 / 3 * math.pi * r ** 3 * d.get('rho', 300.0)
    om = d['Omega']
    t0 = 8.4e8 if args.t0 is None else args.t0
    nsnap = int(round(args.orbits / args.snap)) + 1
    gens_log = []
    for k in range(nsnap):
        t = t0 + k * args.snap * d['P']
        wf.update(t)
        gens_log.append(dict(t=t - t0, pitch=wf.pitch_deg(), phi=wf.phi, gens=[list(g) for g in wf.gens]))
        dens = wf.density(GX, GY).astype(np.float32)
        np.savez(os.path.join(out, f'dens_{k:05d}.npz'), t=np.float64(t - t0), x0=gx[0], y0=gy[0], h=h, dens=dens)
        if npart:
            qx = rng.uniform(-Lx / 2 - margin, Lx / 2 + margin, npart)
            qy = rng.uniform(-Ly / 2 - margin, Ly / 2 + margin, npart)
            dx, dy = wf.displacement(qx, qy)
            pos = np.stack([qx + dx, qy + dy, rng.normal(0, 1, npart) * sz], 1)
            # simulator kinematics (RingLod): radial displacement std sigX = 1.5 sigma_z, c_r = kappa sigX,
            # peculiar c_y = 0.5 Omega sigX (Keplerian epicycle), c_z = nu sigma_z (here kappa = nu = Omega)
            sx = 1.5 * sz
            vel = np.stack([rng.normal(0, 1, npart) * om * sx, -1.5 * om * pos[:, 0] + rng.normal(0, 1, npart) * 0.5 * om * sx,
                            rng.normal(0, 1, npart) * om * sz], 1)
            np.savez(os.path.join(out, f'snap_{k:05d}.npz'), t=np.float64(t - t0), D=np.float64(0.0),
                     pos=pos.astype(np.float32), vel=vel.astype(np.float32))
    np.savez(os.path.join(out, 'particles.npz'), r=r.astype(np.float32), m=m.astype(np.float32))
    pcfg = dict(cfg)
    pcfg.update(name=name, out=out, fine_from=0.0, orbits=args.orbits, procedural=sc, like=os.path.abspath(like),
                seed_proc=args.seed, t0=t0)
    pd = dict(d)
    pd.update(N=npart, periodic=False, margin=margin, grid_h=h)
    nb.write_json(os.path.join(out, 'params.json'), dict(config=pcfg, derived=pd, generations=gens_log))
    print(f'{name}: {nsnap} snapshots, {npart} particles over {(Lx + 2 * margin):.0f} m x {(Ly + 2 * margin):.0f} m, '
          f'lambda {sc["lambda_m"]:.2f} m, strength {sc["strength"]:.3f}, gamma {sc["gamma"]:.3f} / gap {sc["gamma_gap"]:.3f}, '
          f'spreads {sc["spread_par"]:.2f}/{sc["spread_perp"]:.2f}, Rc {sc["rc"]}, T_LIFE {sc["t_life"]}, '
          f'm0 ({sc["m0x"]}, {sc["m0y"]}), env_w {sc["env_w"]}, async {sc["async_d"]} / {sc["async_ell"]} lambda'
          f'{" (legacy model)" if sc.get("legacy") else ""}')


def forward_density(wf, lam, n, h, sub):
    """Exact Eulerian density of the forward map on an n x n grid of cell h centred on 0: a Lagrangian lattice of sub^2
    points per cell (plus a margin of one lambda) mapped by wakeDisplacement and deposited cloud-in-cell."""
    L = n * h
    m = int(round(lam / h))
    g = (np.arange(-(m * sub), (n + m) * sub) + 0.5) / sub * h - L / 2
    cnt = np.zeros((n, n))
    # rows of the lattice in chunks (memory)
    step = max(1, (len(g) * 64) // max(len(g), 1))
    for i0 in range(0, len(g), step):
        qx, qy = np.meshgrid(g[i0:i0 + step], g, indexing='ij')
        dx, dy = wf.displacement(qx, qy)
        u = (qx + dx + L / 2) / h - 0.5
        v = (qy + dy + L / 2) / h - 0.5
        ii0, jj0 = np.floor(u).astype(np.int64), np.floor(v).astype(np.int64)
        fx, fy = u - ii0, v - jj0
        for di, dj, w in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
            ii, jj = ii0 + di, jj0 + dj
            ok = (ii >= 0) & (ii < n) & (jj >= 0) & (jj < n)
            cnt += np.bincount((ii * n + jj)[ok], weights=w[ok], minlength=n * n).reshape(n, n)
    return cnt / (sub * sub)


def forward_jacobian(wf, qx, qy, eps=0.005):
    """Determinant of the forward map's Jacobian at Lagrangian points (central differences of wakeDisplacement)."""
    ax, ay = wf.displacement(qx + eps, qy)
    bx, by = wf.displacement(qx - eps, qy)
    cx, cy = wf.displacement(qx, qy + eps)
    ex, ey = wf.displacement(qx, qy - eps)
    return (1 + (ax - bx) / (2 * eps)) * (1 + (cy - ey) / (2 * eps)) - (cx - ex) / (2 * eps) * (ay - by) / (2 * eps)


def pointwise_check(wf, lam, times, n=100000, seed=1, with_inverse=True):
    """Per particle (mass-weighted): random Lagrangian points q are mapped forward (x = q + wakeDisplacement(q)) and
    wakeDensity(x) is compared with 1 / det(dx/dq) (exact, central differences). Returns per time: share of the particles
    in folds (det <= 0), share with |ln(wakeDensity / exact)| > ln 1.2 and > ln 2, and the area mean of wakeDensity
    (6 lambda grid). with_inverse=False: folds only."""
    rng = np.random.default_rng(seed)
    g = (np.arange(192) + 0.5) / 192 * 6 * lam - 3 * lam
    GX, GY = np.meshgrid(g, g, indexing='ij')
    rows = []
    for t in times:
        wf.update(t)
        qx = rng.uniform(-3 * lam, 3 * lam, n)
        qy = rng.uniform(-3 * lam, 3 * lam, n)
        det = forward_jacobian(wf, qx, qy)
        fold = float(np.mean(det <= 0))
        if not with_inverse:
            rows.append([fold])
            continue
        dx, dy = wf.displacement(qx, qy)
        r = np.abs(np.log(wf.density(qx + dx, qy + dy) * np.maximum(det, 1e-9)))
        rows.append([fold, float(np.mean(r > math.log(1.2))), float(np.mean(r > math.log(2))), float(wf.density(GX, GY).mean())])
    return np.array(rows)


def check_inverse(args):
    """wakeDensity() vs the exact Eulerian density of the forward map x = q + wakeDisplacement(q), (1) per area: a fine
    Lagrangian lattice (args.sub^2 points per cell of lambda/32) mapped and deposited (cloud-in-cell); (2) per particle:
    wakeDensity at mapped random points vs 1/det of the forward map's Jacobian there (pointwise_check). Reports the shares
    where the two differ, the means and maxima, and the share of the particles in folds of the forward map."""
    from scipy import ndimage
    om, ka, nu = nb.orbital_frequencies(args.a_km * 1e3)
    lam = nb.toomre_lambda(args.sigma, om)
    sc = site_config(args.a_km, args.tau, lam, om, model_overrides(args), legacy=args.legacy)
    wf = port_from_config(sc)
    h = lam / 32
    n = int(round(args.box * lam / h))
    L = n * h
    P = 2 * math.pi / om
    rows = []
    for k in range(args.times):
        t = 8.4e8 + k * 0.173 * P
        wf.update(t)
        dfwd = forward_density(wf, lam, n, h, args.sub)
        c = (np.arange(n) + 0.5) * h - L / 2
        X, Y = np.meshgrid(c, c, indexing='ij')
        dinv = wf.density(X, Y)
        # compare on a lambda/16 Gaussian-smoothed scale as well (CIC sampling noise at the cell scale)
        r = np.log(np.maximum(dinv, 1e-6) / np.maximum(dfwd, 1e-6))
        rs = np.log(np.maximum(ndimage.gaussian_filter(dinv, 2), 1e-6) / np.maximum(ndimage.gaussian_filter(dfwd, 2), 1e-6))
        rows.append([np.mean(np.abs(r) > math.log(1.2)), np.mean(np.abs(r) > math.log(1.5)), np.mean(np.abs(r) > math.log(2)),
                     np.mean(np.abs(rs) > math.log(1.2)), dinv.mean(), dfwd.mean(), np.corrcoef(dinv.ravel(), dfwd.ravel())[0, 1],
                     np.mean((dinv >= wf.whi * 0.999) | (dinv <= wf.wlo * 1.001)), dfwd.max(), dinv.max(),
                     float(np.quantile(dfwd, 0.999)), float(np.quantile(dinv, 0.999))])
    pw = pointwise_check(wf, lam, [8.4e8 + k * 0.173 * P for k in range(args.times)])
    a = np.concatenate([np.array(rows), pw], 1)
    names = ['area |ln(inv/fwd)| > ln 1.2', '> ln 1.5', '> ln 2', 'smoothed (lambda/16): > ln 1.2', 'mean wakeDensity',
             'mean forward-map density', 'correlation', 'area at the clamp', 'max forward density', 'max wakeDensity',
             'p99.9 forward density', 'p99.9 wakeDensity', 'particles in folds', 'particles |ln(inv/exact)| > ln 1.2',
             'particles > ln 2', 'area mean wakeDensity (6 lambda)']
    print(f'{args.a_km:.0f} km, tau {args.tau}, lambda {lam:.2f} m, strength {sc["strength"]:.3f}, gamma {sc["gamma"]:.3f} / gap '
          f'{sc["gamma_gap"]:.3f}, Rc {sc["rc"]}, newton {sc["newton"]}, local_k {sc["local_k"]}, async {sc["async_d"]}'
          f'{" (legacy model)" if args.legacy else ""}, {args.times} times, box {args.box} lambda, {args.sub}x{args.sub} lattice '
          f'points per lambda/32 cell, clamp [{wf.wlo:.3f}, {wf.whi:.2f}]')
    res = {}
    for j, nm in enumerate(names):
        print(f'  {nm:34s} {a[:, j].mean():.4f}  (min {a[:, j].min():.4f}, max {a[:, j].max():.4f})')
        res[nm] = [float(a[:, j].mean()), float(a[:, j].min()), float(a[:, j].max())]
    if args.json:
        model = {k: sc[k] for k in MODEL_KEYS if k in sc}
        nb.write_json(args.json, dict(a_km=args.a_km, tau=args.tau, sigma=args.sigma, strength=sc['strength'], gamma=sc['gamma'],
                                      gamma_gap=sc['gamma_gap'], lambda_m=lam, times=args.times, legacy=args.legacy,
                                      model=model, clamp=[wf.wlo, wf.whi], stats=res))


def verify(args):
    """Compare the port with the TypeScript originals (bundled with rolldown, run with node)."""
    rolldown = os.path.join(nb.REPO, 'node_modules', '.bin', 'rolldown')
    if not os.path.exists(rolldown):
        sys.exit('node_modules missing (npm install, or symlink the main checkout\'s node_modules into this worktree)')
    tmp = tempfile.mkdtemp(prefix='wakefield-ref-')
    bundle = os.path.join(tmp, 'wf.mjs')
    subprocess.run([rolldown, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wakefield_ref.ts'),
                    '--file', bundle, '--format', 'esm', '--platform', 'node'], check=True, capture_output=True)
    cases = []
    for r_km, tau, sigma, t, shape in ((128000, 0.66, 284.0, 8.4e8, None), (135000, 0.6, 186.0, 8.40123e8, None),
                                       (105000, 2.5, 600.0, 7.77e8, None),
                                       (128000, 1.7, 500.0, 9.1e8, dict(spreadPar=2.2, spreadPerp=3.3, asyncD=0.5, gammaGap=0.06))):
        om, ka, nu = nb.orbital_frequencies(r_km * 1e3)
        cases.append(dict(rKm=r_km, tau=tau, sigma=sigma, omega=om, kappa=ka, qShear=1.5, t=t, shape=shape))
    res = subprocess.run(['node', bundle, json.dumps(dict(seed=12345, cases=cases))], check=True, capture_output=True, text=True)
    ref = json.loads(res.stdout)
    ok = True
    ts_key = dict(gamma='gamma', gamma_gap='gammaGap', spread_par='spreadPar', spread_perp='spreadPerp', rc='rc',
                  t_life='tLife', m0x='m0x', env_w='envW', async_d='asyncD', async_ell='asyncEll', tile_scale='tileScale')
    for c, rc in zip(cases, ref['cases']):
        zk = zone_for_km(c['rKm'])
        z = ZONES[zk]
        for key in ('q', 'aMin', 'aMax', 'H', 'wake', 'wakeB'):
            if abs(z[key] - rc['zone'][key]) > 1e-12 or rc['zone']['key'] != zk:
                print(f'FAIL zone {zk}.{key}: port {z[key]} vs ringRegions.ts {rc["zone"][key]} ({rc["zone"]["key"]})')
                ok = False
        lam = nb.toomre_lambda(c['sigma'], c['kappa'])
        over = {}
        if c['shape']:
            inv = {v: k for k, v in ts_key.items()}
            over = {inv[k]: v for k, v in c['shape'].items()}
        sc = site_config(c['rKm'], c['tau'], lam, c['omega'], over)
        wf = port_from_config(sc)
        wf.configure(lam, sc['strength'], c['omega'], c['qShear'])
        gens = wf.update(c['t'])
        checks = [('lambda', lam, rc['lambda'], 1e-12), ('tile', wf.tile, rc['tile'], 1e-12),
                  ('strength', sc['strength'], rc['strength'], 1e-12), ('pitchDeg', wf.pitch_deg(), rc['pitchDeg'], 1e-9)]
        for k, tk in ts_key.items():
            checks.append((f'set.{tk}', sc[k], rc['shape'][tk], 1e-12))
        for g in range(2):
            for i, lab in enumerate(('S', 'offU', 'offV', 'sel')):
                checks.append((f'gen{g}.{lab}', gens[g][i], rc['gen'][g][i], 1e-9))
        u = rc['uniforms']
        checks += [('clock.phi', wf.phi, u['clock'][0], 1e-9), ('clock.asyncD', sc['async_d'], u['clock'][1], 1e-12),
                   ('clock.2envW', 2 * sc['env_w'], u['clock'][2], 1e-12), ('clock.strength', sc['strength'], u['clock'][3], 1e-12),
                   ('delta.offU', wf.dframe[0], u['delta'][0], 1e-9), ('delta.offV', wf.dframe[1], u['delta'][1], 1e-9),
                   ('delta.S', wf.dframe[2], u['delta'][2], 1e-9), ('delta.scale/L', wf.dscale / wf.tile, u['delta'][3], 1e-9),
                   ('shape.lnGamma', wf.LG, u['shape'][0], 1e-12), ('shape.lnG', wf.LGG, u['shape'][1], 1e-12),
                   ('shape.1/Rc^2', wf.inv_rc2, u['shape'][2], 1e-12), ('shape.kMin', sc['k_min'], u['shape'][3], 1e-12),
                   ('m0x', sc['m0x'], u['m0'][0], 0), ('m0y', sc['m0y'], u['m0'][1], 0),
                   ('bounds.lo', wf.wlo, u['bounds'][0], 1e-12), ('bounds.hi', wf.whi, u['bounds'][1], 1e-12),
                   ('bounds.tmax', wf.tmax, u['bounds'][2], 1e-9)]
        maxtex = 0.0
        for (i, j), tv in zip(ref['texels'], rc['texels']):
            for layer in range(2):
                maxtex = max(maxtex, float(np.max(np.abs(wf.tex[layer, j, i] - np.array(tv[layer], np.float32)))))
        maxd = 0.0
        for (i, j), tv in zip(ref['dtexels'], rc['dtexels']):
            maxd = max(maxd, float(np.max(np.abs(wf.dtex[j, i] - np.array(tv, np.float32)))))
        checks.append(('texels (max |diff|)', maxtex, 0.0, 2e-6))
        checks.append(('delta texels (max |diff|)', maxd, 0.0, 2e-6))
        cok = True
        for lab, a, b, tol in checks:
            err = abs(a - b) / max(1.0, abs(b)) if 'texels' not in lab else a
            good = err <= tol
            cok &= good
            if not good or args.verbose:
                print(f'{"PASS" if good else "FAIL"} {c["rKm"]} km tau {c["tau"]}: {lab} port {a!r} vs TS {b!r}')
        ok &= cok
        print(f'case {c["rKm"]} km tau {c["tau"]}: {"PASS" if cok else "FAIL"} (lambda {lam:.3f} m, strength {sc["strength"]:.3f}, '
              f'gamma {sc["gamma"]:.3f} / gap {sc["gamma_gap"]:.3f}, spreads {sc["spread_par"]:.2f}/{sc["spread_perp"]:.2f}, '
              f'T_LIFE {sc["t_life"]}, m0x {sc["m0x"]:.0f}, pitch {wf.pitch_deg():.2f} deg, max texel diff {maxtex:.2e} / {maxd:.2e})')
    print('verify:', 'PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)


def add_model_args(s):
    s.add_argument('--gamma', type=float, help='core contrast: density 1/gamma at full local strength')
    s.add_argument('--gamma-gap', type=float, help='gap density at full local strength (default: = gamma)')
    s.add_argument('--spread-par', type=float)
    s.add_argument('--spread-perp', type=float)
    s.add_argument('--rc', type=float)
    s.add_argument('--t-life', type=float)
    s.add_argument('--strength', type=float)
    s.add_argument('--tile-scale', type=float, help='scale of the tile = crest spacing (app: 1)')
    s.add_argument('--env-w', type=float, help='plateau envelope crossfade width / T_LIFE (0 = sin^2)')
    s.add_argument('--async-d', type=float, help='asynchrony depth: handover phase spread (fraction of the cycle)')
    s.add_argument('--async-ell', type=float, help='asynchrony correlation length (Toomre wavelengths)')
    s.add_argument('--m0', help='lattice mode at birth "mx,my"')
    s.add_argument('--newton', type=int, help='Newton steps of the inverse (app: 1)')
    s.add_argument('--k-min', type=float, help='lower clamp of the local wave number (fraction of the mean)')
    s.add_argument('--local-k', action=argparse.BooleanOptionalAction, default=None, help='local wave number map')
    s.add_argument('--legacy', action='store_true', help='the app before Nov 2026')


def main(argv):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--verify', action='store_true', help='compare with the TypeScript originals')
    p.add_argument('--verbose', action='store_true')
    sub = p.add_subparsers(dest='cmd')
    s = sub.add_parser('synth', help='synthetic run in the N-body format')
    s.add_argument('--like', required=True, help='N-body run directory (box, lambda, sizes, number density)')
    s.add_argument('--name')
    s.add_argument('--out')
    s.add_argument('--orbits', type=float, default=6.0)
    s.add_argument('--snap', type=float, default=0.05, help='snapshot interval (orbits)')
    s.add_argument('--margin-lambda', type=float, default=1.0, help='margin around the box (Toomre wavelengths)')
    add_model_args(s)
    s.add_argument('--seed', type=int, default=12345)
    s.add_argument('--t0', type=float)
    s.add_argument('--particles', action=argparse.BooleanOptionalAction, default=True)
    c = sub.add_parser('check-inverse', help="wakeDensity() vs the exact density of the forward map")
    c.add_argument('--a-km', type=float, default=128000)
    c.add_argument('--tau', type=float, default=0.66)
    c.add_argument('--sigma', type=float, default=284)
    add_model_args(c)
    c.add_argument('--box', type=float, default=6.0)
    c.add_argument('--sub', type=int, default=6)
    c.add_argument('--times', type=int, default=8)
    c.add_argument('--json')
    a = p.parse_args(argv)
    if a.verify:
        verify(a)
    elif a.cmd == 'synth':
        synth(a)
    elif a.cmd == 'check-inverse':
        check_inverse(a)
    else:
        p.print_help()


if __name__ == '__main__':
    main(sys.argv[1:])
