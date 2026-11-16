import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ default: { app: { getPath: () => '/ud', getVersion: () => '0.0.0' }, net: { fetch: vi.fn() } } }));
vi.mock('@pkg/config/settingsImpl', () => ({ getSettings: () => ({ application: { telemetry: { enabled: false } } }) }));
vi.mock('@pkg/main/cloud/cloudEndpoints', () => ({ CLOUD_API_BASE: 'https://api.test' }));
vi.mock('@pkg/main/supportTimeline', () => ({ supportTimeline: { record: vi.fn() } }));

import { InstallPingScheduler, type InstallPingDeps } from './installPing';

function deps(overrides: Partial<InstallPingDeps> = {}): InstallPingDeps {
  return { telemetryEnabled: () => true, recordInstalled: vi.fn(), installId: () => 'install-1', appVersion: () => '1.2.3', fetch: vi.fn(async () => undefined), ...overrides };
}

afterEach(() => { vi.useRealTimers() });

describe('InstallPingScheduler', () => {
  it('posts the anonymous ping with the install id and event', async () => {
    const d = deps();

    await new InstallPingScheduler(d).send('daily');
    expect(d.fetch).toHaveBeenCalledWith('https://api.test/desktop/ping', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((vi.mocked(d.fetch).mock.calls[0][1] as RequestInit).body as string);

    expect(body).toMatchObject({ installId: 'install-1', appVersion: '1.2.3', event: 'daily' });
    expect(d.recordInstalled).not.toHaveBeenCalled();
  });

  // risk: consent — telemetry off sends no ping, but the launch still records the support timeline
  it('sends nothing when telemetry is disabled', async () => {
    const d = deps({ telemetryEnabled: () => false });

    await new InstallPingScheduler(d).send('launch');
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.recordInstalled).toHaveBeenCalledTimes(1);
  });

  it('swallows network failures', async () => {
    await expect(new InstallPingScheduler(deps({ fetch: async () => { throw new Error('offline') } })).send('daily')).resolves.toBeUndefined();
  });

  // risk: duplicate side effects — a second start must not schedule a second set of pings
  it('schedules the launch ping once even when started twice', async () => {
    vi.useFakeTimers();
    const d = deps();
    const scheduler = new InstallPingScheduler(d);

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(InstallPingScheduler.LAUNCH_DELAY_MS);
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });
});
