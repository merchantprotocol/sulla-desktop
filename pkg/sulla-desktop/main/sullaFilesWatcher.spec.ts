// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { once: vi.fn() } }));
vi.mock('@pkg/utils/startupTrace', () => ({ traceAsync: (_name:string, run:() => unknown) => run(), traceEvent: vi.fn() }));
vi.mock('./sullaFilesBootstrapFacade', () => ({ SullaFilesBootstrapFacade: class {} }));
vi.mock('./NativeSourceRevalidator', () => ({ NativeSourceRevalidator: class {} }));
vi.mock('./VaultFilesStartup', () => ({ VaultFilesStartup: class {} }));
vi.mock('./sullaFilesBoundedResponse', () => ({ boundedFilesResponseReader: { read: vi.fn() } }));
vi.mock('./sullaFilesMountManager', () => ({ getSullaFilesMountManager: vi.fn() }));
vi.mock('./sullaFilesNativeBroker', () => ({ SullaFilesNativeBroker: class {} }));
vi.mock('./sullaFilesSourceGateway', () => ({ getSullaFilesSourceGateway: vi.fn(), lockSullaFilesSourceGateway: vi.fn(), unlockSullaFilesSourceGateway: vi.fn() }));
vi.mock('./sullaFinderBadges', () => ({ FINDER_BADGE_MIN_INTERVAL_MS: 1 }));
vi.mock('./sullaUseCaseFiles', () => ({ SullaUseCaseFiles: class {} }));
vi.mock('./SullaUseCaseFilesRequest', () => ({ SullaUseCaseFilesRequest: class {} }));
vi.mock('@pkg/agent/useCases/UseCaseSuggestionCompositionRoot', () => ({ UseCaseSuggestionCompositionRoot: class {} }));
vi.mock('@pkg/agent/builtinSkills', () => ({ getBuiltinSkillSpecs: () => [] }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient: {} }));
vi.mock('@pkg/agent/database/RedisClient', () => ({ redisClient: {} }));
vi.mock('@pkg/agent/useCases/UseCaseChangeBus', () => ({ RedisUseCaseChangeTransport: class {} }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: {} }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: console } }));
vi.mock('@pkg/utils/sullaFilesNativeSource', () => ({ sullaFilesNativeSourceRolloutRequested: () => false }));
vi.mock('@pkg/utils/sullaFilesPaths', () => ({ resolveSullaFilesUserRoot: () => ({ activePath: '/tmp/files' }) }));
vi.mock('./SullaFilesWatcherSupport', () => ({ DEFAULT_IGNORES: [], NATIVE_POLL_ACTIVE_MS: 1, NATIVE_POLL_IDLE_MAX_MS: 1, UNLOCK_RETRY_DELAYS_MS: [2_000, 5_000, 10_000], ignored: () => false }));
vi.mock('./SullaFilesWatcherRequestService', () => ({ SullaFilesWatcherRequestService: class {} }));
vi.mock('./SullaFilesWatcherTrackedRoots', () => ({ SullaFilesWatcherTrackedRoots: class {} }));
vi.mock('./SullaFilesWatcherOperations', () => ({ SullaFilesWatcherOperations: class {} }));

import { SullaFilesWatcher } from './sullaFilesWatcher';

describe('SullaFilesWatcher unlock generation', () => {
  it('starts a fresh unlock after a generation bump supersedes the in-flight run', async() => {
    // risk: availability — a new vault unlock must not keep joining an old generation's doomed promise.
    const watcher = Object.create(SullaFilesWatcher.prototype) as SullaFilesWatcher;
    let rejectFirst:(error:Error) => void = () => undefined;
    const oldRun = new Promise<void>((_resolve, reject) => { rejectFirst = reject });
    const generations:number[] = [];

    (watcher as any).lockGeneration = 1;
    (watcher as any).performEnsureUnlocked = vi.fn((generation:number) => {
      generations.push(generation);
      return generations.length === 1 ? oldRun : Promise.resolve();
    });

    const initial = (watcher as any).ensureUnlocked() as Promise<void>;

    (watcher as any).lockGeneration = 2;
    const replacement = (watcher as any).ensureUnlocked() as Promise<void>;
    rejectFirst(new Error('Files unlock was superseded'));

    await expect(initial).rejects.toThrow('Files unlock was superseded');
    await expect(replacement).resolves.toBeUndefined();
    expect(generations).toEqual([1, 2]);
  });

  it('retries a superseded unlock immediately without entering the backoff ladder', async() => {
    // risk: availability — startup unlock should not delay session restore behind retry backoff after a generation change.
    const watcher = Object.create(SullaFilesWatcher.prototype) as SullaFilesWatcher;
    const timeout = vi.spyOn(globalThis, 'setTimeout');

    (watcher as any).unlockRetryEpoch = 0;
    (watcher as any).stopped = false;
    (watcher as any).appUnlocked = vi.fn().mockResolvedValue(true);
    (watcher as any).unlockService = vi.fn()
      .mockRejectedValueOnce(new Error('Files unlock was superseded'))
      .mockResolvedValueOnce(undefined);

    try {
      await watcher.unlockServiceWithRetry();
      expect((watcher as any).unlockService).toHaveBeenCalledTimes(2);
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it('distinguishes a superseded generation from genuine shutdown', () => {
    // risk: availability — generation invalidation is retried, while app quit remains a shutdown error.
    const watcher = Object.create(SullaFilesWatcher.prototype) as SullaFilesWatcher;
    (watcher as any).unlockPermitted = true;
    (watcher as any).lockGeneration = 3;
    (watcher as any).stopped = false;

    expect(() => (watcher as any).assertUnlockGeneration(2)).toThrow('Files unlock was superseded');
    (watcher as any).stopped = true;
    expect(() => (watcher as any).assertUnlockGeneration(3)).toThrow('Files is shutting down');
  });
});
