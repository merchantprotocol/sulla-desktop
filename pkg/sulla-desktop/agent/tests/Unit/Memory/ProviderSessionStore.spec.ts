// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../database/RedisClient', () => ({ redisClient: { get: async () => null, set: async () => undefined, del: async () => undefined } }));

import { ProviderSessionStore } from '../../../languagemodels/providerSessionStore';

class SessionCacheFixture {
  readonly ttls: Record<string, number | undefined> = {};
  async get(): Promise<string | null> { return null; }
  async set(key: string, _value: string, ttl?: number): Promise<void> { this.ttls[key] = ttl; }
  async del(): Promise<void> {}
}

describe('provider session lifetimes', () => {
  it('uses short-lived sessions only for subconscious runs and preserves ordinary sessions', async () => {
    // risk: background agent sessions either accumulate indefinitely or user conversations expire prematurely
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-session-test-'));
    try {
      const cache = new SessionCacheFixture();
      const store = new ProviderSessionStore({ filePath: path.join(directory, 'sessions.json'), cache, ttlSeconds: 7 * 24 * 60 * 60, ephemeralTtlSeconds: 60 * 60 });
      await store.set('openai_session:subconscious_run-1', 'ephemeral-session');
      await store.set('openai_session:conversation-1', 'ordinary-session');
      expect(cache.ttls).toEqual({
        'openai_session:subconscious_run-1': 60 * 60,
        'openai_session:conversation-1': 7 * 24 * 60 * 60,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
