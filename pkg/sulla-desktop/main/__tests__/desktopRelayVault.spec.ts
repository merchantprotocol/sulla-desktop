/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/* eslint-disable @typescript-eslint/require-await -- async fakes mirror the broker API */

/**
 * DesktopRelayClient over the container-vault relay (`sulla-cloud.relay`).
 * Uses the real cloudRelayTransport with a fake broker: the app must never
 * read the sulla-cloud token, and failures must back off quietly.
 */

import { jest } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

const ROOM = '11111111-1111-4111-8111-aaaaaaaaaaaa';

class FakeVaultBrokerError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

interface RelayEvent { sequence: number; type: string; payload: unknown }

/** Controllable NDJSON relay stream. */
class FakeStream {
  private queue: RelayEvent[] = [];
  private wake:  (() => void) | null = null;
  private ended = false;
  private seq = 0;
  push(type: string, payload: unknown) { this.queue.push({ sequence: ++this.seq, type, payload }); this.wake?.() }
  end() { this.ended = true; this.wake?.() }
  async * iterate(signal?: AbortSignal): AsyncIterable<RelayEvent> {
    while (!signal?.aborted) {
      const next = this.queue.shift();
      if (next) { yield next; continue }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = () => { this.wake = null; resolve() };
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  }
}

const broker = {
  unlocked:    true,
  createError: null as Error | null,
  streams:     [] as FakeStream[],
  status:      jest.fn(async() => ({ state: broker.unlocked ? 'unlocked' : 'locked', unlocked: broker.unlocked })),
  createRelay: jest.fn(async(..._args: unknown[]) => {
    if (broker.createError) throw broker.createError;
    broker.streams.push(new FakeStream());
    return { relayId: `relay-${ broker.streams.length }`, expiresAt: Date.now() + 1_800_000 };
  }),
  relayEventStream: jest.fn((relayId: string, signal?: AbortSignal) => {
    return broker.streams[Number(relayId.split('-')[1]) - 1].iterate(signal);
  }),
  relaySend:  jest.fn(async(..._args: unknown[]) => undefined),
  closeRelay: jest.fn(async(..._args: unknown[]) => undefined),
};

const log = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };
const mockAuth = { getCurrentAccessToken: jest.fn(async() => { throw new Error('token read must not happen in vault mode') }) };

mockModules({
  '@pkg/agent/database/models/SullaSettingsModel': {
    SullaSettingsModel: {
      get:                jest.fn(async() => ''),
      set:                jest.fn(async() => undefined),
      getServicePassword: jest.fn(async() => 'synthetic-files-token'),
    },
  },
  '@pkg/agent/services/WebSocketClientService': { getWebSocketClientService: () => ({ connect: jest.fn(), send: jest.fn(), onMessage: jest.fn() }) },
  '@pkg/main/ipcMain':                          { getIpcMainProxy: jest.fn() },
  '@pkg/main/sullaCloudAuth':                   mockAuth,
  '@pkg/main/deviceIdentity':                   { getDesktopDeviceId: jest.fn(async() => 'desktop-1') },
  '@pkg/main/sync/syncMirror':                  {
    claudeMessageExists: jest.fn(async() => false),
    deriveMessageId:     jest.fn(() => 'id'),
    scribeRelayTurn:     jest.fn(async() => undefined),
  },
  '@pkg/agent/services/IntegrationService': {
    getIntegrationService: () => ({
      getAccounts: jest.fn(async() => [{ integration_id: 'sulla-cloud', account_id: ROOM, label: ROOM, active: true, connected: true }]),
    }),
  },
  '@pkg/vault-broker': {
    usesContainerVaultAuthority:       () => true,
    requireConfiguredCredentialBroker: () => broker,
    issueLocalBrokerContext:           jest.fn(async(input: any) => ({
      sub: 'principal', agent_id: input.agentId, pod_id: input.podId, credential_scope: input.credentialScope,
    })),
    VaultBrokerError: FakeVaultBrokerError,
  },
  '@pkg/utils/logging': { default: { background: log } },
});

(globalThis as any).WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

const { DesktopRelayClient } = await import('@pkg/main/desktopRelay');

const warnings = () => log.warn.mock.calls.map(call => String(call[0]));

describe('DesktopRelayClient via the vault relay broker', () => {
  let client: InstanceType<typeof DesktopRelayClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    broker.unlocked = true;
    broker.createError = null;
    broker.streams = [];
    client = new DesktopRelayClient();
  });

  afterEach(async() => {
    await client.setPairedUserId('');
    jest.useRealTimers();
  });

  it('connects through sulla-cloud.relay without ever reading the token, and relays frames both ways', async() => {
    await client.setPairedUserId(ROOM);
    await jest.advanceTimersByTimeAsync(0);

    expect(broker.createRelay).toHaveBeenCalledTimes(1);
    const [ctx, operation, ref, , approvalId, params] = broker.createRelay.mock.calls[0] as any[];
    expect(operation).toBe('sulla-cloud.relay');
    expect(ref).toEqual({ integrationId: 'sulla-cloud', accountId: ROOM });
    expect(params).toEqual({ room: ROOM, deviceId: 'desktop-1' });
    expect(approvalId).toBeUndefined();
    expect(ctx.credential_scope).toEqual({ integration_id: 'sulla-cloud', account_id: ROOM });
    expect(mockAuth.getCurrentAccessToken).not.toHaveBeenCalled();
    expect(client.getStatus().connected).toBe(true);

    // Outbound: the heartbeat ping goes out as a vault relay frame.
    await jest.advanceTimersByTimeAsync(20_000);
    expect(broker.relaySend).toHaveBeenCalledWith('relay-1', { type: 'sulla-cloud.frame', payload: { data: '{"type":"ping"}' } }, expect.anything());

    // Inbound frames keep the watchdog quiet (no forced reconnect).
    broker.streams[0].push('sulla-cloud.frame', { data: '{"type":"pong"}' });
    await jest.advanceTimersByTimeAsync(20_000);
    broker.streams[0].push('sulla-cloud.frame', { data: '{"type":"pong"}' });
    await jest.advanceTimersByTimeAsync(20_000);
    expect(broker.createRelay).toHaveBeenCalledTimes(1);
    expect(client.getStatus().connected).toBe(true);

    // An upstream close ends the session; the client reconnects promptly.
    broker.streams[0].push('relay.closed', { code: 1006 });
    await jest.advanceTimersByTimeAsync(1_100);
    expect(broker.closeRelay).toHaveBeenCalledWith('relay-1');
    expect(broker.createRelay).toHaveBeenCalledTimes(2);
    expect(client.getStatus().connected).toBe(true);
  });

  it('waits on a locked vault with a short fixed poll and connects after unlock', async() => {
    broker.unlocked = false;
    await client.setPairedUserId(ROOM);
    await jest.advanceTimersByTimeAsync(0);

    expect(broker.createRelay).not.toHaveBeenCalled();
    expect(client.getStatus().lastError).toMatch(/Vault is locked/);
    // Two minutes locked: polls every 5s, never escalates, logs once.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(broker.status.mock.calls.length).toBeGreaterThanOrEqual(20);
    expect(broker.createRelay).not.toHaveBeenCalled();
    expect(warnings().filter(line => line.includes('Vault is locked'))).toHaveLength(1);

    broker.unlocked = true;
    await jest.advanceTimersByTimeAsync(5_100);
    expect(broker.createRelay).toHaveBeenCalledTimes(1);
    expect(client.getStatus().connected).toBe(true);
  });

  it('backs off exponentially on a broker denial, capped at 5 minutes, logging one line', async() => {
    broker.createError = new FakeVaultBrokerError('policy_denied', 'Credential policy denied the operation', 403);
    await client.setPairedUserId(ROOM);
    await jest.advanceTimersByTimeAsync(0);
    expect(client.getStatus().lastError).toMatch(/policy denied/);

    // Attempt times: 0, +1s, +2s, +4s ... → about 12 attempts per hour once capped.
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    const attemptsInFirstHour = broker.createRelay.mock.calls.length;
    expect(attemptsInFirstHour).toBeGreaterThan(8);
    expect(attemptsInFirstHour).toBeLessThan(25);
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    const secondHour = broker.createRelay.mock.calls.length - attemptsInFirstHour;
    expect(secondHour).toBeGreaterThanOrEqual(11);
    expect(secondHour).toBeLessThanOrEqual(13);
    expect(warnings().filter(line => line.includes('policy denied'))).toHaveLength(1);
    expect(client.getStatus().connected).toBe(false);
  });

  it('treats a network failure as unavailable, backs off, and recovers with one line per state change', async() => {
    broker.createError = new FakeVaultBrokerError('upstream_failed', 'Sulla Cloud relay is unreachable', 502);
    await client.setPairedUserId(ROOM);
    await jest.advanceTimersByTimeAsync(0);
    expect(client.getStatus().lastError).toMatch(/unavailable/);

    await jest.advanceTimersByTimeAsync(10 * 60_000);
    const failedAttempts = broker.createRelay.mock.calls.length;
    // 1+2+4+...+256s fits ~9 tries in 10 minutes; a 30s fixed loop would be 20.
    expect(failedAttempts).toBeLessThanOrEqual(11);

    broker.createError = null;
    // The next retry is at most one capped backoff (5 min) away.
    for (let waited = 0; waited <= 5 * 60_000 && !client.getStatus().connected; waited += 5_000) {
      await jest.advanceTimersByTimeAsync(5_000);
    }
    expect(client.getStatus().connected).toBe(true);
    expect(warnings().filter(line => line.includes('unavailable'))).toHaveLength(1);
    expect(log.log.mock.calls.map(call => String(call[0])).filter(line => line.includes('Connected'))).toHaveLength(1);
  });

  it('maps an expired Sulla Cloud session to sign-in required', async() => {
    broker.createError = new FakeVaultBrokerError('upstream_failed', 'Sulla Cloud session expired; sign in again', 401);
    await client.setPairedUserId(ROOM);
    await jest.advanceTimersByTimeAsync(0);
    expect(client.getStatus().lastError).toMatch(/sign-in required/);
    expect(mockAuth.getCurrentAccessToken).not.toHaveBeenCalled();
  });
});
