// Diagnostic plot of the main-ring optical-depth profile (public/data/rings/tau_main) and the zone model
// (src/rings/ringRegions.ts). Owned by the ring science & data agent.
//
// URL parameters:
//   view=overview (default) | zoom | sigma      preset panel sets
//   x0=<km>&x1=<km>                              a single custom panel
//   theme=dark|light                             force a theme
// If data-raw/rings/derived/tau_components.* exist (dev server, after scripts/data/rings/build_tau.mjs),
// the RSS-derived and UVIS-derived input profiles and the radio->visible ratio map are shown too.
// window.__svReady becomes true after the first render (for scripts/shot.mjs).
import { RING_FEATURES, RING_ZONES, describeRadiusKm, zoneParamsAtKm } from '../src/rings/ringRegions';
import { dataUrl } from '../src/core/assets';

interface Series { name: string; color: string; r0: number; dr: number; y: Float32Array; under?: boolean }
interface Panel { title: string; x0: number; x1: number; y0: number; y1: number; log?: boolean; unit: string; series: Series[]; labels?: boolean }

const params = new URLSearchParams(location.search);
if (params.get('theme')) document.documentElement.dataset.theme = params.get('theme')!;
const css = (v: string) => getComputedStyle(document.body).getPropertyValue(v).trim();

async function getF32(url: string): Promise<Float32Array | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return new Float32Array(await r.arrayBuffer());
  } catch {
    return null;
  }
}
async function getJson(url: string): Promise<any> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

async function main() {
  const meta = await getJson(dataUrl('data/rings/tau_main.json'));
  const tau = meta ? await getF32(dataUrl('data/rings/tau_main.f32')) : null;
  const sub = document.getElementById('sub')!;
  if (!meta || !tau) { sub.textContent = 'public/data/rings/tau_main.{json,f32} not found'; (window as any).__svReady = true; return; }
  const R0: number = meta.r0_km, DR: number = meta.dr_km, N: number = meta.n;
  const compMeta = await getJson('/data-raw/rings/derived/tau_components.json');
  const compBuf = compMeta ? await getF32('/data-raw/rings/derived/tau_components.f32') : null;
  const layer = (k: string) => (compMeta && compBuf ? compBuf.subarray(compMeta.layers.indexOf(k) * N, (compMeta.layers.indexOf(k) + 1) * N) : null);
  const tX = layer('tauX_geom'), tU = layer('tauUVIS'), ratio = layer('ratio');
  const tXv = tX && ratio ? Float32Array.from(tX, (v, i) => v * ratio[i]) : null;

  // surface density, both models of ringRegions.ts
  const sProp = new Float32Array(N), sAff = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = tau[i];
    if (!Number.isFinite(t)) { sProp[i] = sAff[i] = NaN; continue; }
    const zp = zoneParamsAtKm(R0 + i * DR);
    sProp[i] = zp.sigmaPerTau * t;
    sAff[i] = zp.sigma0 * smooth(0.002, 0.02, t) + zp.sigmaSlope * t;
  }

  const C1 = css('--series-1'), C2 = css('--series-2'), C3 = css('--series-3');
  const S = (name: string, color: string, y: Float32Array, under = false): Series => ({ name, color, r0: R0, dr: DR, y, under });
  const tauSeries: Series[] = [];
  if (tXv) tauSeries.push(S('RSS X-band Rev7E, tau_X/2 x R(r)', C2, tXv, true));
  if (tU) tauSeries.push(S('UVIS beta Cen x6, -mu ln<T>', C3, tU, true));
  tauSeries.push(S('tau_main (final)', C1, tau));

  const view = params.get('view') ?? 'overview';
  let panels: Panel[];
  if (params.has('x0') && params.has('x1')) {
    const x0 = +params.get('x0')!, x1 = +params.get('x1')!;
    let mx = 0;
    for (let i = Math.max(0, Math.floor((x0 - R0) / DR)); i < Math.min(N, (x1 - R0) / DR); i++) if (Number.isFinite(tau[i])) mx = Math.max(mx, tau[i]);
    panels = [{ title: `tau, ${x0}-${x1} km`, x0, x1, y0: 0, y1: Math.max(0.05, Math.ceil(mx * 11) / 10), unit: '', series: tauSeries, labels: true }];
  } else if (view === 'zoom') {
    const z = (title: string, x0: number, x1: number, y1: number): Panel => ({ title, x0, x1, y0: 0, y1, unit: '', series: tauSeries, labels: true });
    panels = [
      z('C ring: Colombo gap and Titan ringlet', 77_600, 78_000, 2.5),
      z('C ring: Maxwell gap and ringlet', 87_300, 87_700, 1.6),
      z('Huygens gap, B-ring edge, Huygens and Strange ringlets', 117_400, 118_000, 3.5),
      z('Cassini Division gaps', 118_100, 120_400, 1.0),
      z('Encke gap', 133_350, 133_800, 1.4),
      z('Keeler gap and A-ring outer edge', 136_400, 136_850, 2.0),
    ];
  } else if (view === 'sigma') {
    const prop = S('Sigma = sigmaPerTau x tau (RingProfile loader)', C1, sProp);
    const aff = S('Sigma = sigma0 + sigmaSlope x tau (affine, proposed)', C2, sAff);
    panels = [
      { title: 'Surface mass density Sigma (kg/m^2, log): zone model on the real tau profile', x0: 74_000, x1: 137_000, y0: 1, y1: 3000, log: true, unit: 'kg/m^2', series: [prop, aff] },
      { title: 'Surface mass density Sigma (kg/m^2), B ring', x0: 91_500, x1: 118_000, y0: 0, y1: 1200, unit: 'kg/m^2', series: [prop, aff] },
    ];
    if (ratio) panels.push({ title: 'Radio-to-visible ratio map R(r) = <tau_UVIS> / <tau_X/2> (unused inside the B ring, where UVIS is taken directly)', x0: 74_000, x1: 137_000, y0: 0.5, y1: 3.5, unit: '', series: [S('R(r) ratio map', C3, ratio)] });
  } else {
    panels = [
      { title: 'Main rings, normal optical depth (log)', x0: 72_000, x1: 140_000, y0: 0.001, y1: 10, log: true, unit: '', series: [S('tau_main (final)', C1, tau)] },
      { title: 'C ring', x0: 74_000, x1: 92_500, y0: 0, y1: 0.6, unit: '', series: tauSeries },
      { title: 'B ring', x0: 91_500, x1: 118_000, y0: 0, y1: 8.5, unit: '', series: tauSeries },
      { title: 'Cassini Division', x0: 117_300, x1: 122_400, y0: 0, y1: 1.6, unit: '', series: tauSeries, labels: true },
      { title: 'A ring', x0: 122_000, x1: 137_000, y0: 0, y1: 2.5, unit: '', series: tauSeries },
    ];
  }

  // legend (always present for >= 2 series)
  const leg = document.getElementById('legend')!;
  const legendSeries = new Map<string, string>();
  for (const p of panels) for (const s of p.series) legendSeries.set(s.name, s.color);
  leg.innerHTML = '';
  if (legendSeries.size >= 2) for (const [n, c] of legendSeries) { const e = document.createElement('span'); e.textContent = n; e.style.setProperty('--c', c); leg.appendChild(e); }
  sub.textContent = `source: ${meta.source} · ${N} samples @ ${DR} km from ${R0} km` + (compMeta ? ' · input profiles from data-raw/rings/derived' : '');

  const host = document.getElementById('panels')!;
  const tip = document.getElementById('tip')!;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(600, host.clientWidth);
  const PH = panels.length > 5 ? 200 : 230;
  for (const p of panels) {
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(PH * dpr);
    cv.style.height = `${PH}px`;
    host.appendChild(cv);
    const g = cv.getContext('2d')!;
    const L = 52, Rm = 10, T = 22, B = p.labels ? 44 : 24;
    const pw = W - L - Rm, ph = PH - T - B;
    const xOf = (r: number) => L + ((r - p.x0) / (p.x1 - p.x0)) * pw;
    const yOf = (v: number) => {
      if (p.log) { const lv = Math.log10(Math.max(v, p.y0 * 0.5)); return T + ph - ((lv - Math.log10(p.y0)) / (Math.log10(p.y1) - Math.log10(p.y0))) * ph; }
      return T + ph - ((v - p.y0) / (p.y1 - p.y0)) * ph;
    };
    // per-column envelopes (cached; redraw for hover is cheap)
    const env = p.series.map((s) => {
      const out: (number[] | null)[] = [];
      for (let c = 0; c < pw; c++) {
        const ra = p.x0 + ((p.x1 - p.x0) * c) / pw, rb = p.x0 + ((p.x1 - p.x0) * (c + 1)) / pw;
        const i0 = Math.max(0, Math.floor((ra - s.r0) / s.dr)), i1 = Math.min(s.y.length - 1, Math.ceil((rb - s.r0) / s.dr));
        let mn = Infinity, mx = -Infinity;
        for (let i = i0; i <= i1; i++) { const v = s.y[i]; if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; } }
        out.push(Number.isFinite(mn) ? [mn, mx] : null);
      }
      return out;
    });
    const draw = (hoverX: number | null) => {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = css('--surface-1');
      g.fillRect(0, 0, W, PH);
      g.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
      // grid + y ticks
      g.strokeStyle = css('--grid');
      g.lineWidth = 1;
      g.fillStyle = css('--text-muted');
      const yt: number[] = [];
      if (p.log) for (let e = Math.ceil(Math.log10(p.y0)); e <= Math.floor(Math.log10(p.y1)); e++) yt.push(10 ** e);
      else { const st = niceStep((p.y1 - p.y0) / 4); for (let v = Math.ceil(p.y0 / st) * st; v <= p.y1 + 1e-9; v += st) yt.push(+v.toPrecision(6)); }
      for (const v of yt) { const y = Math.round(yOf(v)) + 0.5; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.textAlign = 'right'; g.fillText(fmt(v), L - 6, y + 4); }
      const xs = niceStep((p.x1 - p.x0) / 8);
      g.textAlign = 'center';
      for (let r = Math.ceil(p.x0 / xs) * xs; r <= p.x1; r += xs) { const x = Math.round(xOf(r)) + 0.5; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.fillText(r.toLocaleString('en-US'), x, T + ph + 14); }
      g.strokeStyle = css('--axis');
      g.beginPath(); g.moveTo(L, T + ph + 0.5); g.lineTo(L + pw, T + ph + 0.5); g.stroke();
      // zone boundaries + names
      g.setLineDash([3, 3]);
      g.strokeStyle = css('--zone');
      g.textAlign = 'left';
      let lastLabelEnd = -1e9;
      for (const z of RING_ZONES) {
        if (z.rInnerKm < p.x0 || z.rInnerKm > p.x1) continue;
        const x = Math.round(xOf(z.rInnerKm)) + 0.5;
        g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
        const label = z.key;
        const w = g.measureText(label).width;
        if (x + 3 > lastLabelEnd + 6 && x + 3 + w < L + pw) { g.fillStyle = css('--text-secondary'); g.fillText(label, x + 3, T + 11); lastLabelEnd = x + 3 + w; }
      }
      g.setLineDash([]);
      // series: context first, final last
      const order = p.series.map((s, k) => k).sort((a, b) => Number(!p.series[a].under) - Number(!p.series[b].under));
      for (const k of order) {
        const s = p.series[k];
        g.strokeStyle = s.color;
        g.lineWidth = s.under ? 1 : 1.5;
        g.globalAlpha = s.under ? 0.9 : 1;
        g.beginPath();
        let pen = false;
        env[k].forEach((c, i) => {
          if (!c) { pen = false; return; }
          const x = L + i + 0.5;
          const a = clampY(yOf(c[0])), b = clampY(yOf(c[1]));
          if (!pen) { g.moveTo(x, a); pen = true; } else g.lineTo(x, a);
          g.lineTo(x, b);
        });
        g.stroke();
        g.globalAlpha = 1;
      }
      // feature labels (selective, collision-avoiding)
      if (p.labels) {
        g.fillStyle = css('--text-secondary');
        g.strokeStyle = css('--text-muted');
        g.textAlign = 'left';
        let lx = -1e9;
        const feats = RING_FEATURES.filter((f) => (f.type === 'gap' || f.type === 'ringlet' || f.type === 'edge' || f.type === 'plateau') && f.rKm >= p.x0 && f.rKm <= p.x1).sort((a, b) => a.rKm - b.rKm);
        for (const f of feats) {
          const x = xOf(f.rKm);
          const wpx = Math.max(1, (f.widthKm / (p.x1 - p.x0)) * pw);
          g.beginPath(); g.moveTo(x - wpx / 2, T + ph + 20.5); g.lineTo(x + wpx / 2, T + ph + 20.5); g.stroke();
          const t = f.name;
          const tw = g.measureText(t).width;
          if (x - tw / 2 > lx + 6 && x + tw / 2 < W) { g.fillText(t, x - tw / 2, T + ph + 34); lx = x + tw / 2; }
        }
      }
      // title
      g.fillStyle = css('--text-primary');
      g.textAlign = 'left';
      g.font = '600 12px system-ui, -apple-system, Segoe UI, sans-serif';
      g.fillText(p.title, L, 14);
      // crosshair
      if (hoverX !== null) { g.strokeStyle = css('--text-secondary'); g.beginPath(); g.moveTo(hoverX + 0.5, T); g.lineTo(hoverX + 0.5, T + ph); g.stroke(); }
    };
    const clampY = (y: number) => Math.min(Math.max(y, T - 1), T + ph + 1);
    draw(null);
    cv.addEventListener('mousemove', (ev) => {
      const rect = cv.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      if (x < L || x > L + pw) { tip.style.display = 'none'; draw(null); return; }
      draw(x);
      const r = p.x0 + ((x - L) / pw) * (p.x1 - p.x0);
      const i = Math.round((r - R0) / DR);
      const zp = zoneParamsAtKm(r);
      const lines = [`r = ${r.toFixed(2)} km   ${describeRadiusKm(r)}`];
      for (const s of p.series) { const v = s.y[Math.round((r - s.r0) / s.dr)]; lines.push(`${s.name}: ${Number.isFinite(v) ? fmt(v) : '—'}`); }
      if (p.unit !== 'kg/m^2') lines.push(`Sigma ${fmt(sProp[i])} kg/m^2 (affine ${fmt(sAff[i])}) · H ${zp.H.toFixed(1)} m · q ${zp.q.toFixed(2)} · a ${fmt(zp.aMin)}-${fmt(zp.aMax)} m`);
      tip.textContent = lines.join('\n');
      tip.style.display = 'block';
      tip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - 360)}px`;
      tip.style.top = `${ev.clientY + 14}px`;
    });
    cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; draw(null); });
  }

  // zone table (the table view)
  const tb = document.getElementById('table')!;
  const rows = ['<tr><th>zone</th><th>r (km)</th><th>mean tau</th><th>Sigma (kg/m^2)</th><th>mass (kg)</th><th>q</th><th>aMin (m)</th><th>aMax (m)</th><th>H (m)</th><th>wake</th><th>rho implied</th></tr>'];
  let mTot = 0;
  for (const z of RING_ZONES) {
    let a = 0, ta = 0, m = 0;
    for (let i = Math.max(0, Math.ceil((z.rInnerKm - R0) / DR)); i < N && R0 + i * DR < z.rOuterKm; i++) {
      if (!Number.isFinite(tau[i])) continue;
      const dA = 2 * Math.PI * (R0 + i * DR) * DR * 1e6;
      a += dA; ta += tau[i] * dA; m += sProp[i] * dA;
    }
    mTot += m;
    rows.push(`<tr><td>${z.name}</td><td>${z.rInnerKm.toLocaleString('en-US')}–${z.rOuterKm.toLocaleString('en-US')}</td><td>${a ? fmt(ta / a) : '—'}</td><td>${a ? fmt(m / a) : '—'}</td><td>${m ? m.toExponential(2) : '—'}</td><td>${z.q}</td><td>${z.aMin}</td><td>${z.aMax}</td><td>${z.H}</td><td>${z.wake}</td><td>${z.rhoBulk ?? '—'}</td></tr>`);
  }
  rows.push(`<tr><th>total</th><td></td><td></td><td></td><th>${mTot.toExponential(3)}</th><td colspan="6">Iess et al. 2019: 1.54 ± 0.49 × 10^19 kg</td></tr>`);
  tb.innerHTML = rows.join('');
  (window as any).__svReady = true;
}

function niceStep(raw: number): number {
  const e = Math.floor(Math.log10(raw));
  const f = raw / 10 ** e;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * 10 ** e;
}
function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000 || a < 0.001) return v.toExponential(1);
  return String(+v.toPrecision(3));
}

main();
