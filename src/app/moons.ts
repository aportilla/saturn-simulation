// Moon provider loading: the real ephemeris (src/moons/MoonSystem.ts, loadMoonSystem()) when present and
// working, else the built-in circular-orbit StubMoons. import.meta.glob keeps this compiling and bundling
// whether or not MoonSystem.ts exists yet.
import type { MoonProvider } from '../moons/types';
import { StubMoons } from '../moons/stubMoons';

type MoonModule = { loadMoonSystem?: (...args: unknown[]) => Promise<MoonProvider> | MoonProvider };
const modules = import.meta.glob<MoonModule>('../moons/MoonSystem.ts');

export interface MoonLoadResult {
  provider: MoonProvider;
  source: 'ephemeris' | 'stub';
  error?: string;
}

export async function loadMoons(): Promise<MoonLoadResult> {
  const loader = modules['../moons/MoonSystem.ts'];
  if (loader) {
    try {
      const mod = await loader();
      if (typeof mod.loadMoonSystem === 'function') {
        const p = await mod.loadMoonSystem();
        if (p && typeof p.getStates === 'function') {
          // smoke test: one evaluation must succeed
          p.getStates(8.3e8, []);
          // loadMoonSystem() itself falls back to StubMoons when its data files are missing
          return { provider: p, source: p instanceof StubMoons ? 'stub' : 'ephemeris' };
        }
      }
      console.warn('[app] MoonSystem.ts did not provide a usable loadMoonSystem(); using StubMoons');
    } catch (e) {
      console.warn('[app] MoonSystem unavailable, using StubMoons:', e);
      return { provider: new StubMoons(), source: 'stub', error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { provider: new StubMoons(), source: 'stub' };
}

/** Wrap a provider so a runtime exception falls back to StubMoons instead of killing the frame loop. */
export class SafeMoons implements MoonProvider {
  private fallback: StubMoons | null = null;
  constructor(private inner: MoonProvider, private onFail: (e: unknown) => void) {}
  get count(): number {
    return (this.fallback ?? this.inner).count;
  }
  getStates(t: number, out: import('../core/FrameState').MoonState[]): void {
    if (this.fallback) {
      this.fallback.getStates(t, out);
      return;
    }
    try {
      this.inner.getStates(t, out);
    } catch (e) {
      this.fallback = new StubMoons();
      out.length = 0;
      this.onFail(e);
      this.fallback.getStates(t, out);
    }
  }
}
