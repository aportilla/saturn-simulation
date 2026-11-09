// Live physical numbers for the HUD and the "what you're seeing" explainers, computed from the running
// model: ring profile (RingProfile.local), LOD vertical structure (RingLod), wakes (WakeField), orbital
// frequencies (J2..J6), Sun geometry and Saturn's shadow.
import { Vector3 } from 'three';
import type { FrameState } from '../core/FrameState';
import { DAY, SATURN, orbitalFrequencies, shearParameter } from '../core/constants';
import type { PipelineContext } from '../render/Pipeline';
import type { RingLocal } from '../rings/RingProfile';
import { describeRadiusKm } from '../rings/ringRegions';
import { findMoon, moonAngularRateZ } from '../camera/frames';
import { FreeController } from '../camera/FreeController';
import { OrbitController } from '../camera/OrbitController';
import type { CameraRig } from '../camera/CameraRig';
import { saturnAltitude, saturnRadiusAt } from '../camera/math';
import {
  columnAbove, layerTauBeyond, localSolarTime, medianCrossSectionRadius, saturnSunVisibility, shadowTiming,
  sigmaZForRadius, sizeDistribution, toomreLambda, type ShadowTiming, type SizeDist,
} from './physics';

const PROFILE_MIN_M = 66_000e3;
const PROFILE_MAX_M = 139_500e3;

export interface LiveInfo {
  rCyl: number;
  /** height above the ring material's local mid-plane near the rings (vertical relief), else above the SEF plane (m) */
  z: number;
  /** height of the local mid-plane above the SEF plane (m): vertical relief under the camera (bending waves, corrugation,
   *  moonlet edge waves, B-ring-edge structures); 0 away from the rings */
  zMid: number;
  dist: number;
  alt: number;
  feature: string;
  nearRings: boolean;
  local: RingLocal | null;
  sd: SizeDist | null;
  omega: number;
  kappa: number;
  nu: number;
  q: number;
  vOrb: number;
  period: number;
  epicyclePeriod: number;
  verticalPeriod: number;
  shear100: number;
  shear1k: number;
  n1cm: number;
  n10cm: number;
  n1m: number;
  /** mean separation of particles with radius > 10 cm near the mid-plane (m) */
  spacing10cm: number;
  /** radius splitting the optical depth in half (m) */
  aHalfTau: number;
  lambda: number;
  wakeStrength: number;
  /** horizontal mean free path ~ H / tau (m) */
  mfp: number;
  /** vertical transmission of the full layer, and from the camera's height upward / downward */
  tFull: number;
  tUp: number;
  tDown: number;
  /** fraction of direct sunlight reaching the camera through the ring layer */
  tSun: number;
  /** height above the mid-plane, toward the lit face, where direct sunlight reaches 30% (m; 0 if already) */
  zSunlit30: number;
  /** random velocity scale ~ Omega H / 2 (m/s) */
  vRandom: number;
  sunEl: number;
  litSign: number;
  sunVis: number;
  shadow: ShadowTiming | null;
  phase: number;
  lst: number;
  saturnAngDiam: number;
  /** camera velocity relative to the local ring flow (m/s), co-orbit only */
  vRel: number | null;
}

const _v = new Vector3();
const _f = new Vector3();
const _c = new Vector3();

/**
 * The ring material at the camera through the 2-D ring structure (moonlet-perturbed gap edges): the profile values
 * of the streamline (Lagrangian) radius there, with tau and Sigma scaled by the density factor J.
 */
function localAtCamera(ctx: PipelineContext, f: FrameState, rCyl: number, mid: { z: number }): RingLocal {
  const st = ctx.structure?.streamAtSEF(rCyl, Math.atan2(f.camPos.y, f.camPos.x), 0, true);
  mid.z = st ? st.zeta : 0;
  if (!st || (st.da === 0 && st.J === 1 && st.tauMod === 1)) return ctx.profile.local(rCyl);
  const loc = ctx.profile.local(rCyl + st.da);
  const k = st.J * st.tauMod;
  return { ...loc, tau: loc.tau * k, sigma: loc.sigma * k, macroscopic: loc.macroscopic && loc.tau * k > 0.002 };
}

export function computeLiveInfo(f: FrameState, ctx: PipelineContext | null, rig: CameraRig, timeDir: number): LiveInfo {
  const p = f.camPos;
  const rCyl = Math.hypot(p.x, p.y);
  const dist = p.length();
  const alt = saturnAltitude(p);
  const feature = rCyl < SATURN.R_EQ && alt > 0 ? 'above Saturn' : describeRadiusKm(rCyl / 1000);
  // apparent size of Saturn: the 1-bar ellipsoid radius toward the camera's latitude
  const rLocal = saturnRadiusAt(dist > 0 ? p.z / dist : 0, dist > 0 ? rCyl / dist : 1);
  const inProfile = rCyl >= PROFILE_MIN_M && rCyl <= PROFILE_MAX_M;
  const nearRings = inProfile && Math.abs(p.z) < 50_000e3;
  // the ring material's local mid-plane under the camera (vertical relief): heights are taken relative to it
  const mid = { z: 0 };
  const local = ctx && inProfile ? localAtCamera(ctx, f, rCyl, mid) : null;
  const zMid = nearRings ? mid.z : 0;
  const z = p.z - zMid;
  // the particle population (counts, spacing) carries the dynamical optical depth: the profile's is photometric
  // (ring-physics.md 10.12; RingLod.tauDynFactor, as the near field draws them)
  const lodDyn = ctx ? (ctx.lod as unknown as { tauDynFactor?: (t: number) => number }) : null;
  const popTau = local ? local.tau * (lodDyn?.tauDynFactor ? lodDyn.tauDynFactor(local.tau) : 1) : 0;
  const sd = local && local.macroscopic ? sizeDistribution({ ...local, tau: popTau }) : null;
  const rf = Math.max(rCyl, SATURN.R_EQ);
  const fr = orbitalFrequencies(rf);
  const q = shearParameter(rf);
  const lod = ctx ? (ctx.lod as unknown as { tauFrac: Float32Array; sigZFrac: Float32Array; aLo: Float32Array; aHi: Float32Array }) : null;

  let n1cm = 0, n10cm = 0, n1m = 0, spacing10cm = Infinity, aHalfTau = 0;
  if (sd && local) {
    n1cm = columnAbove(sd, 0.01);
    n10cm = columnAbove(sd, 0.1);
    n1m = columnAbove(sd, 1);
    const sz = sigmaZForRadius(lod, 0.1, local.H);
    const nMid = n10cm / (Math.sqrt(2 * Math.PI) * Math.max(sz, 0.05));
    spacing10cm = nMid > 0 ? Math.cbrt(1 / nMid) : Infinity;
    aHalfTau = medianCrossSectionRadius(sd);
  }
  const tau = local?.tau ?? 0;
  const H = local?.H ?? 10;
  const litSign = f.sunDir.z >= 0 ? 1 : -1;
  const mu0 = Math.max(Math.abs(f.sunDir.z), 1e-3);
  const lodForLayer = local && local.macroscopic ? lod : null;
  const tUp = Math.exp(-layerTauBeyond(lodForLayer, z, tau, H, 1));
  const tDown = Math.exp(-layerTauBeyond(lodForLayer, z, tau, H, -1));
  const tSun = Math.exp(-layerTauBeyond(lodForLayer, z, tau, H, litSign) / mu0);
  let zSunlit30 = 0;
  if (tau > 0 && tSun < 0.3) {
    let lo = 0, hi = 4 * H + 1;
    for (let i = 0; i < 40; i++) {
      const m = 0.5 * (lo + hi);
      if (Math.exp(-layerTauBeyond(lodForLayer, litSign * m, tau, H, litSign) / mu0) < 0.3) lo = m;
      else hi = m;
    }
    zSunlit30 = hi;
  }

  // angular rate of the camera's motion about Saturn's axis (for shadow timing)
  let omegaCam = 0;
  const a = rig.transition ? null : rig.active;
  if (a instanceof FreeController) {
    if (a.frameKind === 'ring') omegaCam = orbitalFrequencies(Math.max(rCyl, 1e6)).omega;
    else if (a.body === 'saturn') omegaCam = SATURN.W_RATE / DAY;
    else {
      const m = findMoon(f, a.body);
      if (m) omegaCam = moonAngularRateZ(m);
    }
  } else if (a instanceof OrbitController && a.target !== 'saturn') {
    const m = findMoon(f, a.target);
    if (m) omegaCam = moonAngularRateZ(m);
  }
  const shadow = shadowTiming(p, omegaCam, f.sunDir, timeDir);

  // phase angle of what is at the center of the view
  _f.set(0, 0, -1).applyQuaternion(f.camQuat);
  if (a instanceof OrbitController) {
    const m = findMoon(f, a.target);
    _c.set(0, 0, 0);
    if (m) _c.copy(m.pos);
    _v.copy(p).sub(_c).normalize();
  } else {
    _v.copy(_f).negate();
  }
  const phase = Math.acos(Math.max(-1, Math.min(1, _v.dot(f.sunDir))));

  let vRel: number | null = null;
  if (a instanceof FreeController && a.frameKind === 'ring') {
    a.velocityLocal(_v);
    _v.y += a.anchor.qShear * a.anchor.omega * a.local.x;
    vRel = _v.length();
  }

  return {
    rCyl, z, zMid, dist, alt, feature, nearRings, local, sd,
    omega: fr.omega, kappa: fr.kappa, nu: fr.nu, q,
    vOrb: fr.omega * rf,
    period: (2 * Math.PI) / fr.omega,
    epicyclePeriod: (2 * Math.PI) / fr.kappa,
    verticalPeriod: (2 * Math.PI) / fr.nu,
    shear100: q * fr.omega * 100,
    shear1k: q * fr.omega * 1000,
    n1cm, n10cm, n1m, spacing10cm, aHalfTau,
    lambda: local && local.sigma > 0 ? toomreLambda(local.sigma, fr.kappa) : 0,
    wakeStrength: ctx ? ctx.wakes.strength : 0,
    mfp: tau > 0 ? H / tau : Infinity,
    tFull: Math.exp(-tau),
    tUp, tDown, tSun, zSunlit30,
    vRandom: 0.5 * fr.omega * H,
    sunEl: Math.asin(Math.max(-1, Math.min(1, f.sunDir.z))),
    litSign,
    sunVis: saturnSunVisibility(p, f.sunDir, f.sunAngularRadius),
    shadow,
    phase,
    lst: localSolarTime(Math.atan2(p.y, p.x), f.sunDir),
    saturnAngDiam: 2 * Math.asin(Math.min(1, rLocal / Math.max(dist, 1))),
    vRel,
  };
}
