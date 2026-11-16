import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scheduleJob:      vi.fn(),
  desktopFilesFetch: vi.fn(),
  servicePassword:  vi.fn(async() => 'files-token'),
}));

vi.mock('electron', () => ({}));
vi.mock('@pkg/utils/logging', () => ({ default: {} }));
vi.mock('node-schedule', () => ({ default: { scheduleJob: mocks.scheduleJob } }));
vi.mock('../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { getServicePassword: mocks.servicePassword } }));
vi.mock('@pkg/main/sullaFilesTls', () => ({ FILES_HTTPS_ORIGIN: 'https://127.0.0.1:30124', desktopFilesFetch: mocks.desktopFilesFetch }));

import {
  getSullaFilesMaintenanceService,
  SullaFilesMaintenanceService,
  SullaFilesMaintenanceServiceProvider,
  type SullaFilesMaintenanceDependencies,
} from './SullaFilesMaintenanceService.ts';

function dependencies(overrides:Partial<SullaFilesMaintenanceDependencies> = {}) {
  const job = { cancel: vi.fn() };
  const deps = {
    scheduleJob:     vi.fn(() => job),
    servicePassword: vi.fn(async() => 'files-token'),
    fetch:           vi.fn(async() => Response.json({ expiredFiles: 0, deletedChunks: 0 })),
    filesFetch:      vi.fn(async() => Response.json({ expiredFiles: 3, deletedChunks: 7 })),
    filesOrigin:     'https://127.0.0.1:30124',
    filesApi:        undefined as string | undefined,
    log:             vi.fn(),
    warn:            vi.fn(),
    ...overrides,
  };
  return { job, deps };
}

describe('SullaFilesMaintenanceService', () => {
  afterEach(() => {
    delete process.env.SULLA_FILES_API_URL;
    vi.clearAllMocks();
  });

  it('schedules the nightly job once however often it is started', () => {
    // risk: duplicate side effects — repeated starts must not run maintenance twice a night.
    const { job, deps } = dependencies();
    const service = new SullaFilesMaintenanceService(deps);
    service.initialize();
    service.initialize();
    expect(deps.scheduleJob).toHaveBeenCalledTimes(1);
    expect(deps.scheduleJob).toHaveBeenCalledWith('0 3 * * *', expect.any(Function));
    service.shutdown();
    service.shutdown();
    expect(job.cancel).toHaveBeenCalledTimes(1);
    service.initialize();
    expect(deps.scheduleJob).toHaveBeenCalledTimes(2);
  });

  it('posts maintenance to the pinned local Files origin with the service token', async() => {
    // risk: authentication — maintenance must use the pinned TLS transport and the Files service token.
    const { deps } = dependencies();
    const service = new SullaFilesMaintenanceService(deps);
    service.initialize();
    const run = (deps.scheduleJob.mock.calls[0] as unknown as [string, () => Promise<void>])[1];
    await run();
    expect(deps.filesFetch).toHaveBeenCalledWith('https://127.0.0.1:30124/v1/local/maintenance', expect.objectContaining({ method: 'POST', headers: { 'x-sulla-files-token': 'files-token' } }));
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('[SullaFiles] nightly maintenance expired 3 files and collected 7 chunks');
  });

  it('uses the development Files API when one is configured', async() => {
    // risk: data integrity — a configured development API must receive maintenance, not the pinned production origin.
    const { deps } = dependencies({ filesApi: 'http://localhost:4100' });
    await new SullaFilesMaintenanceService(deps).runNightly();
    expect(deps.fetch).toHaveBeenCalledWith('http://localhost:4100/v1/local/maintenance', expect.objectContaining({ method: 'POST' }));
    expect(deps.filesFetch).not.toHaveBeenCalled();
  });

  it('reports a failed run without throwing out of the scheduler', async() => {
    // risk: availability — a Files error must be logged, never crash the main process scheduler.
    const { deps } = dependencies({ filesFetch: vi.fn(async() => new Response('', { status: 503 })) });
    await expect(new SullaFilesMaintenanceService(deps).runNightly()).resolves.toBeUndefined();
    expect(deps.warn).toHaveBeenCalledWith('[SullaFiles] nightly maintenance failed:', expect.objectContaining({ message: 'Files maintenance returned 503' }));
    expect(deps.log).not.toHaveBeenCalled();
  });

  it('shares one service instance so stop cancels the job that start scheduled', () => {
    // risk: lifecycle — sulla.ts starts and stops through separate getter calls; they must reach the same job.
    expect(getSullaFilesMaintenanceService()).toBe(getSullaFilesMaintenanceService());
    const factory = vi.fn(() => new SullaFilesMaintenanceService(dependencies().deps));
    const provider = new SullaFilesMaintenanceServiceProvider(factory);
    expect(provider.resolve()).toBe(provider.resolve());
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('wires the default scheduler, token and trimmed development API', async() => {
    // risk: configuration — the production wiring must schedule with node-schedule and honour SULLA_FILES_API_URL.
    process.env.SULLA_FILES_API_URL = 'http://localhost:4100//';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ expiredFiles: 1, deletedChunks: 2 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      mocks.scheduleJob.mockReturnValue({ cancel: vi.fn() });
      const service = new SullaFilesMaintenanceService();
      service.initialize();
      expect(mocks.scheduleJob).toHaveBeenCalledWith('0 3 * * *', expect.any(Function));
      await service.runNightly();
      expect(fetchSpy).toHaveBeenCalledWith('http://localhost:4100/v1/local/maintenance', expect.objectContaining({ headers: { 'x-sulla-files-token': 'files-token' } }));
      expect(mocks.desktopFilesFetch).not.toHaveBeenCalled();
      service.shutdown();
    } finally {
      fetchSpy.mockRestore();
      log.mockRestore();
    }
  });
});
