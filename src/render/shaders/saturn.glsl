// ===== sv_saturn ============================================================================
// Saturn's 1-bar oblate spheroid: ray intersection, surface normal, and occultation of the Sun.
// Requires sv_common.
#ifndef SV_SATURN
#define SV_SATURN

uniform vec3 uSaturnCenter;   // Saturn's center relative to the camera (m) (= -camPos)
uniform vec2 uSaturnRadii;    // (equatorial, polar) radii (m)
uniform float uSaturnRot;     // System III prime meridian angle W (rad), SEF, from +X toward +Y

// Intersect a ray (camera-relative origin ro, unit direction rd) with the 1-bar ellipsoid.
// Returns (tNear, tFar) in meters along rd; tNear > tFar means no hit.
vec2 saturnIntersect(vec3 ro, vec3 rd) {
  float k = uSaturnRadii.x / uSaturnRadii.y;
  vec3 o = (ro - uSaturnCenter) / uSaturnRadii.x;
  o.z *= k;
  vec3 d = rd;
  d.z *= k;
  float dl = length(d);
  d /= dl;
  float b = dot(o, d);
  vec3 qc = o - b * d;
  float h = 1.0 - dot(qc, qc);
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  float s = uSaturnRadii.x / dl;
  return vec2((-b - h) * s, (-b + h) * s);
}

// Outward unit normal at a point p given RELATIVE TO SATURN'S CENTER (m).
vec3 saturnNormal(vec3 pc) {
  vec2 R = uSaturnRadii;
  return normalize(vec3(pc.x / (R.x * R.x), pc.y / (R.x * R.x), pc.z / (R.y * R.y)));
}

// Fraction of the solar disk visible from camera-relative point p, considering occultation by Saturn
// (soft penumbra from the Sun's finite angular size; oblateness handled by z-scaling).
float saturnSunVisibility(vec3 p) {
  float k = uSaturnRadii.x / uSaturnRadii.y;
  vec3 o = (p - uSaturnCenter) / uSaturnRadii.x;
  o.z *= k;
  vec3 d = uSunDir;
  d.z *= k;
  d = normalize(d);
  float dist = length(o);
  if (dist <= 1.0) return 0.0;
  float angS = asin(clamp(1.0 / dist, 0.0, 1.0));
  float sep = acos(clamp(dot(-o / dist, d), -1.0, 1.0));
  return smoothstep(angS - uSunAngRadius, angS + uSunAngRadius, sep);
}

#endif
