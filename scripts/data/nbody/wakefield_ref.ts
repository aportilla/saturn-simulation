// Reference values of the simulator's procedural wake field (src/rings/WakeField.ts) and zone table
// (src/rings/ringRegions.ts) for the verification of the Python port (scripts/data/nbody/procedural.py --verify,
// which bundles and runs this file automatically). Manual use:
//   node_modules/.bin/rolldown scripts/data/nbody/wakefield_ref.ts --file <tmp>/wf.mjs --format esm --platform node
//   node <tmp>/wf.mjs '{"seed":12345,"cases":[{"rKm":128000,"tau":0.66,"sigma":284,"omega":1.34e-4,"kappa":1.33e-4,"t":8.4e8}]}'
// Prints JSON: per case the texture texels, lambda, tile, strength, shape and the generation uniforms after update(t).
import { WakeField } from '../../../src/rings/WakeField';
import { zoneParamsAtKm } from '../../../src/rings/ringRegions';

interface Case { rKm: number; tau: number; sigma: number; omega: number; kappa: number; qShear?: number; t: number; shape?: { gamma?: number; spreadPar?: number; spreadPerp?: number } }
const args = JSON.parse(process.argv[2] ?? '{}') as { seed?: number; texels?: [number, number][]; cases?: Case[] };
const texels = args.texels ?? [[0, 0], [1, 0], [0, 1], [17, 93], [128, 64], [200, 31], [255, 255]];
const out: unknown[] = [];
for (const c of args.cases ?? []) {
  const wf = new WakeField(args.seed ?? 12345);
  if (c.shape) wf.shapeOverride = c.shape;
  const zp = zoneParamsAtKm(c.rKm);
  const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  // the fields of RingLocal that WakeField.configure reads (RingProfile.local)
  const local = { rKm: c.rKm, tau: c.tau, sigma: c.sigma, aMax: zp.aMax, macroscopic: zp.macroscopic && c.tau > 0.002, wake: zp.wake * smooth(0.15, 0.4, c.tau) };
  const ring = { omega: c.omega, kappa: c.kappa, qShear: c.qShear ?? 1.5 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wf.configure(local as any, ring as any);
  wf.update(c.t);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (wf as any).data as Float32Array;
  const N = wf.N;
  out.push({
    zone: { key: zp.zone?.key, q: zp.q, aMin: zp.aMin, aMax: zp.aMax, H: zp.H, wake: zp.wake, sigma0: zp.sigma0, sigmaSlope: zp.sigmaSlope },
    lambda: wf.lambda, tile: wf.tile, strength: wf.strength, shape: wf.shape,
    gen: wf.uniforms.uWakeGen.value.slice(0, 2).map((v) => [v.x, v.y, v.z, v.w]),
    sel: [wf.uniforms.uWakeSel.value.x, wf.uniforms.uWakeSel.value.y],
    wshape: [wf.uniforms.uWakeShape.value.x, wf.uniforms.uWakeShape.value.y, wf.uniforms.uWakeShape.value.z, wf.uniforms.uWakeShape.value.w],
    pitchDeg: wf.pitchDeg,
    texels: texels.map(([i, j]) => Array.from(data.slice((j * N + i) * 4, (j * N + i) * 4 + 4))),
  });
}
console.log(JSON.stringify({ texels, cases: out }));
