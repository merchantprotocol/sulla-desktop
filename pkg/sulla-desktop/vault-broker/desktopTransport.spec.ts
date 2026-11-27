import { describe, expect, it, vi } from 'vitest';
import { loopbackOrigin } from '@pkg/utils/instance';
import { DesktopVaultIdentityRepository, DesktopVaultTransport } from './desktopTransport';

// Default: no port offset. Individual specs remap it to simulate an offset instance.
// Partial mock: keep the real module so transitive imports still resolve; override only loopbackOrigin.
vi.mock('@pkg/utils/instance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pkg/utils/instance')>()),
  loopbackOrigin: vi.fn((protocol: string, basePort: number) => `${ protocol }://127.0.0.1:${ basePort }`),
}));

// desktopTransport.ts imports Electron at module load; the specs inject their own session/safeStorage factories.
vi.mock('electron', () => {
  const app = { on: vi.fn(), isPackaged: false, getPath: vi.fn(() => '/tmp') };
  const safeStorage = { isEncryptionAvailable: vi.fn(() => true), decryptString: vi.fn(), encryptString: vi.fn() };
  const session = { fromPartition: vi.fn() };

  return { default: { app, safeStorage, session }, app, safeStorage, session };
});

describe('DesktopVaultTransport sessions', () => {
  it('keeps separate Electron control and streaming sessions when the Node fallbacks are disabled', async() => {
    // risk: availability — bounded control calls must not queue behind long-lived stream sockets.
    const controlFetch = vi.fn(async() => new Response('{}'));
    const streamFetch = vi.fn(async() => new Response('{}'));
    const sessionFactory = vi.fn((partition: string) => ({ fetch: partition.endsWith('-control') ? controlFetch : streamFetch }) as never);
    const transport = new DesktopVaultTransport({} as never, sessionFactory, async() => {}, async() => new Response('{}') as never, () => ({ close: vi.fn() } as never));
    vi.stubEnv('SULLA_VAULT_CONTROL_TRANSPORT', 'electron');
    vi.stubEnv('SULLA_VAULT_STREAM_TRANSPORT', 'electron');
    try {
      await transport.fetch('https://127.0.0.1:30135/status');
      await transport.fetchStream('https://127.0.0.1:30135/stream');
    } finally { vi.unstubAllEnvs(); }
    expect(sessionFactory.mock.calls.map(([partition]) => partition)).toEqual(['sulla-vault-broker-control', 'sulla-vault-broker']);
    expect(controlFetch).toHaveBeenCalledTimes(1);
    expect(streamFetch).toHaveBeenCalledTimes(1);
  });

  it('uses the pinned Node dispatcher for streams and forwards the abort signal without using Electron', async() => {
    // risk: availability — active streams must not consume Electron session sockets, and cancellation must release them.
    const nodeResponse = new Response('stream');
    const nodeFetch = vi.fn(async(_input: string, init: { signal?: AbortSignal; dispatcher?: unknown }) => {
      expect(init.signal).toBeDefined();
      expect(init.dispatcher).toBeDefined();
      return nodeResponse;
    });
    const sessionFactory = vi.fn(() => ({ fetch: vi.fn() }) as never);
    const transport = new DesktopVaultTransport({} as never, sessionFactory, async() => {}, nodeFetch as never, () => ({ close: vi.fn() } as never));
    const controller = new AbortController();
    expect(await transport.fetchStream('https://127.0.0.1:30135/stream', { signal: controller.signal })).toBe(nodeResponse);
    expect(nodeFetch).toHaveBeenCalledTimes(1);
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it('accepts the remapped vault origin on offset instances and refuses the unmapped port', async() => {
    // risk: availability — on offset instances every model/MCP/relay stream targets the remapped vault port; refusing it breaks all agents. risk: permissions — a different port must still be refused.
    const nodeFetch = vi.fn(async() => new Response('stream'));
    const transport = new DesktopVaultTransport({} as never, () => ({ fetch: vi.fn() }) as never, async() => {}, nodeFetch as never, () => ({ close: vi.fn() } as never));
    const defaultOrigin = (protocol: string, basePort: number) => `${ protocol }://127.0.0.1:${ basePort }`;
    vi.mocked(loopbackOrigin).mockImplementation((protocol: string, basePort: number) => `${ protocol }://127.0.0.1:${ basePort + 20 }`);
    try {
      expect(await transport.fetchStream('https://127.0.0.1:30155/stream')).toBeDefined();
      await expect(transport.fetchStream('https://127.0.0.1:30135/stream')).rejects.toThrow('Vault stream transport only accepts the local vault origin');
      expect(nodeFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(loopbackOrigin).mockImplementation(defaultOrigin);
    }
  });

  it('routes streams to Electron when the transport kill switch is set', async() => {
    // risk: availability — retain a reversible fallback if the Node stream path regresses.
    const sessionFetch = vi.fn(async() => new Response('electron'));
    const nodeFetch = vi.fn();
    const transport = new DesktopVaultTransport({} as never, () => ({ fetch: sessionFetch }) as never, async() => {}, nodeFetch as never);
    vi.stubEnv('SULLA_VAULT_STREAM_TRANSPORT', 'electron');
    try { await transport.fetchStream('https://127.0.0.1:30135/stream'); } finally { vi.unstubAllEnvs(); }
    expect(sessionFetch).toHaveBeenCalledTimes(1);
    expect(nodeFetch).not.toHaveBeenCalled();
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
    vi.stubEnv('SULLA_VAULT_CONTROL_TRANSPORT', 'electron');
    try { await transport.fetch('https://127.0.0.1:30135/control'); } finally { vi.unstubAllEnvs(); }
    expect((await transport.loadBrokerIdentity()).serviceToken).toBe('token-2');
  });
});
