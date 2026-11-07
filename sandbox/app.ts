// The full application with the orchestrator's STUB far-field / ring-layer passes and no near field, so
// the camera, HUD and controls can be tested independently of the in-progress render passes.
// Same URL parameters and window.__sv hooks as the main app (/?preset=...).
import { startApp } from '../src/app/App';

void startApp({ stubs: true });
