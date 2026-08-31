import { describe, it, expect, beforeEach } from '@jest/globals';

import { touchChatStorageScope, _resetLegacyScopeGcForTests } from '../ChatStorageGc';

const CHANNEL = 'sulla-desktop';

function seedLegacyScope(scope: string, size = 10): void {
  localStorage.setItem(`chat_messages_${ scope }`, 'x'.repeat(size));
  localStorage.setItem(`chat_has_sent_message_${ scope }`, 'true');
}

function readIndex(): string[] {
  return JSON.parse(localStorage.getItem('chat_scope_index') ?? '[]');
}

describe('touchChatStorageScope (GW7w legacy chat storage GC)', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetLegacyScopeGcForTests();
  });

  it('discovers pre-existing orphaned tab scopes and caps the index at MAX_CHAT_SCOPES', () => {
    // Simulate cruft accumulated across many closed tabs before this fix shipped —
    // no chat_scope_index exists yet, only the raw per-tab keys.
    for (let i = 0; i < 30; i++) {
      seedLegacyScope(`${ CHANNEL }_tab_${ i }`, 100);
    }
    expect(localStorage.length).toBe(60);

    touchChatStorageScope(`${ CHANNEL }_tab_new`);

    const index = readIndex();

    expect(index.length).toBeLessThanOrEqual(20);
    expect(index[0]).toBe(`${ CHANNEL }_tab_new`);
    // Every surviving pre-existing scope must still have live keys, and every
    // evicted scope (not in the index) must have had both its keys actually
    // removed — eviction isn't just an index trim, it frees the localStorage
    // entries. (tab_new is excluded: touchChatStorageScope runs before its
    // caller ever writes chat_messages_<scope>, so it has no keys yet.)
    for (let i = 0; i < 30; i++) {
      const scope = `${ CHANNEL }_tab_${ i }`;
      const stillTracked = index.includes(scope);
      const stillHasKeys = localStorage.getItem(`chat_messages_${ scope }`) !== null;
      expect(stillHasKeys).toBe(stillTracked);
    }
  });

  it('keeps the current tab scope even when it is the only one, regardless of size', () => {
    seedLegacyScope(`${ CHANNEL }_tab_solo`, 50_000);
    touchChatStorageScope(`${ CHANNEL }_tab_solo`);

    expect(localStorage.getItem(`chat_messages_${ CHANNEL }_tab_solo`)).not.toBeNull();
    expect(readIndex()).toEqual([`${ CHANNEL }_tab_solo`]);
  });

  it('evicts older scopes by aggregate size budget even when under the scope-count cap', () => {
    // A handful of scopes, but each one is large enough that 6 of them trips
    // the byte budget well before the 20-scope count cap would.
    for (let i = 0; i < 5; i++) {
      seedLegacyScope(`${ CHANNEL }_tab_big_${ i }`, 400_000);
    }
    touchChatStorageScope(`${ CHANNEL }_tab_big_new`);

    const index = readIndex();

    // Most recently touched scope always survives, and total stays under budget.
    expect(index[0]).toBe(`${ CHANNEL }_tab_big_new`);
    expect(index.length).toBeLessThan(6);
    let total = 0;
    for (const s of index) {
      total += localStorage.getItem(`chat_messages_${ s }`)?.length ?? 0;
    }
    expect(total).toBeLessThanOrEqual(1_500_000);
  });

  it('only runs the full-storage discovery scan once per session', () => {
    seedLegacyScope(`${ CHANNEL }_tab_pre_existing`, 10);
    touchChatStorageScope(`${ CHANNEL }_tab_a`);

    // A scope created after the first scan is still tracked via its own touch call.
    seedLegacyScope(`${ CHANNEL }_tab_b`, 10);
    touchChatStorageScope(`${ CHANNEL }_tab_b`);

    const index = readIndex();

    expect(index).toContain(`${ CHANNEL }_tab_pre_existing`);
    expect(index).toContain(`${ CHANNEL }_tab_a`);
    expect(index).toContain(`${ CHANNEL }_tab_b`);
  });

  it('protects a scope from eviction as long as it keeps getting re-touched', () => {
    seedLegacyScope(`${ CHANNEL }_tab_favorite`, 10);
    touchChatStorageScope(`${ CHANNEL }_tab_favorite`);

    // Interleave enough new scopes to blow well past MAX_CHAT_SCOPES, but
    // re-touch the favorite between each one so it never ages past the tail.
    for (let i = 0; i < 40; i++) {
      touchChatStorageScope(`${ CHANNEL }_tab_other_${ i }`);
      touchChatStorageScope(`${ CHANNEL }_tab_favorite`);
    }

    expect(localStorage.getItem(`chat_messages_${ CHANNEL }_tab_favorite`)).not.toBeNull();
    expect(readIndex()[0]).toBe(`${ CHANNEL }_tab_favorite`);
  });

  it('eventually evicts a scope that stops being touched (genuine LRU, not permanent pinning)', () => {
    seedLegacyScope(`${ CHANNEL }_tab_stale`, 10);
    touchChatStorageScope(`${ CHANNEL }_tab_stale`);

    // Touch enough distinct new scopes, without ever revisiting tab_stale,
    // to push it past MAX_CHAT_SCOPES and off the tail.
    for (let i = 0; i < 25; i++) {
      touchChatStorageScope(`${ CHANNEL }_tab_other_${ i }`);
    }

    expect(localStorage.getItem(`chat_messages_${ CHANNEL }_tab_stale`)).toBeNull();
    expect(readIndex()).not.toContain(`${ CHANNEL }_tab_stale`);
  });
});
