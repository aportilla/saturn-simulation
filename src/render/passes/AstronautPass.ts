// Astronaut companion: a spacesuited figure at true scale (1.9 m), pinned to the camera - a fixed place in
// camera space, lower right of the view - for a sense of scale wherever you fly. Original procedural model
// (src/render/astronaut/AstronautModel.ts).
//
// Rendering: after the near field and before the ring layer, into ctx.sceneRT (rgb radiance W m^-2 sr^-1,
// a = distance m) with per-fragment log depth, depth-tested against the near-field particles (they pass in
// front of, behind and through the body correctly) and composited under the ring-layer medium like any
// opaque surface. Lighting in physical units with the shared models (astronaut.vert.glsl): direct sunlight
// with Saturn's / the moons' shadows, the ring column toward the Sun and - when the near field's sun shadow
// map is live - the exact shadows of the nearby particles; the ring layer's diffuse light (two-stream field
// near the rings, ringshine vector far away); Saturnshine; a gold visor with the Sun's glint and Saturn's
// disc in its reflection. Nothing is brightened: PostPass exposure adapts as for everything else, so the
// suit goes dark in Saturn's shadow and is a twilight figure inside the B ring.
//
// Placement: the body centre sits at a fixed screen position (NDC_X, NDC_Y), DIST0 metres away at the default
// field of view, farther when the field of view or the aspect ratio would not fit it - always fully in view
// and clear of the centre. Idle motion (slow sway, turn and drift) runs on wall-clock time, so it stays gentle
// at any time warp and while paused.
import {
  FrontSide, GLSL3, LessEqualDepth, Matrix3, Matrix4, Mesh, NearestFilter, NoBlending, Quaternion, RawShaderMaterial,
  RedFormat, UnsignedByteType, Vector2, Vector3, Vector4, WebGLRenderTarget, type BufferGeometry, type IUniform,
} from 'three';
import type { FrameState } from '../../core/FrameState';
import type { PipelineContext, RenderPass } from '../Pipeline';
import { fsCamera } from '../fullscreen';
import { SV_HEADER_ALL } from '../shaders/chunks';
import { LOD_CLASSES } from '../../rings/RingLod';
import nearCommon from '../near/nearCommon.glsl?raw';
import { NEAR_SHADOW_COMMON_GLSL, NEAR_SHADOW_LOOKUP_GLSL } from '../near/NearShadow';
import { phaseTables, PHASE_LUT_N } from '../rings/phase';
import { RingshineTable } from '../far/Ringshine';
import { buildAstronautGeometry } from '../astronaut/AstronautModel';
import astroVert from '../astronaut/astronaut.vert.glsl?raw';
import astroFrag from '../astronaut/astronaut.frag.glsl?raw';

/** screen position (NDC) of the body centre */
const NDC_X = 0.55, NDC_Y = -0.3;
/** distance (m) at the default 60 deg field of view and any wider one */
const DIST0 = 3.75;
/** largest fraction of the screen height the body may span; largest NDC width (keeps it clear of the centre) */
const MAX_H_FRAC = 0.46, MAX_W_NDC = 0.55;
/** body turn toward the screen centre (3/4 view) and resting lean (rad) */
const YAW0 = -0.42, PITCH0 = -0.12, ROLL0 = 0.1;
/** the plane-parallel ring field near the rings fades to the ringshine vector between these heights (m) */
const PLANE_H0 = 2e6, PLANE_H1 = 2e7;

const NO_SHADOW_LOOKUP = /* glsl */ `
float nearShadowCoverage(vec3 p) { return 0.0; }
float nearShadowVisibility(vec3 p, vec3 selfC, float rp) { return 1.0; }
`;

// Exposure-meter mask: the astronaut's VISIBLE pixels (PostPass leaves them out of the auto-exposure meter).
// Drawn after the body itself: a fragment marks its pixel only if sceneRT holds its own distance there, so
// pixels where ring particles pass in front of the body are not masked.
const MASK_VERT = /* glsl */ `
precision highp float;
in vec3 position;
uniform mat3 uAstroRot;
uniform vec3 uAstroPos;
uniform mat4 uProj;
out vec3 vV;
void main() {
  vV = uAstroRot * position + uAstroPos;
  gl_Position = uProj * vec4(vV, 1.0);
  gl_Position.z = 0.0;
}`;
const MASK_FRAG = /* glsl */ `
precision highp float; precision highp sampler2D;
uniform sampler2D tScene;   // sceneRT: a = distance (m)
in vec3 vV;
layout(location = 0) out vec4 o;
void main() {
  float a = texelFetch(tScene, ivec2(gl_FragCoord.xy), 0).a;
  if (a < length(vV) * 0.999) discard;   // something nearer (a ring particle) covers this pixel
  o = vec4(1.0);
}`;

const ZERO4F = new Float32Array(4);

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export class AstronautPass implements RenderPass {
  readonly name = 'astronaut';
  enabled = true;

  private mesh!: Mesh;
  private mat!: RawShaderMaterial;
  private maskMesh!: Mesh;
  private maskRT!: WebGLRenderTarget;
  private ringshine: RingshineTable | null = null;
  private size = new Vector3(1, 1.9, 1);
  /** wall-clock seconds of idle motion */
  private tReal = 0;
  private frame = 0;
  private shown = false;
  private dist = DIST0;
  private readonly rsVec = new Vector3();
  private readonly q = new Quaternion();
  private readonly qTmp = new Quaternion();
  private readonly m4 = new Matrix4();
  private readonly shInfo = { value: new Vector4(0.05, 0, LOD_CLASSES, 4000) };
  private readonly u = {
    uAstroRot: { value: new Matrix3() },
    uAstroPos: { value: new Vector3(0, 0, -DIST0) },
    uNearBeta: { value: new Vector2(0.719, 0.55) },
    uAstroPlaneW: { value: 1 },
    uAstroRs: { value: new Vector3() },
    uNearQuality: { value: 2 },
  };

  init(ctx: PipelineContext): void {
    const geom: BufferGeometry = buildAstronautGeometry();
    const bb = geom.boundingBox!;
    bb.getSize(this.size);
    // shadows of the near-field particles: the near pass shares its sun shadow map (when it exists)
    const ns = ctx.nearShadow;
    const shadowU: Record<string, IUniform> = ns
      ? { uShU: ns.uniforms.uShU, uShV: ns.uniforms.uShV, uShPen: ns.uniforms.uShPen, tShadow: ns.uniforms.tShadow, uNearAllocD: ns.uniforms.uNearAllocD }
      : { uShU: { value: new Vector4(1, 0, 0, 1) }, uShV: { value: new Vector4(0, 0, 1, 1) }, uShPen: { value: new Vector4() }, uNearAllocD: { value: new Float32Array(LOD_CLASSES) } };
    // Saturn's ring-lit night side (the far pass's ringshine table), when the far pass provides it
    const rsTab = ctx.ringshineTable;
    const head = (rsTab ? '#define ASTRO_RINGSHINE\n' : '') + SV_HEADER_ALL + '\n' + NEAR_SHADOW_COMMON_GLSL + '\n';
    this.mat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: head + nearCommon + '\n' + astroVert,
      fragmentShader: head + (ns ? NEAR_SHADOW_LOOKUP_GLSL : NO_SHADOW_LOOKUP) + '\n' + astroFrag,
      uniforms: { ...ctx.shared.u, ...shadowU, uShInfo: this.shInfo, ...this.u, uRingshineTab: { value: rsTab ?? null } },
      depthTest: true,
      depthWrite: true,
      depthFunc: LessEqualDepth,
      blending: NoBlending,
      side: FrontSide,
    });
    this.mesh = new Mesh(geom, this.mat);
    this.mesh.frustumCulled = false;
    this.ringshine = new RingshineTable(ctx.shared.u, ctx.profile);
    // exposure-meter mask (R8 at the render resolution)
    this.maskRT = new WebGLRenderTarget(Math.max(1, ctx.width), Math.max(1, ctx.height), {
      format: RedFormat, type: UnsignedByteType, minFilter: NearestFilter, magFilter: NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    const maskMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: MASK_VERT,
      fragmentShader: MASK_FRAG,
      uniforms: { uAstroRot: this.u.uAstroRot, uAstroPos: this.u.uAstroPos, uProj: ctx.shared.u.uProj, tScene: { value: ctx.sceneRT.texture } },
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      side: FrontSide,
    });
    this.maskMesh = new Mesh(geom, maskMat);
    this.maskMesh.frustumCulled = false;
  }

  resize(ctx: PipelineContext): void {
    this.maskRT?.setSize(Math.max(1, ctx.width), Math.max(1, ctx.height));
    if (this.maskMesh) (this.maskMesh.material as RawShaderMaterial).uniforms.tScene.value = ctx.sceneRT.texture;
  }

  render(f: FrameState, ctx: PipelineContext): void {
    this.shown = f.settings.astronaut;
    if (!this.shown) return;
    this.frame++;
    this.tReal += Math.min(Math.max(f.dtReal, 0), 0.25);
    this.place(f);
    this.environment(f, ctx);
    const r = ctx.renderer;
    ctx.nearShadow?.prepare(r);
    r.setRenderTarget(ctx.sceneRT);
    r.render(this.mesh, fsCamera);
    // its visible pixels, left out of the auto-exposure meter (the scene keeps the exposure it has without it)
    r.setRenderTarget(this.maskRT);
    r.state.buffers.color.setMask(true);
    (r.getContext() as WebGL2RenderingContext).clearBufferfv(WebGL2RenderingContext.COLOR, 0, ZERO4F);
    r.render(this.maskMesh, fsCamera);
    const [x0, x1] = this.screenSpanX(f, ctx.width);
    ctx.meterMask = { texture: this.maskRT.texture, frame: f.frameIndex, x0, x1 };
    r.setRenderTarget(ctx.sceneRT);
  }

  /** Horizontal extent (render pixels, 2 px margin) of the body's bounding box on screen. */
  private screenSpanX(f: FrameState, width: number): [number, number] {
    const tanH = Math.tan(f.fovY / 2), aspect = f.aspect;
    const R = this.u.uAstroRot.value.elements, T = this.u.uAstroPos.value;
    const hx = this.size.x / 2, hy = this.size.y / 2, hz = this.size.z / 2;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 8; i++) {
      const bx = i & 1 ? hx : -hx, by = i & 2 ? hy : -hy, bz = i & 4 ? hz : -hz;
      // view = R b + T (Matrix3 elements are column-major)
      const vx = R[0] * bx + R[3] * by + R[6] * bz + T.x;
      const vz = R[2] * bx + R[5] * by + R[8] * bz + T.z;
      const px = ((vx / Math.max(-vz, 1e-3) / (tanH * aspect)) * 0.5 + 0.5) * width;
      lo = Math.min(lo, px);
      hi = Math.max(hi, px);
    }
    return [Math.floor(lo) - 2, Math.ceil(hi) + 2];
  }

  /** Body pose in camera space: fixed screen position, 3/4 view, slow idle motion on wall-clock time. */
  private place(f: FrameState): void {
    const tanH = Math.tan(f.fovY / 2), aspect = f.aspect;
    const hb = this.size.y, wb = Math.max(this.size.x, this.size.z);
    // farther for narrow fields of view / aspect ratios, so that it always fits lower right
    const d = (this.dist = Math.max(DIST0 * (Math.tan(Math.PI / 6) / tanH), DIST0, hb / (2 * MAX_H_FRAC * tanH), wb / (MAX_W_NDC * tanH * aspect)));
    const t = this.tReal, tw = 2 * Math.PI;
    const pos = this.u.uAstroPos.value;
    pos.set(NDC_X * tanH * aspect * d, NDC_Y * tanH * d, -d);
    pos.x += 0.03 * Math.sin((tw * t) / 19 + 0.4);
    pos.y += 0.025 * Math.sin((tw * t) / 13 + 1.1);
    pos.z += 0.02 * Math.sin((tw * t) / 31 + 2.3);
    // face the camera (body +z toward it, +y screen-up), turned toward the screen centre, leaning back a little
    const toCam = new Vector3().copy(pos).multiplyScalar(-1).normalize();
    const xb = new Vector3(0, 1, 0).cross(toCam).normalize();
    const yb = new Vector3().crossVectors(toCam, xb);
    this.q.setFromRotationMatrix(this.m4.makeBasis(xb, yb, toCam));
    const yaw = YAW0 + 0.21 * Math.sin((tw * t) / 23 + 0.7);
    const pitch = PITCH0 + 0.085 * Math.sin((tw * t) / 17 + 1.9);
    const roll = ROLL0 + 0.07 * Math.sin((tw * t) / 29 + 3.1);
    this.q.multiply(this.qTmp.setFromAxisAngle(new Vector3(0, 1, 0), yaw));
    this.q.multiply(this.qTmp.setFromAxisAngle(new Vector3(1, 0, 0), pitch));
    this.q.multiply(this.qTmp.setFromAxisAngle(new Vector3(0, 0, 1), roll));
    this.u.uAstroRot.value.setFromMatrix4(this.m4.makeRotationFromQuaternion(this.q));
  }

  /** Per-frame lighting inputs that do not vary over the body. */
  private environment(f: FrameState, ctx: PipelineContext): void {
    // two-stream back-scatter fractions of the particle phase function (as the near field and the medium)
    const pt = phaseTables(1);
    const mu = Math.min(1, Math.abs(f.sunDir.z)) * (PHASE_LUT_N - 1);
    const i0 = Math.min(PHASE_LUT_N - 2, Math.floor(mu));
    this.u.uNearBeta.value.set(pt.betaMacro, pt.beta0Macro[i0] + (pt.beta0Macro[i0 + 1] - pt.beta0Macro[i0]) * (mu - i0));
    // near the rings the layer fills half the sky (plane-parallel field); far away it is a distant source
    const wPlane = 1 - smooth(PLANE_H0, PLANE_H1, Math.abs(f.camPos.z));
    this.u.uAstroPlaneW.value = wPlane;
    if (wPlane < 1 && this.ringshine) {
      if (this.frame % 4 === 1) this.ringshine.irradianceVector(f.camPos, f.sunDir, f.solarIrradiance, f.sunAngularRadius, this.rsVec);
      this.u.uAstroRs.value.copy(this.rsVec).multiplyScalar(1 - wPlane);
    } else this.u.uAstroRs.value.set(0, 0, 0);
    // the near field's shadow map only holds this frame's particles when it was rendered this frame
    const ns = ctx.nearShadow;
    const sh = this.shInfo.value;
    if (ns) sh.copy(ns.uniforms.uShInfo.value as Vector4);
    if (!ns || ns.frame !== f.frameIndex) sh.y = 0;
  }

  stats(): Record<string, string | number> {
    const tris = this.mesh?.geometry.index ? this.mesh.geometry.index.count / 3 : 0;
    return this.shown ? { shown: `yes, ${this.dist.toFixed(1)} m away (${(tris / 1000).toFixed(1)}k triangles)` } : { shown: 'no (V)' };
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.mat?.dispose();
    (this.maskMesh?.material as RawShaderMaterial | undefined)?.dispose();
    this.maskRT?.dispose();
    this.ringshine?.dispose();
  }
}
