// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { singleFlight } from '../../../../utils/singleFlight';

describe('singleFlight', () => {
  it('skips overlapping calls and runs again after the first settles', async() => {
    let calls = 0;
    let release: () => void = () => {};
    const load = singleFlight(() => {
      calls++;

      return new Promise<void>((resolve) => { release = resolve });
    });

    const first = load();

    await load();
    await load();
    expect(calls).toBe(1);
    release();
    await first;
    const second = load();

    release();
    await second;
    expect(calls).toBe(2);
  });

  it('releases the guard when the loader throws', async() => {
    let calls = 0;
    const load = singleFlight(async() => {
      calls++;
      throw new Error('boom');
    });

    await expect(load()).rejects.toThrow('boom');
    await expect(load()).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
});
