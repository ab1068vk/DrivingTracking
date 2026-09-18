// P7-IMPL-F04 reproduction 4, in Codex's exact shape: the Capacitor resume
// listener registered at module scope, with no `useEffect` around it to make
// the edge routine by association. `App.addListener` executes its callback
// every time the app returns to the foreground, and it is not spelled
// `addEventListener`, so nothing recognized it as a lifecycle root.
import { App } from '@capacitor/app';
import { tripService } from '@/api/trips';

export const reloadOnResume = () => { tripService.list(); };

App.addListener('appStateChange', reloadOnResume);
