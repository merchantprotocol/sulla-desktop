// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { DesktopRelayStartupRestorer } from '../../../../main/cloud/session/DesktopRelayStartupRestorer';

describe('DesktopRelayStartupRestorer', () => {
  it('returns after startup succeeds without retrying', async() => {
    const client = { start: vi.fn().mockResolvedValue(undefined) };
    const reporter = { failed: vi.fn(), exhausted: vi.fn() };
    const sleep = vi.fn().mockResolvedValue(undefined);

    await new DesktopRelayStartupRestorer(client, reporter, { sleep }).restore();

    expect(client.start).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(reporter.failed).not.toHaveBeenCalled();
  });

  it('retries a boot-time settings failure and stops when the paired relay starts', async() => {
    // risk: session recovery — a temporary settings database boot race must not leave an authenticated relay offline.
    const client = { start: vi.fn().mockRejectedValueOnce(new Error('Settings database not ready yet')).mockResolvedValue(undefined) };
    const reporter = { failed: vi.fn(), exhausted: vi.fn() };
    const sleep = vi.fn().mockResolvedValue(undefined);

    await new DesktopRelayStartupRestorer(client, reporter, { retryMs: 25, sleep }).restore();

    expect(client.start).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
    expect(reporter.failed).toHaveBeenCalledOnce();
    expect(reporter.exhausted).not.toHaveBeenCalled();
  });

  it('gives up only after the startup retry deadline', async() => {
    const error = new Error('Settings database not ready yet');
    const client = { start: vi.fn().mockRejectedValue(error) };
    const reporter = { failed: vi.fn(), exhausted: vi.fn() };
    let now = 0;
    const sleep = vi.fn().mockImplementation(async(ms: number) => { now += ms; });

    await new DesktopRelayStartupRestorer(client, reporter, { retryMs: 5, deadlineMs: 10, now: () => now, sleep }).restore();

    expect(client.start).toHaveBeenCalledTimes(3);
    expect(reporter.failed).toHaveBeenCalledTimes(2);
    expect(reporter.exhausted).toHaveBeenCalledWith(error);
  });
});
