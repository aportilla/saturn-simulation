// Procedural astronaut in an EVA suit, at true scale (1.9 m from boot soles to helmet top, life-support
// backpack included): an original design built from three.js primitives (spheres / capsules / tori /
// cylinders / rounded boxes), merged into one indexed BufferGeometry with smooth per-part normals and a
// per-vertex material id (`mat`, see ASTRO_MAT). No logos, flags or agency markings.
//
// Body frame (m): origin at the centre of the bounding box, +y up (head), +z front (visor / chest), +x the
// astronaut's left. Pose: the relaxed "neutral body posture" of microgravity - arms floating out and forward
// with the elbows bent, hips and knees flexed, feet pointing down - slightly asymmetric.
import {
  BufferGeometry, CapsuleGeometry, CylinderGeometry, Float32BufferAttribute, Matrix4, Quaternion, SphereGeometry,
  TorusGeometry, Uint32BufferAttribute, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/** Material ids (vertex attribute `mat`; shaded in astronaut.frag.glsl). */
export const ASTRO_MAT = {
  fabric: 0,  // white suit fabric (thermal micrometeoroid garment)
  shell: 1,   // white hard shells: helmet, upper torso, backpack, boots (painted, slightly glossy)
  metal: 2,   // grey anodized bearings and rings
  visor: 3,   // gold-coated sun visor
  glove: 4,   // light grey gloves
  dark: 5,    // dark grey soles, grips
  panel: 6,   // light grey chest control module
} as const;

const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const v3 = (x: number, y: number, z: number) => new Vector3(x, y, z);

class Builder {
  readonly parts: BufferGeometry[] = [];

  /** Add a geometry built around the origin: scale (in its own frame), then rotate, then translate. */
  add(g: BufferGeometry, mat: number, pos: Vector3, q = new Quaternion(), scale = v3(1, 1, 1)): void {
    g.applyMatrix4(new Matrix4().compose(pos, q, scale));
    g.deleteAttribute('uv');
    const n = g.getAttribute('position').count;
    if (!g.index) {
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new Uint32BufferAttribute(idx, 1));
    }
    g.setAttribute('mat', new Float32BufferAttribute(new Float32Array(n).fill(mat), 1));
    this.parts.push(g);
  }

  ellipsoid(c: Vector3, r: Vector3, mat: number, q = new Quaternion(), ws = 22, hs = 14): void {
    this.add(new SphereGeometry(1, ws, hs), mat, c, q, r);
  }

  /** Capsule whose cap centres are a and b (radius r), optionally flattened across (sx, sz in its own frame). */
  capsule(a: Vector3, b: Vector3, r: number, mat: number, sx = 1, sz = 1, radial = 14): void {
    const d = b.clone().sub(a);
    const len = d.length();
    const q = new Quaternion().setFromUnitVectors(Y, d.normalize());
    this.add(new CapsuleGeometry(r, len, 5, radial), mat, a.clone().add(b).multiplyScalar(0.5), q, v3(sx, 1, sz));
  }

  /** Closed cylinder from a to b. */
  cylinder(a: Vector3, b: Vector3, r: number, mat: number, radial = 18): void {
    const d = b.clone().sub(a);
    const q = new Quaternion().setFromUnitVectors(Y, d.clone().normalize());
    this.add(new CylinderGeometry(r, r, d.length(), radial, 1, false), mat, a.clone().add(b).multiplyScalar(0.5), q);
  }

  /** Torus (bearing ring) centred at c with its axis along `axis`. */
  ring(c: Vector3, axis: Vector3, R: number, tube: number, mat: number, scale = v3(1, 1, 1)): void {
    const q = new Quaternion().setFromUnitVectors(Z, axis.clone().normalize());
    this.add(new TorusGeometry(R, tube, 8, 30), mat, c, q, scale);
  }

  box(c: Vector3, size: Vector3, radius: number, mat: number, q = new Quaternion()): void {
    this.add(new RoundedBoxGeometry(size.x, size.y, size.z, 3, radius), mat, c, q);
  }
}

/** Orthonormal frame with `along` as +y and `fwd` (projected) as +z. */
function frame(along: Vector3, fwd: Vector3): Quaternion {
  const yA = along.clone().normalize();
  const zA = fwd.clone().sub(yA.clone().multiplyScalar(fwd.dot(yA))).normalize();
  const xA = new Vector3().crossVectors(yA, zA);
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(xA, yA, zA));
}

function arm(b: Builder, s: number, ua: Vector3, fa: Vector3): void {
  const M = ASTRO_MAT;
  const S = v3(s * 0.285, 0.515, -0.005);              // shoulder joint
  const dU = ua.clone().normalize(), dF = fa.clone().normalize();
  const E = S.clone().addScaledVector(dU, 0.3);         // elbow
  const W = E.clone().addScaledVector(dF, 0.27);        // wrist
  b.ring(S.clone().addScaledVector(dU, 0.035), dU, 0.082, 0.017, M.metal);          // scye bearing
  b.capsule(S.clone().addScaledVector(dU, 0.04), E, 0.076, M.fabric);
  b.ring(S.clone().addScaledVector(dU, 0.15), dU, 0.077, 0.011, M.metal);          // upper-arm bearing
  b.ellipsoid(E, v3(0.073, 0.073, 0.073), M.fabric);
  b.capsule(E, W.clone().addScaledVector(dF, -0.02), 0.066, M.fabric);
  b.cylinder(W.clone().addScaledVector(dF, -0.025), W.clone().addScaledVector(dF, 0.01), 0.058, M.metal);  // wrist disconnect
  // glove: gauntlet, flattened hand with the fingers slightly curled, thumb
  const side = new Vector3().crossVectors(dF, Y).normalize().multiplyScalar(s);   // toward the thumb side
  b.cylinder(W.clone().addScaledVector(dF, 0.01), W.clone().addScaledVector(dF, 0.05), 0.05, M.glove);
  const palm = W.clone().addScaledVector(dF, 0.1);
  b.ellipsoid(palm, v3(0.048, 0.062, 0.03), M.glove, frame(dF, side.clone().cross(dF).multiplyScalar(-s)));
  const tip = palm.clone().addScaledVector(dF, 0.055).add(v3(0, -0.02, 0));
  b.capsule(palm.clone().addScaledVector(dF, 0.03), tip, 0.024, M.glove, 1.6, 0.75, 10);
  b.capsule(W.clone().addScaledVector(dF, 0.075).addScaledVector(side, 0.035), W.clone().addScaledVector(dF, 0.125).addScaledVector(side, 0.05), 0.015, M.glove, 1, 1, 8);
}

function leg(b: Builder, s: number, th: Vector3, sh: Vector3, ft: Vector3): void {
  const M = ASTRO_MAT;
  const Hj = v3(s * 0.105, -0.03, 0.0);               // hip joint
  const dT = th.clone().normalize(), dS = sh.clone().normalize(), dFt = ft.clone().normalize();
  const K = Hj.clone().addScaledVector(dT, 0.44);       // knee
  const A = K.clone().addScaledVector(dS, 0.42);        // ankle
  b.ellipsoid(Hj, v3(0.105, 0.105, 0.105), M.fabric);
  b.capsule(Hj, K, 0.097, M.fabric);
  b.ring(Hj.clone().addScaledVector(dT, 0.13), dT, 0.099, 0.013, M.metal);         // thigh bearing
  b.ellipsoid(K, v3(0.09, 0.09, 0.09), M.fabric);
  b.capsule(K, A, 0.08, M.fabric);
  b.ring(A.clone().addScaledVector(dS, -0.03), dS, 0.081, 0.013, M.metal);         // boot ring
  // boot: shell along the foot direction with the sole underneath
  const up = new Vector3().crossVectors(dFt, v3(1, 0, 0)).normalize();   // top of the foot
  const q = frame(up, dFt);
  const bc = A.clone().addScaledVector(dFt, 0.075).addScaledVector(up, -0.01);
  b.box(bc, v3(0.118, 0.115, 0.285), 0.045, M.shell, q);
  b.box(bc.clone().addScaledVector(up, -0.065), v3(0.112, 0.024, 0.29), 0.01, M.dark, q);
}

/** The astronaut mesh geometry (≈ 24k triangles), centred on its bounding box. */
export function buildAstronautGeometry(): BufferGeometry {
  const b = new Builder();
  const M = ASTRO_MAT;
  // --- torso: soft lower torso and brief, waist bearing, hard upper torso with the shoulder yoke
  b.ellipsoid(v3(0, 0.0, 0.0), v3(0.19, 0.135, 0.145), M.fabric);
  b.capsule(v3(0, 0.07, 0.0), v3(0, 0.22, 0.0), 0.155, M.fabric, 1, 0.86, 20);
  b.ring(v3(0, 0.215, 0.0), Y, 0.158, 0.017, M.metal, v3(1, 0.88, 1));
  b.ellipsoid(v3(0, 0.425, 0.005), v3(0.245, 0.215, 0.168), M.shell, undefined, 26, 16);
  b.ellipsoid(v3(0, 0.52, -0.012), v3(0.29, 0.1, 0.152), M.shell, undefined, 26, 12);
  // chest control module with two knobs
  const qc = new Quaternion().setFromAxisAngle(v3(1, 0, 0), -0.28);
  b.box(v3(0, 0.39, 0.17), v3(0.25, 0.13, 0.07), 0.018, M.panel, qc);
  b.cylinder(v3(-0.075, 0.455, 0.165), v3(-0.075, 0.475, 0.17), 0.018, M.metal, 14);
  b.cylinder(v3(0.075, 0.455, 0.165), v3(0.075, 0.475, 0.17), 0.018, M.metal, 14);
  b.box(v3(0, 0.375, 0.2), v3(0.12, 0.05, 0.012), 0.004, M.dark, qc);
  // --- neck ring and helmet: white shell, gold visor over the face, two helmet lamps
  const qn = new Quaternion().setFromAxisAngle(v3(1, 0, 0), -0.17);
  b.ring(v3(0, 0.638, 0.012), v3(0, 1, 0).applyQuaternion(qn), 0.128, 0.022, M.metal);
  const hc = v3(0, 0.783, 0.018);
  b.ellipsoid(hc, v3(0.163, 0.163, 0.163), M.shell, undefined, 30, 20);
  b.add(new SphereGeometry(0.169, 34, 18, Math.PI / 2 - 1.02, 2.04, 0.92, 1.3), M.visor, hc);
  b.capsule(v3(0.135, 0.855, 0.045), v3(0.135, 0.855, 0.105), 0.026, M.shell, 1, 1, 12);
  b.capsule(v3(-0.135, 0.855, 0.045), v3(-0.135, 0.855, 0.105), 0.026, M.shell, 1, 1, 12);
  b.ellipsoid(v3(0.135, 0.855, 0.132), v3(0.02, 0.02, 0.006), M.metal, undefined, 12, 8);
  b.ellipsoid(v3(-0.135, 0.855, 0.132), v3(0.02, 0.02, 0.006), M.metal, undefined, 12, 8);
  // --- life-support backpack with a lower propulsion module and a top handle
  b.box(v3(0, 0.4, -0.3), v3(0.5, 0.64, 0.24), 0.045, M.shell);
  b.box(v3(0, 0.03, -0.27), v3(0.42, 0.15, 0.19), 0.03, M.shell);
  b.box(v3(0, 0.29, -0.426), v3(0.3, 0.2, 0.016), 0.006, M.panel);
  b.cylinder(v3(-0.17, 0.745, -0.3), v3(0.17, 0.745, -0.3), 0.013, M.metal, 12);
  b.cylinder(v3(-0.17, 0.72, -0.3), v3(-0.17, 0.745, -0.3), 0.013, M.metal, 12);
  b.cylinder(v3(0.17, 0.72, -0.3), v3(0.17, 0.745, -0.3), 0.013, M.metal, 12);
  // --- limbs (neutral body posture, slightly asymmetric)
  arm(b, 1, v3(0.55, -0.68, 0.42), v3(0.22, 0.3, 0.93));
  arm(b, -1, v3(-0.5, -0.74, 0.38), v3(-0.12, 0.22, 0.97));
  leg(b, 1, v3(0.12, -0.7, 0.7), v3(0.05, -0.78, -0.62), v3(0.04, -0.75, 0.66));
  leg(b, -1, v3(-0.1, -0.76, 0.62), v3(-0.03, -0.83, -0.56), v3(-0.04, -0.7, 0.71));

  const g = mergeGeometries(b.parts, false);
  if (!g) throw new Error('astronaut: could not merge the part geometries');
  for (const p of b.parts) p.dispose();
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new Vector3());
  g.translate(-c.x, -c.y, -c.z);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
