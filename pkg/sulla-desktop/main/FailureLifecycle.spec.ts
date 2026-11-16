import { describe, expect, it, vi } from 'vitest';

import { FailureLifecycle, type FailureLifecycleOptions } from './failureLifecycle';

function options(overrides: Partial<FailureLifecycleOptions<string>> = {}): FailureLifecycleOptions<string> {
  return {
    isShuttingDown:        () => false,
    waitForLogs:           vi.fn(async () => undefined),
    getFailureDetails:     vi.fn(async () => 'details'),
    showFailureDetails:    vi.fn(),
    showFallback:          vi.fn(),
    onFailureDetailsError: vi.fn(),
    ...overrides,
  };
}

describe('FailureLifecycle', () => {
  it('shows failure details when they are available', async () => {
    const o = options();

    await new FailureLifecycle(o).reportUnlessShuttingDown();
    expect(o.showFailureDetails).toHaveBeenCalledWith('details');
    expect(o.showFallback).not.toHaveBeenCalled();
  });

  it('shows the fallback when there are no details, or reading them fails', async () => {
    const none = options({ getFailureDetails: async () => undefined });
    const error = new Error('logs');
    const failing = options({ getFailureDetails: async () => { throw error } });

    await new FailureLifecycle(none).reportUnlessShuttingDown();
    await new FailureLifecycle(failing).reportUnlessShuttingDown();
    expect(none.showFallback).toHaveBeenCalledTimes(1);
    expect(failing.onFailureDetailsError).toHaveBeenCalledWith(error);
    expect(failing.showFallback).toHaveBeenCalledTimes(1);
  });

  // risk: shutdown — no dialog may open once the app started quitting
  it('shows nothing when shutdown starts while waiting for logs', async () => {
    let shuttingDown = false;
    const o = options({ isShuttingDown: () => shuttingDown, waitForLogs: async () => { shuttingDown = true } });

    await new FailureLifecycle(o).reportUnlessShuttingDown();
    expect(o.getFailureDetails).not.toHaveBeenCalled();
    expect(o.showFailureDetails).not.toHaveBeenCalled();
    expect(o.showFallback).not.toHaveBeenCalled();
  });

  it('does nothing at all when already shutting down', async () => {
    const o = options({ isShuttingDown: () => true });

    await new FailureLifecycle(o).reportUnlessShuttingDown();
    expect(o.waitForLogs).not.toHaveBeenCalled();
    expect(o.showFallback).not.toHaveBeenCalled();
  });
});
