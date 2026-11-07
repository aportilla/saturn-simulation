// The "Places" menu (presets), grouped.
import type { Preset } from '../app/presets';
import { h, setClass } from './dom';

export class PlacesPanel {
  readonly root: HTMLElement;
  private items = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement, presets: Preset[], private onPick: (id: string) => void) {
    this.root = h('div', { class: 'panel sv-chrome sv-hidden', attrs: { id: 'places', role: 'menu' } });
    let group = '';
    for (const p of presets) {
      if (p.group !== group) {
        group = p.group;
        this.root.append(h('div', { class: 'pl-group', text: group }));
      }
      const it = h('div', { class: 'pl-item', attrs: { role: 'menuitem', tabindex: '0' }, on: { click: () => this.onPick(p.id), keydown: (e) => { if (e.key === 'Enter') this.onPick(p.id); } } },
        h('div', null, h('div', { class: 't', text: p.title }), h('div', { class: 's', text: p.subtitle })),
        p.key ? h('kbd', { text: p.key }) : null);
      this.items.set(p.id, it);
      this.root.append(it);
    }
    parent.append(this.root);
  }

  get open(): boolean {
    return !this.root.classList.contains('sv-hidden');
  }
  setOpen(on: boolean): void {
    setClass(this.root, 'sv-hidden', !on);
  }
  setCurrent(id: string | null): void {
    for (const [k, el] of this.items) setClass(el, 'cur', k === id);
  }
}
