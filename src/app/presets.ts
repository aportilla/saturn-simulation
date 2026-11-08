// "Places": camera presets. Each builds a destination controller for the CURRENT geometry (Sun direction,
// moon positions) at the expected arrival time, so lighting is good on any date.
//
// Ring presets are parameterized by ring local solar time (azimuth from the sub-solar direction: 0 deg =
// noon, i.e. the sunward side; 180 = midnight, in Saturn's shadow) and by heights relative to the LIT face
// (the Sun is currently south of the ring plane, so "+30 m" means 30 m on the south side).
import { Quaternion, Vector3 } from 'three';
import type { FrameState } from '../core/FrameState';
import { DEG, SATURN, orbitalFrequencies } from '../core/constants';
import { saturnRotationAngle } from '../core/ephemeris';
import { RingAnchor } from '../core/RingAnchor';
import { FreeController, ringOrientation } from '../camera/FreeController';
import { findMoon, moonAngularRateZ, moonUpAxes } from '../camera/frames';
import { lookQuat, saturnNormal, saturnRadiusAt } from '../camera/math';
import { OrbitController } from '../camera/OrbitController';
import type { Controller } from '../camera/Transition';
import { shadowEntryAzimuth } from './physics';
import type { LiveInfo } from './liveInfo';
import { deg, duration, len, percent, perArea, sig, speed, km } from '../ui/format';

export interface PresetEnv {
  frame: FrameState;
  /** sim time (s since J2000) at which the camera is expected to arrive */
  tArrive: number;
}

export interface Preset {
  id: string;
  title: string;
  group: string;
  subtitle: string;
  key?: string;
  build(env: PresetEnv): Controller;
  explain?: (x: LiveInfo) => string;
}

const sunAz = (f: FrameState) => Math.atan2(f.sunDir.y, f.sunDir.x);
const lit = (f: FrameState) => (f.sunDir.z >= 0 ? 1 : -1);

function orbitSaturn(f: FrameState, dist: number, azFromSunDeg: number, elLitDeg: number): OrbitController {
  return new OrbitController({ target: 'saturn', dist, az: sunAz(f) + azFromSunDeg * DEG, el: lit(f) * elLitDeg * DEG });
}

/** A good default view of any moon (used for label clicks). */
export function moonView(env: PresetEnv, name: string, distRadii = 4): Controller {
  return orbitMoon(env, name, distRadii, -40, 12);
}

/** Orbit a moon with the camera placed relative to the Sun as seen from the moon (good lighting). */
function orbitMoon(env: PresetEnv, name: string, distRadii: number, azFromSunDeg: number, elLitDeg: number): Controller {
  const f = env.frame;
  const m = findMoon(f, name);
  if (!m) return orbitSaturn(f, 1.5e9, -35, 18);
  const X = new Vector3(), Y = new Vector3(), Z = new Vector3();
  moonUpAxes(m, X, Y, Z);
  const s = f.sunDir.clone().multiplyScalar(f.sunDistance).sub(m.pos).normalize();
  const az = Math.atan2(s.dot(Y), s.dot(X));
  return new OrbitController({ target: name, dist: distRadii * m.meanRadius, az: az + azFromSunDeg * DEG, el: lit(f) * elLitDeg * DEG, axes: 'up' });
}

interface RingSpec {
  rKm: number;
  /** azimuth from local noon (deg, prograde positive) */
  fromNoonDeg?: number;
  /** explicit SEF azimuth at arrival (rad); overrides fromNoonDeg */
  phi?: number;
  /** height (m) measured toward the lit side (+) or the unlit side (-) */
  zLit: number;
  yaw: number;
  pitch: number;
  roll?: number;
  /** camera up: the lit side, the unlit side, or the side the camera is on */
  up: 'lit' | 'unlit' | 'side';
  speed: number;
}

function ringPreset(env: PresetEnv, s: RingSpec): FreeController {
  const f = env.frame;
  const L = lit(f);
  const zSef = s.zLit * L;
  const upSign = s.up === 'lit' ? L : s.up === 'unlit' ? -L : zSef !== 0 ? Math.sign(zSef) : L;
  const phi = s.phi ?? sunAz(f) + (s.fromNoonDeg ?? 0) * DEG;
  const anchor = new RingAnchor(s.rKm * 1e3, phi, env.tArrive);
  const q = ringOrientation(s.yaw, s.pitch, s.roll ?? 0, upSign, new Quaternion());
  return new FreeController({ frame: 'ring', anchor, local: new Vector3(0, 0, zSef), qLocal: q, upLocal: new Vector3(0, 0, upSign), speed: s.speed });
}

/**
 * Ring preset co-orbiting next to a ring moon, `distKm` from it along the orbit, looking at it. The camera
 * takes the side of the moon that keeps the Sun behind it (trailing the moon and looking prograde, or leading
 * it and looking back), so the moon and the gap edges are front-lit.
 */
function nearMoonRing(env: PresetEnv, name: string, distKm: number, s: Omit<RingSpec, 'rKm' | 'phi' | 'fromNoonDeg' | 'yaw'>, fallbackRKm: number): FreeController {
  const f = env.frame;
  const m = findMoon(f, name);
  if (!m) return ringPreset(env, { ...s, yaw: 0, rKm: fallbackRKm, fromNoonDeg: 40 });
  const r = Math.hypot(m.pos.x, m.pos.y);
  const n = moonAngularRateZ(m) || orbitalFrequencies(r).omega;
  const phiM = Math.atan2(m.pos.y, m.pos.x) + n * (env.tArrive - f.t);
  // Sun component along the prograde direction at the moon
  const sAlong = -Math.sin(phiM) * f.sunDir.x + Math.cos(phiM) * f.sunDir.y;
  const lead = sAlong > 0; // Sun ahead -> stand in front of the moon and look back at it
  const dphi = (distKm * 1e3) / r;
  return ringPreset(env, { ...s, rKm: r / 1e3, phi: lead ? phiM + dphi : phiM - dphi, yaw: lead ? 180 : 0 });
}

/** F ring & Prometheus: outside the F ring looking in on the day side, inside looking out on the night side. */
function fRing(env: PresetEnv): Controller {
  const f = env.frame;
  const m = findMoon(f, 'prometheus');
  if (!m) return ringPreset(env, { rKm: 139_800, fromNoonDeg: 40, zLit: 30e3, yaw: 90, pitch: -12, up: 'side', speed: 2000 });
  const day = m.pos.x * f.sunDir.x + m.pos.y * f.sunDir.y > 0;
  if (day) return new OrbitController({ target: 'prometheus', dist: 2000e3, az: 18 * DEG, el: lit(f) * 10 * DEG, axes: 'orbital' });
  return new OrbitController({ target: 'prometheus', dist: 1100e3, az: 160 * DEG, el: lit(f) * 14 * DEG, axes: 'orbital' });
}

function cloudTops(env: PresetEnv): FreeController {
  const f = env.frame;
  const L = lit(f);
  const lat = L * 35 * DEG;
  const W = saturnRotationAngle(env.tArrive);
  const lonSun = sunAz(f) - W;
  const lon = lonSun + 40 * DEG;
  const sl = Math.sin(lat), cl = Math.cos(lat);
  const R = saturnRadiusAt(sl, cl);
  const p = new Vector3(cl * Math.cos(lon), cl * Math.sin(lon), sl).multiplyScalar(R);
  const n = saturnNormal(p, new Vector3());
  const local = p.clone().addScaledVector(n, 1000e3);
  // look toward the equator (where the rings rise), pitched up to take in the ring arch
  const north = new Vector3(0, 0, 1).addScaledVector(n, -n.z).normalize();
  const toEquator = north.clone().multiplyScalar(lat < 0 ? 1 : -1);
  const pitch = 15 * DEG;
  const fwd = toEquator.multiplyScalar(Math.cos(pitch)).addScaledVector(n, Math.sin(pitch));
  const q = lookQuat(fwd, n, new Quaternion());
  return new FreeController({ frame: 'body', body: 'saturn', local, qLocal: q, upLocal: n, speed: 2000 });
}

// ------------------------------------------------------------------ explainer helpers
const b = (s: string) => `<b>${s}</b>`;
function particles(x: LiveInfo): string {
  if (!x.local || !x.sd) return 'Here the material is fine dust (µm grains), not macroscopic particles.';
  return `Particles range from ${len(x.local.aMin)} to ${len(x.local.aMax)} in radius (n(a) ∝ a<sup>−${x.local.q.toFixed(2)}</sup>): about ${perArea(x.n1cm)} larger than 1 cm, ${perArea(x.n1m)} larger than 1 m. Half of the light-blocking area is in particles larger than ${len(x.aHalfTau, 2)}.`;
}
function motion(x: LiveInfo): string {
  return `At 1× the scene looks almost frozen — and that is real: neighbours 100 m away drift past at only ${speed(x.shear100, 2)} (Keplerian shear) and random motions are ~${speed(x.vRandom, 1)}.`;
}

export const PRESETS: Preset[] = [
  // ---------------------------------------------------------------- system
  {
    id: 'overview', title: 'Saturn system', group: 'System', key: '1', subtitle: 'Saturn and its moons to scale',
    build: (e) => orbitSaturn(e.frame, 2.4e9, -32, 24),
    explain: () => `${b('Saturn and its moons, to scale.')} Saturn is 120,536 km across at the 1-bar level. The main rings reach 136,775 km from its center yet are only ~10 m thick — scaled to the thickness of a sheet of paper they would be ~2.7 km wide. Titan orbits 1.22 million km out, Iapetus 3.56 million km. Everything moves in real time; press <kbd>L</kbd> to speed time up.`,
  },
  {
    id: 'rings-above', title: 'Rings from above', group: 'System', key: '2', subtitle: 'The sunlit face',
    build: (e) => orbitSaturn(e.frame, 3.3e8, 0, 72),
    explain: (x) => `${b('The sunlit face.')} The Sun is ${deg(Math.abs(x.sunEl))} ${x.litSign < 0 ? 'south' : 'north'} of the ring plane, so the ${x.litSign < 0 ? 'south' : 'north'} face is lit. From the inside out: the dark C ring, the bright, nearly opaque B ring (optical depth up to ~5), the 4,500 km Cassini Division (not empty: τ ≈ 0.1) and the A ring with the Encke and Keeler gaps. Saturn's shadow lies across the rings on the night side; every particle passes through it once per orbit.`,
  },
  {
    id: 'edge-on', title: 'Ring plane, edge-on', group: 'System', key: '3', subtitle: 'How thin the rings are',
    build: (e) => orbitSaturn(e.frame, 4.2e8, -48, 1.2),
    explain: (x) => `${b('Nearly edge-on.')} The main rings are 270,000 km across but only ~10 m thick, so seen edge-on they all but vanish. What remains is the rings' shadow on Saturn's ${x.litSign < 0 ? 'northern' : 'southern'} hemisphere, sunlight glinting through the sparse regions and the faint dusty rings.`,
  },
  // ---------------------------------------------------------------- inside the rings
  {
    id: 'a-ring-inside', title: 'A ring — inside the layer', group: 'Inside the rings', key: '4', subtitle: 'r = 128,000 km, mid-plane',
    build: (e) => ringPreset(e, { rKm: 128_000, fromNoonDeg: 35, zLit: 0, yaw: -90, pitch: 12, up: 'lit', speed: 0.5 }),
    explain: (x) => `${b('Inside the A ring.')} You are co-orbiting at ${speed(x.vOrb, 4)}, ${km(x.rCyl)} from Saturn's center, in the mid-plane of a particle layer only ~${len(x.local?.H ?? 15, 2)} thick. ${particles(x)} Sideways the mean free path is only ~${len(x.mfp, 2)}, so particles fill the view along the plane, while straight up ${percent(x.tUp)} of the sky shows through. ${motion(x)} Self-gravity gathers the particles into trailing wakes ~${len(x.lambda, 2)} apart.`,
  },
  {
    id: 'a-ring-30m', title: 'A ring — 30 m above', group: 'Inside the rings', key: '5', subtitle: 'Just above the lit face',
    build: (e) => ringPreset(e, { rKm: 128_000, fromNoonDeg: 35, zLit: 30, yaw: -90, pitch: -12, up: 'side', speed: 2 }),
    explain: (x) => `${b('30 m above the A ring')} (on its sunlit ${x.litSign < 0 ? 'south' : 'north'} side). The ring is a ~${len(x.local?.H ?? 15, 2)} sheet; with τ ≈ ${sig(x.local?.tau ?? 0, 2)}, ${percent(1 - x.tFull)} of the view straight down is covered by particles. ${particles(x)} Particles directly below drift with you; those 1 km closer to Saturn overtake you at ${speed(x.shear1k, 2)}.`,
  },
  {
    id: 'a-ring-1km', title: 'A ring — 1 km above', group: 'Inside the rings', key: '6', subtitle: 'The texture of the ring',
    build: (e) => ringPreset(e, { rKm: 128_000, fromNoonDeg: 35, zLit: 1000, yaw: -60, pitch: -24, up: 'side', speed: 40 }),
    explain: (x) => `${b('1 km above the A ring.')} From here the layer is a continuous plain. Self-gravity wakes — elongated aggregates ~${len(x.lambda, 2)} apart, trailing ~20° from the orbital direction — give it its texture (and cause the A ring's famous brightness asymmetry). Sunlight arrives ${deg(Math.abs(x.sunEl))} above the plane.`,
  },
  {
    id: 'b-ring-inside', title: 'B ring — inside', group: 'Inside the rings', key: '7', subtitle: 'r = 105,000 km, the densest ring',
    build: (e) => ringPreset(e, { rKm: 105_000, fromNoonDeg: 35, zLit: 4, yaw: 0, pitch: -6, up: 'lit', speed: 0.5 }),
    explain: (x) => `${b('Inside the B ring')} — the most massive ring. Here τ ≈ ${sig(x.local?.tau ?? 0, 2)}, so only ${percent(x.tFull)} of light passes vertically through the ${len(x.local?.H ?? 10, 2)} layer, and Σ ≈ ${sig(x.local?.sigma ?? 0, 2)} kg/m². Particles larger than 10 cm sit ~${len(x.spacing10cm, 2)} apart. Direct sunlight reaching you: ${percent(x.tSun)} — in the middle of the densest ring it is deep twilight, lit only by light diffusing through the layer.${x.zSunlit30 > 0 ? ` Rise ~${len(Math.max(0.1, x.zSunlit30 - x.z * x.litSign), 2)} toward the lit face (hold <kbd>R</kbd>) to reach sunlight.` : ''}`,
  },
  {
    id: 'c-ring-inside', title: 'C ring — inside', group: 'Inside the rings', key: '8', subtitle: 'r = 85,000 km, sparse and dark',
    build: (e) => ringPreset(e, { rKm: 85_000, fromNoonDeg: 40, zLit: 0, yaw: -90, pitch: 14, up: 'lit', speed: 0.5 }),
    explain: (x) => `${b('Inside the C ring.')} Sparse and dark: τ ≈ ${sig(x.local?.tau ?? 0, 2)}, so the layer is mostly empty space between cm-to-m particles (${perArea(x.n1cm)} larger than 1 cm). Saturn, ${km(x.alt)} away, spans ${deg(x.saturnAngDiam, 0)} of the sky. One orbit here takes ${duration(x.period)}.`,
  },
  {
    id: 'cassini-division', title: 'Cassini Division — inside', group: 'Inside the rings', key: '9', subtitle: 'r = 119,000 km',
    build: (e) => ringPreset(e, { rKm: 119_000, fromNoonDeg: 35, zLit: 0, yaw: -60, pitch: 6, up: 'lit', speed: 1 }),
    explain: (x) => `${b('Inside the Cassini Division.')} Not a gap but a 4,500 km wide region of low density (τ ≈ ${sig(x.local?.tau ?? 0, 2)} here), with darker, dustier particles than the A and B rings. Its inner boundary — the sharp outer edge of the B ring at 117,516 km — is held by the 2:1 resonance with Mimas.`,
  },
  {
    id: 'shadow', title: "In Saturn's shadow", group: 'Inside the rings', key: '0', subtitle: 'Eclipse on the night side',
    build: (e) => {
      const f = e.frame;
      const r = 126_000e3, z = lit(f) * 150;
      const sh = shadowEntryAzimuth(r, z, f.sunDir);
      const into = Math.min(0.3 * 2 * sh.halfWidth, 12 * DEG);
      return ringPreset(e, { rKm: r / 1e3, phi: sh.entry + into, zLit: 150, yaw: -80, pitch: 4, up: 'side', speed: 5 });
    },
    explain: (x) => `${b("In Saturn's shadow.")} Every ring particle crosses Saturn's shadow once per orbit — here ${x.shadow ? duration(x.shadow.duration) : '~2 h'} of each ${duration(x.period)} orbit. ${x.shadow && x.shadow.nextEvent ? `You ${x.shadow.inShadow ? 'leave' : 'enter'} the shadow in ${duration(x.shadow.nextIn)} (sim time).` : ''} Only light reflected from Saturn's night side and the sunlit rings beyond reaches you; the particles cool by ~10–20 K during each eclipse.`,
  },
  {
    id: 'bending-wave', title: 'Mimas 5:3 bending wave', group: 'Inside the rings', subtitle: 'The A ring corrugated, 20 km above',
    build: (e) => ringPreset(e, { rKm: 131_900, fromNoonDeg: 30, zLit: 20_000, yaw: -90, pitch: -30, up: 'side', speed: 500 }),
    explain: (x) => `${b('The Mimas 5:3 bending wave.')} Mimas's orbit is tilted by 1.6°; at the 5:3 vertical resonance (131,900 km) its pull bends the A ring into a spiral corrugation that runs ~200 km toward Saturn, its wavelength shrinking from ~50 to ~10 km: crests up to 450 m above the mid-plane, slopes up to 8.5°. Heights here are measured above the local mid-plane, which lies ${len(Math.abs(x.zMid), 2)} ${x.zMid >= 0 ? 'north' : 'south'} of Saturn's equatorial plane under you. The tilted faces catch the ${deg(Math.abs(x.sunEl))} Sun at different angles; near an equinox every crest casts a shadow hundreds of km long.`,
  },
  {
    id: 'under-rings', title: 'Under the rings', group: 'Inside the rings', subtitle: 'The unlit face, 1.5 km below',
    build: (e) => ringPreset(e, { rKm: 127_500, fromNoonDeg: 40, zLit: -1500, yaw: -75, pitch: 8, up: 'lit', speed: 40 }),
    explain: (x) => `${b('Under the rings')}, on the unlit ${x.litSign < 0 ? 'north' : 'south'} side. Sunlight reaches this face only by filtering through the layer, so opaque regions (the B ring) look dark while sparse ones (the C ring and Cassini Division) glow. Saturn's ${x.litSign < 0 ? 'northern' : 'southern'} hemisphere carries the rings' shadow.`,
  },
  // ---------------------------------------------------------------- gaps and shepherds
  {
    id: 'encke-gap', title: 'Encke Gap & Pan', group: 'Gaps & shepherds', subtitle: '325 km gap, 28 km moon',
    build: (e) => nearMoonRing(e, 'pan', 300, { zLit: 40e3, pitch: -7, up: 'side', speed: 2000 }, 133_589),
    explain: () => `${b('The Encke Gap and Pan.')} A 325 km wide gap at 133,589 km, kept open by the ~28 km moon Pan, which orbits inside it. Pan's gravity raises scalloped wakes on the gap edges and herds faint ringlets inside the gap. It shares almost exactly your orbit, so it hangs in front of you.`,
  },
  {
    id: 'keeler-gap', title: 'Keeler Gap & Daphnis', group: 'Gaps & shepherds', subtitle: '~40 km gap, 8 km moon',
    build: (e) => nearMoonRing(e, 'daphnis', 30, { zLit: 3e3, pitch: -6, up: 'side', speed: 300 }, 136_505),
    explain: () => `${b('The Keeler Gap and Daphnis.')} A ~40 km gap near the A ring's outer edge, cleared by 8 km Daphnis. Its slightly eccentric, inclined orbit raises waves on the gap edges that rise up to ~1.5 km out of the ring plane.`,
  },
  {
    id: 'f-ring', title: 'F ring & Prometheus', group: 'Gaps & shepherds', subtitle: 'Shepherd moon at work',
    build: (e) => fRing(e),
    explain: () => `${b('The F ring and Prometheus.')} The F ring (140,221 km) is a narrow, kinked core wrapped in dusty strands. Prometheus (136 × 79 × 59 km) orbits ~800 km inside it; once per 14.7-hour orbit, at closest approach, its gravity pulls streamers and channels out of the ring.`,
  },
  // ---------------------------------------------------------------- moons
  {
    id: 'enceladus', title: 'Enceladus', group: 'Moons', subtitle: 'Ice geysers and the E ring',
    build: (e) => orbitMoon(e, 'enceladus', 4.5, -45, 22),
    explain: () => `${b('Enceladus.')} 504 km across and the most reflective body in the Solar System. Jets from the "tiger stripe" fractures at its south pole vent a subsurface ocean and feed the E ring, which spans ~180,000–480,000 km from Saturn.`,
  },
  {
    id: 'titan', title: 'Titan', group: 'Moons', subtitle: 'Larger than Mercury',
    build: (e) => orbitMoon(e, 'titan', 3.5, -40, 10),
    explain: () => `${b('Titan.')} 5,150 km across — larger than Mercury — with a nitrogen atmosphere of 1.5 bar at the surface and an orange photochemical haze. It orbits 1.22 million km from Saturn every 15.9 days.`,
  },
  {
    id: 'mimas', title: 'Mimas', group: 'Moons', subtitle: 'The ring sculptor',
    build: (e) => orbitMoon(e, 'mimas', 5, -35, 10),
    explain: () => `${b('Mimas.')} 396 km across, dominated by the 139 km crater Herschel. Its 2:1 orbital resonance holds the sharp outer edge of the B ring and shapes the Cassini Division.`,
  },
  {
    id: 'iapetus', title: 'Iapetus', group: 'Moons', subtitle: 'Two-toned, 3.56 million km out',
    build: (e) => orbitMoon(e, 'iapetus', 5, -40, 10),
    explain: () => `${b('Iapetus.')} 1,469 km across and two-toned: its leading hemisphere is coal-dark, the trailing one bright. An equatorial ridge rises up to ~20 km. It orbits 3.56 million km out, inclined ~15° to the rings, every 79.3 days.`,
  },
  // ---------------------------------------------------------------- Saturn
  {
    id: 'cloud-tops', title: 'Saturn cloud tops', group: 'Saturn', subtitle: '1,000 km above the 1-bar level',
    build: (e) => cloudTops(e),
    explain: (x) => `${b('1,000 km above Saturn.')} Hovering at ${deg(Math.atan2(x.z, x.rCyl), 0)} latitude, co-rotating with the planet (10 h 39 m). The rings arch across the sky; their inner edge, the D ring, is only ~6,600 km above the equatorial cloud tops. Saturn has no solid surface — the 1-bar pressure level is the reference "surface" (equatorial radius ${grouped0(SATURN.R_EQ / 1e3)} km).`,
  },
];

function grouped0(x: number): string {
  return x.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));
const ALIASES: Record<string, string> = {
  system: 'overview', saturn: 'overview', above: 'rings-above', edgeon: 'edge-on', 'a-inside': 'a-ring-inside', 'a-ring': 'a-ring-inside',
  'a-30m': 'a-ring-30m', 'a-1km': 'a-ring-1km', 'b-inside': 'b-ring-inside', 'b-ring': 'b-ring-inside', 'c-inside': 'c-ring-inside',
  'c-ring': 'c-ring-inside', cassini: 'cassini-division', encke: 'encke-gap', pan: 'encke-gap', keeler: 'keeler-gap', daphnis: 'keeler-gap',
  'f-ring-prometheus': 'f-ring', prometheus: 'f-ring', under: 'under-rings', unlit: 'under-rings', eclipse: 'shadow', clouds: 'cloud-tops',
};

export function findPreset(id: string): Preset | null {
  const k = id.trim().toLowerCase();
  return BY_ID.get(k) ?? BY_ID.get(ALIASES[k] ?? '') ?? null;
}
