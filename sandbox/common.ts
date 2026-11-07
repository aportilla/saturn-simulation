// Minimal test harness for developing render passes in isolation (not the real app).
//
// URL parameters:
//   t=2026-11-07T12:00:00Z | now      simulation start time (UTC); default 2026-11-07T12:00:00Z
//   warp=1                             time warp (sim seconds per real second)
//   fov=60                             vertical field of view (deg)
//   scale=1                            render scale
//   detail=1                           particle detail (near-field budget multiplier)
//   ev=0                               exposure compensation (log2); exposure=manual -> manual exposure
//   cam=orbit&target=saturn|<moon name>&dist=<m>&az=<deg>&el=<deg>
//       orbit camera looking at the target; position = target + dist*(cos el cos az, cos el sin az, sin el) (SEF)
//   cam=ring&r=<m>&x=<m>&y=<m>&z=<m>&yaw=<deg>&pitch=<deg>&phi=<deg>
//       co-orbiting camera in the local Hill frame at radius r (frame origin azimuth phi at start);
//       yaw 0 = looking prograde (+azimuthal), 90 = radially outward, -90 = toward Saturn; pitch + = north
//   cam=look&pos=x,y,z&at=x,y,z        SEF meters
//   debug=<n>                          settings.debugView
//
// window.__sv exposes { frame, pipeline, clock, world, anchor, setCamera(paramsString), renderer } and
// window.__svReady becomes true after a few frames have rendered.
import { Matrix4, Quaternion, Vector3, WebGLRenderer } from 'three';
import { createFrameState, updateCameraDerived, type FrameState } from '../src/core/FrameState';
import { World } from '../src/core/World';
import { SimClock, tdbFromIso } from '../src/core/time';
import { RingAnchor } from '../src/core/RingAnchor';
import { Pipeline, type PipelinePasses } from '../src/render/Pipeline';
import { DEG } from '../src/core/constants';
import type { MoonProvider } from '../src/moons/types';

export interface SandboxOptions {
  passes: () => PipelinePasses;
  moons?: () => Promise<MoonProvider> | MoonProvider;
  /** extra per-frame hook (after camera update, before render) */
  onFrame?: (f: FrameState) => void;
  /** HTML overlay text supplier */
  overlay?: (f: FrameState, p: Pipeline) => string;
}

type CamMode =
  | { kind: 'orbit'; target: string; dist: number; az: number; el: number }
  | { kind: 'ring'; local: Vector3; yaw: number; pitch: number }
  | { kind: 'look'; pos: Vector3; at: Vector3 };

function basisQuat(forward: Vector3, upHint: Vector3, out: Quaternion): Quaternion {
  const f = forward.clone().normalize();
  let right = new Vector3().crossVectors(f, upHint);
  if (right.lengthSq() < 1e-12) right = new Vector3().crossVectors(f, new Vector3(0, 1, 0));
  right.normalize();
  const up = new Vector3().crossVectors(right, f).normalize();
  const m = new Matrix4().makeBasis(right, up, f.clone().multiplyScalar(-1));
  return out.setFromRotationMatrix(m);
}

export async function startSandbox(opts: SandboxOptions): Promise<void> {
  const params = new URLSearchParams(location.search);
  const num = (k: string, d: number) => (params.has(k) ? parseFloat(params.get(k)!) : d);

  document.body.style.margin = '0';
  document.body.style.background = '#000';
  document.body.style.overflow = 'hidden';
  const canvas = document.createElement('canvas');
  canvas.style.width = '100vw';
  canvas.style.height = '100vh';
  canvas.style.display = 'block';
  document.body.appendChild(canvas);
  const overlay = document.createElement('pre');
  overlay.style.cssText = 'position:fixed;left:8px;top:8px;margin:0;color:#9fd;font:11px/1.35 ui-monospace,monospace;text-shadow:0 0 3px #000;pointer-events:none;white-space:pre';
  document.body.appendChild(overlay);

  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  const scale = num('scale', 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * scale);

  const frame = createFrameState();
  frame.settings.particleDetail = num('detail', 1);
  frame.settings.exposureEV = num('ev', 0);
  if (params.get('exposure') === 'manual') frame.settings.exposureMode = 'manual';
  frame.settings.debugView = num('debug', 0);
  frame.fovY = num('fov', 60) * DEG;
  const tParam = params.get('t');
  const clock = new SimClock(tParam === 'now' ? undefined : tdbFromIso(tParam ?? '2026-11-07T12:00:00Z'));
  clock.warp = num('warp', 1);

  const world = new World(opts.moons ? await opts.moons() : undefined);
  const anchor = new RingAnchor(num('r', 130_000e3), num('phi', 0) * DEG, clock.t);
  const pipeline = new Pipeline(renderer, opts.passes());

  let cam: CamMode = { kind: 'orbit', target: 'saturn', dist: 1.2e9, az: -60, el: 20 };
  const setCamera = (qs: string) => {
    const p = new URLSearchParams(qs);
    const n = (k: string, d: number) => (p.has(k) ? parseFloat(p.get(k)!) : d);
    const kind = p.get('cam') ?? 'orbit';
    if (kind === 'ring') {
      const r = n('r', 130_000e3);
      anchor.reanchor(r, n('phi', 0) * DEG, clock.t);
      cam = { kind: 'ring', local: new Vector3(n('x', 0), n('y', 0), n('z', 0)), yaw: n('yaw', 0), pitch: n('pitch', 0) };
    } else if (kind === 'look') {
      const v = (s: string | null, d: number[]) => new Vector3(...(s ? s.split(',').map(Number) : d));
      cam = { kind: 'look', pos: v(p.get('pos'), [0, -5e8, 1e8]), at: v(p.get('at'), [0, 0, 0]) };
    } else {
      cam = { kind: 'orbit', target: (p.get('target') ?? 'saturn').toLowerCase(), dist: n('dist', 1.2e9), az: n('az', -60), el: n('el', 20) };
    }
    if (p.has('fov')) frame.fovY = n('fov', 60) * DEG;
  };
  setCamera(location.search);

  const resize = () => {
    const dpr = renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(window.innerWidth * dpr));
    const h = Math.max(1, Math.floor(window.innerHeight * dpr));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    frame.width = w;
    frame.height = h;
    frame.aspect = w / h;
    pipeline.setSize(w, h);
  };
  await pipeline.init(Math.floor(window.innerWidth * renderer.getPixelRatio()), Math.floor(window.innerHeight * renderer.getPixelRatio()));
  resize();
  window.addEventListener('resize', resize);

  const tmpV = new Vector3();
  const updateCamera = () => {
    if (cam.kind === 'ring') {
      anchor.localToSef(cam.local, frame.t, frame.camPos);
      anchor.fill(frame.ring, frame.t, frame.camPos);
      const r = frame.ring;
      const cy = Math.cos(cam.yaw * DEG), sy = Math.sin(cam.yaw * DEG);
      const cp = Math.cos(cam.pitch * DEG), sp = Math.sin(cam.pitch * DEG);
      const fwd = new Vector3().addScaledVector(r.ePhi, cy * cp).addScaledVector(r.eR, sy * cp).addScaledVector(r.eZ, sp);
      basisQuat(fwd, r.eZ, frame.camQuat);
    } else {
      let target = new Vector3();
      if (cam.kind === 'orbit') {
        const tgt = cam.target;
        if (tgt !== 'saturn') {
          const m = frame.moons.find((mm) => mm.name.toLowerCase() === tgt);
          if (m) target = m.pos.clone();
        }
        const ce = Math.cos(cam.el * DEG);
        frame.camPos.set(ce * Math.cos(cam.az * DEG), ce * Math.sin(cam.az * DEG), Math.sin(cam.el * DEG)).multiplyScalar(cam.dist).add(target);
      } else {
        frame.camPos.copy(cam.pos);
        target = cam.at.clone();
      }
      basisQuat(tmpV.copy(target).sub(frame.camPos), new Vector3(0, 0, 1), frame.camQuat);
      // keep the ring frame anchored under the camera when near the ring plane
      const rr = Math.hypot(frame.camPos.x, frame.camPos.y);
      anchor.fill(frame.ring, frame.t, frame.camPos);
      if (Math.abs(frame.ring.camLocal.x) > 20e3 || Math.abs(frame.ring.camLocal.y) > 20e3) {
        anchor.reanchorAt(frame.camPos, frame.t);
        anchor.fill(frame.ring, frame.t, frame.camPos);
      }
      void rr;
    }
    updateCameraDerived(frame);
  };

  let last = performance.now();
  let frames = 0;
  let fpsAcc = 0, fpsN = 0, fps = 0;
  (window as any).__sv = { frame, pipeline, clock, world, anchor, renderer, setCamera };
  const loop = () => {
    const now = performance.now();
    const dtReal = (now - last) / 1000;
    last = now;
    fpsAcc += dtReal; fpsN++;
    if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    frame.dtReal = dtReal;
    frame.dt = clock.tick(dtReal);
    frame.t = clock.t;
    frame.timeWarp = clock.warp;
    frame.frameIndex++;
    world.update(frame);
    updateCamera();
    opts.onFrame?.(frame);
    pipeline.render(frame);
    if (opts.overlay) overlay.textContent = `fps ${fps.toFixed(0)}\n` + opts.overlay(frame, pipeline);
    else overlay.textContent = `fps ${fps.toFixed(0)}  ${new Date((clock.t + 946727930.816) * 1000).toISOString()}\n` +
      Object.entries(pipeline.stats()).map(([k, v]) => `${k}: ${v}`).join('\n');
    if (++frames === 6) (window as any).__svReady = true;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
