// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { UsageWriteQueue } from '../../../app/Services/ProviderUsage/UsageWriteQueue';

describe('UsageWriteQueue', () => {
  it('serializes writes per key while allowing independent keys', async() => {
    // risk: concurrent writes lose usage records
    const queue = new UsageWriteQueue(); queue.start(); const events: string[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve });
    const first = queue.enqueue('same', async() => { events.push('first-start'); await gate; events.push('first-end') });
    const second = queue.enqueue('same', async() => { events.push('second') });
    const independent = queue.enqueue('other', async() => { events.push('other') });
    await independent; expect(events).toEqual(['first-start', 'other']); release(); await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'other', 'first-end', 'second']); await queue.dispose();
  });
  it('stop and dispose drain accepted work and reject later writes', async() => {
    // risk: shutdown drops queued metering data
    const queue = new UsageWriteQueue(); queue.start(); let saved = false;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve });
    void queue.enqueue('usage', async() => { await gate; saved = true });
    const stopping = queue.dispose(); expect(queue.pending).toBe(1); release(); await stopping;
    expect(saved).toBe(true); expect(queue.pending).toBe(0);
    await expect(queue.enqueue('usage', async() => undefined)).rejects.toThrow('not running');
    await queue.dispose();
  });
});
