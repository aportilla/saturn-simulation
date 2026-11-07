// The left HUD panel: where you are, how you're moving, the local ring physics, the light, render stats.
import { SATURN } from '../core/constants';
import type { RigStatus } from '../camera/CameraRig';
import type { LiveInfo } from '../app/liveInfo';
import { h, setClass, setHtml, setText } from './dom';
import { deg, duration, grouped, km, len, percent, perArea, sig, speed } from './format';

export interface HudData {
  info: LiveInfo;
  status: RigStatus;
  presetTitle: string | null;
  warp: number;
  paused: boolean;
  renderLine: string;
  renderStats: [string, string][];
}

interface Row { k: HTMLElement; v: HTMLElement }

const COLLAPSE_KEY = 'saturn-sim.hud.collapsed.v1';

export class Hud {
  readonly root: HTMLElement;
  private chip: HTMLElement;
  private where: HTMLElement;
  private sub: HTMLElement;
  private prog: HTMLElement;
  private progBar: HTMLElement;
  private rows = new Map<string, Row>();
  private secMotion: HTMLElement;
  private secRing: HTMLElement;
  private sizeCells: HTMLElement[] = [];
  private sizeWrap: HTMLElement;
  private renderHint: HTMLElement;
  private renderBody: HTMLElement;
  private collapsed: Set<string>;

  constructor(parent: HTMLElement) {
    this.collapsed = loadCollapsed();
    this.chip = h('span', { class: 'chip', text: 'ORBIT' });
    this.where = h('span', { class: 'hud-where', text: 'Saturn' });
    this.sub = h('div', { class: 'hud-sub' });
    this.progBar = h('i');
    this.prog = h('div', { class: 'hud-progress sv-hidden' }, this.progBar);

    const pos = this.section('pos', 'Position', '', [['dist', 'from Saturn'], ['alt', 'altitude'], ['plane', 'ring plane'], ['rad', 'ring radius'], ['size', 'Saturn spans']]);
    this.secMotion = this.section('motion', 'Motion', '', [['orbit', 'orbit'], ['rel', 'vs. particles'], ['fly', 'fly speed']]);
    const sizes = ['> 1 cm', '> 10 cm', '> 1 m'];
    this.sizeWrap = h('div', { class: 'size-bars' }, ...sizes.map((t) => {
      const n = h('div', { class: 'n', text: '—' });
      this.sizeCells.push(n);
      return h('div', { class: 'cell' }, h('div', { class: 't', text: `radius ${t}` }), n);
    }));
    this.secRing = this.section('ring', 'Local ring', 'live model', [['tau', 'optical depth τ'], ['sigma', 'Σ · thickness'], ['sizes', 'sizes']]);
    const ringBody = this.secRing.querySelector('.sec-body')!;
    ringBody.append(this.sizeWrap, this.rowsEl([
      ['spacing', 'spacing'], ['shear', 'shear'], ['epi', 'epicycle'], ['wake', 'wakes'], ['mfp', 'mean free path'],
      ['trans', 'transmission'], ['vrand', 'random motions'],
    ]));
    const light = this.section('light', 'Light', '', [['sun', 'Sun'], ['shadow', 'shadow'], ['phase', 'phase · local time']]);
    const phRow = this.rows.get('phase');
    if (phRow) phRow.k.title = 'Solar phase angle at the view center, and local solar time on Saturn\'s rings (12:00 = toward the Sun, 00:00 = the middle of Saturn\'s shadow)';
    this.renderHint = h('span', { class: 'hint' });
    this.renderBody = h('div', { class: 'rows sec-body' });
    const render = h('div', { class: 'sec' }, this.title('render', 'Render', this.renderHint), this.renderBody);
    this.applyCollapsed(render, 'render');

    this.root = h('div', { class: 'panel sv-chrome', attrs: { id: 'hud' } },
      h('div', { class: 'hud-head' }, this.chip, this.where),
      this.sub, this.prog, pos, this.secMotion, this.secRing, light, render);
    parent.append(this.root);
  }

  private title(id: string, text: string, hint: HTMLElement): HTMLElement {
    const t = h('div', { class: 'sec-title', title: 'click to collapse / expand' }, h('span', { text }), hint);
    t.addEventListener('click', () => {
      if (this.collapsed.has(id)) this.collapsed.delete(id);
      else this.collapsed.add(id);
      saveCollapsed(this.collapsed);
      this.applyCollapsed(t.parentElement as HTMLElement, id);
    });
    return t;
  }

  private applyCollapsed(sec: HTMLElement, id: string): void {
    const body = sec.querySelector('.sec-body') as HTMLElement | null;
    if (body) setClass(body, 'sv-hidden', this.collapsed.has(id));
    setClass(sec, 'collapsed', this.collapsed.has(id));
  }

  private rowsEl(defs: [string, string][]): HTMLElement {
    const grid = h('div', { class: 'rows' });
    for (const [key, label] of defs) {
      const k = h('div', { class: 'k', text: label });
      const v = h('div', { class: 'v', text: '—' });
      grid.append(k, v);
      this.rows.set(key, { k, v });
    }
    return grid;
  }

  private section(id: string, title: string, hint: string, defs: [string, string][]): HTMLElement {
    const body = h('div', { class: 'sec-body' }, this.rowsEl(defs));
    const sec = h('div', { class: 'sec' }, this.title(id, title, h('span', { class: 'hint', text: hint })), body);
    this.applyCollapsed(sec, id);
    return sec;
  }

  private set(key: string, html: string, cls = ''): void {
    const r = this.rows.get(key);
    if (!r) return;
    setHtml(r.v, html);
    const c = cls ? `v ${cls}` : 'v';
    if (r.v.className !== c) r.v.className = c;
  }
  private show(key: string, on: boolean): void {
    const r = this.rows.get(key);
    if (!r) return;
    setClass(r.k, 'sv-hidden', !on);
    setClass(r.v, 'sv-hidden', !on);
  }

  update(d: HudData): void {
    const x = d.info, s = d.status;
    // ---- header
    const chipText = s.mode === 'flying' ? 'Flying' : s.mode === 'co-orbit' ? (s.ballistic ? 'Ballistic' : 'Co-orbit') : s.mode === 'hover' ? 'Hover' : 'Orbit';
    setText(this.chip, chipText);
    setClass(this.chip, 'flying', s.mode === 'flying');
    setClass(this.chip, 'ballistic', s.ballistic);
    let where: string;
    if (s.mode === 'flying') where = `→ ${s.target}`;
    else if (s.mode === 'orbit') where = s.target;
    else if (s.mode === 'hover') where = `above ${s.target}`;
    else where = x.feature;
    setText(this.where, where);
    let sub: string;
    if (s.mode === 'flying') sub = `passing ${x.feature}`;
    else if (s.mode === 'co-orbit') sub = s.ballistic ? 'free test particle · Hill\'s equations' : d.presetTitle ?? 'station keeping in the local flow';
    else sub = d.presetTitle ?? (s.mode === 'orbit' && s.target === 'Saturn' ? x.feature : '');
    setText(this.sub, sub);
    setClass(this.prog, 'sv-hidden', s.mode !== 'flying');
    this.progBar.style.width = `${(s.progress * 100).toFixed(1)}%`;

    // ---- position
    this.set('dist', `${km(x.dist, x.dist < 1e8 ? 1 : 0)} <small>· ${(x.dist / SATURN.R_EQ).toFixed(x.dist < 1e9 ? 3 : 1)} R<sub>S</sub></small>`);
    this.set('alt', x.alt > 0 ? `${len(x.alt, 4)} <small>above 1 bar</small>` : 'inside Saturn', x.alt < 0 ? 'warn' : '');
    const az = Math.abs(x.z);
    const sideName = x.z === 0 ? '' : x.z > 0 ? 'N' : 'S';
    const litSide = x.z === 0 ? '' : Math.sign(x.z) === x.litSign ? 'lit side' : 'unlit side';
    const H = x.local?.H ?? 0;
    const inLayer = x.nearRings && H > 0 && az < 2 * H;
    let plane: string;
    if (inLayer) plane = `${len(x.z, 3)} <small>· inside the layer</small>`;
    else if (az < 1e9) plane = `${len(az, 3)} ${sideName} <small>· ${litSide}</small>`;
    else plane = `${km(az)} ${sideName}`;
    this.set('plane', plane, inLayer ? 'ice' : '');
    this.set('rad', `${grouped(x.rCyl / 1e3, x.rCyl < 2e8 ? 3 : 0)} km <small>cylindrical</small>`);
    this.show('rad', x.rCyl < 5e9 && x.rCyl > SATURN.R_EQ && az > 1e-3 * x.rCyl);
    this.set('size', `${deg(x.saturnAngDiam, x.saturnAngDiam > 0.1 ? 1 : 3)} <small>of sky</small>`);

    // ---- motion (co-orbit / hover)
    const moving = s.mode === 'co-orbit' || s.mode === 'hover';
    setClass(this.secMotion, 'sv-hidden', !moving);
    if (moving) {
      if (s.mode === 'co-orbit') {
        this.set('orbit', `${speed(x.vOrb, 4)} <small>· one orbit</small> ${duration(x.period)}`);
        const vr = x.vRel ?? 0;
        this.set('rel', vr < 1e-5 ? 'at rest in the local flow' : `${speed(vr)} <small>relative to the flow</small>`, vr < 1e-5 ? 'good' : '');
      } else {
        const v = (SATURN.W_RATE / 86400) * x.rCyl;
        this.set('orbit', `${speed(v, 3)} <small>· co-rotating, ${duration(SATURN.ROT_PERIOD_SYSIII)}</small>`);
      }
      this.show('rel', s.mode === 'co-orbit');
      this.set('fly', `${speed(s.speed ?? 0)} <small>scroll or [ ] · ⇧ ×10</small>`);
    }

    // ---- local ring
    const showRing = x.nearRings && !!x.local;
    setClass(this.secRing, 'sv-hidden', !showRing);
    if (showRing && x.local) {
      const L = x.local;
      this.set('tau', `${sig(L.tau, L.tau < 0.01 ? 2 : 3)} <small>· e<sup>−τ</sup> = ${percent(x.tFull)} passes</small>`, 'ice');
      this.set('sigma', `${sig(L.sigma, 3)} kg/m² <small>·</small> H ≈ ${len(L.H, 2)}`);
      if (x.sd) {
        this.set('sizes', `${len(L.aMin, 2)} – ${len(L.aMax, 2)} <small>radius · n(a) ∝ a<sup>−${L.q.toFixed(2)}</sup></small>`);
        setText(this.sizeCells[0], perArea(x.n1cm));
        setText(this.sizeCells[1], perArea(x.n10cm));
        setText(this.sizeCells[2], perArea(x.n1m));
        this.set('spacing', `~${len(x.spacing10cm, 2)} <small>between particles >10 cm</small>`);
      } else {
        this.set('sizes', 'fine dust (µm grains)');
        this.set('spacing', '—');
      }
      setClass(this.sizeWrap, 'sv-hidden', !x.sd);
      this.show('spacing', !!x.sd);
      this.set('shear', `${speed(x.shear100, 2)} <small>@100 m ·</small> ${speed(x.shear1k, 2)} <small>@1 km</small>`);
      this.set('epi', `${sig(x.epicyclePeriod / 3600, 4)} h <small>· vertical ${sig(x.verticalPeriod / 3600, 4)} h</small>`);
      if (L.macroscopic && x.lambda > 0) {
        const on = x.wakeStrength > 1e-3;
        this.set('wake', `λ ≈ ${len(x.lambda, 2)} <small>Toomre · ${on ? `strength ${x.wakeStrength.toFixed(2)}` : 'none here'}</small>`);
      } else this.set('wake', 'none');
      this.set('mfp', L.tau > 0 ? `~${len(x.mfp, 2)} <small>along the plane (H/τ)</small>` : '—');
      this.set('trans', `↑ ${percent(x.tUp)} <small>·</small> ↓ ${percent(x.tDown)} <small>· sunlight</small> ${percent(x.tSun)}`);
      this.set('vrand', `~${speed(x.vRandom, 1)} <small>(≈ ΩH/2)</small>`);
    }

    // ---- light
    const se = x.sunEl;
    this.set('sun', `${deg(Math.abs(se))} ${se < 0 ? 'S' : 'N'} <small>of ring plane · ${se < 0 ? 'south' : 'north'} face lit</small>`, 'gold');
    let sh: string;
    let shCls = '';
    if (x.alt <= 0) sh = '—';
    else if (x.sunVis < 0.001) { sh = 'in Saturn\'s shadow'; shCls = 'shade'; }
    else if (x.sunVis < 0.999) { sh = `penumbra · ${percent(x.sunVis)} of the Sun`; shCls = 'shade'; }
    else sh = 'sunlit';
    const t = x.shadow;
    if (t && t.nextEvent && Number.isFinite(t.nextIn) && x.alt > 0) {
      const ev = t.nextEvent === 'entry' ? 'enters' : 'exits';
      const real = !d.paused && Math.abs(d.warp) > 1 ? ` <small>(${duration(t.nextIn / Math.abs(d.warp))} real)</small>` : '';
      sh += `<br><small>${ev} in</small> ${duration(t.nextIn)}${real}`;
      if (t.nextEvent === 'entry' && Math.abs(d.warp) <= 1) sh += ` <small>· lasts ${duration(t.duration)}</small>`;
    }
    this.set('shadow', sh, `wrap ${shCls}`);
    const hh = Math.floor(x.lst), mm = Math.floor((x.lst - hh) * 60);
    const part = x.lst < 6 ? 'night' : x.lst < 12 ? 'morning' : x.lst < 18 ? 'afternoon' : 'night';
    const lst = x.rCyl < 2.5e9 ? ` <small>·</small> ${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')} <small>${part}</small>` : '';
    this.set('phase', `${deg(x.phase, 0)}${lst}`);

    // ---- render
    setText(this.renderHint, d.renderLine);
    if (!this.collapsed.has('render')) {
      const html = d.renderStats.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('');
      setHtml(this.renderBody, html);
    }
  }
}

function loadCollapsed(): Set<string> {
  try {
    const s = window.localStorage.getItem(COLLAPSE_KEY);
    if (s) return new Set(JSON.parse(s) as string[]);
  } catch {
    /* unavailable */
  }
  return new Set(['render']);
}
function saveCollapsed(s: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s]));
  } catch {
    /* unavailable */
  }
}
