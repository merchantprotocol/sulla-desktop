// SPDX-License-Identifier: GPL-2.0-or-later
import { reactive } from 'vue';
import { describe, expect, it } from 'vitest';
import { ChatMessageQueue } from '../ChatMessageQueue';

describe('ChatMessageQueue', () => {
  it('copies reactive metadata to structured-clone-safe plain data', () => {
    // risk: message delivery — queued sends must not fail structured cloning at Electron IPC.
    const queue = new ChatMessageQueue();
    const metadata = reactive({ nested: { fileReferences: [{ name: 'fixture.txt' }] } });
    queue.enqueue('continue', [], metadata);
    const queued = queue.shift()!;
    expect(() => structuredClone(queued.metadata)).not.toThrow();
    expect(queued.metadata).toEqual({ nested: { fileReferences: [{ name: 'fixture.txt' }] } });
  });
});
