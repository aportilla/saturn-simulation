// STUB ring-layer pass (to be replaced by the full implementation): classical thin-sheet single
// scattering over the scene, using the shared profile. Reads ctx.sceneRT, writes ctx.hdrRT.
import type { FrameState } from '../../../core/FrameState';
import type { PipelineContext, RenderPass } from '../../Pipeline';
import { FullscreenPass } from '../../fullscreen';
import { SV_HEADER_ALL } from '../../shaders/chunks';

const FRAG = /* glsl */ `
${SV_HEADER_ALL}
uniform sampler2D tScene;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 sc = texture(tScene, vUv);
  vec3 rd = cameraRayDir(vUv);
  vec3 col = sc.rgb;
  float camZ = uCamPos.z;
  if (abs(rd.z) > 1e-7) {
    float t = -camZ / rd.z;
    if (t > 0.0 && t < sc.a) {
      vec3 p = rd * t;
      float r = ringRadiusRel(p);
      float fp = t * uPixelAngle / max(abs(rd.z), 0.02);
      RingSample s = ringSample(r, fp);
      if (s.tau > 0.0) {
        float mu = abs(rd.z), mu0 = max(abs(uSunDir.z), 1e-3);
        bool lit = (camZ * uSunDir.z) > 0.0;
        float P = ringPhase(dot(uSunDir, -rd), s.dust);
        float vis = saturnSunVisibility(p) * moonsSunVisibility(p, -1);
        vec3 w0 = s.albedo;
        vec3 IF;
        if (lit) IF = w0 * P * 0.25 * mu0 / (mu + mu0) * (1.0 - exp(-s.tau * (1.0 / mu + 1.0 / mu0)));
        else {
          float d = mu - mu0;
          IF = abs(d) < 1e-4 ? w0 * P * 0.25 * s.tau / mu0 * exp(-s.tau / mu0)
                             : w0 * P * 0.25 * mu0 / d * (exp(-s.tau / mu) - exp(-s.tau / mu0));
        }
        col = sc.rgb * exp(-s.tau / mu) + IF * uSunE * INV_PI * vis;
      }
    }
  }
  outColor = vec4(col, 1.0);
}`;

export class RingLayerStub implements RenderPass {
  readonly name = 'rings';
  enabled = true;
  private fs!: FullscreenPass;

  init(ctx: PipelineContext): void {
    this.fs = new FullscreenPass({ fragmentShader: FRAG, uniforms: { ...ctx.shared.u, tScene: { value: ctx.sceneRT.texture } } });
  }
  resize(ctx: PipelineContext): void {
    this.fs.material.uniforms.tScene.value = ctx.sceneRT.texture;
  }
  render(_f: FrameState, ctx: PipelineContext): void {
    this.fs.material.uniforms.tScene.value = ctx.sceneRT.texture;
    this.fs.render(ctx.renderer, ctx.hdrRT);
  }
}
