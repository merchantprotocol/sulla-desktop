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
    deriveMessageId:     jest.fn(() => 'msg-id'),
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
