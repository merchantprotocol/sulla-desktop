// SPDX-License-Identifier: GPL-2.0-or-later
// The agent window can paint first. Callers that await initialization are bounded; hydration can finish later.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  bootstrap: vi.fn(), readBootstrapFile: vi.fn(), setStartupTelemetry: vi.fn(), setFallbackFilePath: vi.fn(), initialize: vi.fn(), reloadHooks: vi.fn(),
  log: vi.fn(), error: vi.fn(),
}));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { bootstrap: f.bootstrap, readBootstrapFile: f.readBootstrapFile, setFallbackFilePath: f.setFallbackFilePath } }));
vi.mock('@pkg/agent/services/ExtensionService', () => ({ getExtensionService: () => ({ initialize: f.initialize, setStartupTelemetry: f.setStartupTelemetry }) }));
vi.mock('@pkg/agent/extensions/ExtensionLoader', () => ({ reloadExtensionHooks: f.reloadHooks }));
vi.mock('@pkg/utils/logging', () => ({ default: { sulla: { log: f.log, info: f.log, error: f.error, warn: vi.fn() } } }));

import { WindowContextInitializer } from '@pkg/main/startup/WindowContextInitializer';

function deferred<T = void>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail });
  return { promise, resolve, reject };
}

/** IPC with the real channel names; the backends-ready signal is controlled by the test. */
function ipc(backendsReady: Promise<void>) {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'sulla-startup:stage') return Promise.resolve();
    if (channel === 'get-user-data-path') return Promise.resolve('/tmp/sulla-user-data');
    if (channel === 'sulla-settings:wait-for-backends') return backendsReady;
    return Promise.reject(new Error(`unexpected channel ${ channel }`));
  });
  return { invoke };
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true });
  await vi.advanceTimersByTimeAsync(ms);
  return done;
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of Object.values(f)) fn.mockReset();
  f.bootstrap.mockResolvedValue(undefined); f.initialize.mockResolvedValue(undefined); f.reloadHooks.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers() });

describe('window startup before mount', () => {
  it('completes settings and extensions before mounting when they are ready (fast path)', async() => {
    const bridge = ipc(Promise.resolve());
    await new WindowContextInitializer(() => bridge).initialize();
    expect(f.setFallbackFilePath).toHaveBeenCalledWith('/tmp/sulla-user-data/sulla-settings-fallback.json');
    expect(f.bootstrap).toHaveBeenCalledTimes(1);
    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(f.reloadHooks).toHaveBeenCalledTimes(1);
  });

  it('mounts within the bound when backends are ready but settings bootstrap is still pending, then finishes it', async() => {
    const bootstrap = deferred();
    f.bootstrap.mockReturnValue(bootstrap.promise);
    const startup = new WindowContextInitializer(() => ipc(Promise.resolve())).initialize();
    expect(await settledWithin(startup, 7_999)).toBe(false);
    expect(await settledWithin(startup, 1)).toBe(true);
    expect(f.initialize).not.toHaveBeenCalled();
    bootstrap.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(f.reloadHooks).toHaveBeenCalledTimes(1);
  });

  it('mounts within the bound while extension startup is still pending', async() => {
    const extensions = deferred();
    f.initialize.mockReturnValue(extensions.promise);
    const startup = new WindowContextInitializer(() => ipc(Promise.resolve())).initialize();
    expect(await settledWithin(startup, 8_000)).toBe(true);
    expect(f.reloadHooks).not.toHaveBeenCalled();
    extensions.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reloadHooks).toHaveBeenCalledTimes(1);
  });

  it('waits for the backends-ready signal in the background and bootstraps once it arrives', async() => {
    const backends = deferred();
    const startup = new WindowContextInitializer(() => ipc(backends.promise)).initialize();
    expect(await settledWithin(startup, 8_000)).toBe(true);
    expect(f.bootstrap).not.toHaveBeenCalled();
    backends.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bootstrap).toHaveBeenCalledTimes(1);
    expect(f.initialize).toHaveBeenCalledTimes(1);
  });

  it('reports a background settings or extension failure without an unhandled rejection', async() => {
    const bootstrap = deferred();
    const extensions = deferred();
    f.bootstrap.mockReturnValue(bootstrap.promise);
    f.initialize.mockReturnValue(extensions.promise);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const startup = new WindowContextInitializer(() => ipc(Promise.resolve())).initialize();
      expect(await settledWithin(startup, 8_000)).toBe(true);
      bootstrap.reject(new Error('redis still cold'));
      await vi.advanceTimersByTimeAsync(0);
      extensions.reject(new Error('extension manifest broken'));
      await vi.advanceTimersByTimeAsync(0);
      await vi.runAllTimersAsync();
      expect(f.error).toHaveBeenCalledWith('[WindowContext] Failed to initialize settings:', expect.objectContaining({ message: 'redis still cold' }));
      expect(f.error).toHaveBeenCalledWith('[ExtensionService] Failed to initialize:', expect.objectContaining({ message: 'extension manifest broken' }));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
