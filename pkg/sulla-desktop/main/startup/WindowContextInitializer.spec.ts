// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, bootstrap, initializeExtensions, reloadHooks } = vi.hoisted(() => ({
  invoke: vi.fn(),
  bootstrap: vi.fn(),
  initializeExtensions: vi.fn(),
  reloadHooks: vi.fn(),
}));

vi.mock('electron', () => ({ ipcRenderer: { invoke } }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { setFallbackFilePath: vi.fn(), bootstrap } }));
vi.mock('@pkg/agent/services/ExtensionService', () => ({ getExtensionService: () => ({ initialize: initializeExtensions }) }));
vi.mock('@pkg/agent/extensions/ExtensionLoader', () => ({ reloadExtensionHooks: reloadHooks }));
vi.mock('@pkg/utils/logging', () => ({ default: { sulla: { log: vi.fn(), info: vi.fn(), error: vi.fn() } } }));

import { WindowContextInitializer } from './WindowContextInitializer';

describe('WindowContextInitializer first-paint startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { search: '?windowKey=main' } },
    });
    invoke.mockImplementation((channel: string) => channel === 'get-user-data-path'
      ? Promise.resolve('/tmp/sulla')
      : new Promise(() => undefined));
  });

  it('does not hold first paint for the settings-backend handshake', async() => {
    // risk: availability — a slow settings DB must not leave a new agent window blank.
    const initializer = new WindowContextInitializer();

    expect(initializer.startForFirstPaint()).toBeUndefined();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('sulla-settings:wait-for-backends'));
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('continues settings and extension hydration after the readiness response', async() => {
    // risk: availability — removing the paint gate must not skip normal hydration.
    let signalReady!: () => void;
    invoke.mockImplementation((channel: string) => channel === 'get-user-data-path'
      ? Promise.resolve('/tmp/sulla')
      : new Promise<void>(resolve => { signalReady = resolve; }));
    bootstrap.mockResolvedValue(undefined);
    initializeExtensions.mockResolvedValue(undefined);
    reloadHooks.mockResolvedValue(undefined);

    new WindowContextInitializer().startForFirstPaint();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('sulla-settings:wait-for-backends'));
    signalReady();
    await vi.waitFor(() => expect(reloadHooks).toHaveBeenCalledOnce());

    expect(bootstrap).toHaveBeenCalledOnce();
    expect(initializeExtensions).toHaveBeenCalledOnce();
    expect(reloadHooks).toHaveBeenCalledOnce();
  });
});
