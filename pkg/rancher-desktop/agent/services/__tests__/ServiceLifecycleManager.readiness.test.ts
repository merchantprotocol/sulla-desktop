import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@pkg/utils/logging', () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  return { __esModule: true, default: { sulla: logger } };
});

const { ServiceLifecycleManager } = await import('../ServiceLifecycleManager');

describe('ServiceLifecycleManager.waitUntilStarted', () => {
  it('waits for the requested service and then resolves', async() => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve });
    const lifecycle = new ServiceLifecycleManager();

    lifecycle.register('vault', [], async() => { await startGate; }, async() => {});
    const starting = lifecycle.startAll();
    const ready = lifecycle.waitUntilStarted('vault', 1_000);

    releaseStart();
    await expect(ready).resolves.toBeUndefined();
    await starting;
  });

  it('rejects promptly when startup completes without the requested service', async() => {
    const lifecycle = new ServiceLifecycleManager();

    lifecycle.register('vault', [], async() => { throw new Error('synthetic startup failure') }, async() => {});
    await lifecycle.startAll();

    await expect(lifecycle.waitUntilStarted('vault', 1_000)).rejects.toThrow("Lifecycle service 'vault' failed to start");
  });

  it('bounds a service wait when startup does not settle', async() => {
    jest.useFakeTimers();
    const lifecycle = new ServiceLifecycleManager();

    lifecycle.register('vault', [], async() => { await new Promise<void>(() => {}); }, async() => {});
    void lifecycle.startAll();
    const ready = lifecycle.waitUntilStarted('vault', 50);

    jest.advanceTimersByTime(50);
    await expect(ready).rejects.toThrow("Lifecycle service 'vault' did not become ready within 50ms");
    jest.useRealTimers();
  });

  it('rejects and removes waiter listeners when shutdown begins', async() => {
    const lifecycle = new ServiceLifecycleManager();

    lifecycle.register('vault', [], async() => { await new Promise<void>(() => {}); }, async() => {});
    void lifecycle.startAll();
    const ready = lifecycle.waitUntilStarted('vault', 1_000);

    await lifecycle.stopAll();
    await expect(ready).rejects.toThrow("Lifecycle service 'vault' became unavailable during shutdown");
    expect(lifecycle.listenerCount('service:ready')).toBe(0);
    expect(lifecycle.listenerCount('all:ready')).toBe(0);
    expect(lifecycle.listenerCount('shutdown:begin')).toBe(0);
  });
});
