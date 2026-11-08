// Settings: exposure, particle quality, render scale, FOV, bloom, feature toggles. Changes apply immediately
// and are persisted by the app.
import type { AppSettings } from '../app/settings';
import { defaultAppSettings, FPS_CHOICES } from '../app/settings';
import { PARTICLE_QUALITIES, type ParticleQuality, type RenderSettings } from '../core/FrameState';
import { h, setClass, setHtml } from './dom';

export interface SettingsHost {
  settings: AppSettings;
  apply(changed: keyof RenderSettings | 'fovDeg' | 'hud' | 'maxFps' | 'all'): void;
  statusHtml(): string;
  copyLink(): void;
}

type BoolKey = 'wakes' | 'dustRings' | 'stars' | 'labels' | 'nearField' | 'astronaut';

export class SettingsPanel {
  readonly root: HTMLElement;
  private sliders = new Map<string, { input: HTMLInputElement; out: HTMLOutputElement; fmt: (v: number) => string }>();
  private toggles = new Map<BoolKey, HTMLInputElement>();
  private segAuto: HTMLButtonElement;
  private segManual: HTMLButtonElement;
  private segFps = new Map<number, HTMLButtonElement>();
  private segQuality = new Map<ParticleQuality, HTMLButtonElement>();
  private foot: HTMLElement;

  constructor(parent: HTMLElement, private host: SettingsHost) {
    this.segAuto = h('button', { text: 'Auto', on: { click: () => this.setExposureMode('auto') } });
    this.segManual = h('button', { text: 'Manual', on: { click: () => this.setExposureMode('manual') } });
    const exp = h('div', { class: 'set-row' }, h('label', { text: 'Exposure' }), h('div', { class: 'seg' }, this.segAuto, this.segManual), h('span'));
    for (const v of FPS_CHOICES) {
      this.segFps.set(v, h('button', { text: v === 0 ? 'Max' : String(v), title: v === 0 ? 'Uncapped (display refresh rate)' : `Cap at ${v} frames/s`, on: { click: () => this.setMaxFps(v) } }));
    }
    const fps = h('div', { class: 'set-row' }, h('label', { text: 'Frame rate' }), h('div', { class: 'seg' }, ...this.segFps.values()), h('span'));
    const qTitle: Record<ParticleQuality, string> = {
      low: 'Smooth spheres, statistical shadows only (fastest)',
      medium: 'Smooth spheres with shadows cast by the nearby particles',
      high: 'Lumpy, spinning ellipsoids with regolith texture and shadows cast by the nearby particles',
    };
    for (const v of PARTICLE_QUALITIES) {
      this.segQuality.set(v, h('button', { text: v[0].toUpperCase() + v.slice(1), title: qTitle[v], on: { click: () => this.setQuality(v) } }));
    }
    const quality = h('div', {
      class: 'set-row',
      title: 'How finely the ring particles are rendered. It never changes how many there are: every particle at least one pixel across is always drawn, at its true position and size.',
    }, h('label', { text: 'Particle quality' }), h('div', { class: 'seg' }, ...this.segQuality.values()), h('span'));
    this.foot = h('div', { class: 'set-foot' });
    this.root = h('div', { class: 'panel sv-chrome sv-hidden', attrs: { id: 'settings' } },
      exp,
      this.slider('exposureEV', 'EV offset', -6, 6, 0.1, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`),
      quality,
      this.slider('renderScale', 'Render scale', 0.25, 2, 0.25, (v) => `${v.toFixed(2)}×`,
        'Internal resolution relative to the display (capped at ~2.4 MP at 1×). Lower is faster and softer.'),
      fps,
      this.slider('fovDeg', 'Field of view', 20, 100, 1, (v) => `${v.toFixed(0)}°`),
      this.slider('bloom', 'Bloom', 0, 2, 0.1, (v) => (v === 0 ? 'off' : `${v.toFixed(1)}×`)),
      h('div', { class: 'toggles' },
        this.toggle('wakes', 'Self-gravity wakes'), this.toggle('nearField', 'Near-field particles'),
        this.toggle('dustRings', 'Dusty rings'), this.toggle('stars', 'Stars'),
        this.toggle('labels', 'Moon labels'), this.toggle('astronaut', 'Astronaut for scale (V)')),
      h('div', { class: 'set-actions' },
        h('button', { class: 'btn', text: 'Reset to defaults', on: { click: () => this.reset() } }),
        h('button', { class: 'btn', text: 'Copy link to this moment', title: 'Place + UTC time + warp as a URL', on: { click: () => this.host.copyLink() } })),
      this.foot);
    parent.append(this.root);
    this.sync();
  }

  private slider(key: string, label: string, min: number, max: number, step: number, fmt: (v: number) => string, help?: string): HTMLElement {
    const input = h('input', { attrs: { type: 'range', min: String(min), max: String(max), step: String(step), 'aria-label': label } });
    const out = h('output');
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      const s = this.host.settings;
      if (key === 'fovDeg') s.fovDeg = v;
      else (s.render as unknown as Record<string, number>)[key] = v;
      out.textContent = fmt(v);
      this.host.apply(key as keyof RenderSettings);
    });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    this.sliders.set(key, { input, out, fmt });
    return h('div', { class: 'set-row', title: help }, h('label', { text: label }), input, out);
  }

  private toggle(key: BoolKey, label: string): HTMLElement {
    const input = h('input', { attrs: { type: 'checkbox' } });
    input.addEventListener('change', () => {
      this.host.settings.render[key] = input.checked;
      this.host.apply(key);
    });
    this.toggles.set(key, input);
    return h('label', { class: 'tog' }, input, label);
  }

  private setExposureMode(m: 'auto' | 'manual'): void {
    this.host.settings.render.exposureMode = m;
    this.host.apply('exposureMode');
    this.sync();
  }

  private setQuality(v: ParticleQuality): void {
    this.host.settings.render.particleQuality = v;
    this.host.apply('particleQuality');
    this.sync();
  }

  private setMaxFps(v: number): void {
    this.host.settings.maxFps = v;
    this.host.apply('maxFps');
    this.sync();
  }

  private reset(): void {
    const d = defaultAppSettings();
    const s = this.host.settings;
    s.render = d.render;
    s.fovDeg = d.fovDeg;
    s.maxFps = d.maxFps;
    this.host.apply('all');
    this.sync();
  }

  /** Refresh controls from the settings object. */
  sync(): void {
    const s = this.host.settings;
    for (const [key, { input, out, fmt }] of this.sliders) {
      const v = key === 'fovDeg' ? s.fovDeg : (s.render as unknown as Record<string, number>)[key];
      input.value = String(v);
      out.textContent = fmt(v);
    }
    for (const [key, input] of this.toggles) input.checked = s.render[key];
    setClass(this.segAuto, 'on', s.render.exposureMode === 'auto');
    setClass(this.segManual, 'on', s.render.exposureMode === 'manual');
    for (const [v, b] of this.segFps) setClass(b, 'on', v === s.maxFps);
    for (const [v, b] of this.segQuality) setClass(b, 'on', v === s.render.particleQuality);
    const evLabel = this.root.querySelector('.set-row:nth-child(2) label');
    if (evLabel) evLabel.textContent = s.render.exposureMode === 'auto' ? 'EV offset' : 'Manual EV';
  }

  get open(): boolean {
    return !this.root.classList.contains('sv-hidden');
  }
  setOpen(on: boolean): void {
    setClass(this.root, 'sv-hidden', !on);
    if (on) this.refreshStatus();
  }
  refreshStatus(): void {
    setHtml(this.foot, this.host.statusHtml());
  }
}
