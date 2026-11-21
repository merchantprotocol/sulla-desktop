// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterization specs for the desktop relay client, written against the
// pre-split desktopRelay.ts and kept unchanged across the E4 S3 split. They
// drive the public client surface with a fake WebSocket and fake timers and
// pin reconnect/backoff timing, frame formats, pairing and request dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => {
  class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: FakeSocket[] = [];
    readyState = 0;
    bufferedAmount = 0;
    sent: string[] = [];
    closed = false;
    private readonly listeners = new Map<string, ((event: any) => void)[]>();

    constructor(readonly url: string) { FakeSocket.instances.push(this) }
    addEventListener(type: string, listener: (event: any) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    send(data: string): void { this.sent.push(data) }
    close(): void { this.closed = true; this.readyState = 3 }
    emit(type: string, event: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
    open(): void { this.readyState = 1; this.emit('open') }
    drop(): void { this.readyState = 3; this.emit('close') }
    deliver(frame: Record<string, unknown>): void { this.emit('message', { data: JSON.stringify(frame) }) }
    frames(): Record<string, unknown>[] { return this.sent.map(raw => JSON.parse(raw)) }
  }
  class FakeVaultSocket extends FakeSocket {
    failure: string | null = null;
    failureDetail = '';
    constructor(readonly room: string, readonly deviceId: string) { super(`vault:${ room }`) }
    takePendingOutbound(): string[] { return [] }
  }
  const bridge: { handler: ((message: any) => Promise<void>) | null } = { handler: null };
  return {
    FakeSocket,
    FakeVaultSocket,
    bridge,
    log:            { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    settings:       { get: vi.fn(), set: vi.fn(), getServicePassword: vi.fn(), ready: true },
    token:          vi.fn(),
    deviceId:       vi.fn(),
    usesVault:      vi.fn(),
    scribe:         vi.fn(),
    accept:         vi.fn(),
    admit:          vi.fn(),
    persist:        vi.fn(),
    approve:        vi.fn(),
    historySync:    vi.fn(),
    selection:      vi.fn(),
    filesFetch:     vi.fn(),
    acquire:        vi.fn(),
    release:        vi.fn(),
    agentChannel:   {
      connect:   vi.fn(),
      send:      vi.fn(),
      onMessage: vi.fn((_channel: string, handler: (message: any) => Promise<void>) => { bridge.handler = handler }),
    },
  };
});

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, Notification: { isSupported: () => false } }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: fakes.log } }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: fakes.settings }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({ getWebSocketClientService: () => fakes.agentChannel }));
vi.mock('@pkg/main/ipcMain', () => ({ getIpcMainProxy: () => ({ handle: vi.fn() }) }));
vi.mock('@pkg/main/sullaCloudAuth', () => ({ getCurrentAccessToken: fakes.token, getCurrentUserId: async() => 'account-a' }));
vi.mock('@pkg/main/deviceIdentity', () => ({ getDesktopDeviceId: fakes.deviceId }));
vi.mock('@pkg/main/cloudRelayTransport', () => ({ cloudRelayUsesVault: fakes.usesVault, VaultRelaySocket: fakes.FakeVaultSocket }));
vi.mock('@pkg/main/sync/syncMirror', () => ({
  scribeRelayTurn:    fakes.scribe,
  acceptRelayUserTurn: fakes.accept,
  admitRelayThread: fakes.admit,
  deriveMessageId:    (conversationId: string, role: string, content: string) => `id:${ conversationId }:${ role }:${ content }`,
}));
vi.mock('@pkg/main/chatSelection', () => ({ validateChatSelection: fakes.selection }));
vi.mock('@pkg/main/sullaFilesTls', () => ({ desktopFilesFetch: fakes.filesFetch, FILES_HTTPS_ORIGIN: 'https://127.0.0.1:30124' }));
vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireRelayLiveness: fakes.acquire, releaseRelayLiveness: fakes.release }));
vi.mock('@pkg/agent/utils/sullaPaths', () => ({ resolveSullaHomeDir: () => '/tmp/sulla-relay-spec' }));
vi.mock('@pkg/main/mobileCompanion', () => ({ mobileCompanionRequest: vi.fn(), registerMobileCard: vi.fn() }));

vi.mock('../../../../main/cloud/cloudSettings', () => ({ getCloudPreferences: async() => ({ remoteAccess: true, enabled: true, conversations: fakes.historySync() }) }));
vi.mock('../../../../main/cloud/deviceKey', () => ({ signDeviceMessageExact: async() => 'fixture-proof' }));
vi.mock('../../../../main/cloud/approvedClients', () => ({
  ApprovedClients: {
    get: (id: string) => fakes.approve(id) ? { publicKey: 'fixture-viewer-key' } : undefined,
    list: () => [['viewer-a', 'fixture-viewer-key']].map(([clientId, publicKey]) => ({ clientId, publicKey })),
  },
}));
vi.mock('@pkg/main/mobileRelayContent', async importOriginal => ({
  ...await importOriginal<typeof import('@pkg/main/mobileRelayContent')>(),
  persistMobileAttachments: fakes.persist,
}));

import { DesktopRelayClient } from '@pkg/main/desktopRelay';

const { FakeSocket } = fakes;

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

async function pairedClient(room = 'room-1'): Promise<DesktopRelayClient> {
  const client = new DesktopRelayClient();
  await client.setPairedUserId(room);
  await flush();
  return client;
}

describe('DesktopRelayClient characterization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.instances = [];
    fakes.bridge.handler = null;
    fakes.settings.get.mockResolvedValue('');
    fakes.settings.set.mockResolvedValue(undefined);
    fakes.settings.ready = true;
    fakes.token.mockResolvedValue('test-token');
    fakes.deviceId.mockResolvedValue('desk-1');
    fakes.usesVault.mockReturnValue(false);
    fakes.scribe.mockResolvedValue(undefined);
    fakes.accept.mockResolvedValue('accepted');
    fakes.admit.mockResolvedValue(true);
    fakes.persist.mockResolvedValue([]);
    fakes.approve.mockReturnValue(true);
    fakes.historySync.mockReturnValue(false);
    fakes.selection.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('pairing', () => {
    it('persists the trimmed pairing and opens a desktop socket for that room', async() => {
      // risk: data accuracy — pairing must persist exactly what the relay room uses.
      await pairedClient('  room 1 ');

      expect(fakes.settings.set).toHaveBeenCalledWith('pairedMobileUserId', 'room 1', 'string');
      expect(FakeSocket.instances).toHaveLength(1);
      expect(FakeSocket.instances[0].url).toBe('wss://sulla-workers.merchantprotocol.workers.dev/relay/room%201?role=desktop&deviceId=desk-1&token=test-token');
    });

    it('reports status changes and unpairs by closing the socket', async() => {
      // risk: sign-out — clearing the pairing must drop the live relay peer.
      const client = await pairedClient();
      const statuses: unknown[] = [];
      client.onStatusChange(status => statuses.push(status));

      FakeSocket.instances[0].open();
      await client.setPairedUserId('');

      expect(statuses).toEqual([
        { pairedUserId: 'room-1', connected: true, lastError: undefined },
        { pairedUserId: '', connected: false, lastError: undefined },
        { pairedUserId: '', connected: false, lastError: undefined },
      ]);
      expect(FakeSocket.instances[0].closed).toBe(true);
      await advance(10 * 60_000);
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it('refuses to conclude "not paired" before the settings database is ready', async() => {
      // risk: data loss — a boot-time fallback read must be retried, not treated as unpaired.
      fakes.settings.ready = false;
      await expect(new DesktopRelayClient().start()).rejects.toThrow('Settings database not ready yet');
    });
  });

  describe('reconnect and backoff', () => {
    it('backs off exponentially and resets after a successful open', async() => {
      // risk: availability — the relay must keep retrying and recover promptly after success.
      await pairedClient();
      FakeSocket.instances[0].drop();
      await advance(999);
      expect(FakeSocket.instances).toHaveLength(1);
      await advance(1);
      expect(FakeSocket.instances).toHaveLength(2);

      FakeSocket.instances[1].drop();
      await advance(1_999);
      expect(FakeSocket.instances).toHaveLength(2);
      await advance(1);
      expect(FakeSocket.instances).toHaveLength(3);

      FakeSocket.instances[2].open();
      FakeSocket.instances[2].drop();
      await advance(1_000);
      expect(FakeSocket.instances).toHaveLength(4);
    });

    it('tears down a socket that never opens after 15s and retries', async() => {
      // risk: availability — a wedged handshake must not pin the client in "connecting".
      await pairedClient();
      await advance(14_999);
      expect(FakeSocket.instances[0].closed).toBe(false);
      await advance(1);
      expect(FakeSocket.instances[0].closed).toBe(true);
      await advance(1_000);
      expect(FakeSocket.instances).toHaveLength(2);
    });

    it('waits for sign-in without opening a socket and retries on the backoff', async() => {
      // risk: sign-in — no token means no socket, a clear status, and a later retry.
      fakes.token.mockResolvedValueOnce(null);
      const client = await pairedClient();

      expect(FakeSocket.instances).toHaveLength(0);
      expect(client.getStatus()).toEqual({ pairedUserId: 'room-1', connected: false, lastError: 'Not signed in — relay cannot authenticate' });
      await advance(1_000);
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it('polls a locked vault every 5s without growing the delay', async() => {
      // risk: availability — unlocking the vault must reconnect within one short poll.
      fakes.usesVault.mockReturnValue(true);
      await pairedClient();
      const first = FakeSocket.instances[0] as InstanceType<typeof fakes.FakeVaultSocket>;
      expect(first).toBeInstanceOf(fakes.FakeVaultSocket);
      expect([first.room, first.deviceId]).toEqual(['room-1', 'desk-1']);

      first.failure = 'vault_locked';
      first.drop();
      await advance(4_999);
      expect(FakeSocket.instances).toHaveLength(1);
      await advance(1);
      expect(FakeSocket.instances).toHaveLength(2);

      (FakeSocket.instances[1] as InstanceType<typeof fakes.FakeVaultSocket>).failure = 'vault_locked';
      FakeSocket.instances[1].drop();
      await advance(5_000);
      expect(FakeSocket.instances).toHaveLength(3);
    });

    it('sends a heartbeat ping every 20s once open', async() => {
      // risk: availability — NAT idle timeouts kill a silent socket.
      await pairedClient();
      FakeSocket.instances[0].open();
      await advance(20_000);
      expect(FakeSocket.instances[0].sent).toContain('{"type":"ping"}');
      expect(fakes.acquire).toHaveBeenCalledWith('desktop-relay');
    });

    it('closes on suspend, stays closed while asleep, and reconnects after resume', async() => {
      // risk: availability — no reconnect storms while asleep, fast recovery on wake.
      const client = await pairedClient();
      FakeSocket.instances[0].open();
      client.handleSuspend();
      expect(FakeSocket.instances[0].closed).toBe(true);
      expect(client.getStatus().connected).toBe(false);
      await advance(10 * 60_000);
      expect(FakeSocket.instances).toHaveLength(1);

      client.handleResume();
      await advance(1_000);
      expect(FakeSocket.instances).toHaveLength(2);
    });
  });

  describe('frames', () => {
    it('queues a completion frame while the socket is down and flushes it on reconnect', async() => {
      // risk: data loss — a stop/done frame must reach mobile even across a reconnect.
      await pairedClient();
      const first = FakeSocket.instances[0];
      first.open();
      first.deliver({ type: 'chat', conversationId: 'c1', userMessageId: 'r1', messages: [{ role: 'user', content: 'hi' }] });
      await flush();
      first.readyState = 3;
      first.deliver({ type: 'cancel', conversationId: 'c1', clientRunId: 'stale' });
      first.deliver({ type: 'cancel', conversationId: 'c1', clientRunId: 'r1' });
      await flush();

      const stops = fakes.agentChannel.send.mock.calls.filter(([, frame]) => frame.type === 'stop_run');
      expect(stops).toEqual([['mobile-relay', { type: 'stop_run', data: { threadId: 'c1', relayRunId: 'r1' }, timestamp: expect.any(Number) }]]);
      await fakes.bridge.handler!({ type: 'relay_dispatch_complete', data: { thread_id: 'c1', relayRunId: 'r1', outcome: 'stopped' } });
      first.drop();
      await advance(1_000);
      const second = FakeSocket.instances[1];
      second.open();
      expect(second.frames()).toContainEqual(expect.objectContaining({ type: 'stopped', clientRunId: 'r1', conversationId: 'c1' }));
    });

    it('answers a chat without conversationId with an unstamped error frame', async() => {
      // risk: data accuracy — malformed frames are rejected, never run.
      await pairedClient();
      const socket = FakeSocket.instances[0];
      socket.open();
      socket.deliver({ type: 'chat', userMessageId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
      await flush();

      expect(socket.sent).toEqual(['{"type":"error","reason":"missing_conversation_id","userMessageId":"u1"}']);
      expect(fakes.agentChannel.send).not.toHaveBeenCalled();
    });

    it('acks a duplicate chat without dispatching it again', async() => {
      // risk: irreversible side effects — a retried turn must not run the agent twice.
      fakes.accept.mockResolvedValue('duplicate');
      await pairedClient();
      const socket = FakeSocket.instances[0];
      socket.open();
      socket.deliver({ type: 'chat', conversationId: 'c1', userMessageId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
      await flush();

      expect(socket.frames()).toEqual([{ type: 'ack', userMessageId: 'u1', duplicate: true, clientRunId: 'u1', conversationId: 'c1', deviceId: 'desk-1' }]);
      expect(fakes.agentChannel.send).not.toHaveBeenCalled();
      expect(fakes.scribe).not.toHaveBeenCalled();
    });
  });

  describe('request dispatch', () => {
    it('does not ACK or dispatch until acceptance commits, then dispatches only the winner', async() => {
      // risk: irreversible side effects — concurrent delivery must not start two turns.
      let commit!: (value: 'accepted' | 'duplicate') => void;
      let retry!: (value: 'accepted' | 'duplicate') => void;
      fakes.accept
        .mockImplementationOnce(() => new Promise(resolve => { commit = resolve }))
        .mockImplementationOnce(() => new Promise(resolve => { retry = resolve }));
      await pairedClient();
      const socket = FakeSocket.instances[0];
      socket.open();
      const frame = { type: 'chat', conversationId: 'thread_1', userMessageId: 'u1', clientRunId: 'run1', messages: [{ role: 'user', content: 'hello' }] };
      socket.deliver(frame);
      socket.deliver(frame);
      await flush();
      expect(socket.frames()).toEqual([]);
      expect(fakes.agentChannel.send).not.toHaveBeenCalled();
      commit('accepted');
      await flush();
      retry('duplicate');
      await flush();
      expect(fakes.agentChannel.send).toHaveBeenCalledTimes(1);
      expect(socket.frames()).toEqual([
        expect.objectContaining({ type: 'ack', userMessageId: 'u1', clientRunId: 'u1' }),
        expect.objectContaining({ type: 'ack', userMessageId: 'u1', clientRunId: 'u1', duplicate: true }),
      ]);
    });

    it('fails without ACK or dispatch if durable acceptance throws or rejects the identity', async() => {
      // risk: data loss and cross-thread replay — neither outcome may clear the outbox or run.
      fakes.accept.mockRejectedValueOnce(new Error('commit outcome unknown')).mockResolvedValueOnce('conflict');
      await pairedClient();
      const socket = FakeSocket.instances[0];
      socket.open();
      const frame = { type: 'chat', conversationId: 'c1', userMessageId: 'u1', messages: [{ role: 'user', content: 'hello' }] };
      socket.deliver(frame);
      await flush();
      socket.deliver(frame);
      await flush();
      expect(fakes.agentChannel.send).not.toHaveBeenCalled();
      expect(socket.frames()).toEqual([
        expect.objectContaining({ type: 'error', reason: 'acceptance_unavailable', userMessageId: 'u1' }),
        expect.objectContaining({ type: 'error', reason: 'message_identity_conflict', userMessageId: 'u1' }),
      ]);
    });

    it('scribes, acks and dispatches a mobile chat, then relays streaming and done', async() => {
      // risk: data loss — the user turn is scribed before the ack, and the final reply is scribed and delivered once.
      await pairedClient();
      const socket = FakeSocket.instances[0];
      socket.open();
      socket.deliver({ type: 'chat', conversationId: 'c1', userMessageId: 'u1', messages: [{ role: 'user', content: ' hello ' }] });
      await flush();

      expect(fakes.accept).toHaveBeenCalledWith({ conversationId: 'c1', role: 'user', content: 'hello', ts: expect.any(String), id: 'u1' });
      expect(socket.sent[0]).toBe('{"type":"ack","userMessageId":"u1","clientRunId":"u1","conversationId":"c1","deviceId":"desk-1"}');
      expect(fakes.agentChannel.connect).toHaveBeenCalledWith('mobile-relay');
      expect(fakes.agentChannel.send).toHaveBeenCalledWith('mobile-relay', {
        type:      'user_message',
        data:      { content: 'hello', threadId: 'c1', relayRunId: 'u1', metadata: { source: 'mobile-relay', inputSource: 'keyboard', conversationId: 'c1' } },
        timestamp: expect.any(Number),
      });

      await advance(15_000);
      expect(socket.frames()).toContainEqual({ type: 'keepalive', clientRunId: 'u1', userMessageId: 'u1', conversationId: 'c1', deviceId: 'desk-1' });

      await fakes.bridge.handler!({ type: 'assistant_message', data: { kind: 'streaming', thread_id: 'c1', content: 'Hi there' } });
      await fakes.bridge.handler!({ type: 'transfer_data', data: { content: 'graph_execution_complete', thread_id: 'c1' } });

      await fakes.bridge.handler!({ type: 'relay_dispatch_complete', data: { thread_id: 'c1', relayRunId: 'u1', outcome: 'accepted' } });
      const frames = socket.frames();
      expect(frames).toContainEqual({ type: 'chunk', delta: 'Hi there', clientRunId: 'u1', userMessageId: 'u1', conversationId: 'c1', deviceId: 'desk-1' });
      expect(frames[frames.length - 1]).toMatchObject({ type: 'done', outcome: 'completed', content: 'Hi there', id: 'id:c1:assistant:Hi there', clientRunId: 'u1', userMessageId: 'u1', conversationId: 'c1', deviceId: 'desk-1' });
      expect(fakes.scribe).toHaveBeenCalledWith({ conversationId: 'c1', role: 'assistant', content: 'Hi there', ts: expect.any(String), id: 'id:c1:assistant:Hi there' });

      const sentBefore = socket.sent.length;
      await advance(30_000);
      expect(socket.frames().slice(sentBefore).filter(frame => frame.type === 'keepalive')).toEqual([]);
    });

    it('ignores a chat addressed to a different desktop', async() => {
      // risk: tenant/device isolation — another desktop's turn must never run here.
      await pairedClient();
      const socket = FakeSocket.instances[0];
      socket.open();
      socket.deliver({ type: 'chat', targetDeviceId: 'desk-2', conversationId: 'c1', userMessageId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
      await flush();

      expect(socket.sent).toEqual([]);
      expect(fakes.scribe).not.toHaveBeenCalled();
    });

    it('routes secure-channel replies to the caller instead of the relay socket', async() => {
      // risk: privacy — a dashboard conversation must not leak to the legacy mobile room.
      const client = await pairedClient();
      const socket = FakeSocket.instances[0];
      socket.open();
      const reply = vi.fn();
      const respond = vi.fn();

      await client.handleRemoteCommand({ type: 'chat', conversationId: 'c2', userMessageId: 'u2', messages: [{ role: 'user', content: 'hey' }] }, reply, respond);

      expect(respond).toHaveBeenCalledWith({ type: 'ack', userMessageId: 'u2', clientRunId: 'u2', conversationId: 'c2', deviceId: 'desk-1' });
      expect(reply).not.toHaveBeenCalled();
      expect(socket.sent).toEqual([]);

      await client.handleRemoteCommand({ type: 'chat', userMessageId: 'u3' }, reply, respond);
      expect(respond).toHaveBeenCalledWith({ type: 'error', reason: 'missing_conversation_id', userMessageId: 'u3' });
    });

    it('answers scoped denial without dispatch and grants history only with current pairing and consent', async() => {
      // risk: silently dropped cancellations and history disclosure outside current consent.
      vi.stubEnv('SULLA_SHARED_LIVE_RELAY', 'on');
      await pairedClient();
      const socket = FakeSocket.instances[0];
      socket.open();
      socket.deliver({ type: 'relay_device_challenge', nonce: '12345678-1234-1234-1234-123456789abc' });
      await flush();
      socket.deliver({ type: 'relay_device_ready' });
      const frame = { conversationId: 'remote_fixture_1234', targetDeviceId: 'desk-1',
        relayScope: 'v1', accountId: 'account-a', workspaceId: 'workspace-a',
        viewerId: 'viewer-a', viewerKey: 'fixture-viewer-key', relayRequest: 'request-a' };
      fakes.admit.mockResolvedValueOnce(false);
      socket.deliver({ ...frame, type: 'cancel' });
      await flush();
      expect(socket.frames().at(-1)).toMatchObject({ type: 'error', reason: 'thread_not_authorized', relayRequest: 'request-a' });
      expect(fakes.agentChannel.send).not.toHaveBeenCalled();
      socket.deliver({ ...frame, type: 'relay_history_check', relayRequest: 'request-b' });
      await flush();
      expect(socket.frames().at(-1)).toMatchObject({ type: 'error', relayRequest: 'request-b' });
      fakes.historySync.mockReturnValue(true);
      socket.deliver({ ...frame, type: 'relay_history_check', relayRequest: 'request-c' });
      await flush();
      expect(socket.frames().at(-1)).toMatchObject({ type: 'relay_history_allowed', relayRequest: 'request-c' });
      fakes.approve.mockReturnValue(false);
      socket.deliver({ ...frame, type: 'relay_history_check', relayRequest: 'request-d' });
      await flush();
      expect(socket.frames().at(-1)).toMatchObject({ type: 'error', relayRequest: 'request-d' });
    });

    it('never stages attachments for denied or duplicate claims, and keeps a retry canonical', async() => {
      // risk: filesystem mutations and duplicate execution.
      vi.stubEnv('SULLA_SHARED_LIVE_RELAY', 'on');
      fakes.accept.mockResolvedValueOnce('duplicate').mockResolvedValueOnce('accepted');
      await pairedClient();
      const socket = FakeSocket.instances[0];
      socket.open();
      const frame = { type: 'chat', conversationId: 'remote_fixture_1234', targetDeviceId: 'desk-1',
        relayScope: 'v1', accountId: 'account-a', workspaceId: 'workspace-a', viewerId: 'viewer-a', viewerKey: 'fixture-viewer-key', relayRequest: 'request-a',
        userMessageId: 'msg-unique', clientRunId: 'unstable-retry', messages: [{ role: 'user', content: [
          { type: 'text', text: 'Review' },
          { type: 'document', source: { type: 'base64', media_type: 'text/plain', data: 'eA==' }, title: 'fixture.txt' },
        ] }] };
      socket.deliver(frame);
      await flush();
      expect(fakes.accept).not.toHaveBeenCalled();
      socket.deliver({ type: 'relay_device_challenge', nonce: '12345678-1234-1234-1234-123456789abc' });
      await flush();
      socket.deliver({ type: 'relay_device_ready' });
      socket.deliver({ ...frame, accountId: 'different-account' });
      socket.deliver({ ...frame, targetDeviceId: 'different-host' });
      await flush();
      expect(fakes.accept).not.toHaveBeenCalled();
      fakes.admit.mockResolvedValueOnce(false);
      socket.deliver(frame);
      await flush();
      expect(fakes.accept).not.toHaveBeenCalled();
      socket.deliver({ ...frame, relayRequest: 'request-b' });
      await flush();
      expect(socket.frames()).toContainEqual(expect.objectContaining({
        type: 'ack', relayRequest: 'request-b', clientRunId: 'msg-unique', duplicate: true,
      }));
      expect(fakes.persist).not.toHaveBeenCalled();
      expect(fakes.accept).toHaveBeenCalledWith(expect.objectContaining({
        scope: { accountId: 'account-a', workspaceId: 'workspace-a', hostDeviceId: 'desk-1' },
      }));
      socket.deliver({ ...frame, relayRequest: 'request-c' });
      await flush();
      expect(fakes.persist).toHaveBeenCalledOnce();
      expect(fakes.agentChannel.send).toHaveBeenCalledOnce();
    });

    it('streams a shared file as start, base64 chunk and end frames', async() => {
      // risk: data accuracy — shared file bytes must arrive intact and in order.
      fakes.settings.getServicePassword.mockResolvedValue('files-token');
      fakes.filesFetch.mockResolvedValue(new Response('abc', { status: 200, headers: { 'content-type': 'text/plain', 'x-sulla-filename': 'a.txt', 'content-length': '3' } }));
      await pairedClient();
      const socket = FakeSocket.instances[0];
      socket.open();
      socket.deliver({ type: 'share_fetch', requestId: 'q1', linkId: 'link 1', targetDeviceId: 'desk-1' });
      await advance(0);
      await flush();

      const [url, init] = fakes.filesFetch.mock.calls[0];
      expect(String(url)).toBe('https://127.0.0.1:30124/v1/local/shares/link%201/content');
      expect(init.headers.get('X-Sulla-Files-Token')).toBe('files-token');
      expect(socket.frames()).toEqual([
        { type: 'share_fetch_start', requestId: 'q1', status: 200, mime: 'text/plain', name: 'a.txt', contentLength: 3, acceptRanges: 'bytes' },
        { type: 'share_fetch_chunk', requestId: 'q1', data: 'YWJj' },
        { type: 'share_fetch_end', requestId: 'q1' },
      ]);
    });
  });
});
