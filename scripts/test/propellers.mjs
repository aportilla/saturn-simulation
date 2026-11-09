#!/usr/bin/env node
// Propeller moonlets and the sub-km optical-depth texture: the 2-D tau modulation of sv_ringStructure
// (src/rings/ringTexture.ts + shaders/ringTexture.glsl, src/rings/propellers.ts + shaders/ringPropellers.glsl;
// docs/ring-physics.md sections 10-11). CPU mirrors in the page (window.__sv.pipeline.ctx.structure), GLSL through the
// ring-layer readback.
//
// usage: node scripts/test/propellers.mjs [--base URL] [--out DIR] [--only positions,texture,prefilter,structure,presence,bodies]
//                                         [--w 1280 --h 720]
//
// 1. positions  named giants (Tiscareno et al. 2010 Table 1, epoch 2007-01-01 12:00 UTC = 220,924,865.184 s TDB):
//               the app's longitudes at 2009-06-01 and 2026-11-08 = an independent propagation of Table 1 (lambda0 + n
//               dt (+ Bleriot's 0.11 deg / 3.68 yr sinusoid)) within 1e-9 rad; the model radius (where the flow model's
//               angular velocity equals the fitted n) within 50 m of the fitted a. Longitude convention: SEF azimuth =
//               Cassini ring longitude (from the ascending node of the ring plane on the J2000 equator), checked with the
//               B-ring edge's forced m = 2 mode locked to Mimas (Spitale & Porco 2010: varpi0 = 7.2 deg at JED 2454256.9,
//               the minimum lags Mimas by 2.9 deg): Mimas' SEF longitude at that epoch within 5 deg of 7.2 + 2.9 deg (mod
//               180 deg; measured 13.46 deg: Mimas' equation of centre is 2e = 2.2 deg -- a frame error would be tens of
//               degrees).
// 2. texture    CPU statistics of F (all octaves resolved), averaged over the generation cycle: variance / the former
//               radial noise's within 0.85 .. 1.15; radial correlation length (ACF = 0.5) / the former's within
//               0.7 .. 1.4; azimuthal / radial correlation length >= 5 (expected ~9.5: C_BIRTH); trailing streaks
//               (correlation ridge dy/dx < 0, pitch 2 .. 20 deg); decorrelation after one coherence time T (lag-T
//               correlation at a co-moving point < 0.35, lag T/20 > 0.8).
// 3. prefilter  footprint prefilter of the texture (rlApplyTauMod: second-order cumulants of the sub-footprint factor,
//               floor at 3 sigma): for B-ring and A-ring amplitudes and optical depths, path factors m = 1, 0.3, 0.09
//               and footprints 2 km (all octaves unresolved) and 300 m (partly resolved), the mean over random footprint
//               centres of the prefiltered transmission vs the ensemble <exp(-M tau / m)> of the resolved field
//               (120,000 independent points): within 2 % where T > 1e-3, 6 % where 1e-4 < T <= 1e-3; mean preserved
//               (E[m] = 1 within 0.5 %, ensemble <M> = 1 within 0.5 %); variance split (var of m + E[v]) / var M
//               within 5 %.
// 4. structure  the GPU sheet's tau (debug view 7/9: r, tau, theta) looking straight down at a belt propeller (dr ~
//               1 km) and at Bleriot, texture off: median tau_GPU / (tau0(a') J M_CPU) within 0.97 .. 1.03, 95 % of
//               pixels within +-8 %; the gaps present (min ratio to the unperturbed profile <= 0.65). The belt view
//               again with the texture on: median within 0.97 .. 1.03, 90 % of pixels within +-8 %, rms of the
//               modulation GPU / CPU within 0.9 .. 1.1.
// 5. presence   near-field particles 400 m above a belt propeller's outer partial gap (looking down): drawn particles
//               >= 1 px of the busiest class, grouped by the CPU modulation M at each particle (gap M < 0.75, flank
//               0.75 .. 0.95, undisturbed / enhanced >= 0.95), vs the counts.mjs expectation (Monte Carlo of
//               n_k(a) tau0 M over the box, layer height about the local mid-plane z0 -- the propeller's relief, CPU
//               mirror on a 40 x 40 grid --, radii, frustum, >= 1 px): within 1 +- max(0.08, 4/sqrt(n)).
//               Cost gate: the present particles (count, position checksum) with the CPU class mask uRpNearMask are
//               identical to those with the propeller enumeration forced for every class (presence view, a-ring-30m).
// 6. bodies     the propeller presets draw their moonlet (moonlet pass stats), the body's projected centre pixel holds
//               an opaque distance within [d - 1.4 R, d + 0.1 R]; no NaN / negative pixels, no console / GL errors,
//               all passes ok (presets, structure views).
import { join } from 'node:path';
import { fmt, openApp, problems, renderTargetScan, sleep, table, withHarness } from './lib.mjs';

const DAY = 86400, DEG = Math.PI / 180;
const T_EP = (2_454_102.0 - 2_451_545.0) * DAY + 65.184;
// Tiscareno et al. 2010 Table 1 (independent copy): longitude (deg), n (deg/day), a (km)
const TABLE1 = [
  ['Earhart', 57.85, 624.529897, 133797.8401], ['Post', 58.09, 624.4867, 133803.99], ['Sikorsky', 70.37, 623.917736, 133885.0475],
  ['Curtiss', 210.04, 623.7473, 133909.36], ['Lindbergh', 112.08, 623.3176, 133970.69], ['Wright', 251.85, 622.5527, 134080.03],
  ['Kingsford Smith', 202.44, 620.761649, 134336.935], ['Hinkler', 58.85, 619.80519, 134474.639], ['Santos-Dumont', 324.11, 619.458729, 134524.6067],
  ['Richthofen', 122.9, 617.7011, 134778.83], ['Blériot', 193.65, 616.7819329, 134912.24521],
];
const wrap = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
const COMMON = { hud: 0, labels: 0, paused: 1, astronaut: 0 };

await withHarness('propellers', { usage: 'node scripts/test/propellers.mjs [--base URL] [--out DIR] [--only positions,texture,prefilter,structure,presence,bodies]' }, async ({ args, out, rep, base, browser }) => {
  const only = args.list('only', ['positions', 'texture', 'prefilter', 'structure', 'presence', 'bodies']);
  const want = (k) => only.includes(k);

  // ------------------------------------------------------------------ 1. positions + longitude convention
  if (want('positions')) {
    const { page, errs } = await openApp(browser, base, { ...COMMON, preset: 'overview', t: '2009-06-01T00:00:00Z' }, { settle: 500 });
    try {
      const rows = [];
      for (const iso of ['2009-06-01T00:00:00Z', '2026-11-08T12:00:00Z']) {
        const res = await page.evaluate(async (iso) => {
          const sv = window.__sv;
          sv.setTime(iso);
          await new Promise((r) => setTimeout(r, 300));
          const P = sv.pipeline.ctx.structure.propellers;
          return { t: sv.frame.t, g: P.giants.map((g) => ({ name: g.name, theta: g.theta, a: g.a, aFit: g.aFit })) };
        }, iso);
        let worst = 0, worstA = 0;
        for (const [name, lon, n, aKm] of TABLE1) {
          const g = res.g.find((x) => x.name === name);
          let lam = lon * DEG + n * DEG * ((res.t - T_EP) / DAY);
          if (name === 'Blériot') lam += 0.11 * DEG * Math.sin((2 * Math.PI * (res.t - T_EP)) / (3.68 * 365.25 * DAY) + 2.0);
          const d = Math.abs(wrap(g.theta - lam));
          worst = Math.max(worst, d);
          worstA = Math.max(worstA, Math.abs(g.a - aKm * 1e3));
          rows.push([iso.slice(0, 10), name, fmt(g.theta / DEG, 4), fmt(wrap(lam) / DEG, 4), fmt((g.a - aKm * 1e3), 1)]);
        }
        rep.range(`positions ${iso.slice(0, 10)}: max |longitude - Table 1 propagation|`, worst, 0, 1e-9, ' rad');
        rep.range(`positions ${iso.slice(0, 10)}: max |model radius - fitted a|`, worstA, 0, 50, ' m');
      }
      console.log(`\n${table(['date', 'propeller', 'app lon deg', 'Table 1 deg', 'a - a_fit m'], rows)}`);
      // longitude convention: the B-ring edge's forced m = 2 mode (Spitale & Porco 2010) is locked to Mimas
      const mimas = await page.evaluate(async () => {
        const sv = window.__sv;
        const t = (2_454_256.9 - 2_451_545.0) * 86400;
        sv.clock.t = t;
        await new Promise((r) => setTimeout(r, 300));
        const m = sv.frame.moons.find((x) => x.name.toLowerCase() === 'mimas');
        return Math.atan2(m.pos.y, m.pos.x) * 180 / Math.PI;
      });
      // the forced mode's minimum lags Mimas by 2.9 deg: Mimas at 7.2 + 2.9 = 10.1 deg (mod 180, m = 2), +- its equation
      // of centre (2e = 2.25 deg) -- a frame error (ecliptic, Saturn's equinox, ...) would be tens of degrees
      const dm = Math.min(...[0, 180, 360, -180, -360].map((k) => Math.abs(((mimas - 10.1 - k) % 360 + 540) % 360 - 180)));
      console.log(`  Mimas SEF longitude at JED 2454256.9: ${fmt(mimas, 3)} deg (forced m = 2 minimum 7.2 deg + 2.9 deg lag)`);
      rep.range('longitude convention: Mimas SEF longitude at the S&P 2010 epoch - (7.2 + 2.9 deg), mod 180', dm, 0, 5, ' deg');
      rep.data.positions = { rows, mimasLonDeg: mimas };
      const pr = await problems(page, errs);
      rep.check('positions: clean', pr.length === 0, pr.slice(0, 3).join(' | ') || 'none');
    } finally {
      await page.close();
    }
  }

  // ------------------------------------------------------------------ 2. texture statistics (CPU mirror)
  if (want('texture')) {
    const { page } = await openApp(browser, base, { ...COMMON, preset: 'a-ring-1km', t: '2026-11-08T12:00:00Z', nearField: 0 }, { settle: 500 });
    try {
      const res = await page.evaluate(async () => {
        const sv = window.__sv, st = sv.pipeline.ctx.structure, T = st.texture;
        const mod = await import('/src/rings/ringTexture.ts');
        const t0 = sv.frame.t, r0 = st.r0, phi0 = st.phi0, Tc = mod.RT_T_COHERENCE;
        const F = (aL, dth) => (T.evalAt(aL, dth, 0, 1)[0] - 1);   // A = 1 -> F itself
        // the former radial noise (rlFineNoise): 6 octaves of smoothstep value noise on the 250 m profile grid
        const pcg = (v) => { const s = (Math.imul(v | 0, 747796405) + 2891336453) >>> 0; const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) | 0, 277803737) >>> 0; return ((w >>> 22) ^ w) >>> 0; };
        const hU = (v) => pcg(v) / 4294967296;
        const oldF = (r) => {
          const x = r / 250, ci = Math.floor(x), cf = x - ci;
          let s = 0, norm = 0;
          for (let j = -1; j <= 4; j++) {
            const lam = 250 * 2 ** -j, amp = Math.sqrt(lam / 250);
            norm += amp;
            let idx, loc;
            if (j < 0) { idx = ci >>> 1; loc = ((ci & 1) + cf) * 0.5; } else { const sub = cf * 2 ** j, fl = Math.floor(sub); idx = (ci << j) + fl; loc = sub - fl; }
            const salt = Math.imul(j + 2, 0x9e3779b9);
            const h0 = hU((idx ^ salt) >>> 0) * 2 - 1, h1 = hU(((idx + 1) ^ salt) >>> 0) * 2 - 1;
            const u = loc * loc * (3 - 2 * loc);
            s += amp * (h0 + (h1 - h0) * u);
          }
          return s / norm;
        };
        const acf = (f, n, dx) => {
          const v = Float64Array.from({ length: n }, (_, i) => f(i * dx));
          let m = 0; for (const x of v) m += x; m /= n;
          let var0 = 0; for (const x of v) var0 += (x - m) ** 2; var0 /= n;
          const lagHalf = (() => { for (let L = 1; L < 400; L++) { let c = 0; for (let i = 0; i + L < n; i++) c += (v[i] - m) * (v[i + L] - m); c /= (n - L) * var0; if (c < 0.5) return L * dx; } return Infinity; })();
          return { var: var0, half: lagHalf };
        };
        // radial / azimuthal statistics averaged over the generation cycle (6 phases of one coherence time)
        let vNew = 0, hR = 0, hA = 0, ridge = [];
        const nPh = 6;
        for (let k = 0; k < nPh; k++) {
          T.update(t0 + (k * Tc) / nPh, r0, phi0);
          const rad = acf((x) => F(-100e3 + x, 0.001 * k), 60000, 2);
          const azi = acf((y) => F(500 + 37 * k, y / r0), 20000, 20);
          vNew += rad.var / nPh; hR += rad.half / nPh; hA += azi.half / nPh;
          // correlation ridge: at radial lag dx = 50 m, the azimuthal lag of maximum correlation
          const dx = 50; let best = -1, bestY = 0;
          for (let dy = -2000; dy <= 2000; dy += 10) {
            let c = 0, n = 0;
            for (let i = 0; i < 400; i++) { const x = -50e3 + i * 113, y = i * 997; c += F(x, y / r0) * F(x + dx, (y + dy) / r0); n++; }
            if (c / n > best) { best = c / n; bestY = dy; }
          }
          ridge.push(bestY);
        }
        const old = acf((x) => oldF(129e6 + x), 60000, 2);
        // decorrelation at a co-moving point (the Lagrangian azimuth advances with the flow)
        const corrLag = (lag) => {
          let sab = 0, saa = 0, sbb = 0;
          for (let i = 0; i < 3000; i++) {
            const aL = -20e3 + i * 13.7, th = i * 0.00137;
            T.update(t0, r0, phi0); const a = F(aL, th);
            const dW = T.deltaOmega(aL);
            const om0 = mod.omegaModel(r0);
            T.update(t0 + lag, r0, phi0 + om0 * lag);
            const b = F(aL, th + dW * lag - 0 * om0);
            sab += a * b; saa += a * a; sbb += b * b;
          }
          return sab / Math.sqrt(saa * sbb);
        };
        const cT = corrLag(Tc), cShort = corrLag(Tc / 20);
        T.update(t0, r0, phi0);
        return { vNew, vOld: old.var, hR, hOld: old.half, hA, ridge, cT, cShort, Tc };
      });
      const ridgeMean = res.ridge.reduce((s, x) => s + x, 0) / res.ridge.length;
      const pitch = Math.atan2(50, Math.abs(ridgeMean)) / DEG;
      console.log(`  texture: var F ${fmt(res.vNew, 4)} (former ${fmt(res.vOld, 4)}), radial ACF-0.5 lag ${fmt(res.hR, 1)} m (former ${fmt(res.hOld, 1)} m), azimuthal ${fmt(res.hA, 0)} m, ridge dy at dx = 50 m: ${res.ridge.map((x) => x.toFixed(0)).join(' ')} m (pitch ${fmt(pitch, 1)} deg), lag-T corr ${fmt(res.cT, 3)}, lag-T/20 ${fmt(res.cShort, 3)} (T = ${fmt(res.Tc / 3600, 2)} h)`);
      rep.range('texture: variance of F / the former radial noise', res.vNew / res.vOld, 0.85, 1.15);
      rep.range('texture: radial correlation length / the former', res.hR / res.hOld, 0.7, 1.4);
      rep.range('texture: azimuthal / radial correlation length', res.hA / res.hR, 5, 30);
      rep.range('texture: trailing (correlation ridge dy at dx = +50 m, mean)', ridgeMean, -3000, -1);
      rep.range('texture: pitch angle of the streaks', pitch, 2, 20, ' deg');
      rep.range('texture: correlation after one coherence time (co-moving)', res.cT, -1, 0.35);
      rep.range('texture: correlation after T/20 (co-moving)', res.cShort, 0.8, 1);
      rep.data.texture = { ...res, ridgeMean, pitch };
    } finally {
      await page.close();
    }
  }

  // ------------------------------------------------------------------ 3. prefilter (CPU: cumulant model vs the ensemble)
  if (want('prefilter')) {
    const { page } = await openApp(browser, base, { ...COMMON, preset: 'b-ring-inside', t: '2026-11-08T12:00:00Z', nearField: 0 }, { settle: 500 });
    try {
      const res = await page.evaluate(() => {
        const st = window.__sv.pipeline.ctx.structure, T = st.texture;
        // rlApplyTauMod (rlOptics.glsl): second-order cumulants, continued with the slope of the floor
        // F = max(m - 3 sqrt(v), 0) beyond the tilt point
        const prefT = (m, v, tau, mu) => {
          const F = Math.max(m - 3 * Math.sqrt(v), 0), e = m - F;
          const tauEff = v <= 1e-7 * m * m ? m * tau : tau * v < e * mu ? tau * (m - (0.5 * v * tau) / mu) : F * tau + (0.5 * mu * e * e) / v;
          return Math.exp(-tauEff / mu);
        };
        // independent random points over the whole A/B ring band: the ensemble (marginal) statistics of the resolved
        // field, and random footprint centres for the prefiltered (m, v) -- E_x[T_pref(m(x), v(x))] must equal the
        // ensemble <exp(-M tau/mu)>, E_x[m(x)] = <M> = 1, E_x[m] variance + v = var M
        const N = 120000, NF = 30000;
        const px = Float64Array.from({ length: N }, () => (2 * Math.random() - 1) * 60e3);
        const pt = Float64Array.from({ length: N }, () => 2 * Math.PI * Math.random());
        const out = [];
        for (const [label, A, tau] of [['B ring', 0.62, 3.0], ['B ring', 0.62, 1.2], ['A ring', 0.32, 0.65]]) {
          const Ms = new Float64Array(N);
          let mMean = 0, mVar = 0;
          for (let i = 0; i < N; i++) { Ms[i] = T.evalAt(px[i], pt[i], 0, A)[0]; mMean += Ms[i]; }
          mMean /= N;
          for (let i = 0; i < N; i++) mVar += (Ms[i] - mMean) ** 2;
          mVar /= N;
          for (const fp of [2000, 300]) {
            const fm = new Float64Array(NF), fv = new Float64Array(NF);
            let fmMean = 0, fmVar = 0, fvMean = 0;
            for (let i = 0; i < NF; i++) { const [m, v] = T.evalAt(px[i], pt[i], fp, A); fm[i] = m; fv[i] = v; fmMean += m; fvMean += v; }
            fmMean /= NF; fvMean /= NF;
            for (let i = 0; i < NF; i++) fmVar += (fm[i] - fmMean) ** 2;
            fmVar /= NF;
            for (const mu of [1, 0.3, 0.09]) {
              let tMc = 0; for (let i = 0; i < N; i++) tMc += Math.exp((-Ms[i] * tau) / mu); tMc /= N;
              let tG = 0; for (let i = 0; i < NF; i++) tG += prefT(fm[i], fv[i], tau, mu); tG /= NF;
              out.push({ label, A, tau, fp, mu, tMc, tPref: tG, tMean: Math.exp((-mMean * tau) / mu), mMean, mVar, fmMean, fmVar, fvMean });
            }
          }
        }
        return out;
      });
      const rows = [];
      for (const r of res) {
        rows.push([r.label, fmt(r.tau, 2), fmt(r.fp, 0), fmt(r.mu, 2), fmt(r.tMc, 5), fmt(r.tPref, 5), fmt(r.tMean, 5), fmt(r.mVar, 5), `${fmt(r.fmVar, 5)} + ${fmt(r.fvMean, 5)}`]);
        const name = `prefilter ${r.label} tau ${r.tau} fp ${r.fp} m path ${r.mu}: E[T(prefilter)] / <exp(-M tau/m)>`;
        if (r.tMc > 1e-3) rep.range(name, r.tPref / r.tMc, 0.98, 1.02);
        else if (r.tMc > 1e-4) rep.range(name, r.tPref / r.tMc, 0.94, 1.06);
      }
      for (const r of res.filter((x) => x.mu === 1 && x.tau !== 1.2)) {
        rep.range(`prefilter ${r.label} fp ${r.fp} m: mean of the prefiltered factor E[m] (mean preserved)`, r.fmMean, 0.995, 1.005);
        rep.range(`prefilter ${r.label} fp ${r.fp} m: (var of m + unresolved v) / var M`, (r.fmVar + r.fvMean) / r.mVar, 0.95, 1.05);
      }
      rep.range('prefilter: ensemble mean factor <M> of the resolved field (A = 0.62)', res[0].mMean, 0.995, 1.005);
      console.log(`\n${table(['region', 'tau', 'fp m', 'path m', '<exp(-M tau/m)> MC', 'E[prefilter]', 'exp(-<M> tau/m)', 'var M', 'var m + E[v]'], rows)}`);
      rep.data.prefilter = res;
    } finally {
      await page.close();
    }
  }

  // ------------------------------------------------------------------ 4. structure: GPU tau vs the CPU model
  let beltTarget = null;
  if (want('structure') || want('presence')) {
    const { page } = await openApp(browser, base, { ...COMMON, preset: 'overview', t: '2026-11-08T12:00:00Z' }, { settle: 300 });
    beltTarget = await page.evaluate(() => {
      const sv = window.__sv, P = sv.pipeline.ctx.structure.propellers;
      const th0 = Math.atan2(sv.frame.sunDir.y, sv.frame.sunDir.x) + 35 * Math.PI / 180;
      const m = P.findLargest(129_350e3, th0, 850e3, 2000e3, 3);
      const g = P.giant('Bleriot');
      return { belt: { a: m.a, theta: m.theta, h: m.h, dD: m.dD, dB: m.dB, key: m.key }, bleriot: { a: g.a, theta: g.theta, h: g.h, dD: g.dD, dB: g.dB } };
    });
    await page.close();
  }
  if (want('structure')) {
    const rows = [];
    for (const [id, tg, hKm, tex] of [['belt', beltTarget.belt, 12, false], ['bleriot', beltTarget.bleriot, 60, false], ['belt-texture', beltTarget.belt, 12, true]]) {
      const params = { ...COMMON, t: '2026-11-08T12:00:00Z', nearField: 0, wakes: 0, scale: 1, fps: 0, cam: 'ring', r: tg.a.toFixed(1), phi: (tg.theta / DEG).toFixed(7), z: (-hKm * 1e3).toFixed(0), yaw: 90, pitch: 89.5, fov: 50 };
      const { page, errs } = await openApp(browser, base, params, { settle: 2500 });
      try {
        const scan = await renderTargetScan(page);
        const res = await page.evaluate(async (tex) => {
          const sv = window.__sv, st = sv.pipeline.ctx.structure, prof = sv.pipeline.ctx.profile;
          const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
          st.texture.amp = tex ? 1 : 0;
          const rt = sv.pipeline.ctx.hdrRT, w = rt.width, h = rt.height;
          const read = async (dbg) => { sv.frame.settings.debugView = dbg; await frames(4); const b = new Float32Array(w * h * 4); sv.renderer.readRenderTargetPixels(rt, 0, 0, w, h, b); return b; };
          const b7 = await read(7), b9 = await read(9);
          sv.frame.settings.debugView = 0;
          // footprint ~ the pixel size on the ring (straight down)
          let r0 = Infinity, r1 = -Infinity;
          for (let i = 0; i < w * h; i++) { const r = b7[i * 4] * 1e6; if (r > 1e8) { r0 = Math.min(r0, r); r1 = Math.max(r1, r); } }
          const fp = (r1 - r0) / h;
          const ratios = [], dips = [], mods = [];
          const sp = { da: 0, J: 1, drda: 1, tauMod: 1, tauVar: 0, wakeMod: 1, zeta: 0, slopeR: 0, slopeT: 0 };
          for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
            const k = (y * w + x) * 4, r = b7[k] * 1e6, tau = b7[k + 2], th = b9[k + 2];
            if (!(r > 1e8) || !Number.isFinite(tau)) continue;
            st.streamAtSEF(r, th, fp, false, sp);
            const t0 = prof.tauAtKm((r + sp.da) / 1e3) * sp.J;
            if (t0 < 0.1) continue;
            const exp = t0 * sp.tauMod;
            ratios.push(tau / exp);
            dips.push(tau / t0);
            mods.push(sp.tauMod);
          }
          st.texture.amp = 1;
          ratios.sort((a, b) => a - b);
          const q = (p) => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))];
          const within = ratios.filter((x) => Math.abs(x - 1) <= 0.08).length / ratios.length;
          const rms = (v) => Math.sqrt(v.reduce((s, x) => s + (x - 1) ** 2, 0) / v.length);
          return { n: ratios.length, med: q(0.5), p05: q(0.05), p95: q(0.95), within, minDip: Math.min(...dips), fp, rmsCpu: rms(mods), rmsGpu: rms(dips) };
        }, tex);
        await page.screenshot({ path: join(out, `structure-${id}.png`) });
        const pr = await problems(page, errs);
        rep.check(`structure ${id}: clean (errors, GL, passes)`, pr.length === 0, pr.slice(0, 3).join(' | ') || 'none');
        const bad = scan.sceneRT.nan + scan.sceneRT.neg + scan.hdrRT.nan + scan.hdrRT.neg;
        rep.check(`structure ${id}: no NaN / negative pixels`, bad === 0, `scene ${scan.sceneRT.nan}/${scan.sceneRT.neg}, hdr ${scan.hdrRT.nan}/${scan.hdrRT.neg}`);
        rep.range(`structure ${id}: median tau_GPU / (tau0 J M_CPU)`, res.med, 0.97, 1.03);
        rep.range(`structure ${id}: share of pixels within +-8 %`, res.within, tex ? 0.9 : 0.95, 1);
        if (!tex) rep.range(`structure ${id}: deepest gap tau / tau0 (gaps present)`, res.minDip, 0, 0.65);
        else rep.range(`structure ${id}: rms modulation GPU / CPU (texture present, same amplitude)`, res.rmsGpu / res.rmsCpu, 0.9, 1.1);
        rows.push([id, res.n, fmt(res.fp, 1), fmt(res.p05, 3), fmt(res.med, 3), fmt(res.p95, 3), fmt(res.within, 3), fmt(res.minDip, 3), `${fmt(res.rmsGpu, 4)} / ${fmt(res.rmsCpu, 4)}`]);
        rep.data[`structure-${id}`] = res;
      } finally {
        await page.close();
      }
    }
    console.log(`\n${table(['view', 'pixels', 'footprint m', 'ratio p05', 'median', 'p95', 'within 8 %', 'min tau/tau0', 'rms M GPU / CPU'], rows)}`);
  }

  // ------------------------------------------------------------------ 5. near-field presence follows M
  if (want('presence')) {
    const tg = beltTarget.belt;
    // over the outer edge of the outer partial gap (x = +3 h; the gap at 2 h, the enhanced lobe at 4.5 h; downstream
    // d = dD: s = -dD), 400 m above the lit face, looking down: the view holds the gap and the undisturbed ring
    const s = -tg.dD, x = 3 * tg.h;
    const th = tg.theta + s / tg.a;
    const params = { ...COMMON, t: '2026-11-08T12:00:00Z', scale: 1, fps: 0, cam: 'ring', r: (tg.a + x).toFixed(1), phi: (th / DEG).toFixed(7), z: -400, yaw: 0, pitch: 89, fov: 60 };
    const { page, errs } = await openApp(browser, base, params, { settle: 3000 });
    try {
      const res = await page.evaluate(async () => {
        const sv = window.__sv, st = sv.pipeline.ctx.structure, lod = sv.pipeline.ctx.lod, prof = sv.pipeline.ctx.profile;
        const near = sv.pipeline.passes.near?.inner;
        if (!near || !near.classes || !near.r0RT) return { error: 'near-field internals not found' };
        near.cullEnabled = false;
        await new Promise((r) => setTimeout(r, 1200));
        const f = sv.frame, eR = f.ring.eR, eP = f.ring.ePhi, cam = f.ring.camLocal, pa = f.canvasPixelAngle;
        const W2C = f.worldToCam.elements, tanH = Math.tan(f.fovY / 2), asp = f.aspect;
        const inFrustum = (x, y, z, rb) => {
          const vx = W2C[0] * x + W2C[3] * y + W2C[6] * z, vy = W2C[1] * x + W2C[4] * y + W2C[7] * z, vz = W2C[2] * x + W2C[5] * y + W2C[8] * z;
          const w = -vz, tx = tanH * asp, ty = tanH;
          return !(w < -rb || Math.abs(vx) > w * tx + rb * Math.sqrt(1 + tx * tx) || Math.abs(vy) > w * ty + rb * Math.sqrt(1 + ty * ty));
        };
        const Mof = (lx, ly) => st.tauModAt(cam.x + lx, Math.atan2(cam.y + ly, f.ring.r0 + cam.x + lx), 0)[0];
        const tauMacro = (rm) => { const l = prof.local(rm); return l.tau * (1 - l.dust); };
        // groups of the local modulation M: partial gap, its flank, undisturbed (incl. the enhanced lobe)
        const grp = (M) => (M < 0.75 ? 0 : M < 0.95 ? 1 : 2);
        // the class with the most drawn particles >= 1 px
        const out = [];
        for (const c of near.classes) {
          if (!(c.slots > 0)) continue;
          const buf = new Float32Array(2048 * c.rows * 4);
          sv.renderer.readRenderTargetPixels(near.r0RT, 0, c.row0, 2048, c.rows, buf);
          const n = [0, 0, 0];
          for (let i = 0; i < c.slots; i++) {
            const w = buf[i * 4 + 3];
            if (!(w > 0)) continue;
            const px = buf[i * 4], py = buf[i * 4 + 1], pz = buf[i * 4 + 2];
            if (w / (Math.hypot(px, py, pz) * pa) < 0.5) continue;
            const lx = px * eR.x + py * eR.y + pz * eR.z, ly = px * eP.x + py * eP.y + pz * eP.z;
            n[grp(Mof(lx, ly))]++;
          }
          out.push({ c, n });
        }
        out.sort((a, b) => b.n[0] + b.n[1] + b.n[2] - (a.n[0] + a.n[1] + a.n[2]));
        const best = out[0], k = best.c.k;
        // expected (counts.mjs): Monte Carlo of n_k(a) tau0 M over the box, layer height about the local mid-plane z0
        // (the propeller's relief lifts the stirred material toward the Sun's side: CPU z0 on a grid), radii,
        // frustum, >= 1 px
        const D = lod.box[k], lo = lod.aLo[k], hi = lod.aHi[k], q = lod.q, sig = lod.sigZ(k), p1 = 1 - q;
        const NG = 40, zg = new Float64Array((NG + 1) * (NG + 1));
        for (let j = 0; j <= NG; j++) {
          for (let i = 0; i <= NG; i++) {
            const gx = -D + (2 * D * i) / NG, gy = -D + (2 * D * j) / NG;
            zg[j * (NG + 1) + i] = st.streamAt(cam.x + gx, Math.atan2(cam.y + gy, f.ring.r0 + cam.x + gx), 0, true).zeta;
          }
        }
        const z0At = (lx, ly) => {
          const u = ((lx + D) / (2 * D)) * NG, v = ((ly + D) / (2 * D)) * NG;
          const i = Math.min(NG - 1, Math.max(0, Math.floor(u))), j = Math.min(NG - 1, Math.max(0, Math.floor(v)));
          const fu = u - i, fv = v - j, g = j * (NG + 1) + i;
          return (zg[g] * (1 - fu) + zg[g + 1] * fu) * (1 - fv) + (zg[g + NG + 1] * (1 - fu) + zg[g + NG + 2] * fu) * fv;
        };
        const e = [0, 0, 0], mSum = [0, 0, 0], mN = [0, 0, 0];
        const nMc = 4000000;
        for (let n = 0; n < nMc; n++) {
          const lx = (2 * Math.random() - 1) * D, ly = (2 * Math.random() - 1) * D;
          const zz = sig * Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
          const a = Math.abs(p1) < 1e-9 ? lo * Math.pow(hi / lo, Math.random()) : Math.pow(lo ** p1 + (hi ** p1 - lo ** p1) * Math.random(), 1 / p1);
          const x = lx * eR.x + ly * eP.x, y = lx * eR.y + ly * eP.y, z = zz + z0At(lx, ly) - cam.z;
          const s = Math.hypot(lx, ly, z);
          if (a / (s * pa) < 0.5 || !inFrustum(x, y, z, 1.2 * a)) continue;
          const M = Mof(lx, ly), g = grp(M);
          e[g] += tauMacro(f.ring.r0 + cam.x + lx) * M;
          mSum[g] += M; mN[g]++;
        }
        const scale = (lod.nPerTau[k] * (2 * D) ** 2) / nMc;
        near.cullEnabled = true;
        return { k, D, n: best.n, e: e.map((x) => x * scale), mMean: mSum.map((x, i) => x / Math.max(mN[i], 1)) };
      });
      if (res.error) rep.check('presence: setup', false, res.error);
      else {
        const names = ['partial gap (M < 0.75)', 'gap flank (0.75 <= M < 0.95)', 'undisturbed / enhanced (M >= 0.95)'];
        const ratios = res.n.map((n, i) => n / Math.max(res.e[i], 1e-9));
        console.log(`  presence: class ${res.k} (box ${fmt(res.D, 0)} m): drawn >= 1 px / expected (n_k tau0 M) -- ${names.map((nm, i) => `${nm}: ${res.n[i]} / ${fmt(res.e[i], 0)} (mean M ${fmt(res.mMean[i], 3)})`).join(', ')}`);
        if (res.e[0] < 30) rep.check('presence: enough particles expected in the partial gap', false, fmt(res.e[0], 0));
        for (let i = 0; i < 3; i++) {
          if (res.e[i] < 30) continue;
          const tol = Math.max(0.08, 4 / Math.sqrt(res.e[i]));
          rep.range(`presence: drawn / expected, ${names[i]}`, ratios[i], 1 - tol, 1 + tol);
        }
        rep.data.presence = { ...res, ratios };
      }
      await page.screenshot({ path: join(out, 'presence.png') });
      const pr = await problems(page, errs);
      rep.check('presence: clean', pr.length === 0, pr.slice(0, 3).join(' | ') || 'none');
      await gateCheck(page, 'presence view', false);
    } finally {
      await page.close();
    }
    // the cost gate in a belt (a-ring-30m: every class within some propeller's reach) and 9.5 km outside Bleriot's orbit
    // (r_H 611 m, reach 8.2 km: the small classes' boxes miss it, the large ones' reach it -- a mixed mask)
    const bl = beltTarget.bleriot;
    for (const [label, params, mixed] of [
      ['a-ring-30m', { ...COMMON, preset: 'a-ring-30m', t: '2026-11-08T12:00:00Z' }, false],
      ['beside Bleriot', { ...COMMON, t: '2026-11-08T12:00:00Z', cam: 'ring', r: (bl.a + 9500).toFixed(1), phi: ((bl.theta - 20e3 / bl.a) / DEG).toFixed(7), z: -300, yaw: 0, pitch: 60, fov: 60 }, true],
    ]) {
      const g = await openApp(browser, base, params, { settle: 3000 });
      try {
        await gateCheck(g.page, label, mixed);
      } finally {
        await g.page.close();
      }
    }
  }

  // near-field cost gate (uRpNearMask, PropellerSystem.nearClassMask): skipping the propeller enumeration for the
  // classes no propeller can reach must not change a single particle (present slots and their positions identical
  // with the enumeration forced for every class)
  async function gateCheck(page, label, mixed) {
    const res = await page.evaluate(async () => {
      const sv = window.__sv, P = sv.pipeline.ctx.structure.propellers, near = sv.pipeline.passes.near?.inner;
      if (!near || !near.classes) return { error: 'near-field internals not found' };
      const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      const count = () => {
        let n = 0, sum = 0;
        for (const c of near.classes) {
          if (!(c.slots > 0)) continue;
          const b = new Float32Array(2048 * c.rows * 4);
          sv.renderer.readRenderTargetPixels(near.r0RT, 0, c.row0, 2048, c.rows, b);
          for (let i = 0; i < c.slots; i++) if (b[i * 4 + 3] !== 0) { n++; sum += b[i * 4] + 3 * b[i * 4 + 1] + 7 * b[i * 4 + 2]; }
        }
        return { n, sum };
      };
      near.cullEnabled = false;
      await frames(4);
      const mask = P.uniforms.uRpNearMask.value;
      const ks = near.classes.filter((c) => c.slots > 0).map((c) => c.k);
      const a = count();
      P.nearMaskOverride = -1;
      await frames(4);
      const b = count();
      P.nearMaskOverride = null;
      near.cullEnabled = true;
      return { mask, gated: ks.filter((k) => !(mask & (1 << k))).length, classes: ks.length, a, b };
    });
    if (res.error) { rep.check(`gate ${label}: setup`, false, res.error); return; }
    console.log(`  gate ${label}: ${res.gated} of ${res.classes} classes skip the enumeration; present slots ${res.a.n} (forced for all: ${res.b.n})`);
    rep.check(`gate ${label}: identical particles with the enumeration forced for every class`, res.a.n === res.b.n && Math.abs(res.a.sum - res.b.sum) <= 1e-6 * Math.abs(res.b.sum), `${res.a.n} vs ${res.b.n} present, ${res.gated} of ${res.classes} classes gated`);
    if (mixed) rep.check(`gate ${label}: the mask is exercised (some classes gated, some not)`, res.gated > 0 && res.gated < res.classes, `${res.gated} of ${res.classes}`);
    rep.data[`gate-${label}`] = res;
  }

  // ------------------------------------------------------------------ 6. bodies + presets
  if (want('bodies')) {
    for (const preset of ['propeller-bleriot', 'propeller-belt']) {
      const { page, errs } = await openApp(browser, base, { ...COMMON, preset, t: '2026-11-08T12:00:00Z' }, { settle: 3000 });
      try {
        const scan = await renderTargetScan(page);
        const res = await page.evaluate(() => {
          const sv = window.__sv, f = sv.frame;
          const pm = sv.pipeline.passes.bodies?.inner;
          if (!pm) return { error: 'moonlet pass not found' };
          const list = pm.moonlets;
          // the largest-looking body well inside the view: project its centre, read the opaque distance there
          const W = f.worldToCam.elements, th = Math.tan(f.fovY / 2);
          let best = null;
          for (const m of list) {
            const x = m.a * Math.cos(m.theta) - f.camPos.x, y = m.a * Math.sin(m.theta) - f.camPos.y, z = m.z - f.camPos.z;
            const d = Math.hypot(x, y, z);
            const vx = W[0] * x + W[3] * y + W[6] * z, vy = W[1] * x + W[4] * y + W[7] * z, vz = W[2] * x + W[5] * y + W[8] * z;
            if (vz >= 0) continue;
            const u = 0.5 + 0.5 * (vx / -vz) / (th * f.aspect), v = 0.5 + 0.5 * (vy / -vz) / th;
            if (u < 0.1 || u > 0.9 || v < 0.1 || v > 0.9) continue;
            if (!best || m.R / d > best.m.R / best.d) best = { m, d, u, v };
          }
          if (!best) return { error: 'no moonlet in view' };
          const { u, v } = best;
          const rt = sv.pipeline.ctx.sceneRT;
          const px = Math.floor(u * rt.width), py = Math.floor(v * rt.height);
          const b = new Float32Array(4);
          sv.renderer.readRenderTargetPixels(rt, px, py, 1, 1, b);
          const s = sv.pipeline.stats();
          return { drawn: Number(s['moonlets.drawn']), name: best.m.name, R: best.m.R, d: best.d, dist: b[3], u, v };
        });
        if (res.error) { rep.check(`${preset}: moonlet`, false, res.error); continue; }
        console.log(`  ${preset}: ${res.drawn} moonlets drawn, nearest ${res.name} R = ${fmt(res.R, 0)} m at ${fmt(res.d / 1e3, 3)} km (screen ${fmt(res.u, 3)}, ${fmt(res.v, 3)}), opaque distance there ${fmt(res.dist / 1e3, 3)} km`);
        rep.range(`${preset}: moonlets drawn`, res.drawn, 1, 1e6);
        rep.range(`${preset}: opaque distance at the body's centre pixel - distance to its centre (units of R)`, (res.dist - res.d) / res.R, -1.4, 0.1);
        await page.screenshot({ path: join(out, `${preset}.png`) });
        const pr = await problems(page, errs);
        rep.check(`${preset}: clean (errors, GL, passes)`, pr.length === 0, pr.slice(0, 3).join(' | ') || 'none');
        const bad = scan.sceneRT.nan + scan.sceneRT.neg + scan.hdrRT.nan + scan.hdrRT.neg;
        rep.check(`${preset}: no NaN / negative pixels`, bad === 0, `scene ${scan.sceneRT.nan}/${scan.sceneRT.neg}, hdr ${scan.hdrRT.nan}/${scan.hdrRT.neg}`);
        rep.data[preset] = res;
      } finally {
        await page.close();
      }
      await sleep(200);
    }
  }
});
