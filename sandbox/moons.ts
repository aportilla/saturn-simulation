// Moons & sky data sandbox: real moon ephemerides (MoonSystem), Sun table, star catalogue, with stub passes.
//   /sandbox/moons.html?cam=orbit&target=enceladus&dist=2e6         (see sandbox/common.ts for camera params)
// window.__moons = { system, stars, check(name) } for --eval inspection:
//   __moons.check('Titan') -> { t, posKm, distKm, latDeg, lonDeg, subSaturnLonDeg, subSolarLonDeg, ... }
import { Vector3 } from 'three';
import { startSandbox } from './common';
import { FarFieldStub } from '../src/render/passes/stubs/FarFieldStub';
import { RingLayerStub } from '../src/render/passes/stubs/RingLayerStub';
import { PostPass } from '../src/render/PostPass';
import { loadMoonSystem, MoonSystem } from '../src/moons/MoonSystem';
import { loadSunTable, hasSunTable } from '../src/core/ephemeris';
import { loadStarCatalog, type StarCatalog } from '../src/sky/starCatalog';
import type { FrameState } from '../src/core/FrameState';
import { isoFromTdb } from '../src/core/time';

let stars: StarCatalog | null = null;
let system: MoonSystem | null = null;
let lastFrame: FrameState | null = null;
const DEG = 180 / Math.PI;

/** Planetocentric (lat, east lon) of a SEF direction in a moon's body frame. */
function bodyLatLon(frame: FrameState, i: number, dirSef: Vector3): { lat: number; lonE: number } {
  const m = frame.moons[i];
  const v = dirSef.clone().normalize().applyQuaternion(m.orient.clone().invert());
  return { lat: Math.asin(v.z) * DEG, lonE: Math.atan2(v.y, v.x) * DEG };
}

function check(name: string) {
  const f = lastFrame;
  if (!f || !system) return null;
  const i = f.moons.findIndex((m) => m.name.toLowerCase() === name.toLowerCase());
  if (i < 0) return null;
  const m = f.moons[i];
  const toSaturn = m.pos.clone().multiplyScalar(-1);
  const sub = bodyLatLon(f, i, toSaturn);
  const sol = bodyLatLon(f, i, f.sunDir.clone().multiplyScalar(f.sunDistance).sub(m.pos));
  const r = m.pos.length();
  return {
    t: isoFromTdb(f.t), name: m.name, kind: m.kind,
    posKm: [m.pos.x / 1e3, m.pos.y / 1e3, m.pos.z / 1e3].map((v) => +v.toFixed(1)),
    distKm: +(r / 1e3).toFixed(1),
    speedKms: +(m.vel.length() / 1e3).toFixed(4),
    latDeg: +(Math.asin(m.pos.z / r) * DEG).toFixed(4),
    lonDeg: +(Math.atan2(m.pos.y, m.pos.x) * DEG).toFixed(4),
    subSaturn: { latDeg: +sub.lat.toFixed(3), lonEastDeg: +sub.lonE.toFixed(3) },
    subSolar: { latDeg: +sol.lat.toFixed(3), lonEastDeg: +sol.lonE.toFixed(3) },
    radiiKm: [m.radii.x / 1e3, m.radii.y / 1e3, m.radii.z / 1e3],
    albedo: m.albedo, color: m.color, textureKey: m.textureKey,
  };
}

const sunOk = await loadSunTable();
const [st] = await Promise.all([loadStarCatalog()]);
stars = st;
console.log(`[moons-sandbox] sun table loaded: ${sunOk && hasSunTable()}; stars: ${stars ? `${stars.count} (V <= ${stars.magLimit}), E0 = ${stars.e0.toExponential(3)} W/m^2, Sirius E = ${stars.irradiance[0].toExponential(3)} W/m^2` : 'none'}`);

startSandbox({
  passes: () => ({ far: new FarFieldStub(), rings: new RingLayerStub(), post: new PostPass() }),
  moons: async () => {
    const p = await loadMoonSystem();
    if (p instanceof MoonSystem) system = p;
    console.log(`[moons-sandbox] moon provider: ${p instanceof MoonSystem ? `MoonSystem, ${p.count} moons` : 'StubMoons (fallback)'}`);
    return p;
  },
  onFrame: (f) => { lastFrame = f; },
  overlay: (f) => {
    const target = new URLSearchParams(location.search).get('target');
    const c = target && target !== 'saturn' ? check(target) : null;
    let s = `${isoFromTdb(f.t)}  warp ${f.timeWarp}\nsun elev above rings ${(Math.asin(f.sunDir.z) * DEG).toFixed(3)} deg\n`;
    if (c) s += `${c.name}: r ${c.distKm} km  v ${c.speedKms} km/s  lon ${c.lonDeg} lat ${c.latDeg}\n  sub-Saturn lat ${c.subSaturn.latDeg} lonE ${c.subSaturn.lonEastDeg}\n  sub-solar  lat ${c.subSolar.latDeg} lonE ${c.subSolar.lonEastDeg}`;
    return s;
  },
});
(window as any).__moons = { get system() { return system; }, get stars() { return stars; }, check };
