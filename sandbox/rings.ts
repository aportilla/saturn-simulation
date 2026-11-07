// Ring-layer pass sandbox. URL parameters: see sandbox/common.ts, plus
//   near=1      include the (in-progress) NearFieldPass (default: omitted, so the medium carries all tau)
//   far=real    use the real FarFieldPass instead of the stub
//   debug=n     ring-layer debug views: 1 tau, 2 transmission, 3 I/F, 4 march steps, 5 march weight, 6 footprint
//               (7-10: raw values for read-back scripts)
//   phase=0     shared Lambert-sphere ringPhase instead of the calibrated power-law particle phase function
//   half=0      near-field march at full resolution (default: half resolution + depth-aware upsampling)
// Other agents' passes are imported dynamically, so their in-progress work cannot break this page.
// window.__rl helpers: shadowPhi() / sunPhi() -> SEF azimuth (deg) of the anti-solar / solar direction.
import { startSandbox } from './common';
import { FarFieldStub } from '../src/render/passes/stubs/FarFieldStub';
import { RingLayerPass } from '../src/render/passes/RingLayerPass';
import { PostPass } from '../src/render/PostPass';
import type { PipelinePasses, RenderPass } from '../src/render/Pipeline';

const params = new URLSearchParams(location.search);
let far: RenderPass = new FarFieldStub();
if (params.get('far') === 'real') {
  const m = await import('../src/render/passes/FarFieldPass');
  far = new m.FarFieldPass();
}
let near: RenderPass | undefined;
if (params.get('near') === '1') {
  const m = await import('../src/render/passes/NearFieldPass');
  near = new m.NearFieldPass();
}

const rings = new RingLayerPass();
if (params.has('phase')) rings.phaseModel = parseInt(params.get('phase')!, 10);
if (params.get('half') === '0') rings.halfRes = false;

startSandbox({
  passes: () => {
    const p: PipelinePasses = { far, rings, post: new PostPass() };
    if (near) p.near = near;
    return p;
  },
  overlay: (f, pl) => {
    const s = pl.stats();
    const rKm = Math.hypot(f.camPos.x, f.camPos.y) / 1000;
    const lines = [
      `r ${rKm.toFixed(1)} km  z ${f.camPos.z.toFixed(1)} m  sun elev ${((Math.asin(f.sunDir.z) * 180) / Math.PI).toFixed(2)} deg`,
      ...Object.entries(s).map(([k, v]) => `${k}: ${v}`),
    ];
    return lines.join('\n');
  },
});

(window as any).__rl = {
  pass: rings,
  /** set a ring-layer uniform, e.g. __rl.set('uRlShScale', 0.5) */
  set: (name: string, v: number) => {
    (rings as any).u[name].value = v;
  },
  shadowPhi: () => {
    const f = (window as any).__sv.frame;
    return (Math.atan2(-f.sunDir.y, -f.sunDir.x) * 180) / Math.PI;
  },
  sunPhi: () => {
    const f = (window as any).__sv.frame;
    return (Math.atan2(f.sunDir.y, f.sunDir.x) * 180) / Math.PI;
  },
};
