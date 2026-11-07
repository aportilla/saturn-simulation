// Screen-projected moon labels: hidden when behind Saturn, behind the camera or off-screen; decluttered by
// priority; clickable (fly to the moon).
import { Vector3 } from 'three';
import type { FrameState, MoonState } from '../core/FrameState';
import { SATURN } from '../core/constants';
import { segmentHitsSaturn } from '../camera/math';
import { h } from './dom';

interface Entry {
  el: HTMLElement;
  name: string;
  w: number;
}

const _v = new Vector3();
const _c = new Vector3();
const _zero = new Vector3();

export class Labels {
  readonly root: HTMLElement;
  private entries = new Map<string, Entry>();
  private saturn: Entry;
  visible = true;
  /** optional main-ring lookup (normal optical depth, full thickness H in m at radius rKm): labels of moons
   *  hidden behind (or, from inside the layer, by) the ring material are suppressed */
  ringAt: ((rKm: number) => { tau: number; H: number }) | null = null;

  /** Transmission of the main rings along the sight line camera -> camera + d. */
  private ringTransmission(cam: Vector3, d: Vector3, dist: number): number {
    if (!this.ringAt) return 1;
    const mu = Math.abs(d.z) / Math.max(dist, 1);
    const rc = Math.hypot(cam.x, cam.y) / 1000;
    const here = this.ringAt(rc);
    if (here.tau > 0 && Math.abs(cam.z) < 0.5 * here.H) {
      // inside the layer: the material between the camera and the face toward the target
      const f = Math.min(1, Math.max(0, 0.5 - Math.sign(d.z) * cam.z / here.H));
      return Math.exp(-f * here.tau / Math.max(mu, 1e-3));
    }
    if (d.z === 0) return 1;
    const s = -cam.z / d.z;
    if (s <= 0 || s >= 1) return 1;
    const rKm = Math.hypot(cam.x + s * d.x, cam.y + s * d.y) / 1000;
    const tau = this.ringAt(rKm).tau;
    return tau > 0 ? Math.exp(-tau / Math.max(mu, 1e-3)) : 1;
  }

  constructor(parent: HTMLElement, private onPick: (name: string) => void) {
    this.root = h('div', { attrs: { id: 'labels' } });
    parent.append(this.root);
    this.saturn = this.make('Saturn', 'saturn');
  }

  private make(name: string, cls: string): Entry {
    const el = h('div', { class: `mlabel ${cls}`, on: { click: (e) => { e.stopPropagation(); this.onPick(name); } } }, h('i'), h('span', { text: name }));
    el.style.display = 'none';
    this.root.append(el);
    return { el, name, w: name.length * 6.4 + 16 };
  }

  update(f: FrameState, focusName: string | null): void {
    if (!this.visible) {
      this.root.style.display = 'none';
      return;
    }
    this.root.style.display = '';
    const W = window.innerWidth, H = window.innerHeight;
    const th = Math.tan(f.fovY / 2);
    const pxPerRad = H / (2 * th);
    const placed: [number, number, number, number][] = [];
    const project = (p: Vector3): [number, number, number] | null => {
      _c.copy(p).sub(f.camPos).applyMatrix3(f.worldToCam);
      if (_c.z >= -1e-6) return null;
      const x = (_c.x / -_c.z / (th * f.aspect)) * 0.5 + 0.5;
      const y = 0.5 - (_c.y / -_c.z / th) * 0.5;
      return [x * W, y * H, -_c.z];
    };
    const place = (e: Entry, x: number, y: number, rPx: number, show: boolean) => {
      if (!show) {
        if (e.el.style.display !== 'none') e.el.style.display = 'none';
        return;
      }
      const lx = x + Math.max(0, rPx) * 0.72 + 3, ly = y - Math.max(0, rPx) * 0.72 - 10;
      const rect: [number, number, number, number] = [lx, ly, lx + e.w, ly + 16];
      if (lx > W || ly > H || rect[2] < 0 || rect[3] < 0) { e.el.style.display = 'none'; return; }
      for (const r of placed) {
        if (rect[0] < r[2] && rect[2] > r[0] && rect[1] < r[3] && rect[3] > r[1]) {
          e.el.style.display = 'none';
          return;
        }
      }
      placed.push(rect);
      if (e.el.style.display === 'none') e.el.style.display = '';
      e.el.style.transform = `translate3d(${lx.toFixed(1)}px, ${ly.toFixed(1)}px, 0)`;
    };

    // Saturn (only when it's small on screen)
    const sp = project(_zero);
    const dS = f.camPos.length();
    const rS = sp ? (SATURN.R_EQ / dS) * pxPerRad : 0;
    place(this.saturn, sp ? sp[0] - 4 : 0, sp ? sp[1] : 0, rS, !!sp && rS < 26 && rS * 2 < H);
    // keep labels off Saturn's disk and main rings while they are small on screen
    if (sp && rS < 120) placed.push([sp[0] - 2.35 * rS - 4, sp[1] - 1.05 * rS - 4, sp[0] + 2.35 * rS + 4, sp[1] + 1.05 * rS + 4]);

    // moons by priority: major first, then by size
    const moons = [...f.moons].sort((a, b) => rank(b) - rank(a));
    const seen = new Set<string>();
    for (const m of moons) {
      seen.add(m.name);
      let e = this.entries.get(m.name);
      if (!e) {
        e = this.make(m.name, m.kind === 'major' ? 'major' : 'minor');
        this.entries.set(m.name, e);
      }
      const p = project(m.pos);
      if (!p) { place(e, 0, 0, 0, false); continue; }
      const d = p[2];
      const dist = _v.copy(m.pos).sub(f.camPos).length();
      // small outer/irregular moons only get a label when you are near them
      if ((m.kind === 'minor' || m.kind === 'irregular') && dist > 2e7) { place(e, 0, 0, 0, false); continue; }
      const rPx = (m.meanRadius / dist) * pxPerRad;
      // hidden behind Saturn?
      _v.copy(m.pos).sub(f.camPos);
      const occluded = segmentHitsSaturn(f.camPos, _v, 1 - m.meanRadius / Math.max(dist, 1))
        || this.ringTransmission(f.camPos, _v, dist) < 0.1;
      const isFocus = focusName !== null && m.name.toLowerCase() === focusName;
      const tooBig = rPx > 90 || (isFocus && rPx > 30);
      place(e, p[0], p[1], rPx, !occluded && !tooBig && d > 0);
    }
    for (const [name, e] of this.entries) if (!seen.has(name)) e.el.style.display = 'none';
  }
}

function rank(m: MoonState): number {
  return (m.kind === 'major' ? 1e7 : 0) + m.meanRadius / 1e3;
}
