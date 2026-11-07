// STUB far-field pass (to be replaced by the full implementation): ray-traced Saturn with ring shadows,
// Sun disk, moons as Lambert spheres. Writes rgb radiance + distance, and log depth.
import { AlwaysDepth, RawShaderMaterial } from 'three';
import type { FrameState } from '../../../core/FrameState';
import type { PipelineContext, RenderPass } from '../../Pipeline';
import { FullscreenPass } from '../../fullscreen';
import { SV_HEADER_ALL } from '../../shaders/chunks';

const FRAG = /* glsl */ `
${SV_HEADER_ALL}
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec3 rd = cameraRayDir(vUv);
  vec3 col = vec3(0.0);
  float dist = SKY_DIST;
  if (dot(rd, uSunDir) > cos(uSunAngRadius)) col = vec3(uSunRadiance);
  vec2 t = saturnIntersect(vec3(0.0), rd);
  if (t.x <= t.y && t.y > 0.0) {
    float th = t.x > 0.0 ? t.x : t.y;
    vec3 p = rd * th;
    vec3 n = saturnNormal(p - uSaturnCenter);
    float mu0 = max(dot(n, uSunDir), 0.0);
    float T = ringSunTransmission(p, th * uPixelAngle);
    col = vec3(0.55, 0.48, 0.36) * INV_PI * uSunE * mu0 * T * moonsSunVisibility(p, -1);
    dist = th;
  }
  for (int i = 0; i < MAX_MOONS; i++) {
    if (i >= uMoonCount) break;
    vec3 c = uMoonPosR[i].xyz;
    float R = uMoonPosR[i].w;
    float b = dot(c, rd);
    vec3 q = c - b * rd;
    float h2 = R * R - dot(q, q);
    if (h2 < 0.0) continue;
    float tt = b - sqrt(h2);
    if (tt <= 0.0 || tt >= dist) continue;
    vec3 p = rd * tt;
    vec3 n = normalize(p - c);
    float mu0 = max(dot(n, uSunDir), 0.0);
    col = vec3(0.6) * INV_PI * uSunE * mu0 * saturnSunVisibility(p) * ringSunTransmission(p, 0.0);
    dist = tt;
  }
  outColor = vec4(col, dist);
  gl_FragDepth = dist >= SKY_DIST ? 1.0 : logDepth01(dist * (-(uWorldToCam * rd).z));
}`;

export class FarFieldStub implements RenderPass {
  readonly name = 'far';
  enabled = true;
  private fs!: FullscreenPass;

  init(ctx: PipelineContext): void {
    this.fs = new FullscreenPass({
      fragmentShader: FRAG,
      uniforms: { ...ctx.shared.u },
      depthTest: true,
      depthWrite: true,
      depthFunc: AlwaysDepth,
    });
  }
  render(_f: FrameState, ctx: PipelineContext): void {
    this.fs.render(ctx.renderer, ctx.sceneRT);
  }
  get material(): RawShaderMaterial {
    return this.fs.material;
  }
}
