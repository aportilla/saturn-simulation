// ===== propeller moonlets: vertex shader (src/render/passes/PropellerMoonletPass.ts) ======================
// One instanced box around each moonlet's ellipsoid; the fragment shader ray-traces the body. Requires SV_HEADER_ALL.
in vec3 position;     // unit box corner, [-1, 1]^3
in vec3 iPos;         // moonlet centre relative to the camera (SEF, m)
in vec4 iAxis;        // (radial unit vector x, y in the ring plane (the long axis points at Saturn), shadow sphere index + 1
                      //  (0: none), seed)
in vec4 iSize;        // semi-axes (radial, along the orbit, polar) (m), albedo factor
in vec4 iPhot;        // per-moonlet photometry: (regolith factor f(alpha) at its phase angle, -, -, -)

out vec3 vP;          // camera-relative position on the box (m)
flat out vec3 vC;
flat out vec4 vAxis;
flat out vec4 vSize;
flat out vec4 vPhot;

void main() {
  vec3 ex = vec3(iAxis.xy, 0.0), ez = vec3(0.0, 0.0, 1.0), ey = cross(ez, ex);
  vec3 lp = position * iSize.xyz * 1.04;
  vec3 p = iPos + ex * lp.x + ey * lp.y + ez * lp.z;
  vP = p;
  vC = iPos;
  vAxis = iAxis;
  vSize = iSize;
  vPhot = iPhot;
  vec3 v = uWorldToCam * p;
  gl_Position = uProj * vec4(v, 1.0);
  // (the fragment writes its own log depth; any z inside the clip volume will do here)
  gl_Position.z = logDepthClipZ(max(gl_Position.w, 1e-6));
}
