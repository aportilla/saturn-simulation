#!/usr/bin/env node
// Run several tests in sequence against ONE dev server and summarize (npm test).
//
// usage: node scripts/test/run.mjs [smoke physics counts seam exposure edges ...] [--base URL] [--out DIR]
//
// Starts a private Vite server unless --base answers, passes --base / --out <DIR>/<test> to each test, prints a
// pass/fail table with runtimes and exits 1 if any test failed. Default tests: smoke physics counts seam exposure
// edges moonflux.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO, outputDir, parseArgs, startServer, table, writeJson } from './lib.mjs';

const args = parseArgs();
const tests = args._.length ? args._ : ['smoke', 'physics', 'counts', 'seam', 'exposure', 'edges', 'moonflux'];
const out = outputDir('run', args.str('out'));
const srv = await startServer({ base: args.str('base') });
const rows = [];
let failed = 0;
try {
  for (const t of tests) {
    const t0 = Date.now();
    const code = await new Promise((res) => {
      const p = spawn(process.execPath, [join(REPO, 'scripts', 'test', `${t}.mjs`), '--base', srv.base, '--out', join(out, t)], { stdio: 'inherit' });
      p.on('exit', (c) => res(c ?? 1));
    });
    const secs = (Date.now() - t0) / 1000;
    if (code !== 0) failed++;
    rows.push([t, code === 0 ? 'PASS' : 'FAIL', secs.toFixed(0), join(out, t, 'results.json')]);
  }
} finally {
  await srv.close();
}
console.log(`\n${table(['test', 'result', 'seconds', 'results'], rows)}`);
writeJson(join(out, 'summary.json'), rows.map(([test, result, seconds, results]) => ({ test, result, seconds: Number(seconds), results })));
process.exit(failed ? 1 : 0);
