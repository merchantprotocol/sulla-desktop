// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { CloudSessionStartupRestoreCoordinator } from '../../../../main/cloud/session/CloudSessionStartupRestoreCoordinator';

describe('CloudSessionStartupRestoreCoordinator', () => {
  const lifecycle = () => ({ on: vi.fn(), off: vi.fn() });

  it('retries a transient storage failure and starts services for the restored identity', async() => {
    // risk: session recovery — a transient database boot failure must not leave an authenticated user disconnected.
    const restoreIdentity = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue({ userId: 'user-1' });
    const pairRelay = vi.fn().mockResolvedValue(undefined);
    const startCloudServices = vi.fn().mockResolvedValue(undefined);
    const schedule = vi.fn((callback: () => void) => {
      queueMicrotask(callback);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const coordinator = new CloudSessionStartupRestoreCoordinator({
      lifecycle: lifecycle(), restoreIdentity, pairRelay, startCloudServices,
      trace: vi.fn(), logger: { log: vi.fn(), warn: vi.fn() }, setLastError: vi.fn(), schedule, cancel: vi.fn(),
    });

    await coordinator.start();

    expect(restoreIdentity).toHaveBeenCalledTimes(2);
    expect(pairRelay).toHaveBeenCalledWith('user-1');
    expect(startCloudServices).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 2_000);
  });

  it('stops on terminal restore errors and records the surfaced failure', async() => {
    const error = new Error('malformed account metadata');
    const setLastError = vi.fn();
    const pairRelay = vi.fn();
    const coordinator = new CloudSessionStartupRestoreCoordinator({
      lifecycle: lifecycle(), restoreIdentity: vi.fn().mockRejectedValue(error), pairRelay,
      startCloudServices: vi.fn(), trace: vi.fn(), logger: { log: vi.fn(), warn: vi.fn() }, setLastError,
    });

    await coordinator.start();

    expect(pairRelay).not.toHaveBeenCalled();
    expect(setLastError).toHaveBeenCalledWith('Sulla Cloud restore stopped: malformed account metadata');
  });
});
