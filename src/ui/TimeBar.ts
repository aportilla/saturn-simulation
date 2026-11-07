// Time controls: UTC clock (click to set), reverse, play/pause, warp magnitudes, Now.
import type { SimClock } from '../core/time';
import { tdbFromIso } from '../core/time';
import { h, ICONS, setClass, setHtml, setText } from './dom';
import { utc, utcInputValue, warp as fmtWarp } from './format';

export const WARP_STEPS = [1, 10, 100, 1e3, 1e4, 1e5, 1e6];
const WARP_LABELS = ['1×', '10', '100', '1k', '10k', '100k', '1M'];

export interface TimeActions {
  onTimeJump(): void;
  toast(msg: string): void;
}

export class TimeBar {
  readonly root: HTMLElement;
  private clockEl: HTMLElement;
  private playBtn: HTMLButtonElement;
  private revBtn: HTMLButtonElement;
  private warpBtns: HTMLButtonElement[] = [];
  private label: HTMLElement;
  private editor: HTMLElement;
  private input: HTMLInputElement;
  private editing = false;

  constructor(parent: HTMLElement, private clock: SimClock, private act: TimeActions) {
    this.clockEl = h('div', { class: 'clock', title: 'Simulation time (UTC) — click to set', on: { click: () => this.openEditor() } });
    this.input = h('input', { attrs: { type: 'datetime-local', step: '1', 'aria-label': 'UTC date and time' } });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.applyEditor();
      if (e.key === 'Escape') this.closeEditor();
      e.stopPropagation();
    });
    this.editor = h('div', { class: 'date-edit sv-hidden' },
      this.input,
      h('span', { class: 'warp-label', text: 'UTC' }),
      h('button', { class: 'tb-btn', text: 'Set', on: { click: () => this.applyEditor() } }),
      h('button', { class: 'tb-btn', text: 'Cancel', on: { click: () => this.closeEditor() } }));
    this.revBtn = h('button', { class: 'tb-btn', title: 'Reverse time (J)', html: ICONS.reverse, on: { click: () => this.reverse() } });
    this.playBtn = h('button', { class: 'tb-btn', title: 'Play / pause (P)', html: ICONS.pause, on: { click: () => this.togglePause() } });
    const warps = h('div', { class: 'warps', attrs: { role: 'group', 'aria-label': 'time warp' } });
    WARP_STEPS.forEach((w, i) => {
      const b = h('button', { text: WARP_LABELS[i], title: `Time warp ×${w.toLocaleString('en-US')} (K / L)`, on: { click: () => this.setWarpMagnitude(w) } });
      this.warpBtns.push(b);
      warps.append(b);
    });
    this.label = h('div', { class: 'warp-label' });
    const nowBtn = h('button', { class: 'tb-btn', title: 'Jump to now, real time (N)', html: `${ICONS.now}<span>Now</span>`, on: { click: () => this.now() } });
    this.root = h('div', { class: 'panel sv-chrome', attrs: { id: 'timebar' } },
      this.clockEl, this.editor, h('div', { class: 'sep' }), this.revBtn, this.playBtn, warps, this.label, h('div', { class: 'sep' }), nowBtn);
    parent.append(this.root);
  }

  private openEditor(): void {
    this.editing = true;
    this.input.value = utcInputValue(this.clock.date);
    setClass(this.clockEl, 'sv-hidden', true);
    setClass(this.editor, 'sv-hidden', false);
    this.input.focus();
  }
  private closeEditor(): void {
    this.editing = false;
    setClass(this.clockEl, 'sv-hidden', false);
    setClass(this.editor, 'sv-hidden', true);
  }
  private applyEditor(): void {
    const v = this.input.value;
    try {
      this.setTime(v.length === 16 ? `${v}:00` : v);
      this.closeEditor();
    } catch {
      this.act.toast('Could not parse that date');
    }
  }

  setTime(iso: string): void {
    this.clock.t = tdbFromIso(iso);
    this.act.onTimeJump();
  }

  togglePause(): void {
    this.clock.paused = !this.clock.paused;
    this.act.toast(this.clock.paused ? 'Paused' : `Running ${fmtWarp(this.clock.warp, false)}`);
  }
  reverse(): void {
    this.clock.warp = -this.clock.warp;
    this.act.toast(this.clock.warp < 0 ? 'Time running backwards' : 'Time running forwards');
  }
  setWarpMagnitude(m: number): void {
    this.clock.warp = Math.sign(this.clock.warp || 1) * m;
    this.clock.paused = false;
  }
  /** step = +1 faster / -1 slower */
  stepWarp(step: number): void {
    const a = Math.abs(this.clock.warp);
    let i = WARP_STEPS.findIndex((w) => Math.abs(w - a) < 1e-9 * w);
    if (i < 0) i = WARP_STEPS.reduce((best, w, j) => (Math.abs(Math.log(w / a)) < Math.abs(Math.log(WARP_STEPS[best] / a)) ? j : best), 0);
    i = Math.max(0, Math.min(WARP_STEPS.length - 1, i + step));
    this.setWarpMagnitude(WARP_STEPS[i]);
    this.act.toast(`Time warp ${fmtWarp(this.clock.warp, false)}`);
  }
  now(): void {
    this.clock.setNow();
    this.clock.warp = 1;
    this.clock.paused = false;
    this.act.onTimeJump();
    this.act.toast('Now, real time');
  }

  update(): void {
    if (!this.editing) setHtml(this.clockEl, `${utc(this.clock.date)}<small>UTC</small>`);
    setHtml(this.playBtn, this.clock.paused ? ICONS.play : ICONS.pause);
    setClass(this.revBtn, 'on', this.clock.warp < 0);
    const a = Math.abs(this.clock.warp);
    this.warpBtns.forEach((b, i) => setClass(b, 'on', Math.abs(WARP_STEPS[i] - a) < 1e-9 * a));
    const txt = this.clock.paused ? 'paused' : this.clock.warp === 1 ? 'real time' : fmtWarp(this.clock.warp, false);
    setText(this.label, txt);
    setClass(this.label, 'rev', this.clock.warp < 0 && !this.clock.paused);
  }
}
