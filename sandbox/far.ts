// Far-field development sandbox: FarFieldPass + RingLayerStub + PostPass (other agents' passes stubbed).
// Extra URL parameters (besides those of sandbox/common.ts):
//   gpu=1          GPU timing of the far pass (stats overlay)
//   rings=0        no ring layer (plain copy)
//   moons=stub     force the placeholder moon provider (default: src/moons/MoonSystem.ts if present)
//   bloom=<x>      glare strength multiplier
import { startSandbox } from './common';
import { FarFieldPass } from '../src/render/passes/FarFieldPass';
import { RingLayerStub } from '../src/render/passes/stubs/RingLayerStub';
import { PostPass } from '../src/render/PostPass';
import { StubMoons } from '../src/moons/stubMoons';
import type { MoonProvider } from '../src/moons/types';

const params = new URLSearchParams(location.search);
const moonModules = import.meta.glob('../src/moons/MoonSystem.ts');

async function moonProvider(): Promise<MoonProvider> {
  if (params.get('moons') !== 'stub') {
    const loader = moonModules['../src/moons/MoonSystem.ts'];
    if (loader) {
      try {
        const mod: any = await loader();
        const fn = mod.loadMoonSystem ?? mod.default;
        if (typeof fn === 'function') {
          const p = await fn();
          if (p) return p as MoonProvider;
        }
      } catch (e) {
        console.warn('[far sandbox] MoonSystem unavailable, using stub moons', e);
      }
    }
  }
  return new StubMoons();
}

startSandbox({
  passes: () => ({
    far: new FarFieldPass({ gpuTiming: params.get('gpu') === '1' }),
    rings: params.get('rings') === '0' ? undefined : new RingLayerStub(),
    post: new PostPass(),
  }),
  moons: moonProvider,
  onFrame: (f) => {
    if (params.has('bloom')) f.settings.bloom = parseFloat(params.get('bloom')!);
  },
});
