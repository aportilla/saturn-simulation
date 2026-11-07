// Raw input accumulation (keyboard / mouse / wheel / touch). Controllers consume one InputFrame per
// animation frame.

export interface InputFrame {
  /** pointer drag since the last frame (CSS px; +x right, +y down) */
  dragX: number;
  dragY: number;
  /** normalized wheel delta (~100 per notch; + = toward the user / zoom out) */
  wheel: number;
  /** product of pinch distance ratios (> 1 = fingers spreading = zoom in) */
  pinch: number;
  keys: ReadonlySet<string>;
  shift: boolean;
  alt: boolean;
  /** radians per CSS pixel at the screen center (grab-to-rotate feel) */
  lookScale: number;
  /** any camera-moving input happened this frame (cancels fly-to transitions) */
  interacted: boolean;
}

const MOVE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'KeyQ', 'KeyE', 'Space', 'ControlLeft', 'ControlRight',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown',
]);

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export class InputState {
  readonly keys = new Set<string>();
  private dragX = 0;
  private dragY = 0;
  private wheel = 0;
  private pinch = 1;
  private touched = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  /** set by the app: radians per CSS pixel */
  lookScale = 1e-3;
  enabled = true;

  attach(canvas: HTMLElement): void {
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) this.pinchDist = this.currentPinchDist();
      this.touched = true;
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 1) {
        this.dragX += dx;
        this.dragY += dy;
      } else if (this.pointers.size === 2) {
        const d = this.currentPinchDist();
        if (this.pinchDist > 0 && d > 0) this.pinch *= d / this.pinchDist;
        this.pinchDist = d;
      }
      this.touched = true;
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.pinchDist = this.pointers.size === 2 ? this.currentPinchDist() : 0;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      let d = e.deltaY;
      if (e.deltaMode === 1) d *= 33;
      else if (e.deltaMode === 2) d *= 600;
      // macOS trackpad pinch arrives as ctrl+wheel with small deltas
      if (e.ctrlKey) d *= 4;
      this.wheel += d;
      this.touched = true;
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (!this.enabled || isTypingTarget(e.target)) return;
      if (e.metaKey) return;
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'PageUp' || e.code === 'PageDown') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.key === 'Meta') this.keys.clear();
    });
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.keys.clear();
    });
  }

  private currentPinchDist(): number {
    const ps = [...this.pointers.values()];
    if (ps.length < 2) return 0;
    return Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
  }

  /** Accumulated input since the previous call. */
  consume(): InputFrame {
    let moveKey = false;
    for (const k of this.keys) if (MOVE_KEYS.has(k)) { moveKey = true; break; }
    const fr: InputFrame = {
      dragX: this.dragX,
      dragY: this.dragY,
      wheel: this.wheel,
      pinch: this.pinch,
      keys: this.keys,
      shift: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      alt: this.keys.has('AltLeft') || this.keys.has('AltRight'),
      lookScale: this.lookScale,
      interacted: moveKey || this.dragX !== 0 || this.dragY !== 0 || this.wheel !== 0 || this.pinch !== 1,
    };
    this.dragX = 0;
    this.dragY = 0;
    this.wheel = 0;
    this.pinch = 1;
    this.touched = false;
    return fr;
  }
}

/** An InputFrame with no input (used for passive controller updates during transitions). */
export function emptyInput(lookScale = 1e-3): InputFrame {
  return { dragX: 0, dragY: 0, wheel: 0, pinch: 1, keys: new Set(), shift: false, alt: false, lookScale, interacted: false };
}

/** +1 / -1 / 0 from a pair of key sets. */
export function axis(keys: ReadonlySet<string>, pos: string[], neg: string[]): number {
  let v = 0;
  for (const k of pos) if (keys.has(k)) { v += 1; break; }
  for (const k of neg) if (keys.has(k)) { v -= 1; break; }
  return v;
}
