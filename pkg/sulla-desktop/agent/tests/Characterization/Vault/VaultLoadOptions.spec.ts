// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { LoadOptionsParser } from '../../../../../../services/sulla-vault/scripts/load/LoadOptions.js';
import { MachineCapacityGuard } from '../../../../../../services/sulla-vault/scripts/load/TestAssets.js';

describe('bounded vault load options', () => {
  it('rejects a concurrency value above the hard connection cap before creating resources', () => {
    // risk: resource exhaustion — user input must never start more than 1,000 streams.
    expect(() => new LoadOptionsParser().parse(['--concurrency', '1001']))
      .toThrow('--concurrency must be between 1 and 1000');
  });

  it('rejects concurrency and body-size combinations above the in-flight memory budget', () => {
    // risk: memory exhaustion — the 1,000-connection hard cap cannot be multiplied by a 350 KB body unchecked.
    expect(() => new LoadOptionsParser().parse(['--concurrency', '1000', '--body-kb', '350']))
      .toThrow('in-flight body budget');
  });

  it('rejects a soak or request body above its configured bound', () => {
    // risk: resource exhaustion — duration and body size are bounded independently of concurrency.
    const parser = new LoadOptionsParser();
    expect(() => parser.parse(['--duration', '301'])).toThrow('--duration must be between 0 and 300');
    expect(() => parser.parse(['--body-kb', '1025'])).toThrow('--body-kb must be between 1 and 1024');
  });

  it('does not bypass a low MemAvailable result through the free-memory fallback', async() => {
    // risk: resource exhaustion — a low /proc reading must stop the load run even if a fallback looks larger.
    const guard = new MachineCapacityGuard(async() => 'MemTotal: 16384000 kB\nMemAvailable: 4194303 kB\n');
    await expect(guard.check()).rejects.toThrow('only 4095 MiB is available (4 GiB required)');
  });
});
