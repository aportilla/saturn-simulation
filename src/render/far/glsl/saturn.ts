// Saturn's visible atmosphere for the far-field ray tracer. Requires sv_common, sv_saturn, sv_ringProfile,
// sv_lighting and FAR_NOISE_GLSL.
//
// Model:
//  * cloud deck = the 1-bar spheroid; Minnaert reflectance I/F = A mu0^k mu^(k-1) with a latitude palette
//    (saturnModel.ts) perturbed by procedural turbulence (domain-warped simplex fbm, streak-stretched along
//    longitude), advected by the zonal wind profile relative to System III with two crossfaded phases
//    (bounded shear), plus the 78N hexagon, polar vortices, the 47N ribbon wave and discrete storms;
//  * an exponential haze + Rayleigh shell (H = 60 / 45 km) integrated in single scattering along the view
//    ray (Chapman-function solar attenuation, Saturn's penumbral shadow, ring shadow) -> limb haze, soft
//    terminator/twilight, forward-scattering glow at high phase;
//  * direct-sun shadows: rings (ringSunTransmission with a ray-differential + solar-disk footprint) and moons;
//  * ringshine from a per-frame table of the irradiance by the lit (or diffusely transmitting) rings.
import { MAX_STORMS } from '../saturnModel';

export const FAR_SATURN_GLSL = /* glsl */ `
#define MAX_STORMS ${MAX_STORMS}
#define SAT_H_TOP 700e3
uniform sampler2D uSatLut;
uniform vec4 uSatAdv;          // (tau0, tau1, w0, w1)
uniform vec3 uSatSeed0;
uniform vec3 uSatSeed1;
uniform int uStormCount;
uniform vec4 uStormA[MAX_STORMS];  // xyz: unit centre (body frame), w: angular radius (rad)
uniform vec4 uStormB[MAX_STORMS];  // x: kind, y: strength, z: aspect, w: spin sign
uniform vec4 uSatPolar;        // x: hexagon vertex longitude (rad), y: N vortex spin, z: S vortex spin, w: ribbon phase
uniform sampler2D uRingshine;  // (E_ring / E_sun) rgb; u = (dLon + pi)/2pi, v = (latG + pi/2)/pi
uniform float uRingshineOn;
uniform sampler2D uSatTex;
uniform vec4 uSatTexInfo;      // x: on, y: u of lon 0, z: +1 east-right / -1 west-right, w: width (texels)
uniform vec3 uSatTexGain;
uniform vec3 uSatHazeTau;      // vertical optical depth of the haze shell (rgb)
uniform vec3 uSatRayTau;       // vertical Rayleigh optical depth above the deck (rgb)
uniform vec3 uSatDeckComp;     // deck albedo compensation for the shell attenuation
uniform int uFarDebug;         // 0 off, 1 ringshine irradiance, 2 deck albedo

const vec3 SAT_K = vec3(0.90, 0.88, 0.84);
const float SAT_RCURV_POLE = 66812e3;   // a^2/b (m)

// Moon occultation of the solar disk, like sv_lighting's moonsSunVisibility but with the Sun-moon separation
// from atan2(|c x s|, c.s): acos of a dot product near 1 has a float32 resolution (~3.5e-4 rad) comparable to
// the Sun's angular radius at Saturn (4.9e-4 rad), which speckles penumbrae.
float farMoonsSunVisibility(vec3 p, int skipIndex) {
  float vis = 1.0;
  for (int i = 0; i < MAX_MOONS; i++) {
    if (i >= uMoonCount) break;
    if (i == skipIndex) continue;
    vec3 c = uMoonPosR[i].xyz - p;
    float cs = dot(c, uSunDir);
    if (cs <= 0.0) continue;
    float R = uMoonPosR[i].w;
    float d = length(c);
    if (d <= R) return 0.0;
    float angM = asin(R / d);
    float sep = atan(length(cross(c, uSunDir)), cs);
    if (sep >= angM + uSunAngRadius) continue;
    vis *= 1.0 - diskOverlapFraction(sep, uSunAngRadius, angM);
  }
  return vis;
}

vec4 satLut0(float latG) { return texture(uSatLut, vec2((latG + 0.5 * PI) * INV_PI, 0.25)); }
vec4 satLut1(float latG) { return texture(uSatLut, vec2((latG + 0.5 * PI) * INV_PI, 0.75)); }

// Albedo of the cloud deck at body-frame unit direction u (planetographic latitude latG, east lon lonE).
// fpU = surface footprint of the pixel in units of R_eq (drives the noise LOD).
vec3 saturnAlbedo(vec3 u, float latG, float lonE, float fpU) {
  vec4 l1 = satLut1(latG);
  float omega = l1.r * 1e-6;
  float stretch = l1.b;
  float cl = cos(latG), sl = sin(latG);
  // LOD: detail octaves from frequency 36 until features reach ~2 pixels
  float octD = clamp(log2(max(1.0 / (2.5 * max(fpU, 1e-7)), 1.0) / 36.0) + 1.0, 0.0, 9.0);
  float octL = clamp(log2(max(1.0 / (2.5 * max(fpU, 1e-7)), 1.0) / 14.0) + 1.0, 0.0, 4.0);
  float nl = 0.0, nd = 0.0;
  float wsum2 = 0.0;
  for (int k = 0; k < 2; k++) {
    float w = k == 0 ? uSatAdv.z : uSatAdv.w;
    if (w < 1e-3) continue;
    float tau = k == 0 ? uSatAdv.x : uSatAdv.y;
    vec3 seed = k == 0 ? uSatSeed0 : uSatSeed1;
    float lonA = lonE - omega * tau;
    vec3 q = vec3(cl * cos(lonA), cl * sin(lonA), sl * stretch);
    vec3 qs = q * 5.0 + seed;
    vec3 wv = vec3(snoise(qs), snoise(qs + vec3(31.4, 0.0, 0.0)), snoise(qs + vec3(0.0, 47.2, 0.0)));
    vec3 q2 = q + 0.03 * wv;
    float a = fbmL(q2 * 14.0 + seed.yzx, octL, 2.0, 0.6);
    float b = fbmL(q2 * 36.0 + seed.zxy * 1.3, octD, 2.03, 0.62);
    nl += w * a;
    nd += w * b;
    wsum2 += w * w;
  }
  float nrm = inversesqrt(max(wsum2, 1e-6));
  nl *= nrm;
  nd *= nrm;
  float latEff = latG + satLut0(latG).a * nl * 0.75;
  // 47N ribbon: a wavy jet (~50 wavelengths around), advected with the jet (phase from the CPU)
  float rib = exp(-0.5 * pow((latG - 0.8203) / 0.022, 2.0));
  latEff += rib * 0.006 * sin(50.0 * lonE + uSatPolar.w + 1.5 * nl);
  // north polar hexagon: band latitudes follow the hexagon shape inside ~72N
  vec3 col;
  float hexBand = 0.0, hexOut = 0.0;
  if (latG > 1.15) {
    // hexagonal radial coordinate q = s cos(phi): equal to the arc distance s from the pole at the side
    // midpoints, hexagon-shaped level sets (corners slightly rounded: asin(0.985 ...)), no medial-axis creases
    float s = (0.5 * PI - latG) * SAT_RCURV_POLE;            // arc distance from the pole (m)
    float ang = lonE - uSatPolar.x;                           // from a vertex
    float phi = asin(0.985 * cos(3.0 * ang)) / 3.0;
    const float aJet = 12.56e6;                               // apothem 12,560 km (14,500 km sides)
    // hexagonal shaping only around the jet; inner bands relax to circles
    float q = mix(s * 1.05, s * cos(phi), smoothstep(0.45 * aJet, 0.85 * aJet, s));
    float dq = q - aJet;
    float latHex = 0.5 * PI - (q + 1.0e6) / SAT_RCURV_POLE;   // bands concentric to the hexagon
    float wHex = smoothstep(1.17, 1.28, latG);
    latEff = mix(latEff, latHex + satLut0(latG).a * nl * 0.8, wHex);
    hexBand = wHex * exp(-0.5 * pow((dq + 0.15e6 * nl) / 0.55e6, 2.0));
    hexOut = wHex * exp(-0.5 * pow((dq - 1.5e6) / 0.7e6, 2.0));
  }
  if (uSatTexInfo.x > 0.5) {
    float uu = fract(uSatTexInfo.y + uSatTexInfo.z * lonE / TWO_PI);
    float lod = log2(max(fpU * uSatTexInfo.w / TWO_PI, 1e-3));
    col = textureLod(uSatTex, vec2(uu, 0.5 - latEff * INV_PI), lod).rgb * uSatTexGain;
  } else {
    col = satLut0(latEff).rgb;
  }
  col *= 1.0 - 0.22 * hexBand;
  col *= 1.0 + 0.07 * hexOut;
  // fine turbulent detail (slightly warmer where darker)
  float dc = l1.g * nd * 1.6;
  col *= vec3(1.0 + dc * 1.05, 1.0 + dc, 1.0 + dc * 0.9);
  // polar vortices
  if (abs(latG) > 1.35) {
    bool north = latG > 0.0;
    float s = (0.5 * PI - abs(latG)) * SAT_RCURV_POLE;
    float spin = north ? uSatPolar.y : uSatPolar.z;
    float ang = lonE + spin;
    float eye = north ? 1.0e6 : 3.6e6;     // eye radius: N ~2000 km wide, S ~8000 km wide
    float r = s / eye;
    float arms = 0.5 + 0.5 * sin(2.0 * ang - 4.5 * log(max(r, 0.05)) + 2.0 * nl);
    float armW = smoothstep(1.2, 1.8, r) * (1.0 - smoothstep(north ? 3.0 : 2.0, north ? 5.0 : 3.2, r));
    col *= 1.0 + 0.10 * (arms - 0.5) * armW;
    col *= mix(north ? 0.72 : 0.62, 1.0, smoothstep(0.75, 1.0, r + 0.1 * nd));   // dark eye
    col *= 1.0 + 0.16 * exp(-0.5 * pow((r - 1.15) / 0.18, 2.0));                    // bright eyewall
  }
  // discrete storms
  for (int i = 0; i < MAX_STORMS; i++) {
    if (i >= uStormCount) break;
    vec3 c = uStormA[i].xyz;
    float th = uStormA[i].w;
    vec3 dv = u - c;
    if (dot(dv, dv) > 9.0 * th * th * uStormB[i].z * uStormB[i].z) continue;
    vec3 ee = normalize(vec3(-c.y, c.x, 0.0));
    vec3 en = cross(c, ee);
    vec2 lp = vec2(dot(dv, ee) / uStormB[i].z, dot(dv, en)) / th;
    float r = length(lp);
    float kind = uStormB[i].x, str = uStormB[i].y;
    if (kind < 0.5) {
      // bright convective cloud: ragged, high and white
      float m = 1.0 - smoothstep(0.35, 1.1, r + 0.45 * nd + 0.25 * nl);
      col = mix(col, vec3(0.80, 0.78, 0.70) * 1.25, str * m);
    } else if (kind < 1.5) {
      // dark brownish anticyclonic oval with a lighter collar
      float core = 1.0 - smoothstep(0.55, 1.0, r);
      float collar = exp(-0.5 * pow((r - 1.1) / 0.18, 2.0));
      col *= mix(vec3(1.0), vec3(0.80, 0.74, 0.66), str * 4.0 * core);
      col *= 1.0 + 0.6 * str * collar;
    } else {
      // pale oval with a thin dark rim
      float core = 1.0 - smoothstep(0.6, 1.0, r);
      float rim = exp(-0.5 * pow((r - 1.02) / 0.1, 2.0));
      col *= 1.0 + str * core;
      col *= 1.0 - 0.8 * str * rim;
    }
  }
  return max(col, vec3(0.0));
}

// ---- haze shell helpers
// Chapman grazing-incidence function for a spherical exponential atmosphere, x = r/H, cosChi >= 0
float chapmanUp(float x, float cosChi) {
  float y = sqrt(0.5 * x) * cosChi;
  return sqrt(2.0 * x) / (y + sqrt(y * y + 1.2732395));
}
// Slant optical depth toward the Sun (per unit vertical optical depth at the deck, i.e. multiply by tau_v)
// from altitude h (m) at local radius R (m) with solar zenith cosine cosChi; H = scale height.
float slantFactor(float h, float R, float cosChi, float H) {
  float x = (R + h) / H;
  if (cosChi >= 0.0) return exp(-h / H) * chapmanUp(x, cosChi);
  float sinChi = sqrt(max(1.0 - cosChi * cosChi, 0.0));
  float hmin = (R + h) * sinChi - R;
  if (hmin < -2.0 * H) return 1e4;
  float xm = (R + hmin) / H;
  return 2.0 * exp(-hmin / H) * sqrt(0.5 * PI * xm) - exp(-h / H) * chapmanUp(x, -cosChi);
}
float phaseHG2(float cosT, float g1, float g2, float f) {
  return f * phaseHG(cosT, g1) + (1.0 - f) * phaseHG(cosT, g2);
}

struct SatShell { vec3 Lin; vec3 T; };

// Single scattering through the haze + Rayleigh shell along the camera ray between true distances t0 and
// t1 (m). sat geometry: o = camera in scaled space, d = normalised scaled direction, sPerT = scaled units
// per meter along the ray, sCa = scaled closest-approach parameter, rCa = closest-approach scaled radius.
// mode 0: limb ray (densest at sCa); mode 1: deck ray (densest at t1). ringT: ring shadow to apply.
SatShell saturnShell(vec3 rd, float t0, float t1, vec3 d, vec3 qc, float sCa, float sPerT, int mode, float ringT) {
  SatShell r;
  r.Lin = vec3(0.0);
  r.T = vec3(1.0);
  float k = uSaturnRadii.x / uSaturnRadii.y;
  float cosT = dot(uSunDir, rd);
  float Ph = phaseHG2(cosT, 0.65, -0.25, 0.92);
  float Pr = 0.75 * (1.0 + cosT * cosT);
  vec3 wHaze = vec3(0.985, 0.975, 0.94);
  const float Hh = 60e3, Hr = 45e3;
  vec3 sig0h = uSatHazeTau / Hh;
  vec3 sig0r = uSatRayTau / Hr;
  vec3 tauAcc = vec3(0.0);
  const int M = 12;
  float tCa = sCa / sPerT;
  for (int j = 0; j < M; j++) {
    float x = (float(j) + 0.5) / float(M);
    float t, dt;
    if (mode == 0) {
      // first half: t0 -> tCa (denser near tCa); second half: tCa -> t1 (denser near tCa)
      if (j < M / 2) {
        float xx = (float(j) + 0.5) / float(M / 2);
        float a = max(tCa - t0, 0.0);
        t = tCa - a * (1.0 - xx) * (1.0 - xx);
        dt = a * 2.0 * (1.0 - xx) / float(M / 2);
      } else {
        float xx = (float(j - M / 2) + 0.5) / float(M / 2);
        float a = max(t1 - tCa, 0.0);
        t = tCa + a * xx * xx;
        dt = a * 2.0 * xx / float(M / 2);
      }
      if (tCa < t0) { t = t0 + (t1 - t0) * x * x; dt = (t1 - t0) * 2.0 * x / float(M); }
    } else {
      float a = t1 - t0;
      t = t1 - a * (1.0 - x) * (1.0 - x);
      dt = a * 2.0 * (1.0 - x) / float(M);
    }
    float sRel = t * sPerT - sCa;
    vec3 ps = qc + sRel * d;                 // scaled position relative to Saturn's centre
    float rho = length(ps);
    vec3 us = ps / rho;
    float Rloc = uSaturnRadii.x / sqrt(1.0 + (k * k - 1.0) * us.z * us.z);
    float h = max((rho - 1.0) * Rloc, 0.0);
    vec3 nT = normalize(vec3(us.xy, us.z * k));
    float cosChi = dot(nT, uSunDir);
    vec3 p = rd * t;
    float vis = saturnSunVisibility(p);
    float fh = slantFactor(h, Rloc, cosChi, Hh);
    float fr = slantFactor(h, Rloc, cosChi, Hr);
    vec3 Tsun = vis * ringT * exp(-(uSatHazeTau * fh + uSatRayTau * fr));
    vec3 sh = sig0h * exp(-h / Hh);
    vec3 sr = sig0r * exp(-h / Hr);
    vec3 sigT = sh + sr;
    vec3 Tv = exp(-(tauAcc + 0.5 * sigT * dt));
    r.Lin += (wHaze * sh * Ph + sr * Pr) * (0.25 * INV_PI) * Tsun * Tv * dt;
    tauAcc += sigT * dt;
  }
  r.Lin *= uSunE;
  r.T = exp(-tauAcc);
  return r;
}

// Ring-shadow footprint (radial extent in the ring plane, m) for a surface point p (camera-relative) with
// normal n, hit distance t along rd: pixel ray differentials projected along the sunlight + solar blur.
float ringShadowFootprint(vec3 p, vec3 n, vec3 rd, float t) {
  float sz = uSunDir.z;
  if (abs(sz) < 1e-5) return 1e9;
  float zs = p.z + uCamPos.z;
  vec3 h = p - (zs / sz) * uSunDir;
  vec2 hr = normalize(h.xy + uCamPos.xy);
  // two orthogonal pixel steps on the screen -> tangent-plane displacements
  vec3 ex = uCamToWorld[0] * uPixelAngle;
  vec3 ey = uCamToWorld[1] * uPixelAngle;
  float rn = dot(rd, n);
  rn = sign(rn) * max(abs(rn), 0.03);
  vec3 dx = t * (ex - rd * dot(ex, n) / rn);
  vec3 dy = t * (ey - rd * dot(ey, n) / rn);
  vec3 hx = dx - uSunDir * (dx.z / sz);
  vec3 hy = dy - uSunDir * (dy.z / sz);
  float fpPix = max(abs(dot(hx.xy, hr)), abs(dot(hy.xy, hr)));
  // penumbral blur by the solar disk: distance to the ring plane along the sunbeam
  float D = abs(zs / sz);
  vec2 sh = normalize(uSunDir.xy + vec2(1e-9));
  float c = dot(hr, sh);
  float fpSun = 1.8 * D * uSunAngRadius * sqrt(c * c / (sz * sz) + (1.0 - c * c));
  return max(fpPix, fpSun);
}

// Ringshine irradiance (W/m^2) on the deck at Saturn-centred point pc with planetographic latitude latG.
vec3 saturnRingshine(vec3 pc, float latG) {
  if (uRingshineOn < 0.5) return vec3(0.0);
  float dl = atan(pc.y, pc.x) - atan(uSunDir.y, uSunDir.x);
  dl = mod(dl + PI, TWO_PI) - PI;
  return texture(uRingshine, vec2((dl + PI) / TWO_PI, (latG + 0.5 * PI) * INV_PI)).rgb * uSunE;
}

struct SatResult { vec3 L; vec3 T; float cov; float dist; float sortDist; bool any; };
float gAAPix;   // pixel angle used for analytic limb coverage (tiny -> binary coverage, for flux integration)

// Full Saturn evaluation for the camera ray rd: deck radiance (if hit), haze in-scattering and the
// transmittance applied to what lies behind. cov = deck pixel coverage (analytic AA at the limb).
SatResult traceSaturn(vec3 rd) {
  SatResult res;
  res.L = vec3(0.0); res.T = vec3(1.0); res.cov = 0.0; res.dist = SKY_DIST; res.sortDist = SKY_DIST; res.any = false;
  float k = uSaturnRadii.x / uSaturnRadii.y;
  vec3 o = -uSaturnCenter / uSaturnRadii.x;      // camera rel. centre, scaled (centre at origin)
  o.z *= k;
  vec3 d = rd;
  d.z *= k;
  float dl = length(d);
  d /= dl;
  float sPerT = dl / uSaturnRadii.x;               // scaled units per meter
  float b = dot(o, d);
  vec3 qc = o - b * d;
  float rCa2 = dot(qc, qc);
  float rCa = sqrt(rCa2);
  float rTop = 1.0 + SAT_H_TOP / uSaturnRadii.x;
  float D = length(o);
  if (rCa >= rTop || -b + sqrt(max(rTop * rTop - rCa2, 0.0)) <= 0.0) return res;
  float sCa = -b;
  // limb coverage in pixels
  float tang = sqrt(max(D * D - 1.0, 1e-8));
  float sdPx = (rCa - 1.0) / (tang * gAAPix);
  float cov = D > 1.0 ? clamp(0.5 - sdPx, 0.0, 1.0) : 1.0;
  bool hit = rCa < 1.0;
  float hDeck = sqrt(max(1.0 - rCa2, 0.0));
  float sHit = sCa - hDeck;
  if (hit && sHit <= 0.0) { hit = false; cov = 0.0; }    // camera inside (should not happen)
  // shell segment
  float hTop = sqrt(max(rTop * rTop - rCa2, 0.0));
  float sIn = max(sCa - hTop, 0.0), sOut = sCa + hTop;
  float t0 = sIn / sPerT;
  float t1 = (hit ? sHit : sOut) / sPerT;
  vec3 deckL = vec3(0.0);
  float tDeck = hit ? sHit / sPerT : sCa / sPerT;
  float ringT = 1.0;
  float moonVis = 1.0;
  if (cov > 0.0) {
    // deck point: actual hit, or the nearest limb point for partially covered pixels
    vec3 ps = hit ? qc - hDeck * d : qc / max(rCa, 1e-6);
    vec3 pc = vec3(ps.xy, ps.z / k) * uSaturnRadii.x;   // relative to Saturn's centre (m)
    vec3 p = pc + uSaturnCenter;                          // camera-relative
    float tP = length(p);
    vec3 n = saturnNormal(pc);
    float latG = asin(clamp(n.z, -1.0, 1.0));
    float W = uSaturnRot;
    vec3 ub = vec3(cos(W) * pc.x + sin(W) * pc.y, -sin(W) * pc.x + cos(W) * pc.y, pc.z);
    vec3 nb = vec3(cos(W) * n.x + sin(W) * n.y, -sin(W) * n.x + cos(W) * n.y, n.z);
    float lonE = atan(ub.y, ub.x);
    float mu = max(dot(n, -rd), 0.0);
    float fpU = tP * uPixelAngle / max(mu, 0.08) / uSaturnRadii.x;
    vec3 A = saturnAlbedo(nb, latG, lonE, fpU) * uSatDeckComp;
    float mu0 = dot(n, uSunDir);
    float fp = ringShadowFootprint(p, n, rd, tP);
    ringT = ringSunTransmission(p, fp);
    float vis = farMoonsSunVisibility(p, -1);
    moonVis = vis;
    // soft twilight: mu0 -> softplus (the deck itself is lit only while the Sun is above its horizon)
    float mu0s = 0.012 * log(1.0 + exp(mu0 / 0.012));
    vec3 IF = A * pow(vec3(mu0s), SAT_K) * pow(vec3(max(mu, 0.03)), SAT_K - 1.0);
    // attenuation of the direct beam by the haze above the deck (Chapman grazing incidence)
    float m0 = max(mu0, 0.0);
    vec3 Tsun = exp(-(uSatHazeTau * chapmanUp(uSaturnRadii.x / 60e3, m0) + uSatRayTau * chapmanUp(uSaturnRadii.x / 45e3, m0)));
    deckL = IF * uSunE * INV_PI * ringT * vis * Tsun;
    vec3 Ers = saturnRingshine(pc, latG);
    deckL += A * INV_PI * Ers;
    if (uFarDebug == 1) deckL = Ers / uSunE * 20.0;           // ringshine irradiance (x20, units of E_sun)
    else if (uFarDebug == 2) deckL = A * uSunE * INV_PI;       // albedo map
    tDeck = tP;
  }
  // haze shell (ring / moon shadows: the deck's for deck rays, else evaluated at the tangent point)
  if (cov <= 0.0) {
    vec3 pt = rd * (sCa / sPerT);
    ringT = ringSunTransmission(pt, 400e3);
    moonVis = farMoonsSunVisibility(pt, -1);
  }
  SatShell sh = saturnShell(rd, t0, t1, d, qc, sCa, sPerT, hit ? 1 : 0, ringT * moonVis);
  res.any = true;
  res.cov = cov;
  res.L = sh.Lin + cov * deckL * sh.T;
  res.T = sh.T * (1.0 - cov);
  res.dist = cov >= 0.5 ? tDeck : SKY_DIST;
  res.sortDist = cov > 0.0 ? tDeck : sCa / sPerT;
  return res;
}
`;
