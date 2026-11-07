// Tiny DOM helpers (no framework).

type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  attrs?: Record<string, string>;
  style?: string;
  on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.text !== undefined) el.textContent = props.text;
    if (props.html !== undefined) el.innerHTML = props.html;
    if (props.title) el.title = props.title;
    if (props.style) el.setAttribute('style', props.style);
    if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
    if (props.on) {
      for (const [k, fn] of Object.entries(props.on)) if (fn) el.addEventListener(k, fn as EventListener);
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** Set textContent only when it changed (avoids layout churn). */
export function setText(el: HTMLElement, s: string): void {
  if (el.textContent !== s) el.textContent = s;
}
export function setHtml(el: HTMLElement, s: string): void {
  if ((el as HTMLElement & { _h?: string })._h !== s) {
    el.innerHTML = s;
    (el as HTMLElement & { _h?: string })._h = s;
  }
}
export function setClass(el: HTMLElement, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

const svg = (d: string) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`;
export const ICONS = {
  play: svg('M4 2.5v11l9-5.5z'),
  pause: svg('M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z'),
  reverse: svg('M12 2.5v11L3 8z'),
  forward: svg('M4 2.5v11L13 8z'),
  now: svg('M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 1.6a4.9 4.9 0 1 1 0 9.8 4.9 4.9 0 0 1 0-9.8zM7.3 4.5v4.1l3.2 1.9.7-1.1-2.5-1.5V4.5z'),
  gear: svg('M9.4 1.5l.4 1.7c.4.1.8.3 1.2.5l1.5-.9 1.4 1.4-.9 1.5c.2.4.4.8.5 1.2l1.7.4v2l-1.7.4c-.1.4-.3.8-.5 1.2l.9 1.5-1.4 1.4-1.5-.9c-.4.2-.8.4-1.2.5l-.4 1.7h-2l-.4-1.7c-.4-.1-.8-.3-1.2-.5l-1.5.9-1.4-1.4.9-1.5c-.2-.4-.4-.8-.5-1.2L1.5 9V7l1.7-.4c.1-.4.3-.8.5-1.2l-.9-1.5 1.4-1.4 1.5.9c.4-.2.8-.4 1.2-.5l.4-1.7zM8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z'),
  help: svg('M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm.1 9.6a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zM8.2 3.6c1.5 0 2.6.9 2.6 2.2 0 1-.6 1.5-1.3 2-.5.3-.7.6-.7 1.1v.3H7.3v-.4c0-.9.4-1.4 1.1-1.9.5-.3.8-.6.8-1.1 0-.5-.4-.9-1-.9s-1.1.4-1.1 1H5.5c0-1.4 1.1-2.3 2.7-2.3z'),
  places: svg('M8 1.5a4.6 4.6 0 0 0-4.6 4.6C3.4 9.6 8 14.5 8 14.5s4.6-4.9 4.6-8.4A4.6 4.6 0 0 0 8 1.5zm0 2.6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z'),
  eye: svg('M8 3.5C4.4 3.5 1.8 6.2 1 8c.8 1.8 3.4 4.5 7 4.5s6.2-2.7 7-4.5c-.8-1.8-3.4-4.5-7-4.5zm0 1.8a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4z'),
  info: svg('M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM7.2 7h1.6v4.8H7.2zm.8-2.9a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9z'),
};
