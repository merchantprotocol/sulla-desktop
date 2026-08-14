/**
 * Regression test for the dual-store `heartbeatEnabled` flip-false bug.
 *
 * Root cause (see ~/sulla/projects/dual-store-heartbeat-trace.md): a single
 * transient PG/Redis unavailability during a restart made `bootstrap()` throw,
 * which was swallowed, leaving `isReady=false` for the whole process. Every
 * later read then silently fell back to the caller default (`heartbeatEnabled`
 * → `false`) while PG/Redis still held `true` — the operator quietly disabled
 * itself.
 *
 * The fix: retry with backoff, and if every attempt fails, THROW so the
 * `database-manager` lifecycle gate fails loudly instead of the heartbeat
 * silently reading defaults.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { SullaSettingsModel } from '../SullaSettingsModel';

describe('SullaSettingsModel.bootstrap — fail loud, not silent', () => {
  let initializeSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    // Reset the per-process static readiness flag between tests.
    (SullaSettingsModel as any).isReady = false;
    // Bootstrap requires an installation lock file path to be set.
    SullaSettingsModel.setFallbackFilePath('/tmp/sulla-bootstrap-test-settings.json');

    // Fast retries so the exhaustion path does not sleep for seconds.
    SullaSettingsModel.bootstrapMaxAttempts = 3;
    SullaSettingsModel.bootstrapBaseDelayMs = 1;
    SullaSettingsModel.bootstrapMaxDelayMs = 1;

    // Treat the install as already done so bootstrap skips the file-sync block
    // and we exercise only the initialize()/readiness path under test.
    jest.spyOn(SullaSettingsModel, 'getSetting').mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (SullaSettingsModel as any).isReady = false;
  });

  test('retries a transient failure and eventually succeeds → isReady=true', async() => {
    // Fail the first two attempts (backends slow to accept connections), then succeed.
    initializeSpy = jest.spyOn(SullaSettingsModel, 'initialize')
      .mockRejectedValueOnce(new Error('ECONNREFUSED redis'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED postgres'))
      .mockResolvedValueOnce(undefined);

    await expect(SullaSettingsModel.bootstrap()).resolves.toBeUndefined();

    expect(initializeSpy).toHaveBeenCalledTimes(3);
    expect((SullaSettingsModel as any).isReady).toBe(true);
  });

  test('throws loudly after exhausting all attempts, and leaves isReady=false', async() => {
    // Every attempt fails — the old code swallowed this and left isReady=false silently.
    initializeSpy = jest.spyOn(SullaSettingsModel, 'initialize')
      .mockRejectedValue(new Error('ECONNREFUSED postgres'));

    await expect(SullaSettingsModel.bootstrap())
      .rejects.toThrow(/bootstrap failed after 3 attempts/i);

    expect(initializeSpy).toHaveBeenCalledTimes(3);
    // Critical: a failed bootstrap must NOT leave a half-ready process that
    // would read default-`false` for heartbeatEnabled.
    expect((SullaSettingsModel as any).isReady).toBe(false);
  });

  test('is idempotent — a second call after success does not re-initialize', async() => {
    initializeSpy = jest.spyOn(SullaSettingsModel, 'initialize').mockResolvedValue(undefined);

    await SullaSettingsModel.bootstrap();
    await SullaSettingsModel.bootstrap();

    expect(initializeSpy).toHaveBeenCalledTimes(1);
  });
});
