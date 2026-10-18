import { describe, expect, it, jest } from '@jest/globals';

type Listener = (...args: any[]) => void;

const listeners = new Map<string, Listener>();
const invoke = jest.fn<(channel: string) => Promise<unknown>>();

jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    on: (channel: string, listener: Listener) => {
      listeners.set(channel, listener);
    },
    invoke,
  },
}));

const { useVaultUnlock } = await import('../useVaultUnlock');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });

  return { promise, resolve };
}

describe('useVaultUnlock startup readiness', () => {
  it('keeps status unresolved and ignores results invalidated by restart or logout', async() => {
    const firstStatus = deferred<{ unlocked: boolean; state: string }>();
    const secondStatus = deferred<{ unlocked: boolean; state: string }>();
    let statusCalls = 0;

    invoke.mockImplementation(async(channel) => {
      if (channel === 'vault:initialize') return true;
      if (channel === 'vault:status') return await (++statusCalls === 1 ? firstStatus.promise : secondStatus.promise);
      throw new Error(`Unexpected channel: ${ channel }`);
    });

    const vault = useVaultUnlock();
    const initial = vault.tryAutoLogin();

    await Promise.resolve();
    expect(vault.statusResolved.value).toBe(false);

    vault.invalidateStatus();
    firstStatus.resolve({ unlocked: true, state: 'ready' });
    await initial;
    expect(vault.statusResolved.value).toBe(false);
    expect(vault.loggedIn.value).toBe(false);

    const refresh = vault.refreshStatus();

    await Promise.resolve();
    listeners.get('vault:logged-out')?.({});
    secondStatus.resolve({ unlocked: true, state: 'ready' });
    await refresh;
    expect(vault.statusResolved.value).toBe(true);
    expect(vault.loggedIn.value).toBe(false);
  });
});
