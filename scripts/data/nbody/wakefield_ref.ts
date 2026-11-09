// Reference values of the simulator's procedural wake field (src/rings/WakeField.ts) and zone table
// (src/rings/ringRegions.ts) for the verification of the Python port (scripts/data/nbody/procedural.py --verify,
// which bundles and runs this file automatically). Manual use:
//   node_modules/.bin/rolldown scripts/data/nbody/wakefield_ref.ts --file <tmp>/wf.mjs --format esm --platform node
//   node <tmp>/wf.mjs '{"seed":12345,"cases":[{"rKm":128000,"tau":0.66,"sigma":284,"omega":1.34e-4,"kappa":1.33e-4,"t":8.4e8}]}'
// Prints JSON: per case the zone values, the wake set, the texture texels (both layers) and delta-texture texels,
// lambda, tile, strength and the uniforms after update(t), and the CPU mirror of the shared wake functions
// (WakeField.densityAt / displacementAt = wakeDensity / wakeDisplacement) at the given points (units of lambda).
import { WakeField, type WakeShape } from '../../../src/rings/WakeField';
import { zoneParamsAtKm } from '../../../src/rings/ringRegions';

interface Case { rKm: number; tau: number; sigma: number; omega: number; kappa: number; qShear?: number; t: number; shape?: Partial<WakeShape> }
const args = JSON.parse(process.argv[2] ?? '{}') as { seed?: number; texels?: [number, number][]; dtexels?: [number, number][]; points?: [number, number][]; cases?: Case[] };
const points = args.points ?? [];
const texels = args.texels ?? [[0, 0], [1, 0], [0, 1], [17, 93], [128, 64], [200, 31], [255, 255]];
const dtexels = args.dtexels ?? [[0, 0], [1, 0], [0, 1], [17, 33], [40, 12], [63, 63]];
const out: unknown[] = [];
const v4 = (v: { x: number; y: number; z: number; w: number }) => [v.x, v.y, v.z, v.w];
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ddata = (wf as any).ddata as Float32Array;
  const N = wf.N, DN = wf.DN;
  const u = wf.uniforms;
  out.push({
    zone: { key: zp.zone?.key, q: zp.q, aMin: zp.aMin, aMax: zp.aMax, H: zp.H, wake: zp.wake, wakeB: zp.wakeB, sigma0: zp.sigma0, sigmaSlope: zp.sigmaSlope },
    lambda: wf.lambda, tile: wf.tile, strength: wf.strength, shape: wf.shape,
    gen: u.uWakeGen.value.map(v4),
    uniforms: {
      clock: v4(u.uWakeClock.value), delta: v4(u.uWakeDelta.value), shape: v4(u.uWakeShape.value),
      m0: [u.uWakeM0.value.x, u.uWakeM0.value.y], bounds: v4(u.uWakeBounds.value),
    },
    pitchDeg: wf.pitchDeg,
    texels: texels.map(([i, j]) => [0, 1].map((L) => Array.from(data.slice(((L * N + j) * N + i) * 4, ((L * N + j) * N + i) * 4 + 4)))),
    dtexels: dtexels.map(([i, j]) => Array.from(ddata.slice((j * DN + i) * 4, (j * DN + i) * 4 + 4))),
    density: points.map(([x, y]) => wf.densityAt(x * wf.lambda, y * wf.lambda)),
    displacement: points.map(([x, y]) => wf.displacementAt(x * wf.lambda, y * wf.lambda)),
  });
}
console.log(JSON.stringify({ texels, dtexels, cases: out }));
