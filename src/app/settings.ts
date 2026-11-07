// User settings (persisted to localStorage) and URL deep-link parameters.
import { defaultSettings, type RenderSettings } from '../core/FrameState';

export interface AppSettings {
  render: RenderSettings;
  fovDeg: number;
  hud: boolean;
}

const KEY = 'saturn-sim.settings.v1';

export function defaultAppSettings(): AppSettings {
  return { render: defaultSettings(), fovDeg: 60, hud: true };
}

const clampNum = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Validate/merge a partial settings object onto defaults. */
export function sanitize(raw: unknown): AppSettings {
  const d = defaultAppSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Omit<Partial<AppSettings>, 'render'> & { render?: Partial<RenderSettings> };
  const rs: Partial<RenderSettings> = r.render ?? {};
  const out: AppSettings = {
    fovDeg: clampNum(r.fovDeg, 20, 100, d.fovDeg),
    hud: bool(r.hud, d.hud),
    render: {
      exposureMode: rs.exposureMode === 'manual' ? 'manual' : 'auto',
      exposureEV: clampNum(rs.exposureEV, -12, 12, d.render.exposureEV),
      renderScale: clampNum(rs.renderScale, 0.5, 2, d.render.renderScale),
      // capped at 2x (8M particle slots, ~400 MB of GPU state)
      particleDetail: clampNum(rs.particleDetail, 0.25, 2, d.render.particleDetail),
      wakes: bool(rs.wakes, d.render.wakes),
      dustRings: bool(rs.dustRings, d.render.dustRings),
      stars: bool(rs.stars, d.render.stars),
      labels: bool(rs.labels, d.render.labels),
      nearField: bool(rs.nearField, d.render.nearField),
      bloom: clampNum(rs.bloom, 0, 3, d.render.bloom),
      debugView: 0,
    },
  };
  return out;
}

export function loadSettings(): AppSettings {
  try {
    const s = window.localStorage.getItem(KEY);
    if (!s) return defaultAppSettings();
    return sanitize(JSON.parse(s));
  } catch {
    return defaultAppSettings();
  }
}

export function saveSettings(s: AppSettings): void {
  try {
    const copy = { ...s, render: { ...s.render, debugView: 0 } };
    window.localStorage.setItem(KEY, JSON.stringify(copy));
  } catch {
    /* storage unavailable (private mode, quota, sandbox) */
  }
}

// ------------------------------------------------------------------ URL parameters
export interface UrlParams {
  preset: string | null;
  /** ISO time, or 'now' */
  t: string | null;
  warp: number | null;
  paused: boolean;
  /** raw query string for sandbox-style camera parameters (cam=orbit|ring|look ...) */
  cam: URLSearchParams | null;
  overrides: Partial<RenderSettings> & { fovDeg?: number; hud?: boolean };
}

export function parseUrl(search = location.search): UrlParams {
  const p = new URLSearchParams(search);
  const num = (k: string): number | undefined => {
    if (!p.has(k)) return undefined;
    const v = parseFloat(p.get(k)!);
    return Number.isFinite(v) ? v : undefined;
  };
  const flag = (k: string): boolean | undefined => {
    if (!p.has(k)) return undefined;
    const v = (p.get(k) ?? '').toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  };
  const ov: UrlParams['overrides'] = {};
  const fov = num('fov'); if (fov !== undefined) ov.fovDeg = fov;
  const detail = num('detail'); if (detail !== undefined) ov.particleDetail = detail;
  const scale = num('scale'); if (scale !== undefined) ov.renderScale = scale;
  const ev = num('ev'); if (ev !== undefined) ov.exposureEV = ev;
  if (p.get('exposure') === 'manual') ov.exposureMode = 'manual';
  if (p.get('exposure') === 'auto') ov.exposureMode = 'auto';
  const bloom = num('bloom'); if (bloom !== undefined) ov.bloom = bloom;
  const debug = num('debug'); if (debug !== undefined) ov.debugView = debug;
  for (const k of ['wakes', 'dustRings', 'stars', 'labels', 'nearField', 'hud'] as const) {
    const v = flag(k);
    if (v !== undefined) (ov as Record<string, unknown>)[k] = v;
  }
  return {
    preset: p.get('preset') ?? p.get('place'),
    t: p.get('t'),
    warp: num('warp') ?? null,
    paused: flag('paused') ?? false,
    cam: p.has('cam') ? p : null,
    overrides: ov,
  };
}
