#!/usr/bin/env node
// The size rules of the LOD contract (docs/ring-physics.md 10.12) where they rest on numbers measured from the app's own
// wake field: the CPU mirror of the shared wake functions, the wake-density statistics behind the medium's dynamical
// optical depth tau_dyn, and the result that matters -- the medium's transmission equals the occultation tau.
//
// usage: node scripts/test/lod.mjs [--base URL] [--out DIR] [--only wakes,bins,transmission] [--n 64] [--cycle 12]
//                                  [--treal 3] [--ref]
//
// 1. wakes  WakeField.densityAt / displacementAt (the CPU mirror of sv_wakes wakeDensity / wakeDisplacement: float64,
//           behind WAKE_D_BINS and so tau_dyn; also checked against the Python port, procedural.py --verify) vs the GPU
//           (float32, bilinear weights of a few bits) on --n x --n points over 3 x 3 Toomre wavelengths around the camera,
//           at a-ring-1km (A wake set) and b-ring-inside (B set). Limits: median |ln(GPU / CPU)| <= 0.01, 99th percentile
//           <= 0.1 (the wake cores are steep: a texel-weight rounding moves a point across a core edge), mean density
//           ratio 1 +- 0.01; displacement rms difference <= 2e-3 lambda.
// 2. bins   WAKE_D_BINS (src/rings/WakeStats.ts, pasted) vs a re-measurement with the current WakeField
//           (measureDensityBins): the medium's factor x(tau, c) = tau_dyn g1 / tau_profile from both within 1 +- 0.002 at
//           tau 0.3, 0.6, 1.2 (A; c = 0.63) and 1.5, 4, 8 (B; c = 0.79), and every bin within 1 % (+ 0.002). When stale,
//           the new bins go to <out>/wake_d_bins.json (paste them into WakeStats.ts; the tests then pass again).
// 3. transmission  the medium's transmission at normal incidence (camera 6 km above the layer looking straight down
//           with a 10 deg field, near field and far pass off, sub-km texture and propellers off, debug view 2) vs
//           exp(-tau_profile / mu) (the occultation optical depth at each pixel's radius, its slant path: mu >= 0.993)
//           at 128,000 km (A) and 105,000 km (B), averaged over
//           --cycle times spread evenly over one generation cycle of the wake model (its two generations hand over
//           globally: the B ring's effective tau swings by ~+12 % for ~20 % of the cycle, -2.5 % otherwise -- the
//           normalization holds for the cycle mean), over --treal 3 independent wake patterns. Limits: the effective
//           tau -ln<T> within 2 % (A) / 5 % (B) of the profile's: |ln(<T> / <exp(-tau)>)| <= 0.02 tau (A), 0.05 tau (B);
//           at A also every frame within 0.02 tau + 0.01 of the CPU prediction from the live field (exp(-tau_dyn g
//           (1 - pbar + pbar D) / mu) at each pixel's ground point; measured <= 0.010). Measured Nov 2026: A 1.000 (frames
//           0.990-1.009 of the live prediction), B 1.15 (-3.4 % in tau; frames 0.55-1.39 of exp(-tau) through the cycle).
//           The B-ring residual has two known parts (--ref: the reference explicit field, wakeDensity per step): the
//           clipmap prefilter correction of the march (a Gamma-model estimate of the texel smoothing, rlMarch) overshoots
//           where the mean transmission is set by the emptiest gaps (T ~ exp(-a F), a ~ 10): production / reference
//           +17 % in T; and the reference itself is ~8 % below the 2-D column prediction (the packing ceiling thickens
//           the participating layer in the wakes to ~2-5 H, so the slightly oblique rays catch the wake walls). The
//           pattern / cycle sampling of 36 frames over ~2 wake tiles scatters the B mean by ~+-7 % in T.
//           Control without wakes (the homogeneous tau_iso layer, g1 tau_iso = tau_profile exactly): |ln(T / exp(-tau))|
//           <= 0.005 tau + 0.005 (measured 1.002, 1.009). Before the size rules (photometric tau as the medium's mean) the
//           wakes made the medium far too transparent: T 1.15x exp(-tau) at A, 15x at B (effective tau 1.5 instead of 4.2).
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fmt, openApp, setSimTime, sleep, table, waitFrames, withHarness } from './lib.mjs';

const T0 = '2026-11-08T12:00:00Z';
const COMMON = { paused: 1, hud: 0, labels: 0, astronaut: 0 };

await withHarness('lod', {
  usage: 'node scripts/test/lod.mjs [--base URL] [--out DIR] [--only wakes,bins,transmission] [--n 64] [--cycle 12] [--treal 3] [--ref]',
}, async ({ args, out, rep, base, browser }) => {
  const only = new Set(args.list('only', ['wakes', 'bins', 'transmission']));
  rep.data = {};

  if (only.has('wakes')) {
    const n = args.num('n', 64);
    console.log('\n[wakes] CPU mirror (WakeField.densityAt / displacementAt) vs GPU (sv_wakes)');
    const rows = [];
    for (const preset of ['a-ring-1km', 'b-ring-inside']) {
      const { page } = await openApp(browser, base, { ...COMMON, preset, t: T0 }, { settle: 2500 });
      const res = await page.evaluate(async (n) => {
        const { FullscreenPass } = await import(/* @vite-ignore */ '/src/render/fullscreen.ts');
        const { SV_HEADER_ALL } = await import(/* @vite-ignore */ '/src/render/shaders/chunks.ts');
        const sv = window.__sv;
        const p = sv.pipeline, r = sv.renderer, wf = p.ctx.wakes;
        const lam = wf.lambda;
        const step = (3 * lam) / n;
        const cam = sv.frame.ring.camLocal;
        const x0 = cam.x - 1.5 * lam, y0 = cam.y - 1.5 * lam;
        const rt = p.ctx.hdrRT.clone();
        rt.setSize(n, n);
        const V4 = p.ctx.hdrRT.viewport.constructor;
        const pass = new FullscreenPass({
          fragmentShader: `${SV_HEADER_ALL}
uniform vec4 uP;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 q = uP.xy + gl_FragCoord.xy * uP.z;
  outColor = vec4(wakeDensity(q), wakeDisplacement(q), 1.0);
}`,
          uniforms: { ...p.ctx.shared.u, uP: { value: new V4(x0, y0, step, 0) } },
        });
        pass.render(r, rt);
        const buf = new Float32Array(n * n * 4);
        r.readRenderTargetPixels(rt, 0, 0, n, n, buf);
        pass.dispose?.();
        rt.dispose();
        const lr = [];
        let sG = 0, sC = 0, sd2 = 0;
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const x = x0 + (i + 0.5) * step, y = y0 + (j + 0.5) * step;
            const k = (j * n + i) * 4;
            const dC = wf.densityAt(x, y), [ux, uy] = wf.displacementAt(x, y);
            lr.push(Math.abs(Math.log(buf[k] / dC)));
            sG += buf[k];
            sC += dC;
            sd2 += (buf[k + 1] - ux) ** 2 + (buf[k + 2] - uy) ** 2;
          }
        }
        lr.sort((a, b) => a - b);
        return { on: wf.uniforms.uWakeOn.value, strength: wf.strength, lam, med: lr[Math.floor(0.5 * lr.length)], p99: lr[Math.floor(0.99 * lr.length)],
          max: lr[lr.length - 1], meanRatio: sG / sC, meanCpu: sC / (n * n), dispRms: Math.sqrt(sd2 / (n * n)) / lam, glErr: r.getContext().getError() };
      }, n);
      await page.close();
      rows.push([preset, res.on > 0.5 ? 'on' : 'OFF', fmt(res.strength, 3), fmt(res.lam, 2), fmt(res.meanCpu, 4), fmt(res.meanRatio, 4), fmt(res.med, 4), fmt(res.p99, 4), fmt(res.max, 3), fmt(res.dispRms, 6)]);
      rep.data[`wakes-${preset}`] = res;
      rep.check(`wakes ${preset}: wakes on, GPU pass ran (no GL error)`, res.on > 0.5 && res.glErr === 0, `strength ${fmt(res.strength, 3)}, gl error ${res.glErr}`);
      rep.range(`wakes ${preset}: median |ln(GPU / CPU density)|`, res.med, 0, 0.01);
      rep.range(`wakes ${preset}: 99th percentile |ln(GPU / CPU density)|`, res.p99, 0, 0.1);
      rep.range(`wakes ${preset}: mean density GPU / CPU`, res.meanRatio, 0.99, 1.01);
      rep.range(`wakes ${preset}: displacement rms |GPU - CPU| / lambda`, res.dispRms, 0, 2e-3);
    }
    console.log(table(['place', 'wakes', 'strength', 'lambda m', 'mean D (CPU)', 'mean GPU/CPU', 'median |ln|', 'p99 |ln|', 'max |ln|', 'disp rms / lambda'], rows));
  }

  if (only.has('bins')) {
    console.log('\n[bins] WAKE_D_BINS (pasted) vs a re-measurement with the current WakeField');
    const { page } = await openApp(browser, base, { ...COMMON, preset: 'a-ring-1km', t: T0 }, { settle: 1500 });
    const res = await page.evaluate(async () => {
      const W = await import(/* @vite-ignore */ '/src/rings/WakeStats.ts');
      const out = {};
      for (const set of ['A', 'B']) {
        const t0 = performance.now();
        const fresh = W.measureDensityBins(set);
        const ms = performance.now() - t0;
        const old = W.WAKE_D_BINS[set];
        let worst = 0;
        for (let i = 0; i < fresh.length; i++) worst = Math.max(worst, Math.abs(fresh[i] - old[i]) / (0.01 * old[i] + 0.002));
        const c = set === 'A' ? 0.63 : 0.79;
        const taus = set === 'A' ? [0.3, 0.6, 1.2] : [1.5, 4, 8];
        out[set] = { ms, worst, fresh: fresh.map((v) => Math.round(v * 1000) / 1000), x: taus.map((t) => [t, W.solveDynFactor(old, t, c), W.solveDynFactor(fresh, t, c)]) };
      }
      return out;
    });
    await page.close();
    const rows = [];
    let stale = false;
    for (const set of ['A', 'B']) {
      const r = res[set];
      for (const [t, xo, xn] of r.x) {
        rows.push([set, fmt(t, 2), fmt(xo, 4), fmt(xn, 4), fmt(xn / xo, 4)]);
        const ok = Math.abs(xn / xo - 1) <= 0.002;
        stale ||= !ok;
        rep.check(`bins ${set}: tau_dyn factor x(tau ${t}) from the pasted / re-measured bins within 1 +- 0.002`, ok, `${fmt(xo, 4)} / ${fmt(xn, 4)}`);
      }
      stale ||= r.worst > 1;
      rep.check(`bins ${set}: every pasted bin within 1 % + 0.002 of the re-measurement (${r.ms.toFixed(0)} ms)`, r.worst <= 1, `worst ${fmt(r.worst, 3)} of the tolerance`);
    }
    console.log(table(['set', 'tau', 'x pasted', 'x re-measured', 'ratio'], rows));
    if (stale) {
      const f = join(out, 'wake_d_bins.json');
      writeFileSync(f, JSON.stringify({ A: res.A.fresh, B: res.B.fresh }));
      console.log(`stale: new bins in ${f} (paste into WAKE_D_BINS, src/rings/WakeStats.ts)`);
    }
    rep.data.bins = { A: res.A.x, B: res.B.x, stale };
  }

  if (only.has('transmission')) {
    const nCyc = args.num('cycle', 12);
    console.log(`\n[transmission] medium at normal incidence vs exp(-tau_profile), ${nCyc} times over one generation cycle`);
    const rows = [];
    for (const site of [{ id: 'A', r: 128000e3, wakes: 1 }, { id: 'B', r: 105000e3, wakes: 1 }, { id: 'A', r: 128000e3, wakes: 0 }, { id: 'B', r: 105000e3, wakes: 0 }]) {
      const tag = `${site.id}${site.wakes ? '' : ' wakes off'}`;
      let n = site.wakes ? nCyc : 1;
      // 6 km up with a 10 deg field: ~1 x 2 km of ring (a few wake tiles) at <1/mu> - 1 < 0.5 %, 3 m pixels (explicit field)
      const { page } = await openApp(browser, base, { ...COMMON, cam: 'ring', r: site.r, z: 6000, yaw: 0, pitch: -90, fov: 10, t: T0, nearField: 0, debug: 2, wakes: site.wakes }, { settle: 2500 });
      const setup = await page.evaluate((ref) => {
        const sv = window.__sv, st = sv.pipeline.ctx.structure;
        st.texture.amp = 0;
        st.propellers.scale = 0;
        sv.pipeline.passes.far.inner.enabled = false;
        if (ref) {
          // --ref: the march with the reference explicit field (wakeDensity per step, no clipmap prefilter: test:seam)
          const p = sv.pipeline.passes.rings.inner;
          const up = Object.getPrototypeOf(p).update;
          p.update = function (f, ctx) {
            up.call(this, f, ctx);
            this.u.uRlLodRange.value = 1e9;
            this.u.uRlForce.value.x = 1;
            this.u.uRlForce.value.y = 1;
          };
        }
        const wf = sv.pipeline.ctx.wakes;
        // one generation cycle of the wake clock (WakeField.update: phase = Omega t, cycle 0.5 T_LIFE)
        return { t: sv.clock.t, cycle: (0.5 * wf.shape.tLife) / sv.frame.ring.omega, on: wf.uniforms.uWakeOn.value, strength: wf.strength };
      }, args.flag('ref'));
      const samples = [];
      const nReal = site.wakes ? args.num('treal', 3) : 1;
      for (let rz = 0; rz < nReal; rz++) {
        // independent wake patterns (WakeField.realization, as test:seam)
        if (rz > 0) await page.evaluate((k) => { window.__sv.pipeline.ctx.wakes.realization = k; }, rz);
        for (let k = 0; k < n; k++) {
          await setSimTime(page, setup.t + ((k + 0.5) / n) * setup.cycle, 300);
          await waitFrames(page, 6);
          await sleep(700);
          samples.push(await page.evaluate(() => {
            const sv = window.__sv;
            const rt = sv.pipeline.ctx.hdrRT, w = rt.width, h = rt.height;
            const buf = new Float32Array(w * h * 4);
            sv.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
            // each pixel's ground point (its ray from the camera to the local mid-plane; local frame x = eR, y = ePhi) ->
            // the profile's (photometric) tau at that radius; and the CPU prediction from the live wake field there:
            // exp(-tau_dyn g(mu) (1 - pbar + pbar D) / mu) (D = WakeField.densityAt, the mirror of wakeDensity)
            const prof = sv.pipeline.ctx.profile, lod = sv.pipeline.ctx.lod, wf = sv.pipeline.ctx.wakes;
            const f = sv.frame, ring = f.ring, cam = ring.camLocal;
            const m = f.camToWorld.elements, tn = Math.tan(f.fovY / 2), zc = cam.z - ring.zMid;
            // (trees before the size rules: no tau_dyn / anisotropy -> no live prediction)
            const on = wf.uniforms.uWakeOn.value > 0.5 && typeof lod.anisoAt === 'function';
            let sT = 0, sE = 0, sC = 0, n = 0;
            for (let j = 2; j < h; j += 4) {
              for (let i = 2; i < w; i += 4) {
                sT += buf[(j * w + i) * 4] / 2;
                const cx = ((i + 0.5) / w * 2 - 1) * tn * f.aspect, cy = ((j + 0.5) / h * 2 - 1) * tn;
                const d = [0, 1, 2].map((c) => m[c] * cx + m[3 + c] * cy - m[6 + c]);
                const dot = (e) => d[0] * e.x + d[1] * e.y + d[2] * e.z;
                const dR = dot(ring.eR), dP = dot(ring.ePhi), dZ = dot(ring.eZ);
                const s = zc / Math.max(-dZ, 1e-6);
                const x = cam.x + s * dR, y = cam.y + s * dP;
                // the pixel's slant path: exp(-tau / mu)
                const len = Math.hypot(d[0], d[1], d[2]), mu = Math.abs(dZ) / len;
                const l = prof.local(ring.r0 + x);
                sE += Math.exp(-l.tau / mu);
                if (on) {
                  const g = 1 + lod.fAlignTot * lod.anisoAt(dR / len, dP / len, dZ / len);
                  sC += Math.exp(-l.tauDyn * g * (1 - l.pbar + l.pbar * wf.densityAt(x, y)) / mu);
                }
                n++;
              }
            }
            return { T: sT / n, E: sE / n, C: sC / n };
          }));
        }
      }
      n = samples.length;
      await page.close();
      const mean = (k) => samples.reduce((a, s) => a + s[k], 0) / n;
      const T = mean('T'), E = mean('E'), C = mean('C');
      const tauP = -Math.log(E);
      const inst = samples.map((s) => s.T / s.E), live = samples.map((s) => s.T / s.C);
      const d = Math.log(T / E);
      rows.push([tag, fmt(site.r / 1e3, 0), fmt(tauP, 3), fmt(E, 4), fmt(T, 4), fmt(T / E, 4), fmt(-d / tauP, 4), `${fmt(Math.min(...inst), 3)} .. ${fmt(Math.max(...inst), 3)}`,
        site.wakes ? `${fmt(C, 4)} / ${fmt(Math.min(...live), 3)} .. ${fmt(Math.max(...live), 3)}` : '-']);
      rep.data[`transmission-${tag}`] = { tauP, E, T, C, inst, live };
      if (site.wakes) {
        rep.check(`transmission ${tag}: wakes on at the site`, setup.on > 0.5, `strength ${fmt(setup.strength, 3)}`);
        // the effective tau -ln<T> within 2 % (A) / 5 % (B) of the profile's: see the header for the B-ring residuals
        const k = site.id === 'A' ? 0.02 : 0.05;
        rep.check(`transmission ${tag}: |ln(<T> / <exp(-tau_profile)>)| over the cycle <= ${k} tau`, Math.abs(d) <= k * tauP, `${fmt(d, 4)} (limit ${fmt(k * tauP, 3)}; T ${fmt(T, 4)} vs ${fmt(E, 4)})`);
        // frame by frame: the rendered medium vs the CPU prediction from the same live field (no sampling noise of the
        // pattern or the cycle: what the renderer does with the field it has) -- A only (B: informational, see header)
        if (site.id === 'A' && C > 0) {
          const dl = Math.max(...live.map((v) => Math.abs(Math.log(v))));
          const limL = 0.02 * tauP + 0.01;
          rep.check(`transmission ${tag}: every frame |ln(T / CPU prediction from the live field)| <= 0.02 tau + 0.01`, dl <= limL, `worst ${fmt(dl, 4)} (limit ${fmt(limL, 3)})`);
        }
      } else {
        // control: without wakes the medium is the homogeneous tau_iso layer, g1 tau_iso = tau_profile exactly
        const lim = 0.005 * tauP + 0.005;
        rep.check(`transmission ${tag}: |ln(T / exp(-tau_profile))| <= 0.005 tau + 0.005 (homogeneous layer)`, Math.abs(d) <= lim, `${fmt(d, 4)} (limit ${fmt(lim, 4)})`);
      }
    }
    console.log(table(['site', 'r km', 'tau profile', '<exp(-tau)>', '<T> medium', 'ratio', 'tau error', 'instantaneous ratio', 'CPU live field / T:CPU per frame'], rows));
  }
});
