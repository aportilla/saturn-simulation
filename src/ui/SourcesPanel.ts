// The Sources panel (key G): the simulator's bibliography (src/app/references.ts) grouped by topic, searchable and
// filterable, every entry with its full citation, what in the simulator uses it, its licence (data products) and
// links (DOI, arXiv, ADS, archive pages) that open in a new tab. A modal <dialog>: Esc, G or a click outside closes
// it and focus returns to where it was; keys typed inside never reach the camera or the time controls.
// Also renders the explainer's compact "Sources" line (sourcesLineHtml).
import { REFERENCES, TOPICS, authorList, findReference, primaryUrl, shortCite, topicLabel, type RefType, type Reference, type Topic } from '../app/references';
import { esc } from './format';
import { h } from './dom';

const TYPE_LABEL: Record<RefType, string> = {
  paper: 'Papers', book: 'Books', thesis: 'Theses', 'conference abstract': 'Conference abstracts',
  dataset: 'Data sets', catalog: 'Catalogues', software: 'Software',
};

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Plain-text citation (tooltips, search). */
export function citationText(r: Reference): string {
  const where = [r.venue, r.volume, r.pages].filter(Boolean).join(' ');
  return `${authorList(r)} (${r.year}${r.suffix ?? ''}). ${r.title}. ${where}.`;
}

/** The explainer's compact line: short citations that open the panel at the entry (modifier-click: the DOI). */
export function sourcesLineHtml(ids: readonly string[], max = 8): string {
  const refs = ids.map((id) => findReference(id)).filter((r): r is Reference => !!r).slice(0, max);
  if (!refs.length) return '';
  const links = refs.map((r) => {
    const url = primaryUrl(r) ?? '#sources';
    const tip = `${citationText(r)} — click for details; Ctrl/⌘-click opens ${r.doi ? 'the DOI' : 'the source'}`;
    return `<a href="${esc(url)}" target="_blank" rel="noopener" data-ref="${esc(r.id)}" title="${esc(tip)}">${esc(shortCite(r))}</a>`;
  });
  return `<div class="src-line"><span class="k">Sources</span> ${links.join(' · ')} · <a href="#sources" data-sources="all" title="All sources (G)">all…</a></div>`;
}

function hostLabel(url: string): string {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  if (/pds-rings|sbnarchive|sbn\.psi/.test(host)) return 'PDS archive';
  if (/photojournal|science\.nasa\.gov/.test(host)) return 'NASA Photojournal';
  if (/usgs\.gov/.test(host)) return 'USGS';
  if (/github\.com/.test(host)) return 'GitHub';
  if (/threejs\.org/.test(host)) return 'threejs.org';
  if (/naif\.jpl/.test(host)) return 'NAIF';
  if (/ssd\.jpl/.test(host)) return 'JPL SSD';
  if (/uapress/.test(host)) return 'University of Arizona Press';
  if (/jcgt\.org/.test(host)) return 'JCGT';
  if (/uni-potsdam/.test(host)) return 'University of Potsdam repository';
  if (/harvard\.edu/.test(host)) return 'Harvard TDC catalogue page';
  return host.replace(/^www\./, '') || 'link';
}

export class SourcesPanel {
  readonly root: HTMLDialogElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private topicSel: HTMLSelectElement;
  private typeSel: HTMLSelectElement;
  private count: HTMLElement;
  private returnFocus: Element | null = null;
  private hay = new Map<string, string>();
  private hlTimer = 0;
  /** called after the panel closed (focus already restored) */
  onClose?: () => void;

  constructor(parent: HTMLElement) {
    for (const r of REFERENCES) {
      this.hay.set(r.id, fold([r.id, authorList(r), r.year, r.suffix ?? '', r.title, r.venue, r.usedFor, r.note ?? '', r.doi ?? '',
        r.arxiv ?? '', r.type, r.licence ?? '', ...r.topics.map((t) => topicLabel(t)), ...(r.cite ?? [])].join(' ')));
    }
    this.search = h('input', { attrs: { type: 'search', placeholder: 'Search authors, titles, topics…', 'aria-label': 'Search the sources', autocomplete: 'off', spellcheck: 'false' } });
    this.topicSel = h('select', { attrs: { 'aria-label': 'Topic' } },
      h('option', { text: 'All topics', attrs: { value: '' } }),
      ...TOPICS.map(([k, label]) => h('option', { text: `${label} (${REFERENCES.filter((r) => r.topics.includes(k)).length})`, attrs: { value: k } })));
    const types = [...new Set(REFERENCES.map((r) => r.type))];
    this.typeSel = h('select', { attrs: { 'aria-label': 'Type' } },
      h('option', { text: 'All types', attrs: { value: '' } }),
      ...types.map((t) => h('option', { text: `${TYPE_LABEL[t]} (${REFERENCES.filter((r) => r.type === t).length})`, attrs: { value: t } })));
    this.count = h('span', { class: 'src-count', attrs: { 'aria-live': 'polite' } });
    this.list = h('div', { class: 'src-list', attrs: { tabindex: '-1' } });
    const nData = REFERENCES.filter((r) => r.type === 'dataset' || r.type === 'catalog').length;
    const head = h('div', { class: 'src-head' },
      h('button', { class: 'btn close', text: 'Close', title: 'Close (Esc)', on: { click: () => this.close() } }),
      h('h2', { text: 'Sources', attrs: { id: 'src-title' } }),
      h('p', { class: 'lead', attrs: { id: 'src-lead' }, text: `The published research and archived spacecraft data behind every number in this simulation: ${REFERENCES.length} references, ${nData} of them data sets and catalogues. Each says what in the simulator uses it; links open in a new tab.` }),
      h('div', { class: 'src-controls' }, this.search, this.topicSel, this.typeSel, this.count));
    this.root = h('dialog', { attrs: { id: 'sources', 'aria-labelledby': 'src-title', 'aria-describedby': 'src-lead' } }, head, this.list) as HTMLDialogElement;
    this.root.classList.add('panel');
    parent.append(this.root);

    this.search.addEventListener('input', () => this.render());
    this.topicSel.addEventListener('change', () => this.render());
    this.typeSel.addEventListener('change', () => this.render());
    // a modal: keys typed here must not fly the camera or change time (the app listens on window)
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      if (e.code === 'KeyG' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        this.close();
      }
    });
    // click on the backdrop (outside the dialog box) closes
    this.root.addEventListener('click', (e) => {
      if (e.target !== this.root) return;
      const b = this.root.getBoundingClientRect();
      if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) this.close();
    });
    // 'close' also follows Esc (the dialog's own cancel); it is delivered asynchronously
    this.root.addEventListener('close', () => {
      if (this.root.open) return; // re-opened before this event arrived
      this.releaseFocus();
      const f = this.returnFocus as HTMLElement | null;
      this.returnFocus = null;
      if (f && f.isConnected && typeof f.focus === 'function') f.focus({ preventScroll: true });
      this.onClose?.();
    });
    this.render();
  }

  get open(): boolean {
    return this.root.open;
  }

  /** Open the panel; with an id, clear the filters and scroll to / highlight that entry. */
  show(focusId?: string): void {
    if (!this.root.open) {
      const ae = document.activeElement;
      if (ae && ae !== document.body && !this.root.contains(ae)) this.returnFocus = ae;
      this.root.showModal();
    }
    const target = focusId ? findReference(focusId) : undefined;
    if (target) {
      this.search.value = '';
      this.topicSel.value = '';
      this.typeSel.value = '';
      this.render();
      const el = this.list.querySelector<HTMLElement>(`[data-id="${target.id}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        el.classList.add('hl');
        el.focus({ preventScroll: true });
        window.clearTimeout(this.hlTimer);
        this.hlTimer = window.setTimeout(() => el.classList.remove('hl'), 2600);
      }
    } else {
      this.search.focus({ preventScroll: true });
    }
  }

  close(): void {
    if (!this.root.open) return;
    this.root.close();
    this.releaseFocus();
  }

  /** A focused search field inside the closed dialog would swallow the app's keys (typing target). */
  private releaseFocus(): void {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== document.body && this.root.contains(ae)) ae.blur();
  }

  toggle(): void {
    if (this.root.open) this.close();
    else this.show();
  }

  private matches(r: Reference, terms: string[], topic: string, type: string): boolean {
    if (topic && !r.topics.includes(topic as Topic)) return false;
    if (type && r.type !== type) return false;
    const hay = this.hay.get(r.id)!;
    return terms.every((t) => hay.includes(t));
  }

  private render(): void {
    const terms = fold(this.search.value).split(/\s+/).filter(Boolean);
    const topic = this.topicSel.value;
    const type = this.typeSel.value;
    const shown = REFERENCES.filter((r) => this.matches(r, terms, topic, type));
    const order = (a: Reference, b: Reference) => fold(a.authors[0]).localeCompare(fold(b.authors[0])) || a.year - b.year || (a.suffix ?? '').localeCompare(b.suffix ?? '');
    const groups: [string, Reference[]][] = topic
      ? [[topicLabel(topic as Topic), shown.sort(order)]]
      : TOPICS.map(([k, label]) => [label, shown.filter((r) => r.topics[0] === k).sort(order)] as [string, Reference[]]).filter(([, l]) => l.length);
    this.list.replaceChildren();
    for (const [label, refs] of groups) {
      const sec = h('section', { attrs: { 'aria-label': label } }, h('h3', { text: `${label} · ${refs.length}` }));
      for (const r of refs) sec.append(this.entry(r));
      this.list.append(sec);
    }
    if (!shown.length) this.list.append(h('div', { class: 'src-empty', text: 'No source matches.' }));
    this.count.textContent = shown.length === REFERENCES.length ? `${REFERENCES.length} sources` : `${shown.length} of ${REFERENCES.length}`;
  }

  private entry(r: Reference): HTMLElement {
    const inBook = r.venue.startsWith('in ');
    const venue = inBook ? `In ${esc(r.venue.slice(3))}` : `<i>${esc(r.venue)}</i>`;
    const loc = [r.volume && !inBook ? esc(r.volume) : '', r.pages ? `${inBook ? 'pp. ' : ''}${esc(r.pages)}` : ''].filter(Boolean).join(', ');
    const cite = `<span class="au">${esc(authorList(r))}</span> (${r.year}${r.suffix ?? ''}). <span class="ti">${esc(r.title)}</span>. ${venue}${loc ? `${inBook ? ',' : ''} ${loc}` : ''}.`;
    const links: string[] = [];
    const a = (href: string, text: string, title?: string) => `<a href="${esc(href)}" target="_blank" rel="noopener"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</a>`;
    if (r.doi) links.push(a(`https://doi.org/${r.doi}`, `doi:${r.doi}`));
    if (r.arxiv) links.push(a(`https://arxiv.org/abs/${r.arxiv}`, `arXiv:${r.arxiv}`));
    if (r.ads) links.push(a(`https://ui.adsabs.harvard.edu/abs/${encodeURIComponent(r.ads)}`, 'ADS', r.ads));
    if (r.url) links.push(a(r.url, hostLabel(r.url), r.url));
    const meta: string[] = [...links];
    if (r.type !== 'paper') meta.push(`<span class="type">${esc(r.type)}</span>`);
    if (r.licence) meta.push(`<span class="lic" title="Licence / terms of use">${esc(r.licence)}</span>`);
    meta.push(r.verified
      ? `<span class="ok" title="${esc(`Metadata verified: ${r.verifiedBy}`)}">✓ verified</span>`
      : `<span class="unv" title="${esc(`Not verified: ${r.verifiedBy}`)}">unverified</span>`);
    const el = h('article', { class: 'src-entry', attrs: { 'data-id': r.id, id: `src-${r.id}`, tabindex: '-1', 'aria-label': `${shortCite(r)}: ${r.title}` } });
    el.innerHTML = `<div class="cite">${cite}</div>`
      + `<div class="use"><span class="k">Used for</span> ${esc(r.usedFor)}</div>`
      + (r.note ? `<div class="note">${esc(r.note)}</div>` : '')
      + `<div class="meta">${meta.join('<span class="sep" aria-hidden="true">·</span>')}</div>`;
    return el;
  }
}
