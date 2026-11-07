// Uniform objects shared (by reference) between all materials. Spread `shared.u` into a material's
// uniforms to get every sv_* chunk's uniforms:  uniforms: { ...ctx.shared.u, ...myOwnUniforms }.
import { Matrix3, Matrix4, Vector2, Vector3, Vector4 } from 'three';
import { LOG_DEPTH_FAR, MAX_MOONS, SATURN } from '../core/constants';
import type { FrameState } from '../core/FrameState';
import type { RingProfile } from '../rings/RingProfile';
import type { RingLod } from '../rings/RingLod';
import type { WakeField } from '../rings/WakeField';

export class SharedUniforms {
  readonly u: Record<string, { value: any }>;

  constructor(profile: RingProfile, lod: RingLod, wakes: WakeField) {
    const pv = profile.uniformValues();
    const moonPos: Vector4[] = [];
    for (let i = 0; i < MAX_MOONS; i++) moonPos.push(new Vector4(1e12, 0, 0, 1));
    this.u = {
      // sv_common
      uResolution: { value: new Vector2(1, 1) },
      uPixelAngle: { value: 1e-3 },
      uTanHalfFov: { value: Math.tan(Math.PI / 6) },
      uAspect: { value: 16 / 9 },
      uCamToWorld: { value: new Matrix3() },
      uWorldToCam: { value: new Matrix3() },
      uProj: { value: new Matrix4() },
      uCamPos: { value: new Vector3() },
      uLogDepthFC: { value: 2 / Math.log2(LOG_DEPTH_FAR + 1) },
      uTimeMod: { value: 0 },
      uSunDir: { value: new Vector3(1, 0, 0) },
      uSunE: { value: 15 },
      uSunRadiance: { value: 2e7 },
      uSunAngRadius: { value: 5e-4 },
      // sv_saturn
      uSaturnCenter: { value: new Vector3() },
      uSaturnRadii: { value: new Vector2(SATURN.R_EQ, SATURN.R_POL) },
      uSaturnRot: { value: 0 },
      // sv_ringProfile
      uRingTexA: { value: pv.uRingTexA },
      uRingTexB: { value: pv.uRingTexB },
      uRingTexW: { value: pv.uRingTexW },
      uRingRMin: { value: pv.uRingRMin },
      uRingDr0: { value: pv.uRingDr0 },
      uRingLevels: { value: pv.uRingLevels },
      uRingLevelOff: { value: pv.uRingLevelOff },
      uRingLevelN: { value: pv.uRingLevelN },
      uRingR0: { value: 1.3e8 },
      uRingIdx0: { value: 0 },
      uRingER: { value: new Vector3(1, 0, 0) },
      uRingEPhi: { value: new Vector3(0, 1, 0) },
      uRingCamLocal: { value: new Vector3() },
      uRingOmega: { value: 1e-4 },
      uRingKappa: { value: 1e-4 },
      uRingNu: { value: 1e-4 },
      uRingQ: { value: 1.5 },
      // sv_lighting
      uMoonCount: { value: 0 },
      uMoonPosR: { value: moonPos },
      // sv_ringLod (shared objects owned by RingLod)
      ...lod.uniforms,
      // sv_wakes (shared objects owned by WakeField)
      ...wakes.uniforms,
    };
  }

  update(f: FrameState, profile: RingProfile): void {
    const u = this.u;
    (u.uResolution.value as Vector2).set(f.width, f.height);
    u.uPixelAngle.value = f.pixelAngle;
    u.uTanHalfFov.value = Math.tan(f.fovY / 2);
    u.uAspect.value = f.aspect;
    (u.uCamToWorld.value as Matrix3).copy(f.camToWorld);
    (u.uWorldToCam.value as Matrix3).copy(f.worldToCam);
    (u.uProj.value as Matrix4).copy(f.projMatrix);
    (u.uCamPos.value as Vector3).copy(f.camPos);
    u.uTimeMod.value = ((f.t % 1e5) + 1e5) % 1e5;
    (u.uSunDir.value as Vector3).copy(f.sunDir);
    u.uSunE.value = f.solarIrradiance;
    u.uSunRadiance.value = f.sunRadiance;
    u.uSunAngRadius.value = f.sunAngularRadius;
    (u.uSaturnCenter.value as Vector3).copy(f.camPos).multiplyScalar(-1);
    u.uSaturnRot.value = f.saturnRotation;
    // ring frame
    const r = f.ring;
    u.uRingR0.value = r.r0;
    u.uRingIdx0.value = (r.r0 - profile.rMinKm * 1000) / (profile.drKm * 1000);
    (u.uRingER.value as Vector3).copy(r.eR);
    (u.uRingEPhi.value as Vector3).copy(r.ePhi);
    (u.uRingCamLocal.value as Vector3).copy(r.camLocal);
    u.uRingOmega.value = r.omega;
    u.uRingKappa.value = r.kappa;
    u.uRingNu.value = r.nu;
    u.uRingQ.value = r.qShear;
    // moons (camera-relative)
    const arr = u.uMoonPosR.value as Vector4[];
    const n = Math.min(f.moons.length, MAX_MOONS);
    for (let i = 0; i < n; i++) {
      const m = f.moons[i];
      arr[i].set(m.pos.x - f.camPos.x, m.pos.y - f.camPos.y, m.pos.z - f.camPos.z, m.meanRadius);
    }
    u.uMoonCount.value = n;
  }
}
