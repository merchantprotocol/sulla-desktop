// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  invoke: vi.fn(),
  setFallbackFilePath: vi.fn(),
  bootstrap: vi.fn(),
  initializeExtensions: vi.fn(),
  reloadExtensionHooks: vi.fn(),
}));

vi.mock('electron', () => ({ ipcRenderer: { invoke: deps.invoke } }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: {
  setFallbackFilePath: deps.setFallbackFilePath,
  bootstrap: deps.bootstrap,
} }));
vi.mock('@pkg/agent/services/ExtensionService', () => ({ getExtensionService: () => ({ initialize: deps.initializeExtensions, setStartupTelemetry: vi.fn() }) }));
vi.mock('@pkg/agent/extensions/ExtensionLoader', () => ({ reloadExtensionHooks: deps.reloadExtensionHooks }));
vi.mock('@pkg/utils/logging', () => ({ default: { sulla: { info: vi.fn(), log: vi.fn(), error: vi.fn() } } }));

import { WindowContextInitializer } from './WindowContextInitializer';

describe('WindowContextInitializer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/agent.html?windowKey=secondary&startupId=11111111-1111-4111-8111-111111111111');
    deps.invoke.mockImplementation((channel: string) => Promise.resolve(channel === 'get-user-data-path' ? '/user-data' : undefined));
    deps.bootstrap.mockResolvedValue(undefined);
    deps.initializeExtensions.mockResolvedValue(undefined);
    deps.reloadExtensionHooks.mockResolvedValue(undefined);
  });

  it('keeps backend-dependent hydration off first paint and starts settings/extensions when the DB is ready', async() => {
    // risk: a cold secondary window must not exhaust settings retries or delay the shell
    let markBackendsReady!: () => void;
    const backendsReady = new Promise<void>(resolve => { markBackendsReady = resolve; });
    deps.invoke.mockImplementation((channel: string) => channel === 'get-user-data-path' ? Promise.resolve('/user-data') : backendsReady);

    await new WindowContextInitializer().initialize();
    expect(deps.setFallbackFilePath).toHaveBeenCalledWith('/user-data/sulla-settings-fallback.json');
    expect(deps.invoke).toHaveBeenCalledWith('sulla-settings:wait-for-backends', {
      startupId: '11111111-1111-4111-8111-111111111111',
      windowKey: 'secondary',
    });
    expect(deps.bootstrap).not.toHaveBeenCalled();
    expect(deps.initializeExtensions).not.toHaveBeenCalled();

    markBackendsReady();
    await vi.waitFor(() => expect(deps.reloadExtensionHooks).toHaveBeenCalledTimes(1));
    expect(deps.bootstrap).toHaveBeenCalledTimes(1);
    expect(deps.initializeExtensions).toHaveBeenCalledTimes(1);
  });
});

describe('WindowContextInitializer in the main process', () => {
  it('can be constructed where window is undefined', () => {
    // risk: SullaStartup builds one at import time in main; reading window eagerly crashed boot with no window
    const saved = globalThis.window;
    // @ts-expect-error simulate the Electron main process
    delete globalThis.window;
    try {
      expect(() => new WindowContextInitializer()).not.toThrow();
    } finally {
      globalThis.window = saved;
    }
  });
});
