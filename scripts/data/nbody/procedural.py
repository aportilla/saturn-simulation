#!/usr/bin/env python3
"""Python port of the simulator's procedural self-gravity wake field, and synthetic "runs" drawn from it.

usage ($PY = the venv python, see README.md):
  $PY scripts/data/nbody/procedural.py --verify
      bundle + run scripts/data/nbody/wakefield_ref.ts (the real WakeField.ts / ringRegions.ts, via rolldown + node)
      and compare texture texels, lambda, tile, strength, shape and the generation uniforms with this port
  $PY scripts/data/nbody/procedural.py synth --like data-raw/nbody/A128-sd [--name A128-sd-proc] [--out DIR]
      [--orbits 6] [--snap 0.05] [--gamma G] [--spread-par P] [--spread-perp Q] [--rc R] [--t-life T]
      [--strength S] [--m0 3,6] [--seed 12345] [--particles/--no-particles]
      a synthetic run in the N-body run format (params.json, particles.npz, snap_*.npz) over the same box, with the
      same particle sizes and number density, placed the way the near field draws them (uniform epicyclic positions
      + wakeDisplacement; z Gaussian with RingLod's sigma_z(a) = sigZFrac(a_eff) H), plus the noise-free wakeDensity
      on the analysis grid (dens_*.npz). Not periodic: generated over the box plus a margin (params "margin").

What is ported (deterministic: same seed 12345, same RNG streams as the app):
  src/rings/WakeField.ts   mulberry32, hashFloat, wakeShapeFor, buildTexture (256x256 RGBA32F: two complex
                           envelopes W_A, W_B = Gaussian-weighted random modes around m0 = (3, 6), drawn in the same
                           loop order; the mode sum is an inverse FFT here instead of the explicit separable sum, which
                           is identical up to float32 rounding; then renormalised to mean |W|^2 = 1 in float32),
                           configure (lambda = 4 pi^2 G Sigma / kappa^2, tile = lambda * 6 / sin 20 deg, sizeOk,
                           strength, shape), update (generation clock: T_LIFE = 3/Omega, two generations, sin^2
                           envelopes, shear S = q * age, hashFloat offsets, field selection).
  src/render/shaders/wakes.glsl  texture() with LinearFilter + RepeatWrapping (bilinear, texel centres at (i + 0.5)/N),
                           wakeGenGeom, wakeGenPhase, wakeCircleMap/Inv, wakeGenPhaseD (forward difference 1.5 m),
                           wakeGenJac, wakeGenDisp, wakeDisplacement, wakeGenInverse (one Newton step), wakeDensity
                           (incl. the clamp to [0.9 Wmin, 1.1 Wmax]). Evaluated in float64 (the GPU uses float32).
  src/rings/RingLod.ts     sigZFracForRadius and the octave classes' aEff (vertical law sigma_z = sigZFrac(aEff) H).
  src/rings/ringRegions.ts the zone values used here (A_in, A_out, B3) - checked by --verify.
Not ported: wakeDensityFiltered (footprint fade for distant views), the ring-layer wake clipmap.
Model parameters can be overridden (--gamma ... --m0) for calibration scans (calibrate.py).
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
WAKE_FD_H = 1.5
TWO_PI = 2 * math.pi
# tile_scale, n_gen and env_w are not parameters of the app (1, 2 and sin^2 there): the crest spacing scale, the number
# of overlapping generations and a plateau envelope with crossfade width env_w (fraction of T_LIFE), for calibration
DEFAULTS = dict(m0x=3.0, m0y=6.0, t_life=3.0, rc=0.45, pitch_peak_deg=20.0, tile_scale=1.0, n_gen=2, env_w=0.0)


def envelope(phase, w):
    """Generation envelope at phase = age / T_LIFE in [0, 1). w = 0: the app's sin^2(pi phase). w > 0 (two generations
    only): rise smoothstep(0, w, phase), plateau 1, fall over [0.5, 0.5 + w], 0 after; the two generations, half a
    lifetime apart, again sum to exactly 1."""
    if w <= 0:
        return math.sin(math.pi * phase) ** 2
    if phase < 0.5:
        return smooth(0.0, w, phase)
    return 1.0 - smooth(0.0, w, phase - 0.5)

# zone values of src/rings/ringRegions.ts used by the reference sites (checked against the TS by --verify)
ZONES = {
    'A_in': dict(q=2.9, aMin=0.02, aMax=5.0, H=10.0, wake=1.0),
    'A_out': dict(q=3.05, aMin=0.005, aMax=7.0, H=10.0, wake=0.6),
    'B3': dict(q=3.2, aMin=0.05, aMax=2.0, H=15.0, wake=0.5),
}


def zone_for_km(r_km):
    if 122050 <= r_km < 133423:
        return 'A_in'
    if 133745 <= r_km < 136770:
        return 'A_out'
    if 104000 <= r_km < 110000:
        return 'B3'
    raise ValueError(f'no zone table entry for {r_km} km (add it to ZONES)')


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


def smooth(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def wake_shape_for(tau):
    """wakeShapeFor(local) of WakeField.ts."""
    chaos = smooth(1.0, 2.5, tau)
    return dict(gamma=0.16 + 0.08 * chaos, spreadPar=1.6 + 0.8 * chaos, spreadPerp=5.0 + 1.0 * chaos)


def build_texture(seed, spread_par, spread_perp, m0x=3.0, m0y=6.0):
    """WakeField.buildTexture: returns float32 array [j, i, 4] (texel (s = i, t = j)), channels ReA ImA ReB ImB."""
    N = N_TEX
    m0n = math.hypot(m0x, m0y)
    px, py = m0x / m0n, m0y / m0n
    sp, sq = spread_par, spread_perp
    R = math.ceil(3 * max(sp, sq)) + 1
    data = np.zeros((N, N, 4), np.float32)
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
        data[:, :, 2 * field] = W.real.astype(np.float32)
        data[:, :, 2 * field + 1] = W.imag.astype(np.float32)
    for field in range(2):
        re = data[:, :, 2 * field].astype(np.float64)
        im = data[:, :, 2 * field + 1].astype(np.float64)
        f = 1 / math.sqrt((re * re + im * im).sum() / (N * N))
        data[:, :, 2 * field] = (re * f).astype(np.float32)
        data[:, :, 2 * field + 1] = (im * f).astype(np.float32)
    return data


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


class WakeFieldPort:
    """WakeField.ts + wakes.glsl. Positions are local Hill-frame metres (x radial, y azimuthal)."""

    def __init__(self, seed=12345, **over):
        self.seed = seed
        self.p = dict(DEFAULTS)
        self.p.update({k: v for k, v in over.items() if v is not None and k in DEFAULTS})
        self.tex = None
        self.tex_key = None

    def configure(self, lam, strength, gamma, spread_par, spread_perp, omega, q_shear=1.5):
        p = self.p
        self.lam = lam
        self.tile = max(lam * p['m0y'] / math.sin(math.radians(p['pitch_peak_deg'])) * p['tile_scale'], 1.0)
        self.strength = strength
        self.gamma = gamma
        self.lng = math.log(gamma)
        self.inv_rc2 = 1 / (p['rc'] * p['rc'])
        self.omega = omega
        self.q_shear = q_shear
        key = (round(spread_par, 6), round(spread_perp, 6), p['m0x'], p['m0y'])
        if key != self.tex_key:
            self.tex = build_texture(self.seed, spread_par, spread_perp, p['m0x'], p['m0y'])
            self.tex_key = key
        self.wmin = math.exp(self.lng * strength)
        self.wmax = math.exp(-self.lng * strength)

    def update(self, t):
        """Generation uniforms at sim time t (s): list of (amp, S, offU, offV, sel), older first.
        n_gen = 2 is the app (WakeField.update). n_gen > 2 (calibration variant, not in the app): generations born every
        T/n_gen with amplitude strength * (2/n_gen) * sin^2(pi age / T), which again sum to `strength`."""
        tau = self.omega * t
        T = self.p['t_life']
        n = int(self.p.get('n_gen', 2))
        w = float(self.p.get('env_w', 0.0)) if n == 2 else 0.0
        step = T / n
        ny = math.floor(tau / step)
        gens = []
        for g in range(n):
            ng = ny - (n - 1 - g)
            age = tau - ng * step
            env = envelope(age / T, w)
            gens.append((self.strength * env * 2 / n, self.q_shear * age, hash_float(ng, 1), hash_float(ng, 2), ng % 2))
        self.gens = gens
        return gens

    def pitch_deg(self):
        """WakeField.pitchDeg: amplitude-weighted mean pitch of the two generations."""
        p = self.p
        w = sum(g[0] for g in self.gens)
        if w <= 0:
            return 0.0
        return sum(g[0] * math.degrees(math.atan2(p['m0y'], p['m0x'] + g[1] * p['m0y'])) for g in self.gens) / w

    # ---- GLSL
    def _tex(self, u, v):
        N = N_TEX
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
        T = self.tex
        return (T[j0, i0] * (1 - fx) * (1 - fy) + T[j0, i1] * fx * (1 - fy)
                + T[j1, i0] * (1 - fx) * fy + T[j1, i1] * fx * fy)

    def _w(self, g, u, v):
        t = self._tex(u, v)
        return (t[..., 2], t[..., 3]) if self.gens[g][4] > 0.5 else (t[..., 0], t[..., 1])

    def _geom(self, g):
        p = self.p
        S = self.gens[g][1]
        kx = (p['m0x'] + S * p['m0y']) * TWO_PI / self.tile
        ky = p['m0y'] * TWO_PI / self.tile
        km = math.hypot(kx, ky)
        return kx / km, ky / km, km

    def _uv(self, g, x, y):
        amp, S, ou, ov, _ = self.gens[g]
        return x / self.tile + ou, (y + S * x) / self.tile + ov

    def _phase_from(self, g, u, v, wx, wy):
        p = self.p
        ph = np.mod(p['m0x'] * u + p['m0y'] * v, 1.0) * TWO_PI + np.arctan2(wy, wx + 1e-20)
        return ph - TWO_PI * np.floor(ph / TWO_PI + 0.5)

    def gen_phase(self, g, x, y):
        u, v = self._uv(g, x, y)
        wx, wy = self._w(g, u, v)
        a = self.gens[g][0] * (1 - np.exp(-(wx * wx + wy * wy) * self.inv_rc2))
        return self._phase_from(g, u, v, wx, wy), a

    @staticmethod
    def circle_map(th, gam):
        h = 0.5 * th
        return 2 * np.arctan2(gam * np.sin(h), np.cos(h))

    @staticmethod
    def circle_inv(X, gam):
        h = 0.5 * X
        return 2 * np.arctan2(np.sin(h), gam * np.cos(h))

    def gen_phase_d(self, g, x, y, nx, ny, km):
        amp, S, ou, ov, sel = self.gens[g]
        u, v = self._uv(g, x, y)
        du = nx * (WAKE_FD_H / self.tile)
        dv = (ny + S * nx) * (WAKE_FD_H / self.tile)
        w0x, w0y = self._w(g, u, v)
        w1x, w1y = self._w(g, u + du, v + dv)
        a0 = amp * (1 - np.exp(-(w0x * w0x + w0y * w0y) * self.inv_rc2))
        a1 = amp * (1 - np.exp(-(w1x * w1x + w1y * w1y) * self.inv_rc2))
        ph = self._phase_from(g, u, v, w0x, w0y)
        dphi = np.arctan2(w1y * w0x - w1x * w0y, w1x * w0x + w1y * w0y + 1e-20)
        return ph, a0, km + dphi / WAKE_FD_H, (a1 - a0) / WAKE_FD_H

    def gen_jac(self, ph, a, dth, da, km):
        gam = np.exp(a * self.lng)
        c, s = np.cos(0.5 * ph), np.sin(0.5 * ph)
        den = c * c + gam * gam * s * s
        Md = gam / den
        Ma = gam * np.sin(ph) * self.lng / den
        return 1 + ((Md - 1) * dth + Ma * da) / km

    def gen_disp(self, g, x, y):
        ph, a = self.gen_phase(g, x, y)
        nx, ny, km = self._geom(g)
        gam = np.exp(a * self.lng)
        d = np.where(a < 1e-4, 0.0, (self.circle_map(ph, gam) - ph) / km)
        return nx * d, ny * d

    def displacement(self, x, y):
        """wakeDisplacement(q): displacement (m) of particles whose undisplaced (epicyclic) position is (x, y).
        The maps are composed oldest first (x = M_young(M_old(q)))."""
        if self.strength <= 1e-3:
            return np.zeros_like(x), np.zeros_like(y)
        dx, dy = np.zeros_like(x), np.zeros_like(y)
        for g in range(len(self.gens)):
            ddx, ddy = self.gen_disp(g, x + dx, y + dy)
            dx, dy = dx + ddx, dy + ddy
        return dx, dy

    def gen_inverse(self, g, x, y):
        nx, ny, km = self._geom(g)
        ph, a = self.gen_phase(g, x, y)
        weak = a < 1e-4
        gam = np.exp(a * self.lng)
        th = self.circle_inv(ph, gam)
        qx = x - nx * (ph - th) / km
        qy = y - ny * (ph - th) / km
        P0, P1, P2, P3 = self.gen_phase_d(g, qx, qy, nx, ny, km)
        gb = np.exp(P1 * self.lng)
        Jq = self.gen_jac(P0, P1, P2, P3, km)
        dm = (self.circle_map(P0, gb) - P0) / km
        xqx, xqy = qx + nx * dm, qy + ny * dm
        r = ((x - xqx) * nx + (y - xqy) * ny) / np.maximum(Jq, 0.05)
        qx = qx + nx * r
        qy = qy + ny * r
        J = np.maximum(self.gen_jac(P0 + P2 * r, P1 + P3 * r, P2, P3, km), 1e-3)
        return np.where(weak, x, qx), np.where(weak, y, qy), np.where(weak, 1.0, J)

    def density(self, x, y):
        """wakeDensity(x): Eulerian surface-density factor (mean ~1)."""
        if self.strength <= 1e-3:
            return np.ones_like(x)
        qx, qy, J = x, y, 1.0
        for g in range(len(self.gens) - 1, -1, -1):      # youngest first (wakes.glsl: inverse(1) then inverse(0))
            qx, qy, Jg = self.gen_inverse(g, qx, qy)
            J = J * Jg
        return np.clip(1 / J, self.wmin * 0.9, self.wmax * 1.1)


def simulator_config(params, over=None):
    """Procedural wake parameters the simulator would use at an N-body run's site (its tau, lambda, zone)."""
    cfg, d = params['config'], params['derived']
    zone = ZONES[zone_for_km(cfg['a_km'])]
    lam = d['lambda_T']                      # same Toomre wavelength as the N-body run (Hill: kappa = Omega)
    tau = cfg['tau']
    size_ok = min(1.0, max(0.0, (lam / max(zone['aMax'], 0.1) - 2) / 4))
    wake = zone['wake'] * smooth(0.15, 0.4, tau)
    strength = min(1.0, wake * size_ok)
    shape = wake_shape_for(tau)
    out = dict(lambda_m=lam, strength=strength, gamma=shape['gamma'], spread_par=shape['spreadPar'],
               spread_perp=shape['spreadPerp'], tau=tau, zone=zone_for_km(cfg['a_km']), H=zone['H'],
               q=zone['q'], aMin=zone['aMin'], aMax=zone['aMax'], omega=d['Omega'])
    out.update(DEFAULTS)
    for k, v in (over or {}).items():
        if v is not None:
            out[k] = v
    return out


def synth(args):
    like = args.like
    with open(os.path.join(like, 'params.json')) as f:
        params = json.load(f)
    over = dict(gamma=args.gamma, spread_par=args.spread_par, spread_perp=args.spread_perp, rc=args.rc,
                t_life=args.t_life, strength=args.strength, tile_scale=getattr(args, 'tile_scale', None),
                n_gen=getattr(args, 'n_gen', None), env_w=getattr(args, 'env_w', None))
    if args.m0:
        mx, my = (float(s) for s in args.m0.split(','))
        over.update(m0x=mx, m0y=my)
    sc = simulator_config(params, over)
    cfg, d = params['config'], params['derived']
    name = args.name or (os.path.basename(os.path.normpath(like)) + '-proc')
    out = args.out or os.path.join(nb.RAW_DIR, name)
    os.makedirs(out, exist_ok=True)
    for fn in os.listdir(out):
        if fn.startswith(('snap_', 'dens_')):
            os.remove(os.path.join(out, fn))
    wf = WakeFieldPort(args.seed, m0x=sc['m0x'], m0y=sc['m0y'], t_life=sc['t_life'], rc=sc['rc'], tile_scale=sc['tile_scale'],
                       n_gen=sc['n_gen'], env_w=sc['env_w'])
    wf.configure(sc['lambda_m'], sc['strength'], sc['gamma'], sc['spread_par'], sc['spread_perp'], sc['omega'])
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
        gens_log.append(dict(t=t - t0, pitch=wf.pitch_deg(), gens=[list(g) for g in wf.gens]))
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
          f'lambda {sc["lambda_m"]:.2f} m, strength {sc["strength"]:.3f}, gamma {sc["gamma"]:.3f}, spreads '
          f'{sc["spread_par"]:.2f}/{sc["spread_perp"]:.2f}, Rc {sc["rc"]}, T_LIFE {sc["t_life"]}, m0 ({sc["m0x"]}, {sc["m0y"]})')


def check_inverse(args):
    """wakeDensity() (approximate inverse: one Newton step per generation) vs the exact Eulerian density of the
    forward map x = q + wakeDisplacement(q), obtained by mapping a fine Lagrangian lattice (args.sub^2 points per
    cell of lambda/32) and depositing it (cloud-in-cell). Reports the share of the area where the two differ."""
    om, ka, nu = nb.orbital_frequencies(args.a_km * 1e3)
    lam = nb.toomre_lambda(args.sigma, om)
    shape = wake_shape_for(args.tau)
    wf = WakeFieldPort(12345, t_life=args.t_life, rc=args.rc)
    wf.configure(lam, args.strength, args.gamma or shape['gamma'], shape['spreadPar'], shape['spreadPerp'], om)
    h = lam / 32
    n = int(round(args.box * lam / h))
    L = n * h
    sub = args.sub
    P = 2 * math.pi / om
    rows = []
    for k in range(args.times):
        t = 8.4e8 + k * 0.173 * P
        wf.update(t)
        # Lagrangian lattice over the box plus a margin of 1 lambda (displacements are < lambda/2)
        m = int(round(lam / h))
        g = (np.arange(-(m * sub), (n + m) * sub) + 0.5) / sub * h - L / 2
        qx, qy = np.meshgrid(g, g, indexing='ij')
        dx, dy = wf.displacement(qx, qy)
        u = (qx + dx + L / 2) / h - 0.5
        v = (qy + dy + L / 2) / h - 0.5
        i0, j0 = np.floor(u).astype(np.int64), np.floor(v).astype(np.int64)
        fx, fy = u - i0, v - j0
        cnt = np.zeros((n, n))
        for di, dj, w in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
            ii, jj = i0 + di, j0 + dj
            ok = (ii >= 0) & (ii < n) & (jj >= 0) & (jj < n)
            cnt += np.bincount((ii * n + jj)[ok], weights=w[ok], minlength=n * n).reshape(n, n)
        dfwd = cnt / (sub * sub)
        c = (np.arange(n) + 0.5) * h - L / 2
        X, Y = np.meshgrid(c, c, indexing='ij')
        dinv = wf.density(X, Y)
        # compare on a lambda/16 Gaussian-smoothed scale as well (CIC sampling noise at the cell scale)
        from scipy import ndimage
        r = np.log(np.maximum(dinv, 1e-6) / np.maximum(dfwd, 1e-6))
        rs = np.log(np.maximum(ndimage.gaussian_filter(dinv, 2), 1e-6) / np.maximum(ndimage.gaussian_filter(dfwd, 2), 1e-6))
        rows.append([np.mean(np.abs(r) > math.log(1.2)), np.mean(np.abs(r) > math.log(1.5)), np.mean(np.abs(r) > math.log(2)),
                     np.mean(np.abs(rs) > math.log(1.2)), dinv.mean(), dfwd.mean(), np.corrcoef(dinv.ravel(), dfwd.ravel())[0, 1],
                     np.mean((dinv >= wf.wmax * 1.1 * 0.999) | (dinv <= wf.wmin * 0.9 * 1.001)), dfwd.max(), dinv.max()])
    a = np.array(rows)
    names = ['area |ln(inv/fwd)| > ln 1.2', '> ln 1.5', '> ln 2', 'smoothed (lambda/16): > ln 1.2', 'mean wakeDensity',
             'mean forward-map density', 'correlation', 'area at the clamp', 'max forward density', 'max wakeDensity']
    print(f'{args.a_km:.0f} km, tau {args.tau}, lambda {lam:.2f} m, strength {args.strength}, gamma {wf.gamma:.3f}, '
          f'{args.times} times, box {args.box} lambda, {sub}x{sub} lattice points per lambda/32 cell')
    res = {}
    for j, nm in enumerate(names):
        print(f'  {nm:34s} {a[:, j].mean():.4f}  (min {a[:, j].min():.4f}, max {a[:, j].max():.4f})')
        res[nm] = [float(a[:, j].mean()), float(a[:, j].min()), float(a[:, j].max())]
    if args.json:
        nb.write_json(args.json, dict(a_km=args.a_km, tau=args.tau, sigma=args.sigma, strength=args.strength, gamma=wf.gamma,
                                      lambda_m=lam, times=args.times, stats=res))


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
                                       (105000, 2.5, 600.0, 7.77e8, None), (128000, 1.7, 500.0, 9.1e8, dict(spreadPar=2.2, spreadPerp=3.3))):
        om, ka, nu = nb.orbital_frequencies(r_km * 1e3)
        cases.append(dict(rKm=r_km, tau=tau, sigma=sigma, omega=om, kappa=ka, qShear=1.5, t=t, shape=shape))
    res = subprocess.run(['node', bundle, json.dumps(dict(seed=12345, cases=cases))], check=True, capture_output=True, text=True)
    ref = json.loads(res.stdout)
    ok = True
    for c, rc in zip(cases, ref['cases']):
        zk = zone_for_km(c['rKm'])
        z = ZONES[zk]
        for key in ('q', 'aMin', 'aMax', 'H', 'wake'):
            if abs(z[key] - rc['zone'][key]) > 1e-12 or rc['zone']['key'] != zk:
                print(f'FAIL zone {zk}.{key}: port {z[key]} vs ringRegions.ts {rc["zone"][key]} ({rc["zone"]["key"]})')
                ok = False
        shape = wake_shape_for(c['tau'])
        if c['shape']:
            shape.update(c['shape'])
        lam = nb.toomre_lambda(c['sigma'], c['kappa'])
        size_ok = min(1.0, max(0.0, (lam / max(z['aMax'], 0.1) - 2) / 4))
        strength = min(1.0, z['wake'] * smooth(0.15, 0.4, c['tau']) * size_ok)
        wf = WakeFieldPort(12345)
        wf.configure(lam, strength, shape['gamma'], shape['spreadPar'], shape['spreadPerp'], c['omega'], c['qShear'])
        gens = wf.update(c['t'])
        checks = [('lambda', lam, rc['lambda'], 1e-12), ('tile', wf.tile, rc['tile'], 1e-12),
                  ('strength', strength, rc['strength'], 1e-12), ('gamma', shape['gamma'], rc['shape']['gamma'], 1e-12),
                  ('spreadPar', shape['spreadPar'], rc['shape']['spreadPar'], 1e-12),
                  ('spreadPerp', shape['spreadPerp'], rc['shape']['spreadPerp'], 1e-12),
                  ('pitchDeg', wf.pitch_deg(), rc['pitchDeg'], 1e-9)]
        for g in range(2):
            for i, lab in enumerate(('amp', 'S', 'offU', 'offV')):
                checks.append((f'gen{g}.{lab}', gens[g][i], rc['gen'][g][i], 1e-9))
            checks.append((f'gen{g}.sel', gens[g][4], rc['sel'][g], 0))
        checks.append(('lnGamma', wf.lng, rc['wshape'][0], 1e-12))
        checks.append(('Wmin', wf.wmin, rc['wshape'][2], 1e-12))
        checks.append(('Wmax', wf.wmax, rc['wshape'][3], 1e-12))
        maxtex = 0.0
        for (i, j), tv in zip(ref['texels'], rc['texels']):
            maxtex = max(maxtex, float(np.max(np.abs(wf.tex[j, i] - np.array(tv, np.float32)))))
        checks.append(('texels (max |diff|)', maxtex, 0.0, 2e-6))
        for lab, a, b, tol in checks:
            err = abs(a - b) / max(1.0, abs(b)) if lab != 'texels (max |diff|)' else a
            good = err <= tol
            ok &= good
            if not good or args.verbose:
                print(f'{"PASS" if good else "FAIL"} {c["rKm"]} km tau {c["tau"]}: {lab} port {a!r} vs TS {b!r}')
        print(f'case {c["rKm"]} km tau {c["tau"]}: {"PASS" if ok else "FAIL"} (lambda {lam:.3f} m, strength {strength:.3f}, '
              f'gamma {shape["gamma"]:.3f}, spreads {shape["spreadPar"]:.2f}/{shape["spreadPerp"]:.2f}, '
              f'pitch {wf.pitch_deg():.2f} deg, max texel diff {maxtex:.2e})')
    print('verify:', 'PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)


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
    s.add_argument('--gamma', type=float)
    s.add_argument('--spread-par', type=float)
    s.add_argument('--spread-perp', type=float)
    s.add_argument('--rc', type=float)
    s.add_argument('--t-life', type=float)
    s.add_argument('--strength', type=float)
    s.add_argument('--tile-scale', type=float, help='scale of the tile = crest spacing (app: 1)')
    s.add_argument('--n-gen', type=int, help='number of overlapping generations (app: 2)')
    s.add_argument('--env-w', type=float, help='plateau envelope crossfade width / T_LIFE (app: 0 = sin^2)')
    s.add_argument('--m0', help='lattice mode at birth "mx,my" (default 3,6)')
    s.add_argument('--seed', type=int, default=12345)
    s.add_argument('--t0', type=float)
    s.add_argument('--particles', action=argparse.BooleanOptionalAction, default=True)
    c = sub.add_parser('check-inverse', help="wakeDensity() vs the exact density of the forward map")
    c.add_argument('--a-km', type=float, default=128000)
    c.add_argument('--tau', type=float, default=0.66)
    c.add_argument('--sigma', type=float, default=284)
    c.add_argument('--strength', type=float, default=1.0)
    c.add_argument('--gamma', type=float)
    c.add_argument('--rc', type=float)
    c.add_argument('--t-life', type=float)
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
