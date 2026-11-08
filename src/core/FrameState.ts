// The per-frame state shared by every subsystem. Built once per animation frame by the app loop:
//   clock -> World.update(frame) (sun, Saturn, moons) -> camera rig (camera + ring frame) ->
//   updateCameraDerived(frame) -> Pipeline.render(frame) -> HUD.
// All positions are SEF meters in JS doubles. Shaders receive camera-relative float32 values.
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { LOG_DEPTH_FAR } from './constants';
import type { MoonShape } from '../moons/shapes';

export type MoonKind = 'major' | 'ring' | 'coorbital' | 'trojan' | 'minor' | 'irregular';

export interface MoonState {
  /** NAIF id, e.g. 602 = Enceladus */
  id: number;
  name: string;
  kind: MoonKind;
  /** SEF position (m) relative to Saturn's center */
  pos: Vector3;
  /** SEF velocity (m/s) */
  vel: Vector3;
  /** Triaxial semi-axes (m) in the body frame: x = longest (points at Saturn for synchronous rotators), y = along-orbit, z = polar */
  radii: Vector3;
  meanRadius: number;
  /**
   * Measured shape (star-shaped radius map, src/moons/shapes.ts) when loaded: Pan, Daphnis, Atlas, Prometheus, Pandora,
   * Epimetheus, Janus. It replaces the ellipsoid `radii` for rendering and camera clearance (moonSurfaceRadius()).
   */
  shape?: MoonShape | null;
  /** body -> SEF rotation */
  orient: Quaternion;
  /** Visual geometric albedo (used to scale the surface reflectance) */
  albedo: number;
  /** Linear-RGB color tint (relative, ~1) */
  color: [number, number, number];
  /** Texture key; if data/textures/moons/<key>.jpg exists it is used, else procedural surface */
  textureKey: string | null;
}

/** Local co-orbiting (Hill / shearing-sheet) frame used by all near-field ring physics. */
export interface RingFrame {
  /** Increments whenever the frame is re-anchored. Consumers holding local state must re-initialize. */
  anchorId: number;
  /** Guiding-center radius of the frame origin (m) */
  r0: number;
  /** Current azimuth (rad) of the origin, SEF, measured from +X toward +Y */
  phi0: number;
  /** Mean motion, epicyclic and vertical frequencies at r0 (rad/s), J2..J6-corrected */
  omega: number;
  kappa: number;
  nu: number;
  /** Shear parameter q = -dlnOmega/dlnr (~1.5): v_y(x) = -q * omega * x */
  qShear: number;
  /** Frame origin in SEF (m) */
  originSEF: Vector3;
  /** Unit axes (SEF): radial-outward, prograde-azimuthal, north */
  eR: Vector3;
  ePhi: Vector3;
  eZ: Vector3;
  /** Camera position in the frame (m): x radial, y azimuthal (prograde), z north */
  camLocal: Vector3;
  /** Sim time (s since J2000) at which this anchor was created */
  tAnchor: number;
}

export type ParticleQuality = 'low' | 'medium' | 'high';
export const PARTICLE_QUALITIES: readonly ParticleQuality[] = ['low', 'medium', 'high'];

export interface RenderSettings {
  exposureMode: 'auto' | 'manual';
  /** log2 exposure compensation (auto) or absolute EV offset from the default (manual) */
  exposureEV: number;
  /** Multiplier on the internal render resolution (scale 1 = devicePixelRatio capped to ~2.4 MP); default 0.5 */
  renderScale: number;
  /**
   * Rendering fidelity of the near-field particles - never their number or positions (every particle >= 1
   * display pixel across is always drawn). high: lumpy triaxial ellipsoids + analytic shadow map; medium:
   * smooth spheres + shadow map; low: smooth spheres, statistical shadows only.
   */
  particleQuality: ParticleQuality;
  wakes: boolean;
  dustRings: boolean;
  stars: boolean;
  labels: boolean;
  nearField: boolean;
  /** Camera-pinned astronaut in a spacesuit, lower right of the view, for scale (key V) */
  astronaut: boolean;
  /** Bloom strength multiplier (0 disables) */
  bloom: number;
  /** Debug visualization selector (0 = off). Passes may interpret values. */
  debugView: number;
}

export interface FrameState {
  frameIndex: number;
  /** Simulation time, seconds since J2000 TDB */
  t: number;
  /** Simulated seconds since the previous frame (negative when running backwards) */
  dt: number;
  /** Wall-clock seconds since the previous frame */
  dtReal: number;
  timeWarp: number;
  jdTdb: number;

  // ---- Sun (SEF)
  sunDir: Vector3;
  sunDistance: number;
  solarIrradiance: number;
  sunAngularRadius: number;
  sunRadiance: number;

  // ---- Saturn
  /** System III prime meridian angle W (rad), SEF, from +X toward +Y */
  saturnRotation: number;

  // ---- Moons
  moons: MoonState[];

  // ---- Camera
  camPos: Vector3;
  /** camera -> SEF rotation; camera looks along its local -Z with +Y up (three.js convention) */
  camQuat: Quaternion;
  /** Vertical field of view (rad) */
  fovY: number;
  aspect: number;
  /** Drawing-buffer size in pixels (internal render resolution) */
  width: number;
  height: number;
  /** Angular size of one pixel (rad), vertical */
  pixelAngle: number;
  /** Height of the display canvas in device pixels (0: same as `height`) */
  canvasHeight: number;
  /** Angular size of one DISPLAY (canvas) pixel (rad): the unit of the near-field count contract */
  canvasPixelAngle: number;
  /** camera-local -> SEF rotation (3x3) */
  camToWorld: Matrix3;
  /** SEF -> camera-local rotation (3x3) */
  worldToCam: Matrix3;
  /** World(SEF, camera at origin) -> view; rotation only */
  viewMatrix: Matrix4;
  /** Perspective projection (x,y,w); z is replaced by log depth in shaders */
  projMatrix: Matrix4;
  invProjMatrix: Matrix4;

  // ---- Ring local frame
  ring: RingFrame;

  // ---- Exposure (multiplier radiance[W m^-2 sr^-1] -> display-linear), filled by PostPass from the previous frame
  exposure: number;

  settings: RenderSettings;
}

export function defaultSettings(): RenderSettings {
  return {
    exposureMode: 'auto',
    exposureEV: 0,
    renderScale: 0.5,
    particleQuality: 'high',
    wakes: true,
    dustRings: true,
    stars: true,
    labels: true,
    nearField: true,
    astronaut: true,
    bloom: 1,
    debugView: 0,
  };
}

export function createFrameState(): FrameState {
  return {
    frameIndex: 0,
    t: 0,
    dt: 0,
    dtReal: 0,
    timeWarp: 1,
    jdTdb: 2451545,
    sunDir: new Vector3(1, 0, 0),
    sunDistance: 1.4e12,
    solarIrradiance: 15,
    sunAngularRadius: 5e-4,
    sunRadiance: 2e7,
    saturnRotation: 0,
    moons: [],
    camPos: new Vector3(0, -3e8, 1e8),
    camQuat: new Quaternion(),
    fovY: (60 * Math.PI) / 180,
    aspect: 16 / 9,
    width: 1280,
    height: 720,
    pixelAngle: 1e-3,
    canvasHeight: 0,
    canvasPixelAngle: 1e-3,
    camToWorld: new Matrix3(),
    worldToCam: new Matrix3(),
    viewMatrix: new Matrix4(),
    projMatrix: new Matrix4(),
    invProjMatrix: new Matrix4(),
    ring: {
      anchorId: 0,
      r0: 130_000e3,
      phi0: 0,
      omega: 1e-4,
      kappa: 1e-4,
      nu: 1e-4,
      qShear: 1.5,
      originSEF: new Vector3(130_000e3, 0, 0),
      eR: new Vector3(1, 0, 0),
      ePhi: new Vector3(0, 1, 0),
      eZ: new Vector3(0, 0, 1),
      camLocal: new Vector3(),
      tAnchor: 0,
    },
    exposure: 0.25,
    settings: defaultSettings(),
  };
}

const _m4 = new Matrix4();
/** Recompute camera matrices + pixel angle from camQuat / fovY / aspect / width / height. */
export function updateCameraDerived(f: FrameState): void {
  _m4.makeRotationFromQuaternion(f.camQuat);
  f.camToWorld.setFromMatrix4(_m4);
  f.worldToCam.copy(f.camToWorld).transpose();
  f.viewMatrix.copy(_m4).transpose(); // inverse of a pure rotation
  const near = 1e-3;
  const top = near * Math.tan(f.fovY / 2);
  const right = top * f.aspect;
  f.projMatrix.makePerspective(-right, right, top, -top, near, LOG_DEPTH_FAR);
  f.invProjMatrix.copy(f.projMatrix).invert();
  f.pixelAngle = (2 * Math.tan(f.fovY / 2)) / f.height;
  f.canvasPixelAngle = (2 * Math.tan(f.fovY / 2)) / (f.canvasHeight > 0 ? f.canvasHeight : f.height);
}

/** Camera forward direction (SEF) */
export function cameraForward(f: FrameState, out = new Vector3()): Vector3 {
  return out.set(0, 0, -1).applyQuaternion(f.camQuat);
}
