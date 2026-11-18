import { describe, expect, it, vi } from 'vitest';
import { DesktopVaultTransport } from './desktopTransport';

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
});
