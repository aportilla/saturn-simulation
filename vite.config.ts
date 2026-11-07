import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

const root = import.meta.dirname;

// Every sandbox/*.html page is also a build entry, so component test pages keep working.
const sandboxDir = resolve(root, 'sandbox');
const sandboxPages: Record<string, string> = {};
if (existsSync(sandboxDir)) {
  for (const f of readdirSync(sandboxDir)) {
    if (f.endsWith('.html')) sandboxPages['sandbox_' + f.replace(/\.html$/, '')] = resolve(sandboxDir, f);
  }
}

export default defineConfig({
  server: { port: 5173, strictPort: false, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: { main: resolve(root, 'index.html'), ...sandboxPages },
    },
  },
});
