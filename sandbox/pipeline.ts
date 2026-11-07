// End-to-end pipeline smoke test with whatever passes currently exist.
import { startSandbox } from './common';
import { FarFieldPass } from '../src/render/passes/FarFieldPass';
import { NearFieldPass } from '../src/render/passes/NearFieldPass';
import { RingLayerPass } from '../src/render/passes/RingLayerPass';
import { PostPass } from '../src/render/PostPass';

startSandbox({
  passes: () => ({ far: new FarFieldPass(), near: new NearFieldPass(), rings: new RingLayerPass(), post: new PostPass() }),
});
