#!/usr/bin/env node
// The Sources panel (key G, src/ui/SourcesPanel.ts) and the explainer's per-place "Sources" lines
// (src/app/placeSources.ts) in the real app, with trusted key presses and clicks:
//  1. every place (__sv.presets, instant jumps) shows a Sources line in its explainer: ≥ 3 citations for a place with
//     its own list (PLACE_SOURCES), ≥ 1 otherwise (context defaults); each a link to http(s) with target=_blank,
//     rel=noopener and a data-ref that is a reference id;
//  2. G opens the panel (modal <dialog>) listing every reference, focus in the search field; typing filters
//     ("propeller": fewer entries, each containing the word); keys pressed inside never reach the app (P does not
//     toggle pause); Esc closes and focus leaves the dialog; the app's keys work again afterwards; G closes it
//     from the list;
//  3. clicking an explainer citation opens the panel at that entry (focused, highlighted);
//  4. every link in the panel opens in a new tab (target=_blank, rel=noopener, http(s)); one https://doi.org/ link
//     per entry with a DOI;
//  5. no console / page errors, passes ok.
// The bibliography's content (docs sync, DOIs) is checked without a browser by scripts/check-refs.mjs.
// usage: node scripts/test/sources.mjs [--place a-ring-inside] [--w 1280 --h 720] [--base URL] [--out DIR]
import { openApp, problems, sleep, table, withHarness } from './lib.mjs';

const USAGE = 'node scripts/test/sources.mjs [--place a-ring-inside] [--w --h] [--base URL] [--out DIR]';
const T = '2026-11-08T12:00:00Z';

await withHarness('sources', { usage: USAGE }, async ({ args, rep, browser, base }) => {
  const place = args.str('place', 'a-ring-inside');
  const { page, errs } = await openApp(browser, base, { preset: place, t: T, paused: 1, hud: 1, labels: 0 }, { settle: 800 });
  try {
    const meta = await page.evaluate(async () => {
      const R = await import('/src/app/references.ts');
      const P = await import('/src/app/placeSources.ts');
      return { ids: R.REFERENCES.map((r) => r.id), withDoi: R.REFERENCES.filter((r) => r.doi).length, lists: Object.keys(P.PLACE_SOURCES), presets: window.__sv.presets };
    });
    const known = new Set(meta.ids);

    // 1. a Sources line for every place
    const rows = [];
    const badPlaces = [];
    for (const id of meta.presets) {
      await page.evaluate((id) => window.__sv.goto(id, { instant: true }), id);
      await sleep(120);
      const links = await page.evaluate(() => [...document.querySelectorAll('#explainer .src-line a[data-ref]')]
        .map((a) => ({ ref: a.dataset.ref, target: a.target, rel: a.rel, href: a.href })));
      const own = meta.lists.includes(id);
      const bad = links.filter((l) => !known.has(l.ref) || l.target !== '_blank' || !/\bnoopener\b/.test(l.rel) || !/^https?:\/\//.test(l.href));
      const ok = links.length >= (own ? 3 : 1) && !bad.length;
      if (!ok) badPlaces.push(`${id} (${links.length} links${bad.length ? `, ${bad.length} malformed` : ''})`);
      rows.push([id, own ? 'own list' : 'context', links.length, links.map((l) => l.ref).join(' ')]);
    }
    console.log(`\n${table(['place', 'list', 'n', 'references'], rows)}\n`);
    rep.check('every place shows a Sources line (≥ 3 citations with its own list, ≥ 1 from context defaults)', badPlaces.length === 0,
      badPlaces.length ? badPlaces.join('; ') : `${meta.presets.length} places, ${meta.lists.length} with their own list`);
    rep.data.places = rows;

    // 2. keyboard: G opens, typing filters, keys stay inside, Esc closes
    await page.evaluate((p) => window.__sv.goto(p, { instant: true }), place);
    await page.focus('#sv-canvas');
    await page.keyboard.press('KeyG');
    await sleep(150);
    const s1 = await page.evaluate(() => ({
      open: document.querySelector('#sources').open,
      entries: document.querySelectorAll('#sources .src-entry').length,
      inSearch: !!document.activeElement?.matches?.('#sources input[type=search]'),
    }));
    rep.check('G opens the panel with every reference, focus in the search field', s1.open && s1.inSearch && s1.entries === meta.ids.length,
      `open ${s1.open}, ${s1.entries} of ${meta.ids.length} entries, search focused ${s1.inSearch}`);
    await page.keyboard.type('propeller');
    await sleep(100);
    const texts = await page.evaluate(() => [...document.querySelectorAll('#sources .src-entry')].map((e) => e.textContent.toLowerCase()));
    rep.check('typing in the search field filters the list', texts.length > 0 && texts.length < meta.ids.length && texts.every((t) => t.includes('propeller')),
      `"propeller": ${texts.length} entries`);
    const paused0 = await page.evaluate(() => window.__sv.clock.paused);
    await page.focus('#sources .src-list');
    await page.keyboard.press('KeyP');
    await sleep(100);
    const paused1 = await page.evaluate(() => window.__sv.clock.paused);
    rep.check('keys pressed inside the panel do not reach the app', paused0 === paused1, `P inside the panel: paused ${paused0} → ${paused1}`);
    await page.keyboard.press('Escape');
    await sleep(150);
    const s2 = await page.evaluate(() => ({ open: document.querySelector('#sources').open, inside: document.querySelector('#sources').contains(document.activeElement) }));
    await page.keyboard.press('KeyP');
    await sleep(100);
    const paused2 = await page.evaluate(() => window.__sv.clock.paused);
    rep.check('Esc closes the panel, focus leaves it and the app keys work again', !s2.open && !s2.inside && paused2 !== paused1,
      `open ${s2.open}, focus inside ${s2.inside}, P after closing: paused ${paused1} → ${paused2}`);
    await page.evaluate((p) => { window.__sv.clock.paused = p; }, paused0);
    await page.keyboard.press('KeyG');
    await sleep(100);
    await page.focus('#sources .src-list');
    await page.keyboard.press('KeyG');
    await sleep(150);
    const s3 = await page.evaluate(() => document.querySelector('#sources').open);
    rep.check('G closes the panel again (focus on the list)', !s3, `open ${s3}`);

    // 3. a citation in the explainer opens the panel at its entry
    await page.evaluate((p) => window.__sv.goto(p, { instant: true }), place);
    await sleep(150);
    const ref = await page.evaluate(() => document.querySelector('#explainer .src-line a[data-ref]')?.dataset.ref ?? null);
    if (ref) await page.click('#explainer .src-line a[data-ref]');
    await sleep(200);
    const s4 = await page.evaluate(() => ({ open: document.querySelector('#sources').open, focused: document.activeElement?.dataset?.id ?? null, hl: document.querySelector('#sources .src-entry.hl')?.dataset.id ?? null }));
    rep.check('clicking a citation in the explainer opens the panel at that entry', !!ref && s4.open && s4.focused === ref && s4.hl === ref,
      `clicked ${ref}: open ${s4.open}, focused ${s4.focused}, highlighted ${s4.hl}`);

    // 4. links in the panel
    const links = await page.evaluate(() => [...document.querySelectorAll('#sources a')].map((a) => ({ href: a.href, target: a.target, rel: a.rel })));
    const bad = links.filter((l) => l.target !== '_blank' || !/\bnoopener\b/.test(l.rel) || !/^https?:\/\//.test(l.href));
    const dois = links.filter((l) => /^https:\/\/doi\.org\/10\.\d{4,9}\//.test(l.href)).length;
    rep.check('panel links open in a new tab (target=_blank, rel=noopener); one DOI link per entry with a DOI', bad.length === 0 && dois === meta.withDoi,
      `${links.length} links, ${bad.length} malformed${bad.length ? ` (${bad.slice(0, 3).map((l) => l.href).join(', ')})` : ''}, DOI links ${dois} / entries with DOI ${meta.withDoi}`);
    rep.data.links = { total: links.length, doi: dois, malformed: bad };

    // 5. no errors
    const probs = await problems(page, errs);
    rep.check('no console / page errors, passes ok', probs.length === 0, probs.slice(0, 3).join(' | '));
  } finally {
    await page.close();
  }

  // 6. custom views (no place): the explainer (key I) cites the context defaults of placeSources.contextSources
  const custom = [
    ['orbiting Tethys', { cam: 'orbit', target: 'tethys', dist: 3e6, az: -40, el: 12 }, 'MOON_SOURCES', 'tethys'],
    ['B ring, 20 m above the mid-plane', { cam: 'ring', r: 105_000e3, z: 20 }, 'PLACE_SOURCES', 'b-ring-inside'],
  ];
  for (const [label, params, list, key] of custom) {
    const { page: pg, errs: er } = await openApp(browser, base, { ...params, t: T, paused: 1, hud: 1, labels: 0 }, { settle: 500 });
    try {
      const expected = await pg.evaluate(async (list, key) => (await import('/src/app/placeSources.ts'))[list][key], list, key);
      await pg.focus('#sv-canvas');
      await pg.keyboard.press('KeyI');
      await sleep(150);
      const got = await pg.evaluate(() => [...document.querySelectorAll('#explainer .src-line a[data-ref]')].map((a) => a.dataset.ref));
      const probs = await problems(pg, er);
      rep.check(`custom view, ${label}: the explainer cites the context defaults`, JSON.stringify(got) === JSON.stringify(expected) && probs.length === 0,
        `${got.join(' ')}${JSON.stringify(got) === JSON.stringify(expected) ? '' : ` (expected ${expected.join(' ')})`}${probs.length ? ` | ${probs[0]}` : ''}`);
    } finally {
      await pg.close();
    }
  }
});
