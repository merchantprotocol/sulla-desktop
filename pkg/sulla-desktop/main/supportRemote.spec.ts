import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { remote: { status: 'idle', activity: [] as unknown[] } } as any,
  cloudRequest: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getPath: () => '/user-data', getVersion: () => '1.0.0' }, ipcMain: {}, powerSaveBlocker: { start: () => 1, isStarted: () => true, stop: vi.fn() } }));
vi.mock('ws', () => ({ default: class WebSocket {} }));
vi.mock('@pkg/main/support/supportCloud', () => ({ supportCloudRequest: mocks.cloudRequest }));
vi.mock('@pkg/main/support/supportIdentity', () => ({ supportDeviceIdentity: { getOrCreate: () => 'device-1' } }));
vi.mock('@pkg/main/supportState', () => ({ SupportStateStore: class {
  read() { return mocks.state }
  update(mutator: (state: any) => void) { mutator(mocks.state); return mocks.state }
} }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pkg/utils/paths', () => ({ default: { logs: '/logs' } }));
vi.mock('@pkg/window', () => ({ send: vi.fn(), getWindow: () => undefined }));
vi.mock('@pkg/window/agentWindows', () => ({}));
vi.mock('@pkg/main/update/UpdateManager', () => ({ supportUpdateApi: { status: () => ({ channel: 'stable' }) } }));

import { RemoteSupportService } from './supportRemote';

const expiry = '2026-11-22T00:00:00.000Z';
function cloudResult(body: unknown) {
  mocks.cloudRequest.mockResolvedValue({ ok: true, json: async () => body });
}
function session(status: string, extras: Record<string, unknown> = {}) {
  return { session: { id: 'session-1', status, createdAt: '2026-11-19T00:00:00.000Z', ...extras } };
}

beforeEach(() => {
  mocks.state = { remote: { status: 'idle', activity: [] } };
  mocks.cloudRequest.mockReset();
});

describe('RemoteSupportService.request', () => {
  // risk: permissions — only an active Cloud grant may become connected, and its token/expiry must be persisted.
  it('persists an active grant and returns connected', async () => {
    cloudResult({ ...session('active'), grant: { expiresAt: expiry } });
    const service = new RemoteSupportService();
    const ensureHost = vi.spyOn(service as any, 'ensureHost').mockResolvedValue(undefined);

    const result = await service.request('Please help');

    expect(result.remote.status).toBe('connected');
    expect(result.remote.grant).toMatchObject({ sessionId: 'session-1', deviceId: 'device-1', expiresAt: expiry });
    expect(result.remote.grant?.token).toEqual(expect.any(String));
    expect(mocks.state.remote).toEqual(result.remote);
    expect(ensureHost).toHaveBeenCalledOnce();
  });

  // risk: permissions — legacy Cloud's requested/no-expiry response must preserve the tokenless waiting/approve path.
  it('stores a legacy requested session as waiting without throwing', async () => {
    cloudResult(session('requested'));
    const service = new RemoteSupportService();
    const ensureHost = vi.spyOn(service as any, 'ensureHost');

    const result = await service.request('Please help');

    expect(result.remote).toMatchObject({ status: 'waiting', sessionId: 'session-1', message: 'Please help' });
    expect(result.remote.grant).toBeUndefined();
    expect(ensureHost).not.toHaveBeenCalled();
  });

  // risk: permissions — host-channel failure after grant persistence must not discard or reject an already-authorized request.
  it('resolves with the saved grant when ensureHost throws', async () => {
    cloudResult({ ...session('active'), grant: { expiresAt: expiry } });
    const service = new RemoteSupportService();
    vi.spyOn(service as any, 'ensureHost').mockRejectedValue(new Error('channel unavailable'));

    const result = await service.request('Please help');

    expect(result.remote.status).toBe('connected');
    expect(result.remote.grant).toMatchObject({ sessionId: 'session-1', deviceId: 'device-1', expiresAt: expiry });
    expect(mocks.state.remote.grant).toEqual(result.remote.grant);
  });
});
