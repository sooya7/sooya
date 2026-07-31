// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorkerUpdate, type ServiceWorkerUpdateController } from './serviceWorkerUpdate.js';

const ACCEPTED_KEY = 'sooya:sw-update-accepted';

class FakeWorker extends EventTarget {
  state = 'installing';
  readonly messages: Array<{ type: string }> = [];
  postMessage(message: { type: string }): void {
    this.messages.push(message);
  }
  setState(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  update = vi.fn(async () => undefined);
  /** Mirrors the browser: a new worker installs, then parks in `waiting`. */
  startUpdate(): FakeWorker {
    const worker = new FakeWorker();
    this.installing = worker;
    this.dispatchEvent(new Event('updatefound'));
    this.installing = null;
    this.waiting = worker;
    worker.setState('installed');
    return worker;
  }
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
  readonly registration = new FakeRegistration();
  register = vi.fn(async () => this.registration as unknown as ServiceWorkerRegistration);
}

/** The controller the register call surfaced; fails loudly if none did. */
function only(list: ServiceWorkerUpdateController[]): ServiceWorkerUpdateController {
  const [first] = list;
  if (!first) throw new Error('expected exactly one update controller');
  return first;
}

let container: FakeContainer;

function install(container_: FakeContainer): void {
  Object.defineProperty(navigator, 'serviceWorker', { value: container_, configurable: true });
}

/** Register and collect whatever update controllers get surfaced. */
async function start(updateCheckIntervalMs?: number): Promise<{
  seen: ServiceWorkerUpdateController[];
  reload: ReturnType<typeof vi.fn>;
  teardown: () => void;
}> {
  const seen: ServiceWorkerUpdateController[] = [];
  const reload = vi.fn();
  const teardown = await registerServiceWorkerUpdate((controller) => seen.push(controller), {
    reload,
    updateCheckIntervalMs
  });
  return { seen, reload, teardown };
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  window.sessionStorage.clear();
  container = new FakeContainer();
  install(container);
});

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('registerServiceWorkerUpdate', () => {
  it('installs the first worker silently: no prompt, no reload', async () => {
    const { seen, reload, teardown } = await start();
    container.registration.startUpdate();
    expect(seen).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
    teardown();
  });

  it('never sends SKIP_WAITING on its own — a new build stays parked until accepted', async () => {
    container.controller = new FakeWorker();
    const { seen, reload, teardown } = await start();
    const worker = container.registration.startUpdate();

    expect(seen).toHaveLength(1);
    expect(worker.messages).toEqual([]);
    expect(reload).not.toHaveBeenCalled();

    only(seen).accept();
    expect(worker.messages).toEqual([{ type: 'SKIP_WAITING' }]);
    teardown();
  });

  it('reports a worker that was already waiting when the page loaded', async () => {
    container.controller = new FakeWorker();
    container.registration.waiting = new FakeWorker();
    const { seen, teardown } = await start();
    expect(seen).toHaveLength(1);
    teardown();
  });

  it('reloads once, and only once, after the user accepts', async () => {
    container.controller = new FakeWorker();
    const { seen, reload, teardown } = await start();
    container.registration.startUpdate();
    only(seen).accept();

    container.dispatchEvent(new Event('controllerchange'));
    container.dispatchEvent(new Event('controllerchange'));

    expect(reload).toHaveBeenCalledTimes(1);
    teardown();
  });

  it('leaves the running page untouched when the user says later', async () => {
    container.controller = new FakeWorker();
    const { seen, reload, teardown } = await start();
    const worker = container.registration.startUpdate();

    only(seen).dismiss();
    container.dispatchEvent(new Event('controllerchange'));

    expect(worker.messages).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(ACCEPTED_KEY)).toBeNull();
    teardown();
  });

  it('grants cache cleanup only on the load that follows an accepted update', async () => {
    // Nothing accepted: the new worker must not be told to drop the old shell.
    container.controller = new FakeWorker();
    const first = await start();
    expect(container.controller.messages).toEqual([]);
    first.teardown();

    // Now simulate the reload after an accept.
    window.sessionStorage.setItem(ACCEPTED_KEY, '1');
    const controller = new FakeWorker();
    container = new FakeContainer();
    container.controller = controller;
    install(container);

    const second = await start();
    expect(controller.messages).toEqual([{ type: 'CLIENT_READY' }]);
    expect(window.sessionStorage.getItem(ACCEPTED_KEY)).toBeNull();
    second.teardown();
  });

  it('keeps the HTTP cache out of the update check', async () => {
    const { teardown } = await start();
    expect(container.register).toHaveBeenCalledWith('/sw.js', { updateViaCache: 'none' });
    teardown();
  });

  it('stops listening after teardown', async () => {
    container.controller = new FakeWorker();
    const { seen, reload, teardown } = await start();
    teardown();

    container.registration.startUpdate();
    container.dispatchEvent(new Event('controllerchange'));

    expect(seen).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('update checks on a long-lived page', () => {
  const INTERVAL = 60_000;

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls for a new build while the page stays open', async () => {
    const { teardown } = await start(INTERVAL);
    expect(container.registration.update).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(container.registration.update).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(container.registration.update).toHaveBeenCalledTimes(2);
    teardown();
  });

  it('checks on foreground even when the background froze the timer', async () => {
    const { teardown } = await start(INTERVAL);
    setVisibility('hidden');
    // What a phone actually does to a background tab: timers stop, wall clock
    // keeps going. The poll never fires, so the foreground event is the check.
    vi.setSystemTime(Date.now() + INTERVAL + 1);
    setVisibility('visible');

    expect(container.registration.update).toHaveBeenCalledTimes(1);
    teardown();
  });

  it('throttles app switching: rapid foreground events cost one check', async () => {
    const { teardown } = await start(INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL + 1);
    expect(container.registration.update).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i += 1) {
      setVisibility('hidden');
      setVisibility('visible');
    }
    expect(container.registration.update).toHaveBeenCalledTimes(1);
    teardown();
  });

  it('a failed check is swallowed and the next one still runs', async () => {
    container.registration.update.mockRejectedValueOnce(new Error('offline'));
    const { teardown } = await start(INTERVAL);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(container.registration.update).toHaveBeenCalledTimes(2);
    teardown();
  });

  it('teardown stops the polling', async () => {
    const { teardown } = await start(INTERVAL);
    teardown();

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    setVisibility('hidden');
    setVisibility('visible');
    expect(container.registration.update).not.toHaveBeenCalled();
  });
});
