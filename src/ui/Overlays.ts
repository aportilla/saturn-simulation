// Small overlay components: loading screen, toast, help, explainer card, render stats.
import { h, setClass, setHtml, setText } from './dom';

// ------------------------------------------------------------------ loading screen (markup in index.html)
export class Loading {
  private root: HTMLElement | null;
  private bar: HTMLElement | null;
  private status: HTMLElement | null;
  constructor() {
    this.root = document.getElementById('loading');
    this.bar = this.root?.querySelector('.bar i') ?? null;
    this.status = this.root?.querySelector('.status') ?? null;
  }
  set(text: string, progress: number): void {
    if (this.status) this.status.textContent = text;
    if (this.bar) this.bar.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
  }
  fail(msg: string): void {
    if (!this.root) return;
    const e = this.root.querySelector('.err') ?? this.root.appendChild(h('div', { class: 'err' }));
    e.textContent = msg;
    if (this.status) this.status.textContent = '';
  }
  hide(): void {
    if (!this.root) return;
    this.root.classList.add('done');
    const r = this.root;
    window.setTimeout(() => r.remove(), 1200);
    this.root = null;
  }
}

// ------------------------------------------------------------------ toast
export class Toast {
  readonly root: HTMLElement;
  private timer = 0;
  constructor(parent: HTMLElement) {
    this.root = h('div', { class: 'panel', attrs: { id: 'toast', role: 'status', 'aria-live': 'polite' } });
    parent.append(this.root);
  }
  show(msg: string, ms = 1800): void {
    setText(this.root, msg);
    this.root.classList.add('show');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.root.classList.remove('show'), ms);
  }
}

// ------------------------------------------------------------------ help
const HELP: [string, [string, string][]][] = [
  ['Everywhere', [
    ['1 … 9, 0', 'fly to a place (see Places)'],
    ['M', 'places menu'],
    ['C', 'co-orbit here ⇄ orbit Saturn'],
    ['Esc', 'cancel a fly-to / close panels'],
    ['H', 'hide / show the HUD'],
    ['I', 'show the explainer for this place'],
    ['O', 'settings'],
    ['?', 'this help'],
  ]],
  ['Time', [
    ['P', 'play / pause'],
    ['K  /  L', 'slower / faster (×10 steps)'],
    ['J', 'reverse time'],
    ['N', 'now, real time'],
    ['click the clock', 'set a date (UTC)'],
  ]],
  ['Orbit mode', [
    ['drag', 'rotate around the target'],
    ['scroll / pinch', 'zoom (exponential, surface to 10¹¹ m)'],
    ['W  S', 'zoom in / out'],
    ['A D  R F  arrows', 'rotate'],
    ['click a label', 'fly to that moon'],
  ]],
  ['Co-orbit (inside the rings)', [
    ['drag / arrows', 'look around (relative to the co-rotating frame)'],
    ['W A S D', 'fly horizontally'],
    ['R / Space, F / Ctrl', 'up / down'],
    ['Q  E', 'roll'],
    ['scroll,  [  ]', 'flight speed (1 mm/s … 100 km/s)'],
    ['Shift / Alt', '×10 / ×0.1 speed'],
    ['B', 'ballistic: become a free ring particle'],
  ]],
];

export class Help {
  readonly root: HTMLElement;
  constructor(parent: HTMLElement) {
    const cols = h('div', { class: 'cols' });
    for (const [title, rows] of HELP) {
      cols.append(h('div', null, h('h3', { text: title }), ...rows.map(([k, v]) => h('div', { class: 'kr' }, h('span', { text: k }), h('span', { text: v })))));
    }
    const card = h('div', { class: 'card panel' },
      h('button', { class: 'btn close', text: 'Close', on: { click: () => this.setOpen(false) } }),
      h('h2', { text: 'Saturn, to scale and in real time' }),
      h('p', { class: 'lead', html: 'Everything is at true size and moves at its true speed. Default time is <b>now</b> at 1×: inside the rings that means near-stillness — neighbouring particles drift by at centimeters per second. Speed time up to watch the dynamics.' }),
      cols);
    this.root = h('div', { class: 'sv-hidden', attrs: { id: 'help' }, on: { click: (e) => { if (e.target === this.root) this.setOpen(false); } } }, card);
    parent.append(this.root);
  }
  get open(): boolean {
    return !this.root.classList.contains('sv-hidden');
  }
  setOpen(on: boolean): void {
    setClass(this.root, 'sv-hidden', !on);
  }
}

// ------------------------------------------------------------------ explainer card
export class Explainer {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private kicker: HTMLElement;
  private hideTimer = 0;
  dismissed = false;
  constructor(parent: HTMLElement) {
    this.kicker = h('div', { class: 'kicker', text: 'What you are seeing' });
    this.body = h('div');
    this.root = h('div', { class: 'panel sv-chrome sv-hidden', attrs: { id: 'explainer' } },
      h('button', { class: 'x', text: '×', title: 'Close (I to reopen)', on: { click: () => this.close() } }), this.kicker, this.body);
    parent.append(this.root);
  }
  show(title: string, html: string, autoHideMs = 0): void {
    this.dismissed = false;
    setText(this.kicker, title);
    setHtml(this.body, html);
    setClass(this.root, 'sv-hidden', false);
    window.clearTimeout(this.hideTimer);
    if (autoHideMs > 0) this.hideTimer = window.setTimeout(() => this.close(), autoHideMs);
  }
  update(html: string): void {
    if (!this.open) return;
    setHtml(this.body, html);
  }
  close(): void {
    this.dismissed = true;
    setClass(this.root, 'sv-hidden', true);
  }
  get open(): boolean {
    return !this.root.classList.contains('sv-hidden');
  }
}

// ------------------------------------------------------------------ render stats
export class Stats {
  readonly root: HTMLElement;
  constructor(parent: HTMLElement) {
    this.root = h('div', { class: 'sv-chrome', attrs: { id: 'stats' } });
    parent.append(this.root);
  }
  set(text: string): void {
    setText(this.root, text);
  }
}
