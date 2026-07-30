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
async function start(): Promise<{
  seen: ServiceWorkerUpdateController[];
  reload: ReturnType<typeof vi.fn>;
  teardown: () => void;
}> {
  const seen: ServiceWorkerUpdateController[] = [];
  const reload = vi.fn();
  const teardown = await registerServiceWorkerUpdate((controller) => seen.push(controller), { reload });
  return { seen, reload, teardown };
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
