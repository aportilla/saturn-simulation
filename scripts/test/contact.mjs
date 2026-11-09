#!/usr/bin/env node
// Contact resolution of the resolved near-field particles (src/render/near/NearContact.ts): the overlaps of the
// analytic positions are removed among the particles that are visibly resolved, without changing which particles
// are drawn, and smoothly in time.
//
// usage: node scripts/test/contact.mjs [--base URL] [--out DIR] [--views b-inside,a-inside,a-30m,b-preset] [--w 1280 --h 720]
//                                      [--no-temporal] [--cost [--cost-views b-default,a-default,b-inside,a-inside]
//                                      [--reps 3] [--trials 12]]
//
// Per view (paused, t fixed, render scale 1, astronaut off) the contact list (analytic positions, R0 slots, weights,
// contact shapes), the result and R0 are read back and checked against an independent CPU evaluation in the page:
// 1. overlaps: every pair of list particles closer than its contact distance (sum of the two base shapes' radial
//    extents along the centre line, as the shader), found by a CPU multi-level grid search, at the analytic and at the
//    resolved positions. "Resolved pairs" = both fully in the contact set (weight 1: >= 6 render px radius, not
//    occluded). Visible overlap = the smaller particle sticks out of the larger one (hidden ones - the smaller entirely
//    inside - are left alone by design and counted separately); residual = a visible overlap deeper than max(2% of the
//    contact distance, 1 render px) after resolution. Crowded = a particle with >= 3 initial resolved overlaps (dense
//    clusters, wake cores: where the analytic packing is too dense to resolve locally). Limits per view (VIEWS): the
//    residual / visible overlaps before, and the uncrowded residual / resolved particles.
// 2. displacement bound: |x - x_analytic| <= clampK x D_i (the shader's bound, read back) for every particle, and
//    D_i(GPU) >= D_i(CPU, the first iteration's pair corrections) for >= 99.8 % of the particles with overlaps (the GPU's
//    neighbour search missed nothing that matters). Hash-grid bucket overflow (CPU simulation of the GPU hash) <= 0.1 %.
// 3. write-back: R0 at every list entry's slot = its resolved position, the drawn flag kept or set where the
//    displacement moved a present particle into the view (counted); drawn-particle counts (R0 w > 0 and the HUD's
//    >= 1 px list) with contact on vs off differ only by those particles (<= 0.1 %); present particles unchanged;
//    bodies around the camera (not drawn) have contact weight 0 (b-preset: the camera inside a 1.8 m boulder).
// 4. temporal (unless --no-temporal; not for b-preset): the same frame again -> bit-identical; one frame later at 1x time (t + 1/30 s) the
//    displacement field x - x_analytic must not jump: "pops" = particles whose displacement changes by more than
//    max(5 x their analytic motion, 1 render px) <= the view's limit; t + 1 s and t + 10 s reported (p99 / max change in
//    px); warp +-1000x (running): no NaN, residual within 1.5x the paused limit.
// 5. cost (--cost, informational): the contact step's own GPU time - the captured frame's step re-run between
//    synchronous 1-pixel read-backs, min over trials (robust when other agents share the GPU), with the list
//    compaction / materialization / first grid + search split (cumulative stages, each measured on its own: noisy
//    under contention) - and the whole frame (pipeline.render of the paused frame) with the step off / on,
//    interleaved within each trial, at the default views (render scale 0.5, fov 60: b-default, a-default) and the
//    close-ups; plus uncapped fps with contact on / off alternating in one page (noisiest).
// Measured values: scripts/test/README.md ("contact").
import { pathToFileURL } from 'node:url';
import { fmt, openApp, sleep, table, waitFrames, withHarness } from './lib.mjs';

// limits: resid = residual / visible overlaps before; free = uncrowded residual / resolved particles; pops = frame-to-frame
// pops / matched particles (measured 2026-11-08: see scripts/test/README.md)
const VIEWS = {
  'b-inside': { preset: 'b-ring-inside', fov: 35, scale: 1, what: 'B ring mid-layer (cassini-compare b-inside)', resid: 0.2, free: 0.012, pops: 2e-4 },
  'a-inside': { preset: 'a-ring-inside', fov: 35, scale: 1, what: 'A ring mid-plane, wakes (cassini-compare a-inside)', resid: 0.12, free: 0.012, pops: 1e-4 },
  'a-30m': { preset: 'a-ring-30m', scale: 1, what: '30 m above the lit A ring (wake crests from above)', resid: 0.12, free: 0.012, pops: 1e-4 },
  // the preset itself (fov 60: other particle boxes than at fov 35): the camera lies inside a 1.8 m boulder there
  'b-preset': { preset: 'b-ring-inside', scale: 1, what: 'B ring preset, fov 60 (the camera inside a boulder)', resid: 0.2, free: 0.012, pops: 2e-4, temporal: false },
  // vertical relief: inside the layer, on the local mid-plane (cam=ring heights are relative to it) of the Mimas 5:3
  // bending wave (A ring, slopes up to ~9 deg) and of the Titan -1:0 wave (C ring, up to 45 deg; scripts/test/relief.mjs).
  // mimas53 lies in a dense zone (tau 0.92, a_max 5 m: 15 % of the resolved particles crowded, vs 6 % in a-inside), so
  // its residual (jammed clusters) is higher: 0.22; flat (relief=0) the same within 0.01 - the relief is not the cause
  'mimas53': { params: { cam: 'ring', r: 131850000, phi: 31, z: 0, yaw: 0, pitch: -10 }, fov: 35, scale: 1, what: 'Mimas 5:3 bending wave, inside the layer on the tilted mid-plane', resid: 0.3, free: 0.012, pops: 1e-4 },
  'titan': { params: { cam: 'ring', r: 77545500, phi: 31, z: 0, yaw: 0, pitch: -10 }, fov: 35, scale: 1, what: 'Titan -1:0 bending wave (C ring), inside the layer on the tilted mid-plane', resid: 0.12, free: 0.012, pops: 1e-4 },
};
const BASE = { t: '2026-11-08T12:00:00Z', hud: 0, labels: 0, paused: 1, astronaut: 0 };
/** URL parameters of a view: its preset (or explicit camera parameters), fov, render scale */
const viewParams = (v) => ({ ...(v.params ?? { preset: v.preset }), fov: v.fov, scale: v.scale });

// ------------------------------------------------------------------------------------------------ in page
/** Read the last contact run (list, result, bound) and evaluate it on the CPU. Runs inside the page. */
export function analyzeInPage() {
  const sv = window.__sv;
  const near = sv.pipeline.passes.near?.inner ?? sv.pipeline.passes.near;
  const C = near?.contact;
  if (!C || !C.listTarget || !C.outRT) return { error: 'near.contact internals (listTarget / outRT) not found — update contact.mjs' };
  if (!C.ran) return { error: 'the contact step did not run this frame' };
  const r = sv.renderer, gl = r.getContext(), W = 2048;
  const n = C.drawn, rows = Math.ceil(n / W), N = W * rows;
  // RGBA / FLOAT reads of any float attachment (through three.js's framebuffer cache)
  const readAtt = (rt, att) => {
    const buf = new Float32Array(N * 4);
    r.state.bindFramebuffer(gl.FRAMEBUFFER, r.properties.get(rt).__webglFramebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + att);
    gl.readPixels(0, 0, W, rows, gl.RGBA, gl.FLOAT, buf);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const cur = r.getRenderTarget();
    r.state.bindFramebuffer(gl.FRAMEBUFFER, cur ? r.properties.get(cur).__webglFramebuffer : null);
    return buf;
  };
  // list: [0] (analytic position, R0 slot), [1] (signed a, weight, M'00, M'11), [2] (M'22, M'01, M'02, M'12);
  // result: (position, displacement bound D_i)
  const Q0 = readAtt(C.listTarget, 0), M = readAtt(C.listTarget, 1), S = readAtt(C.listTarget, 2), Q1 = readAtt(C.outRT, 0);
  const P0 = new Float32Array(N * 4), P1 = new Float32Array(N * 4), slot = new Float64Array(N), DB = new Float32Array(N * 4);
  for (let j = 0; j < N; j++) {
    for (let c = 0; c < 3; c++) { P0[j * 4 + c] = Q0[j * 4 + c]; P1[j * 4 + c] = Q1[j * 4 + c]; }
    P0[j * 4 + 3] = P1[j * 4 + 3] = M[j * 4];
    slot[j] = Q0[j * 4 + 3];
    DB[j * 4] = Q1[j * 4 + 3];
  }
  const f = sv.frame, pa = f.pixelAngle, lod = sv.pipeline.ctx.lod;
  // largest base-shape semi-axis / a: the value the step used (NearContact SHAPE_EXT_HIGH at high quality)
  const ext = C.ext ?? (f.settings.particleQuality === 'high' ? 1.37 : 1);
  const lvl = (a) => Math.min(13, Math.max(0, Math.floor(Math.log2(a * 1000))));
  const aHi = (L) => Math.max(lod.aHi[L], 1e-3 * 2 ** (L + 1));
  const ids = [];
  let nan = 0;
  for (let j = 0; j < n; j++) {
    if (P0[j * 4 + 3] === 0) continue;
    ids.push(j);
    for (let c = 0; c < 3; c++) if (!Number.isFinite(P1[j * 4 + c])) nan++;
  }
  const quad = (j, nx, ny, nz) => M[j * 4 + 2] * nx * nx + M[j * 4 + 3] * ny * ny + S[j * 4] * nz * nz +
    2 * (S[j * 4 + 1] * nx * ny + S[j * 4 + 2] * nx * nz + S[j * 4 + 3] * ny * nz);
  // all overlapping pairs of list particles at positions X (multi-level grid, each unordered pair once)
  const pairsAt = (X) => {
    const grids = new Map();
    const key = (x, y, z) => (x + 32768) * 4294967296 + (y + 32768) * 65536 + (z + 32768);
    for (const j of ids) {
      const a = Math.abs(X[j * 4 + 3]), L = lvl(a), c = 2 * ext * aHi(L);
      if (!grids.has(L)) grids.set(L, new Map());
      const g = grids.get(L), k = key(Math.floor(X[j * 4] / c), Math.floor(X[j * 4 + 1] / c), Math.floor(X[j * 4 + 2] / c));
      const l = g.get(k);
      if (l) l.push(j); else g.set(k, [j]);
    }
    const out = { i: [], j: [], delta: [], D: [], rmin: [], e: [], s: [], si: [], sj: [] };
    for (const i of ids) {
      const ai = Math.abs(X[i * 4 + 3]), Li = lvl(ai), xi = X[i * 4], yi = X[i * 4 + 1], zi = X[i * 4 + 2];
      for (const [L, g] of grids) {
        if (L < Li) continue;
        const c = 2 * ext * aHi(L), rr = ext * (ai + aHi(L));
        for (let cz = Math.floor((zi - rr) / c); cz <= Math.floor((zi + rr) / c); cz++)
          for (let cy = Math.floor((yi - rr) / c); cy <= Math.floor((yi + rr) / c); cy++)
            for (let cx = Math.floor((xi - rr) / c); cx <= Math.floor((xi + rr) / c); cx++) {
              const l = g.get(key(cx, cy, cz));
              if (!l) continue;
              for (const j of l) {
                if (j === i || (L === Li && j < i)) continue;
                const aj = Math.abs(X[j * 4 + 3]);
                const dx = xi - X[j * 4], dy = yi - X[j * 4 + 1], dz = zi - X[j * 4 + 2];
                const d = Math.hypot(dx, dy, dz);
                if (d >= ext * (ai + aj)) continue;
                const nx = d > 0 ? dx / d : 0, ny = d > 0 ? dy / d : 0, nz = d > 0 ? dz / d : 1;
                const ri = ai / Math.sqrt(quad(i, nx, ny, nz)), rj = aj / Math.sqrt(quad(j, nx, ny, nz)), D = ri + rj;
                if (D - d <= 0) continue;
                const e = Math.min(M[i * 4 + 1], M[j * 4 + 1]);
                const same = L === Li, m3 = ai ** 3 + aj ** 3;
                out.i.push(i); out.j.push(j); out.delta.push(D - d); out.D.push(D); out.rmin.push(Math.min(ri, rj)); out.e.push(e);
                out.s.push(Math.hypot(xi - 0.5 * dx, yi - 0.5 * dy, zi - 0.5 * dz));
                out.si.push(same ? aj ** 3 / m3 : 1); out.sj.push(same ? ai ** 3 / m3 : 0);
              }
            }
      }
    }
    return out;
  };
  const before = pairsAt(P0), after = pairsAt(P1);
  // per-particle: initial resolved overlaps (crowding) and the CPU's displacement bound D_i (the shader's first-iteration
  // pair correction: weight x share x delta, faded out where the smaller particle lies entirely inside the larger one)
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const n0 = new Map(), dCpu = new Map();
  for (let p = 0; p < before.i.length; p++) {
    const e = before.e[p], i = before.i[p], j = before.j[p];
    if (e >= 0.999) { n0.set(i, (n0.get(i) ?? 0) + 1); n0.set(j, (n0.get(j) ?? 0) + 1); }
    const ee = e * (1 - smooth(2, 2.5, before.delta[p] / before.rmin[p]));
    if (ee > 0) {
      dCpu.set(i, Math.max(dCpu.get(i) ?? 0, ee * before.si[p] * before.delta[p]));
      dCpu.set(j, Math.max(dCpu.get(j) ?? 0, ee * before.sj[p] * before.delta[p]));
    }
  }
  const crowded = (i) => (n0.get(i) ?? 0) >= 3;
  const tolOf = (P, p) => Math.max(0.02 * P.D[p], 1 * P.s[p] * pa);
  // visible overlap: the smaller particle sticks out of the larger one (delta < its diameter along the centre line);
  // hidden: it lies entirely inside (invisible, deliberately left alone)
  const summarize = (P) => {
    let ov = 0, hidden = 0, resid = 0, residCrowd = 0, maxRel = 0, maxRelFree = 0, maxPx = 0, sumDelta = 0;
    for (let p = 0; p < P.i.length; p++) {
      if (P.e[p] < 0.999) continue;
      ov++;
      if (P.delta[p] >= 2 * P.rmin[p]) { hidden++; continue; }
      const rel = P.delta[p] / P.D[p], px = P.delta[p] / (P.s[p] * pa);
      sumDelta += P.delta[p];
      if (P.delta[p] > tolOf(P, p)) {
        resid++;
        const cr = crowded(P.i[p]) || crowded(P.j[p]);
        if (cr) residCrowd++;
        else maxRelFree = Math.max(maxRelFree, rel);
      }
      maxRel = Math.max(maxRel, rel);
      maxPx = Math.max(maxPx, px);
    }
    return { overlapping: ov, hidden, beyondTol: resid, beyondTolCrowded: residCrowd, maxRel, maxRelUncrowded: maxRelFree, maxPx, sumDelta };
  };
  let resolved = 0, crowdedN = 0;
  for (const j of ids) { if (M[j * 4 + 1] >= 0.999) resolved++; if (crowded(j)) crowdedN++; }
  // bodies around the camera (not drawn: the camera is a ghost) must take no part in contacts
  let camInside = 0, camInsideW = 0;
  for (const j of ids) {
    const x = P0[j * 4], y = P0[j * 4 + 1], z = P0[j * 4 + 2], d = Math.hypot(x, y, z), a = Math.abs(P0[j * 4 + 3]);
    if (d > 0 && (d * Math.sqrt(quad(j, x / d, y / d, z / d))) / a >= 1) continue;
    camInside++;
    if (M[j * 4 + 1] > 0) camInsideW++;
  }
  // displacement vs bound (positions are float32: allow 4 ulps of the coordinates), GPU search completeness
  const clampK = C.clampK;
  let moved = 0, maxDispA = 0, maxDispBound = 0, missed = 0, withD = 0;
  for (const j of ids) {
    const d = Math.hypot(P1[j * 4] - P0[j * 4], P1[j * 4 + 1] - P0[j * 4 + 1], P1[j * 4 + 2] - P0[j * 4 + 2]);
    const a = Math.abs(P0[j * 4 + 3]), Dg = DB[j * 4], Dc = dCpu.get(j) ?? 0;
    const ulp = 4 * 1.2e-7 * Math.max(Math.abs(P0[j * 4]), Math.abs(P0[j * 4 + 1]), Math.abs(P0[j * 4 + 2]), 1e-3);
    if (d > 0) moved++;
    maxDispA = Math.max(maxDispA, d / a);
    if (d > ulp) maxDispBound = Math.max(maxDispBound, (d - ulp) / Math.max(clampK * Dg, 1e-12));
    if (Dc > 1e-6 * a) { withD++; if (Dg < 0.98 * Dc - 1e-6 * a) missed++; }
  }
  // CPU simulation of the GPU hash grid for the first iteration (analytic positions): entries beyond CT_K per bucket
  const pcg = (v) => {
    const st = (Math.imul(v, 747796405) + 2891336453) >>> 0;
    const w = Math.imul(((st >>> ((st >>> 28) + 4)) ^ st) >>> 0, 277803737) >>> 0;
    return ((w >>> 22) ^ w) >>> 0;
  };
  const K = C.slotsPerBucket, mask = (C.bucketsUsed || C.buckets) - 1, fill = new Map(), invCell = C.invCellU.value;
  let overflow = 0, maxFill = 0;
  for (const j of ids) {
    const a = Math.abs(P0[j * 4 + 3]), L = Math.min(13, Math.max(0, Math.floor(Math.log2(Math.fround(a * 1000))))), ic = invCell[L];
    const cx = Math.floor(Math.fround(P0[j * 4] * ic)), cy = Math.floor(Math.fround(P0[j * 4 + 1] * ic)), cz = Math.floor(Math.fround(P0[j * 4 + 2] * ic));
    const h = pcg((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791) ^ Math.imul(L + 1, -1640531535)) >>> 0) & mask;
    const c = (fill.get(h) ?? 0) + 1;
    fill.set(h, c);
    if (c > K) overflow++;
    maxFill = Math.max(maxFill, c);
  }
  // write-back: R0 at the moved entries' slots (chunked read of the rows involved)
  const r0 = near.r0RT, texRows = near.texRows;
  const bySlot = new Map();
  for (const j of ids) bySlot.set(Math.round(slot[j]), j);
  let wbBad = 0, flipped = 0, checked = 0;
  const CH = 256;
  for (let y0 = 0; y0 < texRows; y0 += CH) {
    const h = Math.min(CH, texRows - y0);
    const lo = y0 * W, hi = (y0 + h) * W;
    let any = false;
    for (const s of bySlot.keys()) if (s >= lo && s < hi) { any = true; break; }
    if (!any) continue;
    const buf = new Float32Array(W * h * 4);
    r.readRenderTargetPixels(r0, 0, y0, W, h, buf);
    for (const [s, j] of bySlot) {
      if (s < lo || s >= hi) continue;
      const k = (s - lo) * 4;
      checked++;
      const same = buf[k] === P1[j * 4] && buf[k + 1] === P1[j * 4 + 1] && buf[k + 2] === P1[j * 4 + 2];
      if (!same) wbBad++;
      if (Math.abs(buf[k + 3]) !== Math.abs(P0[j * 4 + 3])) wbBad++;
      else if (buf[k + 3] !== P0[j * 4 + 3]) flipped++;
    }
  }
  return {
    n: ids.length, count: C.count, cap: C.cap, buckets: C.bucketsUsed || C.buckets, iterations: C.iterations, resolved, crowded: crowdedN, nan, camInside, camInsideW,
    before: summarize(before), after: summarize(after), pairsBefore: before.i.length, pairsAfter: after.i.length,
    moved, maxDispA, maxDispBound, missed, withD, overflow, maxFill, wbBad, flipped, checked,
    pixelAngle: pa, ext,
    // the wake-field bounds the step mirrors (wakeMinDensity(), the cores' compression) and whether the wakes are on
    bounds: { ...C.bounds }, wakeOn: sv.pipeline.ctx.wakes.uniforms.uWakeOn.value > 0.5,
    // slope of the local mid-plane at the camera (vertical relief), deg
    slopeDeg: (() => { const c = sv.pipeline.ctx.structure?.cam; return c ? (Math.atan(Math.hypot(c.slopeR ?? 0, c.slopeT ?? 0)) * 180) / Math.PI : 0; })(),
  };
}

/** Every R0 texel (drawn count, and a hash of the texels not in the contact list) - chunked. Runs in the page. */
export function r0DigestInPage() {
  const sv = window.__sv;
  const near = sv.pipeline.passes.near?.inner ?? sv.pipeline.passes.near;
  const r = sv.renderer, W = 2048, rows = near.texRows, CH = 256;
  let drawn = 0, present = 0;
  const vals = new Float32Array(1);
  const u32 = new Uint32Array(vals.buffer);
  let h = 2166136261 >>> 0;
  for (let y0 = 0; y0 < rows; y0 += CH) {
    const hh = Math.min(CH, rows - y0);
    const buf = new Float32Array(W * hh * 4);
    r.readRenderTargetPixels(near.r0RT, 0, y0, W, hh, buf);
    for (let i = 0; i < W * hh; i++) {
      const w = buf[i * 4 + 3];
      if (w > 0) drawn++;
      if (w !== 0) present++;
    }
    // FNV over the |w| channel only (positions of list particles differ by design)
    for (let i = 0; i < W * hh; i += 7) { vals[0] = Math.abs(buf[i * 4 + 3]); h = Math.imul(h ^ u32[0], 16777619) >>> 0; }
  }
  return { drawn, present, hash: h, listDrawn: near.listCounts?.[3] ?? null };
}

/** Displacement field per R0 slot from the last run (slot -> [dx, dy, dz, analytic x, y, z, a]). Runs in the page. */
export function fieldInPage() {
  const sv = window.__sv;
  const C = (sv.pipeline.passes.near?.inner ?? sv.pipeline.passes.near).contact;
  const r = sv.renderer, gl = r.getContext(), W = 2048, n = C.drawn, rows = Math.ceil(n / W), N = W * rows;
  const readAtt = (rt, att) => {
    const buf = new Float32Array(N * 4);
    r.state.bindFramebuffer(gl.FRAMEBUFFER, r.properties.get(rt).__webglFramebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + att);
    gl.readPixels(0, 0, W, rows, gl.RGBA, gl.FLOAT, buf);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const cur = r.getRenderTarget();
    r.state.bindFramebuffer(gl.FRAMEBUFFER, cur ? r.properties.get(cur).__webglFramebuffer : null);
    return buf;
  };
  // list [0] (analytic position, R0 slot), [1] (signed a, ...); result (position, bound)
  const P0 = readAtt(C.listTarget, 0), M = readAtt(C.listTarget, 1), P1 = readAtt(C.outRT, 0);
  const out = new Map();
  for (let j = 0; j < n; j++) {
    if (M[j * 4] === 0) continue;
    out.set(Math.round(P0[j * 4 + 3]), [P1[j * 4] - P0[j * 4], P1[j * 4 + 1] - P0[j * 4 + 1], P1[j * 4 + 2] - P0[j * 4 + 2], P0[j * 4], P0[j * 4 + 1], P0[j * 4 + 2], Math.abs(M[j * 4])]);
  }
  return out;
}

/**
 * GPU time (ms) of the contact step alone for each configuration (contact properties, e.g. { stage: 1 } = up to the
 * list compaction): the frame's arguments are captured, the step is re-run `reps` times between synchronous 1-pixel
 * read-backs (gl.finish does not wait in Chrome), the configurations interleaved within every trial, min over
 * `trials`. Runs in the page; the app's own contact step is held meanwhile.
 */
export async function costInPage(confs, reps, trials) {
  const sv = window.__sv, C = (sv.pipeline.passes.near?.inner ?? sv.pipeline.passes.near)?.contact;
  if (!C) return { error: 'near.contact not found' };
  const orig = C.run.bind(C);
  let args = null, hold = false;
  C.run = (fr) => { args = fr; return hold ? false : orig(fr); };
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (!args) { C.run = orig; return { error: 'the contact step did not run' }; }
  const fr = { ...args, layoutChanged: false }, px = new Float32Array(4);
  const sync = () => sv.renderer.readRenderTargetPixels(fr.r0RT, 0, 0, 1, 1, px);
  // every key a configuration may set is restored before each one (configurations are partial)
  const keys = [...new Set(['stage', 'rounds', 'iterations', ...confs.flatMap((c) => Object.keys(c))])];
  const keep = Object.fromEntries(keys.map((k) => [k, C[k]]));
  hold = true;
  const times = confs.map(() => Infinity);
  try {
    for (const c of confs) {
      Object.assign(C, keep, c);
      for (let i = 0; i < 4; i++) { orig(fr); sync(); await new Promise((r) => setTimeout(r, 20)); }
    }
    // configurations interleaved within each trial: a busy stretch of a shared GPU hits all of them alike
    for (let t = 0; t < trials; t++) {
      for (let k = 0; k < confs.length; k++) {
        Object.assign(C, keep, confs[k]);
        orig(fr);
        sync();
        const t0 = performance.now();
        for (let i = 0; i < reps; i++) orig(fr);
        sync();
        times[k] = Math.min(times[k], (performance.now() - t0) / reps);
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  } finally {
    Object.assign(C, keep);
    hold = false;
    C.run = orig;
  }
  return { times, count: C.count };
}

/**
 * Whole-frame time (ms) with the contact step off and on: the pipeline renders the current (paused) frame `reps`
 * times between synchronous 1-pixel read-backs, off and on interleaved within every trial, min over `trials` of
 * each. Catches costs the step causes elsewhere in the frame; the app's own frame loop is held meanwhile.
 */
export async function frameCostInPage(reps, trials) {
  const sv = window.__sv, P = sv.pipeline, near = P.passes.near?.inner ?? P.passes.near, C = near?.contact;
  if (!C) return { error: 'near.contact not found' };
  const orig = P.render.bind(P), px = new Float32Array(4);
  let hold = true;
  P.render = (f) => (hold ? undefined : orig(f));
  const sync = () => sv.renderer.readRenderTargetPixels(near.r0RT, 0, 0, 1, 1, px);
  const was = C.enabled, best = { off: Infinity, on: Infinity };
  try {
    for (const on of [false, true]) { C.enabled = on; for (let i = 0; i < 4; i++) { orig(sv.frame); sync(); } }
    for (let t = 0; t < trials; t++) {
      for (const on of t % 2 ? [true, false] : [false, true]) {
        C.enabled = on;
        orig(sv.frame);
        sync();
        const t0 = performance.now();
        for (let i = 0; i < reps; i++) orig(sv.frame);
        sync();
        const ms = (performance.now() - t0) / reps;
        if (on) best.on = Math.min(best.on, ms); else best.off = Math.min(best.off, ms);
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  } finally {
    C.enabled = was;
    hold = false;
    P.render = orig;
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ node side
const setContact = (page, on) => page.evaluate((on) => { (window.__sv.pipeline.passes.near.inner ?? window.__sv.pipeline.passes.near).contact.enabled = on; }, on);
const analyze = (page) => page.evaluate(analyzeInPage);
const r0Digest = (page) => page.evaluate(r0DigestInPage);
/** store the displacement field of the current frame under `name` (in the page) */
const storeField = (page, name) => page.evaluate(`(() => { const f = (${fieldInPage.toString()})(); window.__ctField = window.__ctField || {}; window.__ctField[${JSON.stringify(name)}] = f; return f.size; })()`);
/** compare two stored fields: matched particles, max |change| (m), pops, bit-identical */
const compareFields = (page, a, b, pxMin) => page.evaluate((a, b, pxMin) => {
  const A = window.__ctField[a], B = window.__ctField[b], pa = window.__sv.frame.pixelAngle;
  let matched = 0, pops = 0, identical = true, maxChange = 0, maxChangePx = 0, p99 = [];
  for (const [s, u] of A) {
    const v = B.get(s);
    if (!v) continue;
    matched++;
    const dd = Math.hypot(v[0] - u[0], v[1] - u[1], v[2] - u[2]);
    const mv = Math.hypot(v[3] - u[3], v[4] - u[4], v[5] - u[5]);
    const dist = Math.max(Math.hypot(u[3], u[4], u[5]), 1e-3);
    if (dd !== 0) identical = false;
    maxChange = Math.max(maxChange, dd);
    const px = dd / (dist * pa);
    maxChangePx = Math.max(maxChangePx, px);
    p99.push(px);
    if (dd > Math.max(5 * mv, pxMin * dist * pa)) pops++;
  }
  p99.sort((x, y) => x - y);
  return { matched, pops, identical, maxChange, maxChangePx, p99px: p99.length ? p99[Math.floor(0.99 * (p99.length - 1))] : 0 };
}, a, b, pxMin);

// (the in-page functions above are exported for tuning scripts; the test runs only when executed directly)
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await withHarness('contact', {
  bool: ['cost', 'no-temporal'],
  uncapped: process.argv.includes('--cost'),
  usage: 'node scripts/test/contact.mjs [--base URL] [--out DIR] [--views b-inside,a-inside,a-30m,b-preset] [--no-temporal] [--cost [--cost-views ids] [--reps 3] [--trials 12]]',
}, async ({ args, rep, base, browser }) => {
  const views = args.list('views', Object.keys(VIEWS));
  const rows = [], trows = [];
  for (const id of views) {
    const v = VIEWS[id];
    if (!v) { rep.check(`${id}: known view`, false, `unknown view (${Object.keys(VIEWS).join(', ')})`); continue; }
    console.log(`\n[contact] ${id}: ${v.what}`);
    const { page } = await openApp(browser, base, { ...BASE, ...viewParams(v) }, { settle: 3500 });
    try {
      // contact off: the analytic frame (R0 digest), then on
      await setContact(page, false);
      await waitFrames(page, 3);
      const off = await r0Digest(page);
      await setContact(page, true);
      await waitFrames(page, 6);
      const on = await r0Digest(page);
      const s = await analyze(page);
      if (s.error) { rep.check(`${id}: analysis`, false, s.error); continue; }
      const b = s.before, a = s.after;
      rows.push([id, s.n, s.resolved, s.crowded, b.overlapping, a.overlapping, `${b.hidden} / ${a.hidden}`, b.beyondTol, a.beyondTol, a.beyondTolCrowded, fmt(b.maxRel, 3), fmt(a.maxRel, 3), fmt(a.maxPx, 2), s.moved, fmt(s.maxDispA, 2), s.overflow]);
      console.log(`  list ${s.n} (read-back ${s.count}, cap ${s.cap}, ${s.buckets} buckets, max bucket fill ${s.maxFill}), resolved ${s.resolved}, crowded ${s.crowded}${s.slopeDeg > 0.01 ? `; local mid-plane slope ${fmt(s.slopeDeg, 2)} deg` : ''}`);
      console.log(`  overlapping resolved pairs ${b.overlapping} -> ${a.overlapping} (hidden: the smaller one entirely inside, ${b.hidden} -> ${a.hidden}); visible beyond tolerance ${b.beyondTol} -> ${a.beyondTol} (${a.beyondTolCrowded} at crowded particles); deepest ${fmt(b.maxRel, 3)} -> ${fmt(a.maxRel, 3)} of the contact distance (uncrowded ${fmt(a.maxRelUncrowded, 3)}), ${fmt(a.maxPx, 2)} px`);
      console.log(`  moved ${s.moved}, max displacement ${fmt(s.maxDispA, 3)} a, ${fmt(s.maxDispBound, 4)} of the bound; GPU bound below CPU for ${s.missed} of ${s.withD}; bucket overflow ${s.overflow}`);
      console.log(`  R0: ${s.checked} list slots checked, ${s.wbBad} mismatches, ${s.flipped} set drawn (moved into view); drawn ${off.drawn} -> ${on.drawn}, present ${off.present} -> ${on.present}, >= 1 px list ${off.listDrawn} -> ${on.listDrawn}`);
      rep.data[id] = { ...s, r0off: off, r0on: on };
      rep.check(`${id}: no NaN in the resolved positions`, s.nan === 0, `${s.nan}`);
      rep.range(`${id}: residual visible overlaps / visible overlaps before`, a.beyondTol / Math.max(b.beyondTol, 1), 0, v.resid);
      rep.range(`${id}: uncrowded residual overlaps / resolved particles`, (a.beyondTol - a.beyondTolCrowded) / Math.max(s.resolved, 1), 0, v.free);
      rep.range(`${id}: displacement / bound (clampK x D_i)`, s.maxDispBound, 0, 1.0001);
      rep.range(`${id}: particles whose GPU bound misses a CPU-found overlap / particles with overlaps`, s.missed / Math.max(s.withD, 1), 0, 0.002);
      rep.range(`${id}: hash-bucket overflow / list entries`, s.overflow / Math.max(s.n, 1), 0, 0.001);
      rep.check(`${id}: R0 write-back = resolved positions`, s.wbBad === 0 && s.checked >= s.n, `${s.wbBad} mismatches in ${s.checked} slots`);
      rep.check(`${id}: present particles unchanged`, off.present === on.present, `${off.present} -> ${on.present}`);
      rep.check(`${id}: bodies around the camera take no part (weight 0)`, s.camInsideW === 0, `${s.camInside} around the camera, ${s.camInsideW} with weight > 0`);
      // the step's mirrors of the wake field (a re-parameterized uniform once fed it 1/Rc^2 as the density floor):
      // with wakes on 0 < floor <= 1 <= cores, else both 1
      const wb = s.bounds;
      rep.check(`${id}: wake-density bounds of the contact set (0 < floor <= 1 <= cores)`, s.wakeOn ? wb.wakeMin > 0 && wb.wakeMin <= 1 && wb.wakeCore >= 1 : wb.wakeMin === 1 && wb.wakeCore === 1,
        `floor ${fmt(wb.wakeMin, 4)}, cores ${fmt(wb.wakeCore, 3)}, path tau ${fmt(wb.tauPath, 4)}${s.wakeOn ? '' : ' (wakes off)'}`);
      rep.check(`${id}: drawn (R0) change = particles moved into view`, on.drawn - off.drawn === s.flipped, `${on.drawn - off.drawn} vs ${s.flipped}`);
      rep.range(`${id}: drawn change / drawn`, Math.abs(on.drawn - off.drawn) / Math.max(off.drawn, 1), 0, 0.001);
      if (off.listDrawn !== null) rep.range(`${id}: HUD >= 1 px count change / count`, Math.abs(on.listDrawn - off.listDrawn) / Math.max(off.listDrawn, 1), 0, 0.001);

      if (!args.flag('no-temporal') && v.temporal !== false) {
        // same frame twice -> identical; one frame later (1/30 s at 1x) -> no jumps; 1 s, 10 s reported
        await storeField(page, 't0');
        await waitFrames(page, 3);
        await storeField(page, 't0b');
        const same = await compareFields(page, 't0', 't0b', 1);
        rep.check(`${id}: paused frames bit-identical`, same.identical && same.matched > 0, `${same.matched} matched`);
        const t0 = await page.evaluate(() => window.__sv.clock.t);
        for (const dt of [1 / 30, 1, 10]) {
          await page.evaluate((t) => { window.__sv.clock.paused = true; window.__sv.clock.t = t; }, t0 + dt);
          await waitFrames(page, 4);
          await storeField(page, `dt${dt}`);
          const c = await compareFields(page, 't0', `dt${dt}`, 1);
          trows.push([id, dt < 1 ? '+1 frame' : `+${dt} s`, c.matched, c.pops, fmt(c.maxChange * 1000, 2), fmt(c.p99px, 3), fmt(c.maxChangePx, 2)]);
          if (dt < 1) rep.range(`${id}: one frame later: pops (displacement jump > 1 px) / matched particles`, c.pops / Math.max(c.matched, 1), 0, v.pops);
        }
        // time warp, both directions, running
        for (const w of [1000, -1000]) {
          await page.evaluate((w) => { window.__sv.clock.paused = false; window.__sv.setWarp(w); }, w);
          await sleep(1500);
          const sw = await analyze(page);
          await page.evaluate(() => { window.__sv.clock.paused = true; });
          if (sw.error) { rep.check(`${id}: warp ${w}`, false, sw.error); continue; }
          trows.push([id, `warp ${w}`, sw.n, '-', '-', `resid ${sw.after.beyondTol} / ${sw.before.beyondTol}`, '-']);
          rep.check(`${id}: warp ${w}: no NaN`, sw.nan === 0, `${sw.nan}`);
          rep.range(`${id}: warp ${w}: residual visible overlaps / before`, sw.after.beyondTol / Math.max(sw.before.beyondTol, 1), 0, 1.5 * v.resid);
        }
        await page.evaluate((t) => { window.__sv.clock.paused = true; window.__sv.setWarp(1); window.__sv.clock.t = t; }, t0);
      }
    } finally {
      await page.close();
    }
  }
  console.log(`\n${table(['view', 'list', 'resolved', 'crowded', 'overlapping before', 'after', 'hidden before / after', 'visible >tol before', 'after', 'after: crowded', 'max d/D before', 'after', 'max px after', 'moved', 'max disp/a', 'overflow'], rows)}`);
  if (trows.length) console.log(`\n${table(['view', 'step', 'matched', 'pops', 'max change mm', 'p99 change px', 'max change px'], trows)}`);
  rep.data.table = rows;
  rep.data.temporal = trows;

  // ---- cost (informational): the contact step's own GPU time (robust to other GPU users) and an fps A/B
  if (args.flag('cost')) {
    const crows = [];
    // (b-fov12: the B ring through a narrow field of view at render scale 1 - particles resolved farther away, the
    // largest contact set of the places; a-1km: 1 km above the A ring, an empty set - the step idles; not in the
    // default list)
    const costViews = {
      ...VIEWS, 'b-default': { preset: 'b-ring-inside' }, 'a-default': { preset: 'a-ring-inside' },
      'b-fov12': { preset: 'b-ring-inside', fov: 12, scale: 1 }, 'a-1km': { preset: 'a-ring-1km' },
    };
    for (const id of args.list('cost-views', ['b-default', 'a-default', 'b-inside', 'a-inside'])) {
      const v = costViews[id];
      if (!v) continue;
      const { page } = await openApp(browser, base, { ...BASE, ...viewParams(v) }, { settle: 3500 });
      try {
        // (the last configuration: the step as of 2026-11-08 - fade-in 3 -> 6 px, the whole grid allocation, 12 undamped
        // iterations - interleaved with the current one: a before / after on the same GPU load)
        const before = { rhoLo: 3, gridFit: false, iterations: 12, omega: 1 };
        const st = await page.evaluate(costInPage, [{ stage: 1 }, { stage: 2 }, { stage: 4, rounds: 1 }, {}, before], args.num('reps', 3), args.num('trials', 12));
        if (st.error) { rep.check(`${id}: cost`, false, st.error); continue; }
        const fc = await page.evaluate(frameCostInPage, args.num('reps', 3), args.num('trials', 12));
        if (fc.error) { rep.check(`${id}: frame cost`, false, fc.error); continue; }
        const [l, m, s1, full, prev] = st.times;
        crows.push([id, st.count, fmt(l, 2), fmt(m - l, 2), fmt(s1 - m, 2), fmt(full, 2), fmt(prev, 2), fmt(fc.off, 2), fmt(fc.on, 2), fmt(fc.on - fc.off, 2)]);
        rep.data[`cost-${id}`] = { ...st, frame: fc };
      } finally {
        await page.close();
      }
    }
    console.log(`\n[cost] ms, min over trials of repeated runs between synchronous 1-px read-backs: the contact step alone (cumulative stages; 'step before' = the 2026-11-08 configuration, interleaved), and whole frames with the step off / on (interleaved):\n${table(['view', 'list', 'list compaction', 'materialize', 'first grid + search', 'whole step', 'step before', 'frame off', 'frame on', 'frame diff'], crows)}`);
    rep.data.cost = crows;
    // frame-rate A/B in one page (uncapped app; the browser may still sync to the display - informational)
    const frows = [];
    for (const id of args.list('cost-views', ['b-default', 'a-default'])) {
      const v = costViews[id];
      if (!v) continue;
      const { page } = await openApp(browser, base, { ...BASE, ...viewParams(v), fps: 0 }, { settle: 3000 });
      try {
        const fps = { on: [], off: [] };
        for (let k = 0; k < 8; k++) {
          const on = k % 2 === 0;
          await setContact(page, on);
          await sleep(500);
          fps[on ? 'on' : 'off'].push(await page.evaluate((secs) => new Promise((res) => {
            const t0 = performance.now();
            let c = 0;
            const tick = () => { c++; if (performance.now() - t0 < secs * 1000) requestAnimationFrame(tick); else res(c / ((performance.now() - t0) / 1000)); };
            requestAnimationFrame(tick);
          }), 2));
        }
        const med = (x) => [...x].sort((p, q) => p - q)[Math.floor(x.length / 2)];
        frows.push([id, fmt(med(fps.off), 1), fmt(med(fps.on), 1), fmt(1000 / med(fps.on) - 1000 / med(fps.off), 2)]);
      } finally {
        await page.close();
      }
    }
    console.log(`\n[cost] fps, contact off / on alternating in one page (2 s windows, median of 4; the GPU may be shared):\n${table(['view', 'fps off', 'fps on', 'ms per frame'], frows)}`);
    rep.data.fps = frows;
  }
});
