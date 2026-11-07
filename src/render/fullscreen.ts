// Fullscreen-triangle helpers for screen-space passes.
import {
  BufferAttribute, BufferGeometry, GLSL3, Mesh, OrthographicCamera, RawShaderMaterial,
  type WebGLRenderer, type WebGLRenderTarget, type ShaderMaterialParameters,
} from 'three';

let _geom: BufferGeometry | null = null;
export function fullscreenGeometry(): BufferGeometry {
  if (_geom) return _geom;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  _geom = g;
  return g;
}
export const fsCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** Vertex shader for fullscreen passes (GLSL3). Provides vUv in [0,1]^2. */
export const FS_VERT = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class FullscreenPass {
  readonly mesh: Mesh;
  readonly material: RawShaderMaterial;
  constructor(params: ShaderMaterialParameters & { fragmentShader: string }) {
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FS_VERT,
      depthTest: false,
      depthWrite: false,
      ...params,
    });
    this.mesh = new Mesh(fullscreenGeometry(), this.material);
    this.mesh.frustumCulled = false;
  }
  render(renderer: WebGLRenderer, target: WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, fsCamera);
  }
  dispose(): void {
    this.material.dispose();
  }
}
