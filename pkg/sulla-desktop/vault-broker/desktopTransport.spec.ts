import { describe, expect, it, vi } from 'vitest';
import { DesktopVaultIdentityRepository, DesktopVaultTransport } from './desktopTransport';

// desktopTransport.ts imports Electron at module load; the specs inject their own session/safeStorage factories.
vi.mock('electron', () => {
  const app = { on: vi.fn(), isPackaged: false, getPath: vi.fn(() => '/tmp') };
  const safeStorage = { isEncryptionAvailable: vi.fn(() => true), decryptString: vi.fn(), encryptString: vi.fn() };
  const session = { fromPartition: vi.fn() };

  return { default: { app, safeStorage, session }, app, safeStorage, session };
});

describe('DesktopVaultTransport sessions', () => {
  it('routes control and explicitly streaming requests to separately pinned sessions', async() => {
    // risk: availability — bounded control calls must not queue behind long-lived stream sockets.
    const controlFetch = vi.fn(async() => new Response('{}'));
    const streamFetch = vi.fn(async() => new Response('{}'));
    const sessionFactory = vi.fn((partition: string) => ({ fetch: partition.endsWith('-control') ? controlFetch : streamFetch }) as never);
    const transport = new DesktopVaultTransport({} as never, sessionFactory, async() => {});
    await transport.fetch('https://vault.test/status');
    await transport.fetchStream('https://vault.test/stream');
    expect(sessionFactory.mock.calls.map(([partition]) => partition)).toEqual(['sulla-vault-broker-control', 'sulla-vault-broker']);
    expect(controlFetch).toHaveBeenCalledTimes(1);
    expect(streamFetch).toHaveBeenCalledTimes(1);
  });

  it('uses identity cache until TTL expiry and reloads when encrypted-file mtime changes', async() => {
    // risk: availability — avoid disk reads per request without retaining rotated credentials.
    vi.useFakeTimers();
    try {
      let mtimeMs = 1;
      const readFile = vi.fn(async() => Buffer.from(String(mtimeMs)));
      const repository = new DesktopVaultIdentityRepository(
        () => ({ isEncryptionAvailable: () => true, decryptString: (value: Buffer) => value.toString() } as never),
        () => '/vault', readFile, async() => ({ mtimeMs }),
      );
      expect((await repository.loadBrokerIdentity()).serviceToken).toBe('1');
      await repository.loadBrokerIdentity();
      expect(readFile).toHaveBeenCalledTimes(1);
      mtimeMs = 2;
      expect((await repository.loadBrokerIdentity()).serviceToken).toBe('2');
      await vi.advanceTimersByTimeAsync(60_000);
      await repository.loadBrokerIdentity();
      expect(readFile).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('invalidates decrypted identity after a 401 from either session', async() => {
    // risk: permissions — rejected credentials must not stay cached for later requests.
    const readFile = vi.fn(async() => Buffer.from('encrypted'));
    const identities = new DesktopVaultIdentityRepository(
      () => ({ isEncryptionAvailable: () => true, decryptString: () => `token-${ readFile.mock.calls.length }` } as never),
      () => '/vault', readFile, async() => ({ mtimeMs: 1 }),
    );
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response(''));
    const transport = new DesktopVaultTransport(identities, () => ({ fetch }) as never, async() => {});
    expect((await transport.loadBrokerIdentity()).serviceToken).toBe('token-1');
    await transport.fetch('https://vault.test/control');
    expect((await transport.loadBrokerIdentity()).serviceToken).toBe('token-2');
  });
});
