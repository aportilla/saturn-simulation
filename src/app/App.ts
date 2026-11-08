// The Saturn system application: renderer + pipeline, world, clock, camera rig, HUD and controls.
//
// Frame flow (docs/ARCHITECTURE.md): SimClock.tick -> World.update -> camera rig (camPos/camQuat/fovY +
// RingAnchor.fill(frame.ring)) -> updateCameraDerived -> Pipeline.render -> HUD / labels.
import { Quaternion, Vector3, WebGLRenderer } from 'three';
import { createFrameState, PARTICLE_QUALITIES, updateCameraDerived, type FrameState, type RenderSettings } from '../core/FrameState';
import { World } from '../core/World';
import { SimClock, tdbFromIso } from '../core/time';
import { hasSunTable, loadSunTable } from '../core/ephemeris';
import { DEG, SATURN } from '../core/constants';
import { RingAnchor } from '../core/RingAnchor';
import { zoneParamsAtKm } from '../rings/ringRegions';
import type { Pipeline } from '../render/Pipeline';
import { CameraRig } from '../camera/CameraRig';
import { InputState, isTypingTarget } from '../camera/Input';
import { OrbitController } from '../camera/OrbitController';
import { FreeController, ringOrientation } from '../camera/FreeController';
import { findMoon } from '../camera/frames';
import { lookQuat } from '../camera/math';
import type { Controller } from '../camera/Transition';
import { installShaderErrorHook, loadPasses, type LoadedPasses } from './passes';
import { loadMoons, SafeMoons } from './moons';
import { loadSettings, parseUrl, saveSettings, type AppSettings, type UrlParams } from './settings';
import { PRESETS, findPreset, moonView, type Preset } from './presets';
import { PLACE_SOURCES, contextSources } from './placeSources';
import { computeLiveInfo, type LiveInfo } from './liveInfo';
import { Hud } from '../ui/Hud';
import { TimeBar } from '../ui/TimeBar';
import { PlacesPanel } from '../ui/PlacesPanel';
import { SettingsPanel } from '../ui/SettingsPanel';
import { Labels } from '../ui/Labels';
import { Explainer, Help, Loading, Stats, Toast } from '../ui/Overlays';
import { SourcesPanel, sourcesLineHtml } from '../ui/SourcesPanel';
import { h, ICONS, setClass } from '../ui/dom';
import { duration as fmtDuration, esc } from '../ui/format';
import '../ui/styles.css';

export interface AppOptions {
  /** use the orchestrator's stub passes (isolated app testing: sandbox/app.html) */
  stubs?: boolean;
}

const EST_TRANSITION_S = 6;
/** internal render resolution budget (pixels) at render scale 1 */
const PIXEL_BUDGET = 2.4e6;
/** tolerance (ms) of the frame-rate cap against requestAnimationFrame jitter */
const FRAME_SLACK_MS = 4;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export class App {
  readonly frame: FrameState = createFrameState();
  readonly clock = new SimClock();
  readonly rig = new CameraRig();
  readonly input = new InputState();
  settings: AppSettings = loadSettings();
  world!: World;
  pipeline!: Pipeline;
  renderer!: WebGLRenderer;
  private loaded!: LoadedPasses;
  private url!: UrlParams;
  private canvas!: HTMLCanvasElement;
  private ui!: HTMLElement;
  private hud!: Hud;
  private timebar!: TimeBar;
  private places!: PlacesPanel;
  private settingsPanel!: SettingsPanel;
  private labels!: Labels;
  private help!: Help;
  private sources!: SourcesPanel;
  private toast!: Toast;
  private explainer!: Explainer;
  private stats!: Stats;
  private loading = new Loading();
  private currentPreset: Preset | null = null;
  private pendingExplain: Preset | null = null;
  private moonSource = 'stub';
  private sunTable = false;
  private last = 0;
  private hudTimer = 0;
  private fps = 60;
  private fpsAcc = 0;
  private fpsN = 0;
  private framesSinceShown = -1;
  private renderErrors = new Set<string>();
  private info: LiveInfo | null = null;
  private hintsShown = new Set<string>();
  ready = false;

  constructor(private opts: AppOptions = {}) {}

  // ---------------------------------------------------------------- startup
  async start(): Promise<void> {
    const L = this.loading;
    try {
      L.set('Starting WebGL2…', 0.04);
      this.url = parseUrl();
      this.applyUrlOverrides();
      this.frame.settings = this.settings.render;
      this.createRenderer();
      installShaderErrorHook(this.renderer);

      L.set('Loading render passes…', 0.12);
      const [pipeMod, loaded] = await Promise.all([import('../render/Pipeline'), loadPasses({ stubs: this.opts.stubs })]);
      this.loaded = loaded;
      this.pipeline = new pipeMod.Pipeline(this.renderer, loaded.passes);

      L.set('Loading the ring profile and ephemerides…', 0.3);
      const { w, h: hh } = this.targetSize();
      const [, moons, sunOk] = await Promise.all([this.pipeline.init(w, hh), loadMoons(), loadSunTable()]);
      // vertical relief: ?relief= multiplier; ring-frame cameras keep their height above the local mid-plane
      const structure = this.pipeline.ctx.structure;
      if (this.url.relief !== null) structure.reliefScale = Math.max(0, this.url.relief);
      FreeController.midPlane = (x, y) => structure.midPlaneAtSEF(Math.hypot(x, y), Math.atan2(y, x));
      this.sunTable = sunOk || hasSunTable();
      this.moonSource = moons.source;
      this.world = new World(new SafeMoons(moons.provider, (e) => {
        console.warn('[app] moon ephemeris failed at runtime; switched to StubMoons', e);
        this.moonSource = 'stub (ephemeris failed)';
      }));

      L.set('Preparing the camera…', 0.7);
      this.applyUrlTime();
      this.frame.t = this.clock.t;
      this.world.update(this.frame);
      this.buildUi();
      this.resize();
      window.addEventListener('resize', () => this.resize());
      this.applyInitialCamera();
      this.exposeHooks();

      L.set('Compiling shaders…', 0.85);
      await nextFrame();
      await nextFrame();
      this.last = performance.now();
      this.tick(1 / 60);
      L.set('Ready', 1);
      await new Promise((r) => setTimeout(r, 280));
      L.hide();
      this.framesSinceShown = 0;
      this.ready = true;
      this.last = performance.now();
      requestAnimationFrame(this.loop);
    } catch (e) {
      console.error('[app] startup failed', e);
      L.fail(`The simulator could not start:\n${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private createRenderer(): void {
    this.canvas = h('canvas', { attrs: { id: 'sv-canvas', tabindex: '0', 'aria-label': 'Saturn system view' } });
    document.body.prepend(this.canvas);
    const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.renderer = new WebGLRenderer({ canvas: this.canvas, context: gl, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(this.displayRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.toast?.show('WebGL context lost — waiting for the GPU…', 6000);
    });
    this.canvas.addEventListener('webglcontextrestored', () => location.reload());
    this.input.attach(this.canvas);
  }

  /**
   * Canvas (display) pixel ratio: devicePixelRatio, capped so the drawing buffer stays within ~2.4 MP
   * (1080p class) — a full-screen Retina window would otherwise be ~3.7x that.
   */
  private displayRatio(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = Math.max(1, window.innerWidth * window.innerHeight);
    return Math.max(0.5, Math.min(dpr, Math.sqrt(PIXEL_BUDGET / css)));
  }

  /**
   * Internal render resolution = canvas resolution x render scale. The ring-layer march and the particle
   * fill scale with it; the final tone-mapping pass upsamples the HDR image bilinearly to the full-resolution
   * canvas (much smoother than letting the compositor stretch a small canvas).
   */
  private targetSize(): { w: number; h: number } {
    const pr = this.displayRatio() * this.settings.render.renderScale;
    return { w: Math.max(1, Math.round(window.innerWidth * pr)), h: Math.max(1, Math.round(window.innerHeight * pr)) };
  }

  resize(): void {
    this.renderer.setPixelRatio(this.displayRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    const { w, h: hh } = this.targetSize();
    this.frame.width = w;
    this.frame.height = hh;
    this.frame.aspect = w / hh;
    // display canvas height: the near-field count contract is in display pixels, so the render scale changes
    // the fidelity of the particles, never which ones are drawn
    this.frame.canvasHeight = this.renderer.domElement.height || hh;
    this.pipeline.setSize(w, hh);
  }

  // ---------------------------------------------------------------- URL
  private applyUrlOverrides(): void {
    const o = this.url.overrides;
    const r = this.settings.render as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'fovDeg') this.settings.fovDeg = Math.min(100, Math.max(20, v as number));
      else if (k === 'hud') this.settings.hud = v as boolean;
      else if (k === 'maxFps') this.settings.maxFps = v as number;
      else r[k] = v;
    }
    if (!PARTICLE_QUALITIES.includes(this.settings.render.particleQuality)) this.settings.render.particleQuality = 'high';
    this.settings.render.renderScale = Math.min(2, Math.max(0.25, this.settings.render.renderScale));
  }

  private applyUrlTime(): void {
    const t = this.url.t;
    if (t && t !== 'now') {
      try {
        this.clock.t = tdbFromIso(t);
      } catch {
        console.warn(`[app] ignoring bad t=${t}`);
      }
    }
    if (this.url.warp !== null) {
      if (this.url.warp === 0) this.clock.paused = true;
      else this.clock.warp = this.url.warp;
    }
    if (this.url.paused) this.clock.paused = true;
  }

  private applyInitialCamera(): void {
    const cam = this.url.cam;
    if (cam) {
      const ctl = this.cameraFromParams(cam);
      if (ctl) {
        this.rig.goto(this.frame, ctl, 'custom view', true);
        return;
      }
    }
    if (!(this.url.preset && this.goto(this.url.preset, { instant: true, keepUrl: true }))) this.goto('overview', { instant: true, keepUrl: true });
  }

  /** Sandbox-compatible camera parameters (see sandbox/common.ts). */
  private cameraFromParams(p: URLSearchParams): Controller | null {
    const n = (k: string, d: number) => {
      const v = p.has(k) ? parseFloat(p.get(k)!) : NaN;
      return Number.isFinite(v) ? v : d;
    };
    const kind = p.get('cam');
    const f = this.frame;
    if (kind === 'orbit') {
      return new OrbitController({ target: (p.get('target') ?? 'saturn').toLowerCase(), dist: n('dist', 1.2e9), az: n('az', -60) * DEG, el: n('el', 20) * DEG });
    }
    if (kind === 'ring') {
      const anchor = new RingAnchor(n('r', 130_000e3), n('phi', 0) * DEG, f.t);
      const q = ringOrientation(n('yaw', 0), n('pitch', 0), n('roll', 0), 1, new Quaternion());
      return new FreeController({ frame: 'ring', anchor, local: new Vector3(n('x', 0), n('y', 0), n('z', 0)), qLocal: q, upLocal: new Vector3(0, 0, 1), speed: n('speed', 1) });
    }
    if (kind === 'look') {
      const v = (s: string | null, d: number[]) => new Vector3(...((s ? s.split(',').map(Number) : d) as [number, number, number]));
      const pos = v(p.get('pos'), [0, -5e8, 1e8]);
      const at = v(p.get('at'), [0, 0, 0]);
      const q = lookQuat(at.clone().sub(pos), new Vector3(0, 0, 1), new Quaternion());
      return FreeController.bodyAt(f, 'sef', pos, q, n('speed', 1e4));
    }
    return null;
  }

  // ---------------------------------------------------------------- navigation
  /** Fly to (or jump to) a preset. Returns false if unknown. */
  goto(name: string, opts: { instant?: boolean; keepUrl?: boolean } = {}): boolean {
    const p = findPreset(name);
    if (!p) {
      this.toast?.show(`Unknown place “${name}”`);
      return false;
    }
    const instant = !!opts.instant;
    const f = this.frame;
    const warp = this.clock.paused ? 0 : this.clock.warp;
    const prevTransition = this.rig.transition;
    let ctl = p.build({ frame: f, tArrive: instant ? f.t : f.t + EST_TRANSITION_S * warp });
    this.rig.goto(f, ctl, p.title, instant);
    if (!instant && this.rig.transition && warp !== 0) {
      // re-time the destination for the actual flight duration (matters at high warp: the rings move)
      const T = this.rig.transition.duration;
      if (Math.abs(T - EST_TRANSITION_S) * Math.abs(warp) > 1) {
        ctl = p.build({ frame: f, tArrive: f.t + T * warp });
        this.rig.transition = prevTransition;
        this.rig.goto(f, ctl, p.title, false);
      }
    }
    this.currentPreset = p;
    this.places?.setCurrent(p.id);
    this.explainer?.close();
    if (instant) {
      this.loaded.post()?.snapExposure?.();
      this.pendingExplain = p;
      this.showExplainer(p);
    } else {
      this.pendingExplain = p;
    }
    if (!opts.keepUrl) this.updateUrl(p.id);
    return true;
  }

  /** Fly to a body by name (label clicks). */
  flyToBody(name: string): void {
    const key = name.toLowerCase();
    const f = this.frame;
    if (key === 'saturn') {
      const c = OrbitController.fromPosition(f, 'saturn', f.camPos);
      c.dist = Math.min(Math.max(c.dist, 2.5 * SATURN.R_EQ), 6 * SATURN.R_EQ);
      this.currentPreset = null;
      this.places.setCurrent(null);
      this.rig.goto(f, c, 'Saturn', false);
      return;
    }
    const preset = findPreset(key);
    if (preset && preset.group === 'Moons') {
      this.goto(preset.id);
      return;
    }
    const m = findMoon(f, key);
    if (!m) return;
    this.currentPreset = null;
    this.places.setCurrent(null);
    this.explainer.close();
    const warp = this.clock.paused ? 0 : this.clock.warp;
    this.rig.goto(f, moonView({ frame: f, tArrive: f.t + EST_TRANSITION_S * warp }, key, m.kind === 'major' ? 4 : 8), m.name, false);
  }

  private updateUrl(id: string): void {
    try {
      const p = new URLSearchParams(location.search);
      p.set('preset', id);
      for (const k of ['cam', 'target', 'dist', 'az', 'el', 'r', 'x', 'y', 'z', 'yaw', 'pitch', 'phi', 'pos', 'at']) p.delete(k);
      history.replaceState(null, '', `${location.pathname}?${p.toString()}`);
    } catch {
      /* sandboxed */
    }
  }

  private showExplainer(p: Preset): void {
    if (!p.explain || !this.explainer) return;
    const info = this.computeInfo();
    try {
      this.explainer.show(p.title, this.explainHtml(p, info), 45_000, sourcesLineHtml(PLACE_SOURCES[p.id] ?? this.contextSourceIds(info)));
    } catch (e) {
      console.warn('[app] explainer failed', e);
    }
  }

  /** References for a view without a place list: the orbited moon, else what lies at the camera's radius. */
  private contextSourceIds(x: LiveInfo): string[] {
    const a = this.rig.active;
    const moon = a instanceof OrbitController ? a.target : null;
    return contextSources({ moon, rKm: x.rCyl / 1e3, zM: x.z, altKm: x.alt / 1e3 });
  }

  /** Open the Sources panel (key G), optionally at one entry. */
  private openSources(id?: string): void {
    this.help.setOpen(false);
    this.closePanels();
    this.sources.show(id);
  }

  /** Clicks on the explainer's citations open the panel at that entry; modifier / middle clicks follow the link. */
  private onSourceLink(e: MouseEvent): void {
    const a = (e.target as Element | null)?.closest?.('a[data-ref], a[data-sources]');
    if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    this.openSources(a.getAttribute('data-ref') ?? undefined);
  }

  /** Preset explainer + a live note when the spot happens to be in Saturn's shadow right now. */
  private explainHtml(p: Preset, x: LiveInfo): string {
    let s = p.explain ? p.explain(x) : '';
    if (p.id !== 'shadow' && x.alt > 0 && x.sunVis < 0.02) {
      const t = x.shadow;
      const when = t && t.nextEvent === 'exit' && Number.isFinite(t.nextIn) ? ` Sunlight returns in ${fmtDuration(t.nextIn)} of sim time — press <kbd>L</kbd> to speed up.` : '';
      s += `<div class="note">This spot is in Saturn's shadow right now, lit only by light reflected from Saturn and the rings.${when}</div>`;
    }
    return s;
  }

  private onTimeJump(): void {
    this.loaded.post()?.snapExposure?.();
    this.frame.t = this.clock.t;
    this.world.update(this.frame);
  }

  // ---------------------------------------------------------------- UI
  private buildUi(): void {
    this.ui = h('div', { class: 'sv-ui' });
    document.body.append(this.ui);
    this.labels = new Labels(document.body, (name) => this.flyToBody(name));
    this.hud = new Hud(this.ui);
    this.toast = new Toast(this.ui);
    this.timebar = new TimeBar(this.ui, this.clock, { onTimeJump: () => this.onTimeJump(), toast: (m) => this.toast.show(m) });
    this.places = new PlacesPanel(this.ui, PRESETS, (id) => {
      this.closePanels();
      this.goto(id);
    });
    this.settingsPanel = new SettingsPanel(this.ui, {
      settings: this.settings,
      apply: (k) => this.applySetting(k),
      statusHtml: () => this.statusHtml(),
      copyLink: () => void this.copyLink(),
    });
    this.explainer = new Explainer(this.ui);
    this.explainer.root.addEventListener('click', (e) => this.onSourceLink(e));
    this.stats = new Stats(this.ui);
    this.sources = new SourcesPanel(document.body);
    this.help = new Help(document.body, { onSources: () => this.openSources() });
    const btnPlaces = h('button', { class: 'btn', title: 'Places (M)', html: `${ICONS.places}<span>Places</span>`, on: { click: () => this.togglePanel('places') } });
    const btnInfo = h('button', { class: 'btn icon', title: 'What am I seeing? (I)', html: ICONS.info, on: { click: () => this.toggleExplainer() } });
    const btnSet = h('button', { class: 'btn icon', title: 'Settings (O)', html: ICONS.gear, on: { click: () => this.togglePanel('settings') } });
    const btnHelp = h('button', { class: 'btn icon', title: 'Controls (?)', html: ICONS.help, on: { click: () => this.help.setOpen(!this.help.open) } });
    const btnHud = h('button', { class: 'btn icon', title: 'Hide the HUD (H)', html: ICONS.eye, on: { click: () => this.setHud(false) } });
    this.ui.append(h('div', { class: 'sv-chrome', attrs: { id: 'toolbar' } }, btnPlaces, btnInfo, btnSet, btnHelp, btnHud));
    this.setHud(this.settings.hud, false);
    this.labels.visible = this.settings.render.labels;
    this.rig.onCancel = () => {
      this.pendingExplain = null;
      this.currentPreset = null;
      this.places.setCurrent(null);
    };
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.canvas.addEventListener('pointerdown', () => {
      if (this.places.open || this.settingsPanel.open) this.closePanels();
      this.canvas.focus({ preventScroll: true });
    });
  }

  private togglePanel(which: 'places' | 'settings'): void {
    const p = which === 'places' ? this.places : this.settingsPanel;
    const other = which === 'places' ? this.settingsPanel : this.places;
    other.setOpen(false);
    p.setOpen(!p.open);
    this.syncPanelState();
  }

  /** The explainer card shares the right edge with the panels: hide it while a panel is open. */
  private syncPanelState(): void {
    setClass(this.ui, 'panel-open', this.places.open || this.settingsPanel.open);
  }

  private closePanels(): void {
    this.places.setOpen(false);
    this.settingsPanel.setOpen(false);
    this.syncPanelState();
  }

  private toggleExplainer(): void {
    if (this.explainer.open) {
      this.explainer.close();
      return;
    }
    if (this.currentPreset?.explain) this.showExplainer(this.currentPreset);
    else this.explainer.show('Here', this.genericExplain(), 30_000, sourcesLineHtml(this.contextSourceIds(this.info ?? this.computeInfo())));
  }

  private genericExplain(): string {
    const x = this.info ?? this.computeInfo();
    if (x.nearRings && x.local) {
      return `<b>${esc(x.feature)}.</b> Normal optical depth τ ≈ ${x.local.tau.toFixed(3)}; the layer is ~${x.local.H.toFixed(0)} m thick. The numbers in the HUD come from the live ring model at your exact radius.`;
    }
    return 'Everything here is at true scale and moves in real time (1×) by default. Use <b>Places</b> to fly somewhere interesting, or press <kbd>?</kbd> for the controls.';
  }

  private setHud(on: boolean, persist = true): void {
    const changed = this.settings.hud !== on;
    this.settings.hud = on;
    setClass(this.ui, 'hud-off', !on);
    if (!persist) return;
    saveSettings(this.settings);
    if (changed && !on) this.toast?.show('HUD hidden — press H to bring it back', 2500);
  }

  /** A deep link to this place and moment (preset, time, warp). */
  shareLink(): string {
    const p = new URLSearchParams();
    if (this.currentPreset) p.set('preset', this.currentPreset.id);
    p.set('t', this.clock.date.toISOString().replace(/\.\d{3}Z$/, 'Z'));
    if (this.clock.warp !== 1) p.set('warp', String(this.clock.warp));
    if (this.clock.paused) p.set('paused', '1');
    return `${location.origin}${location.pathname}?${p.toString()}`;
  }

  private async copyLink(): Promise<void> {
    const link = this.shareLink();
    try {
      await navigator.clipboard.writeText(link);
      this.toast.show('Link to this moment copied');
    } catch {
      this.toast.show(link, 6000);
    }
  }

  private applySetting(k: keyof RenderSettings | 'fovDeg' | 'hud' | 'maxFps' | 'all'): void {
    if (k === 'renderScale' || k === 'all') this.resize();
    if (k === 'labels' || k === 'all') this.labels.visible = this.settings.render.labels;
    if (k === 'exposureMode' || k === 'all') this.loaded.post()?.snapExposure?.();
    this.frame.settings = this.settings.render;
    saveSettings(this.settings);
  }

  private statusHtml(): string {
    const parts: string[] = [];
    for (const g of this.loaded.guards) {
      const s = g.status();
      const cls = s.state === 'ok' ? 'st-ok' : 'st-bad';
      parts.push(`<div>${esc(s.name)}: <span class="${cls}">${esc(s.source)}${s.state === 'failed' ? ' — failed' : ''}</span></div>`);
    }
    const prof = this.pipeline?.ctx?.profile?.source ?? '—';
    parts.push(`<div>ring profile: ${esc(prof)}</div>`);
    parts.push(`<div>moons: ${esc(this.moonSource)} · Sun: ${this.sunTable ? 'JPL table' : 'Standish elements'}</div>`);
    return parts.join('');
  }

  private onKey(e: KeyboardEvent): void {
    if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey) return;
    if (this.sources?.open) return; // a modal; it handles its own keys (Esc, G)
    const f = this.frame;
    const code = e.code;
    if (e.key === '?' || code === 'F1') {
      this.help.setOpen(!this.help.open);
      e.preventDefault();
      return;
    }
    const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
    if (digit) {
      const p = PRESETS.find((pp) => pp.key === digit[1]);
      if (p) this.goto(p.id);
      return;
    }
    switch (code) {
      case 'Escape':
        if (this.help.open) this.help.setOpen(false);
        else if (this.places.open || this.settingsPanel.open) {
          this.closePanels();
        } else if (this.rig.transition) {
          this.rig.cancelTransition(f);
          this.toast.show('Fly-to cancelled');
        }
        break;
      case 'KeyH': this.setHud(!this.settings.hud); break;
      case 'KeyV': {
        const r = this.settings.render;
        r.astronaut = !r.astronaut;
        this.applySetting('astronaut');
        this.settingsPanel.sync();
        this.toast.show(r.astronaut ? 'Astronaut shown (1.9 m tall, for scale) — V hides it' : 'Astronaut hidden — V brings it back');
        break;
      }
      case 'KeyM': this.togglePanel('places'); break;
      case 'KeyO': this.togglePanel('settings'); break;
      case 'KeyI': this.toggleExplainer(); break;
      case 'KeyG':
        e.preventDefault(); // focus moves to the panel's search field: don't type this "g" into it
        this.openSources();
        break;
      case 'KeyP': this.timebar.togglePause(); break;
      case 'KeyK': this.timebar.stepWarp(-1); break;
      case 'KeyL': this.timebar.stepWarp(1); break;
      case 'Comma': this.timebar.stepWarp(-1); break;
      case 'Period': this.timebar.stepWarp(1); break;
      case 'KeyJ': this.timebar.reverse(); break;
      case 'KeyN': this.timebar.now(); break;
      case 'KeyC': {
        this.toast.show(this.rig.toggleCoorbit(f));
        this.currentPreset = null;
        this.places.setCurrent(null);
        break;
      }
      case 'KeyB': {
        const m = this.rig.toggleBallistic();
        this.toast.show(m ?? 'Ballistic mode needs co-orbit mode (press C, or pick a ring place)');
        break;
      }
      case 'BracketLeft':
      case 'BracketRight': {
        const s = this.rig.scaleSpeed(code === 'BracketRight' ? 2 : 0.5);
        if (s !== null) this.toast.show(`Flight speed ${fmtSpeed(s)}`);
        break;
      }
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- frame loop
  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    // frame-rate cap: skip display refreshes until a full frame interval has passed (the slack keeps the
    // cadence exact on 60/120 Hz displays despite rAF jitter: 30 fps = every 2nd / 4th refresh)
    const cap = this.settings.maxFps;
    if (cap > 0 && now - this.last < 1000 / cap - FRAME_SLACK_MS) return;
    const dtReal = Math.min(Math.max((now - this.last) / 1000, 0), 0.25);
    this.last = now;
    this.tick(dtReal);
  };

  private tick(dtReal: number): void {
    const f = this.frame;
    this.fpsAcc += dtReal;
    this.fpsN++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsN / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
    f.dtReal = dtReal;
    f.dt = this.clock.tick(dtReal);
    f.t = this.clock.t;
    f.timeWarp = this.clock.paused ? 0 : this.clock.warp;
    f.frameIndex++;
    f.settings = this.settings.render;
    try {
      this.world.update(f);
    } catch (e) {
      this.logOnce('world', e);
    }
    f.fovY = this.settings.fovDeg * DEG;
    this.input.lookScale = (2 * Math.tan(f.fovY / 2)) / Math.max(1, window.innerHeight);
    const inp = this.input.consume();
    const wasFlying = !!this.rig.transition;
    try {
      this.rig.update(f, inp, dtReal);
    } catch (e) {
      this.logOnce('camera', e);
    }
    if (wasFlying && !this.rig.transition && this.pendingExplain) {
      const p = this.pendingExplain;
      this.pendingExplain = null;
      if (this.currentPreset === p) this.showExplainer(p);
    }
    updateCameraDerived(f);
    try {
      this.pipeline.render(f);
    } catch (e) {
      this.logOnce('render', e);
    }
    const focus = this.rig.transition ? null : this.rig.active instanceof OrbitController ? this.rig.active.target : null;
    if (!this.labels.ringAt && this.pipeline?.ctx?.profile) {
      const prof = this.pipeline.ctx.profile;
      this.labels.ringAt = (rKm) => ({ tau: prof.tauAtKm(rKm), H: zoneParamsAtKm(rKm).H });
    }
    this.labels.update(f, focus);
    this.hudTimer -= dtReal;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.125;
      this.updateHud();
    }
    if (this.framesSinceShown >= 0 && ++this.framesSinceShown === 8) (window as unknown as { __svReady: boolean }).__svReady = true;
  }

  private computeInfo(): LiveInfo {
    const dir = this.clock.paused ? 1 : Math.sign(this.clock.warp) || 1;
    return computeLiveInfo(this.frame, this.pipeline?.ready ? this.pipeline.ctx : null, this.rig, dir);
  }

  private updateHud(): void {
    const f = this.frame;
    let info: LiveInfo;
    try {
      info = this.computeInfo();
    } catch (e) {
      this.logOnce('hud-info', e);
      return;
    }
    this.info = info;
    const status = this.rig.status(f);
    // one-time control hints, the first time each camera mode is used
    if (!this.hintsShown.has(status.mode) && this.framesSinceShown > 40) {
      const hint = status.mode === 'co-orbit' ? 'Drag to look · W A S D to fly · R / F up and down · scroll sets the speed · B: ballistic'
        : status.mode === 'orbit' ? 'Drag to rotate · scroll to zoom · click a moon\'s name to fly there · M: places'
        : status.mode === 'hover' ? 'Drag to look · W A S D to fly over the clouds · scroll sets the speed' : '';
      this.hintsShown.add(status.mode);
      if (hint) this.toast.show(hint, 4500);
    }
    const post = this.loaded.post();
    const ev = Math.log2((post?.exposure ?? f.exposure) / 0.25);
    const evs = `EV ${ev >= 0 ? '+' : ''}${ev.toFixed(1)}${f.settings.exposureMode === 'manual' ? ' manual' : ''}`;
    const renderLine = `${this.fps.toFixed(0)} fps · ${evs}`;
    const renderStats: [string, string][] = [['resolution', `${f.width} × ${f.height}`], ['exposure', `${evs} · ×${(post?.exposure ?? f.exposure).toExponential(2)}`]];
    try {
      for (const [k, v] of Object.entries(this.pipeline.stats())) {
        if (k === 'post.EV' || k === 'post.exposure') continue;
        renderStats.push([esc(k), esc(typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toPrecision(3)) : String(v))]);
      }
    } catch {
      /* stats are best-effort */
    }
    try {
      this.hud.update({ info, status, presetTitle: this.currentPreset?.title ?? null, warp: this.clock.warp, paused: this.clock.paused, renderLine, renderStats });
      this.timebar.update();
      if (this.explainer.open && this.currentPreset?.explain && !this.rig.transition) this.explainer.update(this.explainHtml(this.currentPreset, info));
    } catch (e) {
      this.logOnce('hud', e);
    }
    this.stats.set(this.settings.hud ? '' : renderLine);
    if (this.settingsPanel.open) this.settingsPanel.refreshStatus();
  }

  private logOnce(where: string, e: unknown): void {
    const key = `${where}:${e instanceof Error ? e.message : String(e)}`;
    if (this.renderErrors.has(key)) return;
    this.renderErrors.add(key);
    console.error(`[app] ${where} error (continuing):`, e);
  }

  // ---------------------------------------------------------------- test hooks
  private exposeHooks(): void {
    const w = window as unknown as Record<string, unknown>;
    w.__sv = {
      app: this,
      frame: this.frame,
      pipeline: this.pipeline,
      clock: this.clock,
      world: this.world,
      renderer: this.renderer,
      camera: this.rig,
      anchor: this.rig.frameAnchor,
      presets: PRESETS.map((p) => p.id),
      goto: (name: string, o?: { instant?: boolean }) => this.goto(name, { instant: !!o?.instant }),
      setTime: (iso: string) => this.timebar.setTime(iso),
      setWarp: (n: number) => {
        if (n === 0) this.clock.paused = true;
        else {
          this.clock.warp = n;
          this.clock.paused = false;
        }
      },
      info: () => this.computeInfo(),
      toggleCoorbit: () => this.rig.toggleCoorbit(this.frame),
      toggleBallistic: () => this.rig.toggleBallistic(),
      flyTo: (name: string) => this.flyToBody(name),
    };
  }
}

function fmtSpeed(v: number): string {
  if (v < 1e-2) return `${(v * 1e3).toPrecision(2)} mm/s`;
  if (v < 1) return `${(v * 100).toPrecision(2)} cm/s`;
  if (v < 1e3) return `${v.toPrecision(3)} m/s`;
  return `${(v / 1e3).toPrecision(3)} km/s`;
}

export async function startApp(opts: AppOptions = {}): Promise<App> {
  const app = new App(opts);
  await app.start();
  return app;
}
