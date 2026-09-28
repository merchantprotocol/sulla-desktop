/** @jest-environment node */

/**
 * DesktopRelayClient durability tests.
 *
 * Covers the sleep/net-loss recovery paths behind the "desktop relay never
 * comes back until logout/login" bug:
 *   1. The reconnect loop must survive openSocket() throwing (e.g. the VM's
 *      Postgres still waking when the auth token is read after resume).
 *   2. powerMonitor suspend closes the socket and gates reconnects;
 *      resume reconnects immediately with fresh backoff.
 */

import { jest } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

const mockSullaSettingsModel = {
  SullaSettingsModel: {
    get: jest.fn<() => Promise<any>>().mockResolvedValue(''),
    set: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  },
};

const mockAuth = {
  getCurrentAccessToken: jest.fn<() => Promise<string>>().mockResolvedValue('test-token'),
};

const mockWsService = {
  connect:   jest.fn(),
  send:      jest.fn(),
  onMessage: jest.fn(),
};

mockModules({
  '@pkg/agent/database/models/SullaSettingsModel': mockSullaSettingsModel,
  '@pkg/agent/services/WebSocketClientService':    { getWebSocketClientService: () => mockWsService },
  '@pkg/main/ipcMain':                             { getIpcMainProxy: jest.fn() },
  '@pkg/main/sullaCloudAuth':                      mockAuth,
  '@pkg/main/deviceIdentity':                      { getDesktopDeviceId: jest.fn<() => Promise<string>>().mockResolvedValue('desktop-1') },
  '@pkg/main/sync/syncMirror':                     {
    claudeMessageExists: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    deriveMessageId:     jest.fn((_t: string, role: string, content: string) => `${ role }:${ content }`),
    scribeRelayTurn:     jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  },
  '@pkg/utils/logging': undefined,
});

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Array<(ev: any) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: any) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }

  emit(type: string, ev: any = {}) {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open');
  }

  send(_data: string) {}

  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close');
  }
}

(globalThis as any).WebSocket = MockWebSocket;

const { DesktopRelayClient } = await import('@pkg/main/desktopRelay');

describe('DesktopRelayClient durability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    MockWebSocket.instances = [];
    mockAuth.getCurrentAccessToken.mockResolvedValue('test-token');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps retrying when openSocket throws mid-backoff (loop must not die)', async() => {
    // Every token read throws, as when the VM's Postgres is still waking
    // after system resume.
    mockAuth.getCurrentAccessToken.mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new DesktopRelayClient();
    await client.setPairedUserId('user-1');
    await jest.advanceTimersByTimeAsync(0);

    const callsAfterConnect = mockAuth.getCurrentAccessToken.mock.calls.length;
    expect(callsAfterConnect).toBeGreaterThanOrEqual(1);

    // Walk through several backoff cycles (1s, 2s, 4s, 8s...). Before the
    // fix, the first throw inside the retry timer killed the loop and the
    // call count froze.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockAuth.getCurrentAccessToken.mock.calls.length).toBeGreaterThan(callsAfterConnect + 2);

    // Once the token read recovers, a socket gets opened again.
    mockAuth.getCurrentAccessToken.mockResolvedValue('test-token');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
  });

  it('suspend closes the socket and blocks reconnects; resume reconnects promptly', async() => {
    const client = new DesktopRelayClient();
    await client.setPairedUserId('user-1');
    await jest.advanceTimersByTimeAsync(0);

    expect(MockWebSocket.instances.length).toBe(1);
    const ws = MockWebSocket.instances[0];
    ws.open();

    client.handleSuspend();
    expect(ws.closed).toBe(true);
    expect(client.getStatus().connected).toBe(false);

    // While suspended, no reconnect attempts happen no matter how long we wait.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(MockWebSocket.instances.length).toBe(1);

    // Resume: a fresh socket appears within the base backoff (~1s), not
    // after the stale-socket watchdog window.
    client.handleResume();
    await jest.advanceTimersByTimeAsync(1_500);
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it('does not open a socket when suspend lands during the token read', async() => {
    let releaseToken: (v: string) => void = () => {};

    mockAuth.getCurrentAccessToken.mockReturnValue(new Promise<string>((resolve) => {
      releaseToken = resolve;
    }));

    const client = new DesktopRelayClient();
    const pairing = client.setPairedUserId('user-1');

    client.handleSuspend();
    releaseToken('test-token');
    await pairing;
    await jest.advanceTimersByTimeAsync(0);

    expect(MockWebSocket.instances.length).toBe(0);
  });
});

describe('DesktopRelayClient mobile bridge: multi-segment turns', () => {
  type Frame = Record<string, unknown>;

  function bridge() {
    const client = new DesktopRelayClient() as any;
    const frames: Frame[] = [];

    client.sendChatFrame = (_threadId: string, payload: Frame) => frames.push(payload);
    mockWsService.onMessage.mockClear();
    client.ensureMobileChannelBridge();
    const handler = mockWsService.onMessage.mock.calls[0][1] as (msg: any) => Promise<void>;
    const say = (kind: string, content = '') => handler({ type: 'assistant_message', data: { thread_id: 't1', kind, content } });
    const complete = () => handler({ type: 'transfer_data', data: { thread_id: 't1', content: 'graph_execution_complete' } });

    return { frames, say, complete };
  }

  it('commits every streamed text segment as its own message, in order', async() => {
    const { frames, say, complete } = bridge();

    await say('streaming', 'First');
    await say('streaming', 'First reply.');
    await say('streaming_complete');
    await say('thinking', 'Running Bash');
    await say('streaming', 'Second reply.');
    await say('streaming_complete');
    await say('thinking', 'Running Bash');
    await say('streaming', 'Third reply.');
    await say('streaming_complete');
    await complete();

    const messages = frames.filter(f => f.type === 'message').map(f => f.content);
    expect(messages).toEqual(['First reply.', 'Second reply.', 'Third reply.']);
    const done = frames.find(f => f.type === 'done');
    // done reuses the last committed id so mobile upserts instead of duplicating
    expect(done).toMatchObject({ content: 'Third reply.', id: 'assistant:Third reply.' });
  });

  it('commits a trailing segment that never got its boundary', async() => {
    const { frames, say, complete } = bridge();

    await say('streaming', 'One.');
    await say('streaming_complete');
    await say('streaming', 'Two.');
    await complete();

    expect(frames.filter(f => f.type === 'message').map(f => f.content)).toEqual(['One.', 'Two.']);
    expect(frames.find(f => f.type === 'done')).toMatchObject({ content: 'Two.', id: 'assistant:Two.' });
  });

  it('does not double-send a progress message already committed at its boundary', async() => {
    const { frames, say, complete } = bridge();

    await say('streaming', 'Only reply.');
    await say('streaming_complete');
    await say('progress', 'Only reply.');
    await complete();

    expect(frames.filter(f => f.type === 'message').map(f => f.content)).toEqual(['Only reply.']);
  });

  it('keeps the streaming-only single-segment path on done', async() => {
    const { frames, say, complete } = bridge();

    await say('streaming', 'Just this.');
    await complete();

    expect(frames.filter(f => f.type === 'message')).toEqual([]);
    expect(frames.find(f => f.type === 'done')).toMatchObject({ content: 'Just this.', id: 'assistant:Just this.' });
  });
});
