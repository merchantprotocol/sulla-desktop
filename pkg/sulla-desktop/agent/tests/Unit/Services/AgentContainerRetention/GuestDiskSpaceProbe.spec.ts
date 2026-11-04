// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { GuestDiskSpaceProbe, type GuestCommandRunner } from '@pkg/agent/services/GuestDiskSpaceProbe';

class FakeGuestCommandRunner implements GuestCommandRunner {
  readonly calls: string[][] = [];
  constructor(private readonly result: { stdout: string } | Error) {}

  run(args: string[]): Promise<{ stdout: string }> {
    this.calls.push(args);
    return this.result instanceof Error ? Promise.reject(this.result) : Promise.resolve(this.result);
  }
}

describe('GuestDiskSpaceProbe', () => {
  it('parses the numeric value below df output header', async() => {
    // risk: an incorrect guest free-space reading disables disk-pressure retention
    const runner = new FakeGuestCommandRunner({ stdout: 'Avail\n4294967296\n' });

    await expect(new GuestDiskSpaceProbe(runner).freeBytes()).resolves.toBe(4294967296);
    expect(runner.calls).toEqual([['df', '-B1', '--output=avail', '/var/lib/docker']]);
  });

  it('ignores a trailing blank line after the header and value', async() => {
    // risk: normal df formatting causes a false parse failure at every retention pass
    const runner = new FakeGuestCommandRunner({ stdout: 'Avail\n123\n\n' });

    await expect(new GuestDiskSpaceProbe(runner).freeBytes()).resolves.toBe(123);
  });

  it('throws when df output has no numeric value', async() => {
    // risk: malformed guest output is treated as valid disk space and unsafe cleanup is skipped
    const runner = new FakeGuestCommandRunner({ stdout: 'Avail\nnot-a-number\n' });

    await expect(new GuestDiskSpaceProbe(runner).freeBytes()).rejects.toThrow("could not parse 'df' output");
  });

  it('propagates a non-zero guest df exit as an error', async() => {
    // risk: a guest command failure is swallowed and disk pressure goes unreported
    const runner = new FakeGuestCommandRunner(new Error('df exited 1: permission denied'));

    await expect(new GuestDiskSpaceProbe(runner).freeBytes()).rejects.toThrow('df exited 1: permission denied');
  });
});
