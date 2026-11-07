// Optional GPU timing of a pass (EXT_disjoint_timer_query_webgl2). Queries are never nested by design:
// begin()/end() bracket one pass's draw calls; results are polled a few frames later.
export class GpuTimer {
  private gl: WebGL2RenderingContext;
  private ext: any;
  private pool: WebGLQuery[] = [];
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  /** smoothed GPU time (ms) */
  ms = 0;

  constructor(gl: WebGL2RenderingContext, enabled: boolean) {
    this.gl = gl;
    this.ext = enabled ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  }
  get available(): boolean {
    return !!this.ext;
  }
  begin(): void {
    if (!this.ext || this.active || this.pending.length > 4) return;
    const q = this.pool.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }
  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }
  poll(): void {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.pending.shift();
      this.pool.push(q);
      if (!disjoint) this.ms = this.ms === 0 ? ns * 1e-6 : this.ms * 0.9 + ns * 1e-7;
    }
  }
}
