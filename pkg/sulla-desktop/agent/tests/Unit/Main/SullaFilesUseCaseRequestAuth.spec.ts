// SPDX-License-Identifier: GPL-2.0-or-later
// The use-case index runs inside the trusted main process. Its desktop-only /v1/local/system-areas
// calls need the local service credential; its ordinary Files reads and publishes need the Files
// identity. The real SullaFilesWatcher unlocks and wires the index; only the HTTPS boundary (with
// the Files service's request-auth rule), the vault lock state and the stored secret are faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LOCAL_TOKEN = 'fake-local-service-token';
const ORIGIN = 'https://127.0.0.1:30124';

const f = vi.hoisted(() => ({
  unlocked: true,
  calls: [] as { url: string; method: string; token: string | null; bearer: boolean; contentType: string | null; sourceHash: string | null }[],
  localStatus: new Map<string, number>(),
  indexRequest: undefined as undefined | ((endpoint: string, init?: RequestInit) => Promise<Response>),
  indexStarted: 0,
}));

vi.mock('electron', () => ({ app: { once: vi.fn(), on: vi.fn(), getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, Notification: { isSupported: () => false } }));
vi.mock('@pkg/main/sullaFilesTls', () => ({
  FILES_HTTPS_ORIGIN: 'https://127.0.0.1:30124',
  /** The Files request pipeline: /healthz open, /v1/local/* local token only, everything else a Files Bearer identity. */
  desktopFilesFetch: vi.fn(async(input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const token = headers.get('x-sulla-files-token');
    const bearer = /^Bearer \S+/.test(headers.get('authorization') ?? '');
    f.calls.push({ url: url.href, method: init.method ?? 'GET', token, bearer, contentType: headers.get('content-type'), sourceHash: headers.get('x-sulla-source-hash') });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/healthz') return json(200, { locked: false, legacyImport: { state: 'clear' } });
    if (url.pathname.startsWith('/v1/local/')) {
      if (token !== LOCAL_TOKEN) return json(401, { error: 'unauthorized local request' });
      const forced = f.localStatus.get(url.pathname);
      if (forced) return json(forced, { error: 'forced' });
      if (url.pathname === '/v1/local/identity') return json(200, { principalId: 'principal-1' });
      if (url.pathname === '/v1/local/system-areas') return json(200, [{ id: 'home', systemArea: null }]);
      if (url.pathname === '/v1/local/system-areas/ingest') return json(201, { id: 'file-1', current_version_id: 'version-1' });
      return json(200, {});
    }
    if (!bearer) return json(401, { error: 'unauthorized' });
    if (url.pathname === '/v1/files') return json(200, []);
    return json(200, {});
  }),
}));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { getServicePassword: vi.fn(async() => 'fake-local-service-token') } }));
vi.mock('@pkg/main/deviceIdentity', () => ({ getDesktopDeviceId: async() => 'device-test' }));
vi.mock('@pkg/agent/services/VaultKeyService', () => ({ getVaultKeyService: () => ({ isUnlocked: () => f.unlocked }) }));
// The index itself is covered elsewhere; here it only records the request client the watcher hands it.
vi.mock('@pkg/main/sullaUseCaseFiles', () => ({ SullaUseCaseFiles: class {
  constructor(request: (endpoint: string, init?: RequestInit) => Promise<Response>) { f.indexRequest = request }
  start() { f.indexStarted++ }
  stop() {}
} }));
vi.mock('@pkg/agent/useCases/UseCaseSuggestionCompositionRoot', () => ({ UseCaseSuggestionCompositionRoot: class { notifier = { announce: vi.fn() }; start() {} stop() {} } }));
vi.mock('@pkg/agent/builtinSkills', () => ({ getBuiltinSkillSpecs: () => [] }));
vi.mock('@pkg/agent/database/RedisClient', () => ({ redisClient: {} }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient: { query: vi.fn(async() => []), queryOne: vi.fn(async() => null) } }));
vi.mock('@pkg/agent/useCases/UseCaseChangeBus', () => ({ RedisUseCaseChangeTransport: class {} }));
vi.mock('@pkg/main/sullaFilesRootRegistry', () => ({ getSullaFilesRootRegistry: () => ({ stored: async() => [], startBookmarks: vi.fn(), stopBookmarks: vi.fn() }) }));
vi.mock('@pkg/utils/sullaFilesPaths', () => ({ resolveSullaFilesUserRoot: () => ({ activePath: '/tmp/sulla-files-test' }) }));

import { SullaFilesWatcher } from '@pkg/main/sullaFilesWatcher';
import { VaultFilesStartup } from '@pkg/main/VaultFilesStartup';

const watcher = () => new SullaFilesWatcher(new VaultFilesStartup(), () => ({}) as any);
async function unlockedIndex() {
  await watcher().unlockService();
  expect(f.indexStarted).toBe(1);
  return f.indexRequest!;
}
const callsTo = (pathname: string) => f.calls.filter(call => new URL(call.url).pathname === pathname);

let remoteFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  f.unlocked = true; f.calls = []; f.localStatus.clear(); f.indexRequest = undefined; f.indexStarted = 0;
  remoteFetch = vi.fn(async() => new Response('{}'));
  vi.stubGlobal('fetch', remoteFetch);
});
afterEach(() => { vi.unstubAllGlobals() });

describe('use-case index requests from the trusted main process', () => {
  it('reads the Files system areas with the local service credential, not a Files identity', async() => {
    const request = await unlockedIndex();
    const response = await request('/v1/local/system-areas');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 'home', systemArea: null }]);
    const [call] = callsTo('/v1/local/system-areas');
    expect(call).toMatchObject({ url: `${ ORIGIN }/v1/local/system-areas`, token: LOCAL_TOKEN, bearer: false });
  });

  it('sends ingest, move and audit to their local routes with the credential and the original body headers', async() => {
    const request = await unlockedIndex();
    const ingest = await request('/v1/local/system-areas/ingest?collectionId=home&path=Use+Cases%2Fagents%2Fa%2Fagent.yaml', {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-sulla-source-hash': 'a'.repeat(64) }, body: new ArrayBuffer(1),
    });
    expect(ingest.status).toBe(201);
    expect((await request('/v1/local/system-areas/move', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await request('/v1/local/system-areas/audit', { method: 'POST', body: '{}' })).status).toBe(200);
    expect(callsTo('/v1/local/system-areas/ingest')).toEqual([expect.objectContaining({ method: 'PUT', token: LOCAL_TOKEN, bearer: false, contentType: 'application/octet-stream', sourceHash: 'a'.repeat(64) })]);
    expect(callsTo('/v1/local/system-areas/ingest')[0].url).toContain('collectionId=home');
    expect(callsTo('/v1/local/system-areas/move')).toEqual([expect.objectContaining({ method: 'POST', token: LOCAL_TOKEN, bearer: false })]);
    expect(callsTo('/v1/local/system-areas/audit')).toEqual([expect.objectContaining({ method: 'POST', token: LOCAL_TOKEN, bearer: false })]);
  });

  it('keeps ordinary Files listing, preview and publish on the Files identity without the local credential', async() => {
    const request = await unlockedIndex();
    expect((await request('/v1/files?collectionId=home&path=Use+Cases&limit=250')).status).toBe(200);
    expect((await request('/v1/files/file-1/preview?versionId=version-1')).status).toBe(200);
    expect((await request('/v1/files/file-1/versions/version-1/publish', { method: 'POST', body: '{}' })).status).toBe(200);
    for (const pathname of ['/v1/files', '/v1/files/file-1/preview', '/v1/files/file-1/versions/version-1/publish']) {
      expect(callsTo(pathname)).toEqual([expect.objectContaining({ bearer: true, token: null })]);
    }
  });

  it.each([
    ['a remote origin', 'https://files.example.com/v1/local/system-areas'],
    ['another local route', '/v1/local/native-sources'],
    ['a traversal out of the system areas', '/v1/local/system-areas/../lock'],
    ['an encoded traversal', '/v1/local/system-areas/%2e%2e/lock'],
    ['a case-varied local route', '/V1/LOCAL/lock'],
  ])('never sends the local credential to %s', async(_label, endpoint) => {
    const request = await unlockedIndex();
    f.calls = [];
    await expect(request(endpoint, { method: 'POST' })).rejects.toThrow();
    expect(f.calls.filter(call => call.token || call.bearer)).toEqual([]);
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it('does not run while the application is locked', async() => {
    const request = await unlockedIndex();
    f.unlocked = false; f.calls = [];
    await expect(request('/v1/local/system-areas')).rejects.toThrow('Files is locked with the application');
    await expect(request('/v1/files?collectionId=home')).rejects.toThrow('Files is locked with the application');
    expect(f.calls).toEqual([]);
  });

  it('returns a rejected local credential as-is, with no Files-identity fallback', async() => {
    const request = await unlockedIndex();
    f.localStatus.set('/v1/local/system-areas', 401);
    expect((await request('/v1/local/system-areas')).status).toBe(401);
    expect(callsTo('/v1/local/system-areas')).toEqual([expect.objectContaining({ token: LOCAL_TOKEN, bearer: false })]);
  });

  it('does not repeat an ingest write whose outcome is a server failure', async() => {
    const request = await unlockedIndex();
    f.localStatus.set('/v1/local/system-areas/ingest', 500);
    const response = await request('/v1/local/system-areas/ingest?collectionId=home&path=a', { method: 'PUT', headers: { 'x-sulla-source-hash': 'b'.repeat(64) }, body: new ArrayBuffer(1) });
    expect(response.status).toBe(500);
    expect(callsTo('/v1/local/system-areas/ingest')).toHaveLength(1);
  });
});
