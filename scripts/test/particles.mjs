#!/usr/bin/env node
// Resolved-particle photometry and shape contract: the CPU mirrors (src/render/near/NearRegolith.ts,
// NearRelief.ts) run in the page through the Vite dev server, the GLSL (lighting.glsl, nearCommon.glsl) on the GPU in
// a separate WebGL2 context of the same page.
//
// usage: node scripts/test/particles.mjs [--base URL] [--out DIR] [--only regolith,relief,anisotropy]
//                                        [--bodies 160] [--dirs 12]
//
// 1. regolith  GPU vs CPU on a 64x64 grid: ringRegolithIF (rel. err <= 1e-3 where I/F > 1e-3), extendedSourceCosine
//              (abs. err <= 2e-4), nearRegolithFactor = the LUT lookup (rel. err <= 3e-3: GPU filtering weights are
//              8-bit). The contract between the LUT nodes (CPU): f(alpha, A) x 4 Phi_w(alpha) / ringParticlePhase(alpha)
//              - 1 at alpha off the nodes and albedos between the rows, with the interpolated w the shader uses:
//              |err| <= 0.3% for alpha < 120 deg (~99% of the scattered light), <= 1.5% for 120-160 deg (beyond, P <
//              0.1% of its peak: reported only). Prints f x A_s for an A-ring particle and the LUT build time.
// 2. relief    GPU nearRelief (4 layers) vs the CPU mirror at 16 bodies x 256 directions (abs. err <= 3e-3 radii);
//              orientation-averaged projected area of the displaced bodies with the GLSL kappa(amp, wc) relative to
//              their ellipsoids: |ratio - 1| <= 0.01 for amp 0.25..1, wc 0..1 (shot noise of the ensemble printed);
//              prints the measured G (kappa = 1) and the least-squares K0..K3 to paste into nearCommon.glsl (NR_K*)
//              when the relief changes; the base ellipsoids' mean projected area / pi a^2 (Knud Thomsen) informational.
// 3. anisotropy (informational) mean cross-section / pi a^2 vs view elevation of the principal-axis rotators
//              (near-vertical spin axes for large particles): the direction dependence the LOD contract ignores.
import { fmt, openApp, table, withHarness } from './lib.mjs';

await withHarness('particles', { usage: 'node scripts/test/particles.mjs [--base URL] [--out DIR] [--only regolith,relief,anisotropy] [--bodies N] [--dirs N]' }, async ({ args, out, rep, base, browser }) => {
  const only = new Set(args.list('only', ['regolith', 'relief', 'photometry', 'anisotropy']));
  const { page } = await openApp(browser, base, { preset: 'overview', hud: 0, labels: 0, paused: 1, astronaut: 0, nearField: 0 }, { settle: 500 });
  try {
    // ------------------------------------------------------------------ GPU programs (shared setup)
    const gpu = await page.evaluate(async () => {
      const raw = async (u) => (await import(/* @vite-ignore */ u)).default;
      const [common, saturn, lighting, nearCommon] = await Promise.all([
        raw('/src/render/shaders/common.glsl?raw'), raw('/src/render/shaders/saturn.glsl?raw'),
        raw('/src/render/shaders/lighting.glsl?raw'), raw('/src/render/near/nearCommon.glsl?raw'),
      ]);
      const reg = await import(/* @vite-ignore */ '/src/render/near/NearRegolith.ts');
      const rel = await import(/* @vite-ignore */ '/src/render/near/NearRelief.ts');
      const noise = await import(/* @vite-ignore */ '/src/render/near/NearNoise.ts');
      const t0 = performance.now();
      const tab = reg.regolithTable();
      const lutMs = tab.ms ?? performance.now() - t0;
      const cv = document.createElement('canvas');
      cv.width = 64; cv.height = 64;
      const gl = cv.getContext('webgl2');
      if (!gl) return { error: 'no WebGL2' };
      if (!gl.getExtension('EXT_color_buffer_float')) return { error: 'no EXT_color_buffer_float' };
      gl.getExtension('OES_texture_float_linear');
      const fsSrc = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D; precision highp sampler3D;
${common}
${saturn}
${lighting}
${nearCommon}
uniform vec4 uSo[16];
uniform int uMode;
out vec4 o;
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  float i = float(ij.x), j = float(ij.y);
  if (uMode == 0) {
    float mu0 = (i + 0.5) / 64.0, mu = (j + 0.5) / 64.0;
    float t = fract((i * 7.0 + j * 13.0) / 64.0 + 0.01), w = 0.3 + 0.69 * fract((i * 3.0 + j * 5.0) / 17.0);
    float si = sqrt(1.0 - mu0 * mu0), se = sqrt(1.0 - mu * mu);
    float cg = mu0 * mu + si * se * (2.0 * t - 1.0);
    o = vec4(ringRegolithIF(mu0, mu, cg, w), extendedSourceCosine(2.0 * mu0 - 1.0, 0.2 + 0.6 * mu), nearRegolithFactor(2.0 * mu - 1.0, mu0));
  } else {
    int k = ij.y * 64 + ij.x, bI = k / 256, d = k - bI * 256;
    float z = 1.0 - (float(d) + 0.5) / 128.0, ph = float(d) * 2.39996323, r = sqrt(max(0.0, 1.0 - z * z));
    o = nearRelief(vec3(r * cos(ph), r * sin(ph), z), uSo[bI], 4);
  }
}`;
      const vsSrc = '#version 300 es\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const prog = gl.createProgram();
      try {
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, vsSrc));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fsSrc));
      } catch (e) { return { error: `compile: ${e.message}` }; }
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: `link: ${gl.getProgramInfoLog(prog)}` };
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      // textures: regolith LUT (unit 0), noise (1), clasts (2)
      const tex2 = (unit, w, h, data) => {
        const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      };
      const tex3 = (unit, n, data) => {
        const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_3D, t);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, n, n, n, 0, gl.RGBA, gl.FLOAT, data);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.REPEAT);
      };
      tex2(0, reg.REGOLITH_LUT_NA, reg.REGOLITH_LUT_NALB, tab.lut.image.data);
      tex3(1, noise.NOISE_N, noise.nearNoiseData());
      tex3(2, noise.CLAST_N, noise.nearClastData());
      gl.uniform1i(gl.getUniformLocation(prog, 'tRegolithF'), 0);
      gl.uniform1i(gl.getUniformLocation(prog, 'tNearNoise'), 1);
      gl.uniform1i(gl.getUniformLocation(prog, 'tNearClast'), 2);
      gl.uniform4f(gl.getUniformLocation(prog, 'uRegolithLut'), reg.REGOLITH_LUT_NA, reg.REGOLITH_LUT_NALB, reg.REGOLITH_A0, reg.REGOLITH_A1);
      // bodies for the relief comparison
      let seed = 7;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const so = new Float32Array(64);
      for (let b = 0; b < 16; b++) { so[b * 4] = rnd() * 16; so[b * 4 + 1] = rnd() * 16; so[b * 4 + 2] = rnd() * 16; so[b * 4 + 3] = b / 15; }
      gl.uniform4fv(gl.getUniformLocation(prog, 'uSo'), so);
      const fbt = gl.createTexture();
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, fbt);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 64, 64);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbt, 0);
      gl.viewport(0, 0, 64, 64);
      const run = (mode) => {
        gl.uniform1i(gl.getUniformLocation(prog, 'uMode'), mode);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const px = new Float32Array(64 * 64 * 4);
        gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.FLOAT, px);
        return px;
      };
      const out = { lutMs };
      // --- regolith law, extended source, LUT lookup
      {
        const px = run(0);
        let eIF = 0, eES = 0, eF = 0, eW = 0, nIF = 0;
        for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
          const q = (j * 64 + i) * 4;
          const mu0 = (i + 0.5) / 64, mu = (j + 0.5) / 64;
          const t = ((i * 7 + j * 13) / 64 + 0.01) % 1, w = 0.3 + 0.69 * (((i * 3 + j * 5) / 17) % 1);
          const si = Math.sqrt(1 - mu0 * mu0), se = Math.sqrt(1 - mu * mu);
          const cg = mu0 * mu + si * se * (2 * t - 1);
          const c = reg.regolithIF(mu0, mu, cg, w);
          if (c > 1e-3) { eIF = Math.max(eIF, Math.abs(px[q] / c - 1)); nIF++; }
          eES = Math.max(eES, Math.abs(px[q + 1] - reg.extendedSourceCosine(2 * mu0 - 1, 0.2 + 0.6 * mu)));
          const L = reg.regolithFactorLookup(Math.acos(2 * mu - 1), mu0);
          eF = Math.max(eF, Math.abs(px[q + 2] / L.f - 1));
          eW = Math.max(eW, Math.abs(px[q + 3] - L.w));
        }
        Object.assign(out, { eIF, nIF, eES, eF, eW });
      }
      // --- relief
      {
        const px = run(1);
        let eH = 0, eG = 0;
        const K = rel.reliefConstants();
        for (let k = 0; k < 4096; k++) {
          const b = Math.floor(k / 256), d = k % 256;
          const z = 1 - (d + 0.5) / 128, ph = d * 2.39996323, r = Math.sqrt(Math.max(0, 1 - z * z));
          const body = { ax: [1, 1, 1], so: [so[b * 4], so[b * 4 + 1], so[b * 4 + 2]] };
          const h = rel.reliefH(rel.reliefLayers(body, r * Math.cos(ph), r * Math.sin(ph), z, K), so[b * 4 + 3], K);
          eH = Math.max(eH, Math.abs(px[k * 4] - h));
          eG = Math.max(eG, Math.abs(px[k * 4]));
        }
        Object.assign(out, { eH, hMaxAbs: eG });
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return out;
    });
    if (gpu.error) throw new Error(`GPU setup: ${gpu.error}`);
    rep.data.gpu = gpu;

    if (only.has('regolith')) {
      console.log(`\n[regolith] LUT built in ${fmt(gpu.lutMs, 0)} ms`);
      rep.check('GLSL ringRegolithIF = CPU regolithIF (rel. err <= 1e-3)', gpu.eIF <= 1e-3, `max ${fmt(gpu.eIF, 6)} over ${gpu.nIF} samples`);
      rep.check('GLSL extendedSourceCosine = CPU mirror (abs. err <= 2e-4)', gpu.eES <= 2e-4, `max ${fmt(gpu.eES, 6)}`);
      rep.check('GLSL nearRegolithFactor = CPU LUT lookup (rel. err <= 3e-3, w abs. <= 3e-3)', gpu.eF <= 3e-3 && gpu.eW <= 3e-3, `f ${fmt(gpu.eF, 6)}, w ${fmt(gpu.eW, 6)}`);
      const c = await page.evaluate(async () => {
        const reg = await import(/* @vite-ignore */ '/src/render/near/NearRegolith.ts');
        const tab = reg.regolithTable();
        const rows = [];
        // max |error| per phase-angle band: [0, 120) deg (P > 1.3% of its peak; ~99% of the scattered light),
        // [120, 160], (160, 175]
        const band = [0, 0, 0], at = ['', '', ''];
        const NR = reg.REGOLITH_LUT_NALB;
        // albedos between the rows (0.37 of the way to the next row)
        const albs = [0.13, 0.2, 0.25, 0.4, 0.52, 0.6, 0.75, 0.9].map((A) => {
          const j = Math.min(NR - 2, Math.floor(reg.albedoRow(A)));
          return reg.rowAlbedo(j) + 0.37 * (reg.rowAlbedo(j + 1) - reg.rowAlbedo(j));
        });
        for (const A of albs) {
          const rowMax = [0, 0, 0];
          for (let deg = 0.35; deg <= 175; deg += 0.77) {
            const al = (deg * Math.PI) / 180;
            const L = reg.regolithFactorLookup(al, A);
            const P = reg.powerLawPhase(al) * reg.particleSurge(al);
            const e = Math.abs((L.f * 4 * reg.sphereDiskPhi(al, L.w)) / P - 1);
            const b = deg < 120 ? 0 : deg <= 160 ? 1 : 2;
            rowMax[b] = Math.max(rowMax[b], e);
            if (e > band[b]) { band[b] = e; at[b] = `A ${A.toFixed(3)} alpha ${deg.toFixed(1)}`; }
          }
          const j = Math.min(NR - 1, Math.round(reg.albedoRow(A)));
          rows.push([A.toFixed(3), tab.w[j].toFixed(4), tab.As[j].toFixed(4), ...rowMax.map((x) => (x * 100).toFixed(3))]);
        }
        // the factor itself (without the surge) x A_s for an A-ring particle: 1 = the regolith sphere has the power law
        const j52 = Math.round(reg.albedoRow(0.52));
        const fRow = [0, 10, 30, 60, 90, 120, 150].map((deg) => { const al = (deg * Math.PI) / 180; return (reg.regolithFactorLookup(al, 0.52).f / reg.particleSurge(al)) * tab.As[j52]; });
        return { rows, band, at, fRow, ms: tab.ms };
      });
      console.log(table(['albedo A (between rows)', 'w (nearest row)', 'A_s(w)', 'max err % < 120 deg', '120-160 deg', '160-175 deg'], c.rows));
      console.log(`f(alpha) x A_s for A = 0.52 at 0/10/30/60/90/120/150 deg (1 = the regolith sphere already has the power law): ${c.fRow.map((x) => fmt(x, 3)).join(' / ')}`);
      rep.check('LUT contract between the nodes: |f 4 Phi_w / P - 1| <= 0.3% for alpha < 120 deg', c.band[0] <= 0.003, `max ${fmt(c.band[0] * 100, 4)}% at ${c.at[0]}`);
      rep.check('LUT contract between the nodes: <= 1.5% for 120-160 deg (P < 1.3% of its peak)', c.band[1] <= 0.015, `max ${fmt(c.band[1] * 100, 4)}% at ${c.at[1]}; 160-175 deg: ${fmt(c.band[2] * 100, 3)}% (informational, P < 0.1% of its peak)`);
      rep.data.regolith = c;
    }

    if (only.has('relief')) {
      console.log('\n[relief]');
      rep.check('GLSL nearRelief = CPU mirror (abs. err <= 3e-3 radii)', gpu.eH <= 3e-3, `max ${fmt(gpu.eH, 6)} (|h| up to ${fmt(gpu.hMaxAbs, 3)})`);
      const bodies = args.num('bodies', 160), dirs = args.num('dirs', 12);
      // three body ensembles with the clast weights their sizes get (nearReliefParams: smoothstep(NR_WC0, NR_WC1, a) x
      // 0.55..1) and their shapes (nearShape: rounder when spin-aligned)
      const sets = [{ a: 0.05, wcs: [0] }, { a: 0.4, wcs: [0.25, 0.5] }, { a: 1.5, wcs: [0.5, 0.75, 1] }];
      const a = await page.evaluate(async (bodies, dirs, sets) => {
        const rel = await import(/* @vite-ignore */ '/src/render/near/NearRelief.ts');
        const res = sets.map((s, i) => ({ a: s.a, ...rel.measureReliefArea({ bodies, dirs, wcs: s.wcs, a: s.a, seed: 99 + i }) }));
        const pts = [];
        for (const r of res) r.amps.forEach((amp, i) => r.wcs.forEach((wc, j) => pts.push({ a: r.a, amp, wc, G: r.G[i][j], Gk: r.Gk[i][j] })));
        return { res, pts, fit: rel.fitKappa(pts), K: rel.reliefConstants(), bounds: [rel.reliefBounds(0), rel.reliefBounds(1)] };
      }, bodies, dirs, sets);
      let worst = 0;
      const rows = a.pts.map((p) => { worst = Math.max(worst, Math.abs(p.Gk - 1)); return [fmt(p.a, 2), fmt(p.amp, 2), fmt(p.wc, 2), fmt(p.G, 4), fmt(p.Gk, 4)]; });
      console.log(table(['radius (m)', 'amp', 'clast weight wc', '<A>/<A_ellipsoid> (kappa = 1)', 'with the GLSL kappa'], rows));
      console.log(`fit kappa^-2 = 1 + amp (K0 + K1 wc) + amp^2 (K2 + K3 wc): K0 ${a.fit.K0.toFixed(4)}  K1 ${a.fit.K1.toFixed(4)}  K2 ${a.fit.K2.toFixed(4)}  K3 ${a.fit.K3.toFixed(4)}` +
        `  (GLSL NR_K0..3: ${a.K.NR_K0} ${a.K.NR_K1} ${a.K.NR_K2} ${a.K.NR_K3})`);
      console.log(`h bounds: wc 0 [${a.bounds[0].map((x) => x.toFixed(3)).join(', ')}], wc 1 [${a.bounds[1].map((x) => x.toFixed(3)).join(', ')}];` +
        ` base ellipsoids: mean projected area / pi a^2 = ${a.res.map((r) => `${fmt(r.ellipsoid, 4)} (a ${r.a} m)`).join(', ')};` +
        ` ensemble shot noise (sem of a ratio) ${a.res.map((r) => fmt(r.sem * 100, 3)).join('/')}%; ${bodies} bodies x ${dirs} directions per set in ${fmt(a.res.reduce((s, r) => s + r.ms, 0) / 1000, 1)} s`);
      rep.check('relief: orientation-averaged projected area with kappa = ellipsoid area (|ratio - 1| <= 0.01)', worst <= 0.01, `max |ratio - 1| ${fmt(worst, 4)}`);
      rep.data.relief = a;
    }

    if (only.has('photometry')) {
      const ph = await page.evaluate(async () => {
        const rel = await import(/* @vite-ignore */ '/src/render/near/NearRelief.ts');
        const m = rel.measureReliefPhotTable();
        return { ...m, stored: rel.RELIEF_PHOT, alphas: rel.RELIEF_PHOT_ALPHAS, wcs: rel.RELIEF_PHOT_WCS };
      });
      console.log(`\n[photometry] relief correction (1 / disk-integrated brightness relative to the smooth ellipsoids), measured in ${fmt(ph.ms / 1000, 1)} s`);
      const rows = [];
      let worst = 0, at = '';
      for (const path of ['bump', 'march']) {
        ph.wcs.forEach((wc, j) => {
          rows.push([`${path === 'bump' ? 'analytic + relief normals' : 'ray-marched + self-shadow'}, wc ${wc}`, ...ph[path][j].map((x) => fmt(x, 3))]);
          ph.alphas.forEach((deg, i) => {
            if (deg > 120) return;
            const e = Math.abs(ph.stored[path][j][i] / ph[path][j][i] - 1);
            if (e > worst) { worst = e; at = `${path} wc ${wc} alpha ${deg}`; }
          });
        });
      }
      console.log(table(['measured', ...ph.alphas.map((d) => `${d} deg`)], rows));
      const paste = (t) => t.map((r) => `    [${r.map((x) => x.toFixed(3)).join(', ')}],`).join('\n');
      console.log(`RELIEF_PHOT for NearRelief.ts when the relief changes:\n  bump: [\n${paste(ph.bump)}\n  ],\n  march: [\n${paste(ph.march)}\n  ],`);
      rep.check('relief photometry: stored RELIEF_PHOT = measured (within 2% for alpha <= 120 deg)', worst <= 0.02, `max ${fmt(worst * 100, 3)}%${at ? ` at ${at}` : ''}`);
      rep.data.photometry = ph;
    }

    if (only.has('anisotropy')) {
      const an = await page.evaluate(async () => {
        const rel = await import(/* @vite-ignore */ '/src/render/near/NearRelief.ts');
        const els = [0, 10, 30, 60, 90];
        return [0.05, 0.3, 0.6, 1, 5].map((a) => [a, ...els.map((e) => rel.crossSectionVsElevation(a, e))]);
      });
      console.log('\n[anisotropy] mean cross-section / pi a^2 of the principal-axis rotators vs view elevation (informational)');
      console.log(table(['radius (m)', '0 deg', '10 deg', '30 deg', '60 deg', '90 deg (from above)'], an.map((r) => [fmt(r[0], 2), ...r.slice(1).map((x) => fmt(x, 3))])));
      rep.data.anisotropy = an;
    }
  } finally {
    await page.close();
  }
});
