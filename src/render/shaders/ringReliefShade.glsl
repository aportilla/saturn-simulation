// ===== sv_ringReliefShade ===================================================================
// Geometry and lighting of the relief height field z0 (sv_ringStructure ringStreamRelief: the moonlets' streamline
// height + the sv_ringRelief sources) for every renderer: the local mid-plane normal, the solar incidence on each face
// of the tilted layer (extended solar disk), relief shadows (horizon toward the Sun over the shadow length h / tan B,
// transmission through an occluding layer), and the ray's first intersection with the displaced mid-plane.
// Included after sv_ringStructure (needs sv_common, sv_ringProfile, sv_ringRelief, sv_ringStructure).
// API:
//   vec3  ringReliefNormal(slope, eR, eP)          unit normal of the mid-plane (SEF) from (dz0/dr, dz0/(r dth))
//   vec2  ringReliefSunMu(n)                       mean solar incidence cosine on the face n points to (x) and the other
//                                                  face (y): the Sun as a disk of uSunAngRadius (the terminator of a tilt
//                                                  is soft; the flat ring at equinox gets ~R_sun / 5, not 0)
//   float ringReliefBound(dr)                      bound of |z0| near the Eulerian offset dr (sources + moonlet zeta)
//   float ringReliefSunVis(aL, dth, hp, tau, fp)   visible fraction of the Sun at a point of the surface (relief shadows)
//   float ringReliefHit(rd, zc, tP, fp, out st)    first intersection of a camera ray with z = z0 (camera-relative t)
#ifndef SV_RING_RELIEF_SHADE
#define SV_RING_RELIEF_SHADE

uniform vec4 uRrMlEdge[RS_MOONLETS];   // per moonlet: (inner gap edge, outer gap edge (a' - r0) [m], |zeta| bound [m], -)
uniform vec4 uRrCamN;                  // camera: local mid-plane slope (dz0/dx, dz0/dy) in the frame axes, relief bound
                                       // near the camera (march slab) [m], 1 = relief within the near field's reach

vec3 ringReliefNormal(vec2 slope, vec3 eR, vec3 eP) {
  return normalize(vec3(0.0, 0.0, 1.0) - slope.x * eR - slope.y * eP);
}

// mean of max(sin(elevation), 0) over the solar disk at elevation asin(s) (uniform disk)
float ringReliefSunMuExt(float s, float rs) {
  float x = asin(clamp(s, -1.0, 1.0)) / max(rs, 1e-7);
  if (x >= 1.0) return max(s, 0.0);
  if (x <= -1.0) return 0.0;
  float q = sqrt(max(1.0 - x * x, 0.0));
  return rs * (x * (0.5 * PI + x * q + asin(x)) + (2.0 / 3.0) * q * q * q) * INV_PI;
}
vec2 ringReliefSunMu(vec3 n) {
  float s = dot(uSunDir, n);
  return vec2(ringReliefSunMuExt(s, uSunAngRadius), ringReliefSunMuExt(-s, uSunAngRadius));
}

float ringReliefBound(float dr) {
  float b = rrBound(dr);
  for (int k = 0; k < RS_MOONLETS; k++) {
    vec4 P0 = uRsMl[3 * k], P2 = uRsMl[3 * k + 2];
    if (P0.w != 0.0 && abs(dr - P0.x) < P2.y + 3.0 * P0.z) b += uRrMlEdge[k].z * abs(P0.w);
  }
  return b;
}

// Moonlet (Pan, Daphnis) vertical edge waves as occluders: the Sun's ray from the point crosses each gap edge's
// material band; zeta is sampled at the edge streamline and 0.6 / 1.5 Hill radii into the ring (sun-side heights).
float rrMoonletSunVis(float aL, float dth, float hp, float cr, float ct, float tanB, float rs, float tau, float sg, float fp) {
  float vis = 1.0;
  float tanLo = max(tan(atan(tanB) - rs), 2e-5);
  float rp = uRingR0 + aL;
  for (int k = 0; k < RS_MOONLETS; k++) {
    vec4 P0 = uRsMl[3 * k];
    vec4 E = uRrMlEdge[k];
    if (P0.w == 0.0 || E.z <= 0.0) continue;
    float uMax = (E.z * abs(P0.w) + abs(hp)) / tanLo;
    float best = -1e9, invMu = 1.0, uBest = 1.0;
    for (int e = 0; e < 2; e++) {
      float aE = e == 0 ? E.x : E.y;
      float into = e == 0 ? -1.0 : 1.0;
      for (int j = 0; j < 3; j++) {
        float aS = aE + into * P0.z * (j == 0 ? 0.0 : (j == 1 ? 0.6 : 1.5));
        float u = rrRayReach(rp, cr, aS - aL);
        if (u <= 0.0 || u > uMax) continue;
        float dthS = dth + atan(u * ct, rp + u * cr);
        vec3 rr = vec3(0.0), zz = vec3(0.0);
        // the occluder at full resolution: its shadow (~zeta / tan B, hundreds of km near equinox) is resolved even
        // when the edge wave itself is below the footprint
        rsMoonlet(k, aS, dthS, 0.0, true, rr, zz);
        float th = (sg * zz.x - hp) / u;
        if (th > best) {
          best = th;
          uBest = u;
          invMu = 1.0 / max(sin(atan(abs(zz.y * cr) + abs(zz.z * ct)) + atan(tanB)), 0.02);
        }
      }
    }
    if (best > -1e8) {
      // averaged over the pixel footprint: the occluder's elevation th = dz / u spreads by th fp / u across it (a shadow
      // narrower than the footprint darkens the pixel partly instead of aliasing into isolated dark pixels)
      float pen = 0.5 * abs(best) * fp / max(uBest, 1.0);
      float v = rrDiskVis(best, tanB, sqrt(rs * rs + pen * pen));
      vis *= v + (1.0 - v) * exp(-tau * invMu);
    }
  }
  return vis;
}

// Visible fraction of the Sun at a surface point (Lagrangian offset aL, azimuth offset dth, mid-plane height hp = z0
// there, local optical depth tau, footprint fp) after the relief's shadows. The geometry is mirrored to the lit side
// (sg = sign of the Sun's elevation): occluders are the sun-side extremes of the relief.
float ringReliefSunVis(float aL, float dth, float hp, float tau, float fp) {
  if (uRrOn < 0.5 && uRsOn < 0.5) return 1.0;
  float sz = uSunDir.z;
  float sg = sz >= 0.0 ? 1.0 : -1.0;
  vec2 sh = vec2(dot(uSunDir, uRingER), dot(uSunDir, uRingEPhi));   // horizontal Sun, frame-origin axes
  float shl = length(sh);
  if (shl < 1e-6) return 1.0;
  float tanB = abs(sz) / shl;
  // the point's own radial / azimuthal axes: rotate by dth
  float c = cos(dth), s = sin(dth);
  float cr = (sh.x * c + sh.y * s) / shl, ct = (-sh.x * s + sh.y * c) / shl;
  float rs = uSunAngRadius;
  float vis = 1.0;
  if (uRrOn > 0.5) {
    // sun-side heights of the sources at the point (waves: the corrugation and bending waves are symmetric; the
    // mirrored crests are the troughs, handled by the phase shift inside; sites always rise toward the lit side)
    vec3 hw = rrWaves(aL, dth, fp);
    vec3 hs = rrSites(aL, dth, fp);
    vis *= rrSourcesSunVisSided(aL, dth, cr, ct, tanB, rs, tau, vec2(sg * hw.x, hs.x * sg), sg, fp);
  }
  if (uRsOn > 0.5) vis *= rrMoonletSunVis(aL, dth, sg * hp, cr, ct, tanB, rs, tau, sg, fp);
  return vis;
}

// First intersection of the camera ray rd (camera at height zc above the SEF plane in the local frame) with the
// displaced mid-plane z = z0, near its plane hit tP; fp = radial footprint at the plane hit. Marches the ray across the
// relief slab |z| <= bound (<= 24 samples, 250 m apart or fewer), then regula falsi on the first sign change of
// f(t) = z(t) - z0(t). Returns the plane hit when the relief cannot move the hit by 0.3 footprints. st: the structure
// state at the hit (da, J, zeta, slope).
float ringReliefHit(vec3 rd, float zc, float tP, float fp, out RingStream st) {
  vec3 p0 = rd * tP;
  vec3 l0 = ringLocalFromRel(p0);
  float dr0 = ringDrFromLocal(l0);
  float dth0 = atan(l0.y, uRingR0 + l0.x);
  st = ringStreamRelief(dr0, dth0, fp);
  float zB = ringReliefBound(dr0);
  float az = max(abs(rd.z), 1e-6);
  float hz = length(rd.xy) / az;            // horizontal shift per metre of height
  if (zB <= 0.0 || zB * hz < 0.3 * fp) return tP;
  float tIn = abs(zc) > zB ? (zc > 0.0 ? zB - zc : -zB - zc) / rd.z : 0.0;
  float tOut = (zc > 0.0 ? -zB - zc : zB - zc) / rd.z;
  if (!(tOut > tIn)) return tP;
  float Lh = (tOut - tIn) * length(rd.xy);
  int n = int(clamp(ceil(Lh / 250.0), 2.0, 24.0));
  float dt = (tOut - tIn) / float(n);
  // the camera's side of the surface: at the slab boundary the ray is on it; a camera inside the relief slab compares
  // with the mid-plane height under itself (uRsCam.y)
  float fa = tIn > 0.0 ? (zc > 0.0 ? zB : -zB) : zc - uRsCam.y;
  float side = fa >= 0.0 ? 1.0 : -1.0;
  float ta = tIn;
  RingStream sb;
  for (int i = 1; i <= 24; i++) {
    if (i > n) break;
    float tb = tIn + dt * float(i);
    vec3 lb = ringLocalFromRel(rd * tb);
    sb = ringStreamRelief(ringDrFromLocal(lb), atan(lb.y, uRingR0 + lb.x), fp);
    float fb = zc + rd.z * tb - sb.zeta;
    if (fb * side <= 0.0) {
      // Illinois regula falsi on [ta, tb] (the end kept twice in a row has its value halved: no one-sided stagnation)
      float t0 = ta, f0 = fa, t1 = tb, f1 = fb;
      st = sb;
      for (int k = 0; k < 6; k++) {
        if (f1 == f0) break;
        float tm = t1 - f1 * (t1 - t0) / (f1 - f0);
        vec3 lm = ringLocalFromRel(rd * tm);
        RingStream sm = ringStreamRelief(ringDrFromLocal(lm), atan(lm.y, uRingR0 + lm.x), fp);
        float fm = zc + rd.z * tm - sm.zeta;
        if (fm * f1 < 0.0) { t0 = t1; f0 = f1; } else { f0 *= 0.5; }
        t1 = tm;
        f1 = fm;
        st = sm;
      }
      return t1;
    }
    ta = tb;
    fa = fb;
  }
  return tP;
}

#endif
