// Number / unit formatting for the HUD.

const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

export function superscript(n: number | string): string {
  return String(n).split('').map((c) => SUP[c] ?? c).join('');
}

/** Thousands-grouped fixed decimals. */
export function grouped(x: number, decimals = 0): string {
  if (!Number.isFinite(x)) return '—';
  return x.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** ~3 significant digits, grouped. */
export function sig(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return '—';
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e15 || a < 1e-4) return sci(x, digits - 1);
  const p = Math.floor(Math.log10(a));
  const dec = Math.max(0, digits - 1 - p);
  return grouped(x, Math.min(dec, 6));
}

/** Scientific notation with a unicode exponent, e.g. 1.2 × 10⁻⁴. */
export function sci(x: number, decimals = 1): string {
  if (!Number.isFinite(x)) return '—';
  if (x === 0) return '0';
  const e = Math.floor(Math.log10(Math.abs(x)));
  const m = x / Math.pow(10, e);
  const ms = m.toFixed(decimals);
  if (ms === '1' || ms === '1.0' || ms === '1.00') return `10${superscript(e)}`;
  return `${ms} × 10${superscript(e)}`;
}

/** Length with automatic units from micrometers to kilometers. */
export function len(m: number, digits = 3): string {
  if (!Number.isFinite(m)) return '—';
  const a = Math.abs(m);
  if (a === 0) return '0 m';
  if (a < 1e-3) return `${sig(m * 1e6, digits)} µm`;
  if (a < 1e-2) return `${sig(m * 1e3, digits)} mm`;
  if (a < 1) return `${sig(m * 100, digits)} cm`;
  if (a < 1e3) return `${sig(m, digits)} m`;
  if (a < 1e6) return `${sig(m / 1e3, digits)} km`;
  return `${grouped(m / 1e3, 0)} km`;
}

/** Kilometers with fixed decimals and grouping. */
export function km(m: number, decimals = 0): string {
  return `${grouped(m / 1e3, decimals)} km`;
}

export function speed(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0 m/s';
  if (a < 1e-3) return `${sig(v * 1e6, digits)} µm/s`;
  if (a < 1e-2) return `${sig(v * 1e3, digits)} mm/s`;
  if (a < 1) return `${sig(v * 100, digits)} cm/s`;
  if (a < 1e3) return `${sig(v, digits)} m/s`;
  return `${sig(v / 1e3, digits)} km/s`;
}

/** Duration, e.g. "13 h 15 m", "2 d 4 h", "42 s". */
export function duration(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const a = Math.abs(s);
  const sign = s < 0 ? '−' : '';
  if (a < 1) return `${sign}${sig(a * 1000, 2)} ms`;
  if (a < 60) return `${sign}${a < 10 ? a.toFixed(1) : Math.round(a)} s`;
  if (a < 3600) {
    const m = Math.floor(a / 60), ss = Math.round(a - m * 60);
    return `${sign}${m} m ${ss.toString().padStart(2, '0')} s`;
  }
  if (a < 86400 * 2) {
    const h = Math.floor(a / 3600), m = Math.round((a - h * 3600) / 60);
    return m === 60 ? `${sign}${h + 1} h 00 m` : `${sign}${h} h ${m.toString().padStart(2, '0')} m`;
  }
  if (a < 86400 * 365.25 * 2) {
    const d = Math.floor(a / 86400), h = Math.round((a - d * 86400) / 3600);
    return `${sign}${d} d ${h} h`;
  }
  return `${sign}${sig(a / (86400 * 365.25), 3)} yr`;
}

/** Hours as a decimal-free "13.25 h" style string. */
export function hours(s: number, digits = 4): string {
  return `${sig(s / 3600, digits)} h`;
}

export function deg(rad: number, decimals = 1): string {
  if (!Number.isFinite(rad)) return '—';
  return `${((rad * 180) / Math.PI).toFixed(decimals)}°`;
}

/** Time warp label, e.g. "×1 (real time)", "×10⁴", "−×100". */
export function warp(w: number, paused: boolean): string {
  if (paused) return 'paused';
  const a = Math.abs(w);
  const sign = w < 0 ? '−' : '';
  if (a === 1) return `${sign}×1`;
  const e = Math.log10(a);
  if (Math.abs(e - Math.round(e)) < 1e-9 && a >= 1000) return `${sign}×10${superscript(Math.round(e))}`;
  return `${sign}×${grouped(a, a < 10 ? 1 : 0)}`;
}

function pad(n: number, w = 2): string {
  return n.toString().padStart(w, '0');
}

export function utc(d: Date): string {
  if (Number.isNaN(d.getTime())) return '—';
  const y = d.getUTCFullYear();
  const ys = y < 0 ? `-${pad(-y, 4)}` : pad(y, 4);
  return `${ys}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Value for <input type="datetime-local"> in UTC. */
export function utcInputValue(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Areal number density, e.g. "3.3 per m²" or "1 per 58 m²". */
export function perArea(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return 'none';
  if (n >= 0.995) return `${sig(n, n >= 100 ? 3 : 2)} /m²`;
  const inv = 1 / n;
  if (inv < 1e6) return `1 per ${sig(inv, 2)} m²`;
  return `1 per ${sig(inv / 1e6, 2)} km²`;
}

export function percent(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '—';
  const p = x * 100;
  if (p >= 99.95) return '100%';
  if (p < 0.01) return p <= 0 ? '0%' : '<0.01%';
  return `${sig(p, digits)}%`;
}

/** Escape text for HTML. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
