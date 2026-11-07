// Scan PDS Rings Node mirrors of Photojournal pages for titles (to locate Cassini global maps).
//   node scan_pia.mjs 14920 14940 [17200 17220 ...]   (pairs of inclusive ranges)
const args = process.argv.slice(2).map(Number);
const ids = [];
for (let i = 0; i + 1 < args.length; i += 2) for (let n = args[i]; n <= args[i + 1]; n++) ids.push(n);
const hits = [];
await Promise.all(ids.map(async (n) => {
  const pia = `PIA${String(n).padStart(5, '0')}`;
  const url = `https://pds-rings.seti.org/press_releases/pages/${pia.slice(0, 5)}xxx/${pia}.html`;
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    const t = await r.text();
    const m = t.match(/<title>([^<]*)<\/title>/i);
    const title = m ? m[1].trim() : '?';
    if (/map|atlas|mosaic|global/i.test(title)) hits.push(`${pia}  ${title}`);
  } catch { /* ignore */ }
}));
console.log(hits.sort().join('\n'));
