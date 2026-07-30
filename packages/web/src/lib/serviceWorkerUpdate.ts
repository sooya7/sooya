/**
 * Coordinates service-worker updates.
 *
 * The rule this file exists to enforce: a new build never takes over while the
 * user is mid-conversation. A freshly installed worker waits, the page asks, and
 * only an explicit accept sends `SKIP_WAITING`. Exactly one reload follows, and
 * only after that reload does the new worker get permission (`CLIENT_READY`) to
 * drop the previous shell cache — so a failed reload still has a working shell to
 * fall back to.
 */

const ACCEPTED_KEY = 'sooya:sw-update-accepted';

export interface ServiceWorkerUpdateController {
  /** Let the waiting worker take over; the page reloads once. */
  accept(): void;
  /** Keep the current worker and page exactly as they are. */
  dismiss(): void;
  /** Stop listening for this particular worker. */
  dispose(): void;
}

export interface RegisterOptions {
  /** Injectable for tests; defaults to a real page reload. */
  reload?: () => void;
}

type WaitingHandler = (controller: ServiceWorkerUpdateController) => void;

function readAccepted(): boolean {
  try {
    return window.sessionStorage.getItem(ACCEPTED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAccepted(on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(ACCEPTED_KEY, '1');
    else window.sessionStorage.removeItem(ACCEPTED_KEY);
  } catch {
    // Private mode with storage denied: the worst case is no automatic reload.
  }
}

/**
 * Register the worker and report waiting updates through `onWaiting`.
 * Resolves with a teardown function that detaches every listener.
 */
export async function registerServiceWorkerUpdate(
  onWaiting: WaitingHandler,
  options: RegisterOptions = {}
): Promise<() => void> {
  const container = navigator.serviceWorker;
  if (!container) return () => undefined;

  const reload = options.reload ?? (() => window.location.reload());
  const registration = await container.register('/sw.js');

  // This load is the one that followed an accepted update: the new worker is in
  // control, so it may now discard the old shell cache.
  if (readAccepted()) {
    writeAccepted(false);
    container.controller?.postMessage({ type: 'CLIENT_READY' });
  }

  let reloaded = false;
  let disposed = false;
  const cleanups: Array<() => void> = [];

  const makeController = (worker: ServiceWorker): ServiceWorkerUpdateController => {
    let settled = false;
    return {
      accept() {
        if (settled || disposed) return;
        settled = true;
        // Remember the intent *before* handing over: `controllerchange` is what
        // triggers the reload and it can fire immediately.
        writeAccepted(true);
        worker.postMessage({ type: 'SKIP_WAITING' });
      },
      dismiss() {
        if (settled) return;
        settled = true;
        // Deliberately nothing else: the active worker keeps serving this page.
        writeAccepted(false);
      },
      dispose() {
        settled = true;
      }
    };
  };

  const announce = (worker: ServiceWorker | null | undefined) => {
    if (!worker || disposed) return;
    // No controller means this is a first install, not an update — nothing to ask.
    if (!container.controller) return;
    onWaiting(makeController(worker));
  };

  announce(registration.waiting);

  const onUpdateFound = () => {
    const installing = registration.installing;
    if (!installing) return;
    const onStateChange = () => {
      // `updatefound` alone is never a reason to bother the user or reload;
      // wait until the new worker is actually installed and parked.
      if (installing.state === 'installed') announce(registration.waiting ?? installing);
    };
    installing.addEventListener('statechange', onStateChange);
    cleanups.push(() => installing.removeEventListener('statechange', onStateChange));
  };
  registration.addEventListener('updatefound', onUpdateFound);
  cleanups.push(() => registration.removeEventListener('updatefound', onUpdateFound));

  const onControllerChange = () => {
    // Only an accepted update reloads, and only once per page.
    if (reloaded || disposed || !readAccepted()) return;
    reloaded = true;
    reload();
  };
  container.addEventListener('controllerchange', onControllerChange);
  cleanups.push(() => container.removeEventListener('controllerchange', onControllerChange));

  return () => {
    disposed = true;
    while (cleanups.length) cleanups.pop()?.();
  };
}
