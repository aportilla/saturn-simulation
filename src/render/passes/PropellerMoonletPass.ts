// Propeller moonlets: the bodies at the centres of the propellers (src/rings/propellers.ts: the named giants and the
// procedural belt / trans-Encke populations), drawn where they are at least ~half a display pixel across.
//
// Rendering: after the near field, into ctx.sceneRT (rgb radiance, a = distance) with per-fragment log depth, depth-
// tested against the ring particles (an instanced box per body, ray-traced ellipsoid in the fragment shader:
// src/render/propellers/moonlet.*.glsl); the ring-layer medium then composites over them like any opaque surface.
// Shape: Roche-lobe-filling (1 : 0.667 : 0.638, long axis at Saturn, R = 0.72 r_H); lighting in physical units with
// the resolved ring particles' regolith photometry, the rings' column toward the Sun, the layer's diffuse light and
// Saturnshine. The nearest bodies (MAX_SHADOW_SPH) are registered as sun-shadowing spheres (sv_lighting uShadowSph)
// so they shadow the rings, the particles and each other.
//
// Per frame: the moonlets around the camera are found with the CPU mirror of the propeller hash grid every SCAN_EVERY
// frames (or when the camera moved), and moved to the current time every frame (PropellerSystem.refresh).
import {
  BackSide, BufferAttribute, GLSL3, InstancedBufferAttribute, InstancedBufferGeometry, LessEqualDepth, Mesh,
  NoBlending, RawShaderMaterial, Vector2, Vector3,
} from 'three';
import type { FrameState } from '../../core/FrameState';
import type { PipelineContext, RenderPass } from '../Pipeline';
import { fsCamera } from '../fullscreen';
import { SV_HEADER_ALL } from '../shaders/chunks';
import { MAX_SHADOW_SPH } from '../SharedUniforms';
import { phaseTables, PHASE_LUT_N } from '../rings/phase';
import { regolithFactorLookup } from '../near/NearRegolith';
import type { Moonlet, PropellerSystem } from '../../rings/propellers';
import { zoneParamsAtKm } from '../../rings/ringRegions';
import vert from '../propellers/moonlet.vert.glsl?raw';
import frag from '../propellers/moonlet.frag.glsl?raw';

const MAX_INST = 1024;
const SCAN_EVERY = 30;
/** smallest apparent radius drawn (display pixels) */
const MIN_PX = 0.25;
/** Hill-lobe proportions (radial, along the orbit, polar) and their volume-equivalent radius */
const LOBE = [1, 0.667, 0.638];
const LOBE_REQ = Math.cbrt(LOBE[0] * LOBE[1] * LOBE[2]);

export class PropellerMoonletPass implements RenderPass {
  readonly name = 'moonlets';
  enabled = true;
  private mesh!: Mesh;
  private geom!: InstancedBufferGeometry;
  private mat!: RawShaderMaterial;
  private aPos!: InstancedBufferAttribute;
  private aAxis!: InstancedBufferAttribute;
  private aSize!: InstancedBufferAttribute;
  private aPhot!: InstancedBufferAttribute;
  private props: PropellerSystem | null = null;
  private list: Moonlet[] = [];
  private scanFrame = 0;
  private lastScan = new Vector3(1e30, 0, 0);
  private lastPa = 0;
  private count = 0;
  private nearest = '';
  private readonly u = {
    uPmW: { value: new Vector3(0.95, 0.94, 0.9) },
    uPmAs: { value: new Vector3(0.58, 0.52, 0.43) },
    uPmBeta: { value: new Vector2(0.7, 0.55) },
    uPmDebug: { value: 0 },
  };
  /** albedo of the bodies (rgb): the A-ring particles' (they are aggregates of ring particles) */
  private albedo: [number, number, number] = [0.58, 0.52, 0.43];

  init(ctx: PipelineContext): void {
    this.props = ctx.structure.propellers;
    // unit box: 8 corners, 12 triangles (back faces are drawn: the box may contain the camera)
    const g = new InstancedBufferGeometry();
    const P = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);
    const I = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3]);
    g.setAttribute('position', new BufferAttribute(P, 3));
    g.setIndex(new BufferAttribute(I, 1));
    this.aPos = new InstancedBufferAttribute(new Float32Array(MAX_INST * 3), 3);
    this.aAxis = new InstancedBufferAttribute(new Float32Array(MAX_INST * 4), 4);
    this.aSize = new InstancedBufferAttribute(new Float32Array(MAX_INST * 4), 4);
    this.aPhot = new InstancedBufferAttribute(new Float32Array(MAX_INST * 4), 4);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iAxis', this.aAxis);
    g.setAttribute('iSize', this.aSize);
    g.setAttribute('iPhot', this.aPhot);
    g.instanceCount = 0;
    this.geom = g;
    this.mat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: SV_HEADER_ALL + '\n' + vert,
      fragmentShader: SV_HEADER_ALL + '\n' + frag,
      uniforms: { ...ctx.shared.u, ...this.u },
      depthTest: true,
      depthWrite: true,
      depthFunc: LessEqualDepth,
      blending: NoBlending,
      side: BackSide,
    });
    this.mesh = new Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    // photometry: grain albedo of the regolith law per channel for the A-ring particle albedo (the LUT inverts the
    // regolith sphere's spherical albedo, so A_s(w) = A for the diffusely lit part)
    const zp = zoneParamsAtKm(130_000);
    this.albedo = [zp.albedo[0], zp.albedo[1], zp.albedo[2]];
    const w = this.albedo.map((A) => regolithFactorLookup(0.5, A).w);
    this.u.uPmW.value.set(w[0], w[1], w[2]);
    this.u.uPmAs.value.set(this.albedo[0], this.albedo[1], this.albedo[2]);
  }

  update(f: FrameState, ctx: PipelineContext): void {
    const P = this.props;
    const sh = ctx.shared.u;
    if (!P) return;
    const cam = f.camPos;
    const rc = Math.hypot(cam.x, cam.y), thc = Math.atan2(cam.y, cam.x);
    const pa = f.canvasPixelAngle;
    // ---- find the moonlets around the camera (CPU mirror of the hash grid); refresh their positions every frame
    const moved = cam.distanceTo(this.lastScan);
    if (this.scanFrame++ % SCAN_EVERY === 0 || moved > Math.max(0.1 * Math.abs(cam.z), 2e3) || Math.abs(pa / this.lastPa - 1) > 0.3) {
      if (Math.abs(cam.z) < 3e6) this.list = P.moonletsNear(rc, thc, 3e6, MIN_PX * pa, this.list);
      else this.list.length = 0;
      this.lastScan.copy(cam);
      this.lastPa = pa;
    }
    // two-stream back-scatter fractions (as the particles and the astronaut)
    const pt = phaseTables(1);
    const mu = Math.min(1, Math.abs(f.sunDir.z)) * (PHASE_LUT_N - 1);
    const i0 = Math.min(PHASE_LUT_N - 2, Math.floor(mu));
    this.u.uPmBeta.value.set(pt.betaMacro, pt.beta0Macro[i0] + (pt.beta0Macro[i0 + 1] - pt.beta0Macro[i0]) * (mu - i0));
    this.u.uPmDebug.value = f.settings.debugView === 45 ? 1 : 0;
    // ---- instances: in front of the camera and >= MIN_PX display pixels in radius, nearest first
    const W2C = f.worldToCam.elements;
    const tanH = Math.tan(f.fovY / 2), asp = f.aspect;
    const vis: { m: Moonlet; d: number; x: number; y: number; z: number }[] = [];
    for (const m of this.list) {
      P.refresh(m);
      const x = m.a * Math.cos(m.theta) - cam.x, y = m.a * Math.sin(m.theta) - cam.y, z = m.z - cam.z;
      const d = Math.hypot(x, y, z);
      const ext = m.R / LOBE_REQ;
      if (m.R / Math.max(d, 1e-3) < MIN_PX * pa && d > ext) continue;
      const vz = W2C[2] * x + W2C[5] * y + W2C[8] * z;
      if (vz > ext) continue; // behind the camera
      const vx = W2C[0] * x + W2C[3] * y + W2C[6] * z, vy = W2C[1] * x + W2C[4] * y + W2C[7] * z;
      const w = Math.max(-vz, 1e-3);
      if (d > ext && (Math.abs(vx) - ext * 1.5 > w * tanH * asp || Math.abs(vy) - ext * 1.5 > w * tanH)) continue;
      vis.push({ m, d, x, y, z });
    }
    vis.sort((a, b) => a.d - b.d);
    const n = Math.min(vis.length, MAX_INST);
    const pos = this.aPos.array as Float32Array, ax = this.aAxis.array as Float32Array;
    const sz = this.aSize.array as Float32Array, ph = this.aPhot.array as Float32Array;
    // the nearest ones shadow the rings / particles / each other
    const sph = sh.uShadowSph.value as { set: (x: number, y: number, z: number, w: number) => void }[];
    const nSph = Math.min(n, MAX_SHADOW_SPH);
    const A = (this.albedo[0] + this.albedo[1] + this.albedo[2]) / 3;
    for (let i = 0; i < n; i++) {
      const { m, x, y, z, d } = vis[i];
      const k = m.R / LOBE_REQ;
      pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = z;
      const seed = hashKey(m.key);
      ax[4 * i] = Math.cos(m.theta); ax[4 * i + 1] = Math.sin(m.theta); ax[4 * i + 2] = i < nSph ? i + 1 : 0; ax[4 * i + 3] = seed;
      sz[4 * i] = k * LOBE[0]; sz[4 * i + 1] = k * LOBE[1]; sz[4 * i + 2] = k * LOBE[2];
      sz[4 * i + 3] = 0.9 + 0.2 * ((seed * 7.31) % 1);
      // per-body photometric factor at its phase angle (the factor LUT of the resolved particles)
      const cosA = -(x * f.sunDir.x + y * f.sunDir.y + z * f.sunDir.z) / Math.max(d, 1e-3);
      ph[4 * i] = regolithFactorLookup(Math.acos(Math.max(-1, Math.min(1, cosA))), A).f;
      if (i < nSph) sph[i].set(x, y, z, m.R);
    }
    sh.uShadowSphN.value = nSph;
    this.count = n;
    this.nearest = n > 0 ? `${vis[0].m.name} ${(vis[0].d / 1e3).toFixed(1)} km` : '-';
    this.geom.instanceCount = n;
    this.aPos.needsUpdate = this.aAxis.needsUpdate = this.aSize.needsUpdate = this.aPhot.needsUpdate = true;
    this.aPos.addUpdateRange(0, 3 * n);
    this.aAxis.addUpdateRange(0, 4 * n);
    this.aSize.addUpdateRange(0, 4 * n);
    this.aPhot.addUpdateRange(0, 4 * n);
  }

  render(_f: FrameState, ctx: PipelineContext): void {
    if (this.count === 0) return;
    const r = ctx.renderer;
    r.setRenderTarget(ctx.sceneRT);
    r.render(this.mesh, fsCamera);
  }

  stats(): Record<string, string | number> {
    return { drawn: this.count, nearest: this.nearest, scanned: this.list.length };
  }

  /** the moonlets drawn last frame (tests) */
  get moonlets(): readonly Moonlet[] {
    return this.list;
  }

  dispose(): void {
    this.geom?.dispose();
    this.mat?.dispose();
  }
}

/** [0, 1) from a moonlet key */
function hashKey(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0) / 4294967296;
}
