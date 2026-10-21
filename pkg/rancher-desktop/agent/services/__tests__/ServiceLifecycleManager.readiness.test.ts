import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@pkg/utils/logging', () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  return { __esModule: true, default: { sulla: logger } };
});

const { ServiceLifecycleManager } = await import('../ServiceLifecycleManager');

describe('ServiceLifecycleManager.waitUntilStarted', () => {
  it('keeps stable definitions and stops a superseded startup generation', async() => {
    const lifecycle = new ServiceLifecycleManager();
    let current = true;
    let originalStarts = 0;
    let replacementStarts = 0;
    let dependentStarts = 0;
    let originalStops = 0;

    lifecycle.registerOnce('first', [], async() => {
      await Promise.resolve();
      originalStarts += 1;
      current = false;
    }, async() => {
      await Promise.resolve();
      originalStops += 1;
    });
    lifecycle.registerOnce('first', [], async() => {
      await Promise.resolve();
      replacementStarts += 1;
    }, async() => { await Promise.resolve() });
    lifecycle.registerOnce('dependent', ['first'], async() => {
      await Promise.resolve();
      dependentStarts += 1;
    }, async() => { await Promise.resolve() });

    await expect(lifecycle.startAll(() => {
      if (!current) throw new Error('superseded');
    })).rejects.toThrow('superseded');
    expect(originalStarts).toBe(1);
    expect(replacementStarts).toBe(0);
    expect(dependentStarts).toBe(0);
    expect(lifecycle.isStarted('first')).toBe(true);
    await lifecycle.stopAll();
    expect(originalStops).toBe(1);
    expect(lifecycle.isStarted('first')).toBe(false);
  });

  it('hands a service that finishes starting after shutdown back to teardown', async() => {
    const lifecycle = new ServiceLifecycleManager();
    let releaseStart!: () => void;
    let stops = 0;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve });

    lifecycle.register('slow', [], async() => { await startGate }, async() => { await Promise.resolve(); stops += 1 });
    const starting = lifecycle.startAll();
    await Promise.resolve();
    await lifecycle.stopAll();
    releaseStart();
    await starting;

    expect(stops).toBe(1);
    expect(lifecycle.isStarted('slow')).toBe(false);
  });

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

describe('ServiceLifecycleManager vault transitions', () => {
  it('defers, starts once, locks, and starts once again', async() => {
    const lifecycle = new ServiceLifecycleManager();
    let starts = 0;
    let stops = 0;

    lifecycle.register('vault-dependent', [], async() => { starts += 1 }, async() => { stops += 1 }, { requiresVault: true });
    await lifecycle.startAll();
    expect(lifecycle.serviceStatuses()[0].status).toBe('waiting-on-unlock');

    await lifecycle.setVaultUnlocked(true);
    await lifecycle.setVaultUnlocked(true);
    expect(starts).toBe(1);

    await lifecycle.setVaultUnlocked(false);
    await lifecycle.setVaultUnlocked(false);
    expect(stops).toBe(1);

    await lifecycle.setVaultUnlocked(true);
    expect(starts).toBe(2);
  });
});
