// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as fs from 'fs/promises';
import * as path from 'path';

import { redisClient } from '../database/RedisClient';

import paths from '@pkg/utils/paths';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_ENTRIES = 2_000;
/**
 * Subconscious runs (elephant, goldfish, dreamer, summarizer, digester, reflex
 * trainer) use a fresh `subconscious_<ts>_<n>` conversation id per run and are
 * never resumed after the run ends. Their sessions live in Redis only, for at
 * most an hour, and are never written to provider-sessions.json.
 */
const EPHEMERAL_TTL_SECONDS = 60 * 60;
const EPHEMERAL_CONVERSATION = /(^|:)subconscious_/;
/** Session-key prefixes the CLI providers use; released together when a run ends. */
const RELEASABLE_PREFIXES = ['claude_code_session:', 'codex_session:'];

export function isEphemeralSessionKey(key: string): boolean {
  return EPHEMERAL_CONVERSATION.test(key);
}

interface SessionEntry {
  sessionId: string;
  expiresAt: number;
  updatedAt: number;
}

interface SessionFile {
  entries: Record<string, SessionEntry>;
}

export interface SessionCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface ProviderSessionStoreOptions {
  filePath?:   string;
  cache?:      SessionCache;
  ttlSeconds?: number;
  now?:        () => number;
}

// All instances in this process share the mutation queue because they write one file.
let mutationQueue = Promise.resolve();

export class ProviderSessionStore {
  private readonly filePath: string;
  private readonly cache: SessionCache;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(options: ProviderSessionStoreOptions = {}) {
    this.filePath = options.filePath ?? path.join(paths.appHome, 'provider-sessions.json');
    this.cache = options.cache ?? redisClient;
    this.ttlSeconds = options.ttlSeconds ?? SESSION_TTL_SECONDS;
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const cached = await this.cache.get(key);
      if (cached) return cached;
    } catch { /* Durable storage is the fallback when Redis is unavailable. */ }
    if (isEphemeralSessionKey(key)) return undefined;

    const file = await this.readFile();
    const entry = file.entries[key];
    if (!entry) return undefined;
    const now = this.now();
    if (typeof entry.sessionId !== 'string' || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
      await this.mutate((entries) => {
        if (!entries[key] || entries[key].expiresAt <= now) delete entries[key];
      });
      return undefined;
    }

    const remainingSeconds = Math.max(1, Math.ceil((entry.expiresAt - now) / 1_000));
    try { await this.cache.set(key, entry.sessionId, remainingSeconds) } catch { /* non-fatal */ }
    return entry.sessionId;
  }

  async set(key: string, sessionId: string): Promise<void> {
    if (isEphemeralSessionKey(key)) {
      await this.cache.set(key, sessionId, EPHEMERAL_TTL_SECONDS).catch(() => undefined);
      return;
    }
    const now = this.now();
    await Promise.all([
      this.mutate(entries => {
        entries[key] = { sessionId, updatedAt: now, expiresAt: now + this.ttlSeconds * 1_000 };
      }),
      this.cache.set(key, sessionId, this.ttlSeconds).catch(() => undefined),
    ]);
  }

  async delete(key: string): Promise<void> {
    if (isEphemeralSessionKey(key)) {
      await this.cache.del(key).catch(() => undefined);
      return;
    }
    await Promise.all([
      this.mutate(entries => delete entries[key]),
      this.cache.del(key).catch(() => undefined),
    ]);
  }

  /** Drop every provider session for a finished subconscious run. */
  async releaseConversation(conversationId: string): Promise<void> {
    if (!conversationId) return;
    await Promise.all(RELEASABLE_PREFIXES.map(prefix => this.delete(`${ prefix }${ conversationId }`)));
  }

  private async readFile(): Promise<SessionFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<SessionFile>;
      return { entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {} };
    } catch {
      return { entries: {} };
    }
  }

  private async mutate(change: (entries: Record<string, SessionEntry>) => void): Promise<void> {
    const operation = mutationQueue.then(async() => {
      const file = await this.readFile();
      const now = this.now();
      for (const [key, entry] of Object.entries(file.entries)) {
        if (!entry || typeof entry.sessionId !== 'string' || !Number.isFinite(entry.expiresAt) ||
          !Number.isFinite(entry.updatedAt) || entry.expiresAt <= now) delete file.entries[key];
      }
      change(file.entries);

      const newest = Object.entries(file.entries)
        .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_ENTRIES);
      const contents = JSON.stringify({ entries: Object.fromEntries(newest) });
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${ this.filePath }.${ process.pid }.tmp`;
      await fs.writeFile(temporaryPath, contents, { mode: 0o600 });
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    });
    mutationQueue = operation.catch(() => undefined);
    await operation;
  }
}

export const providerSessionStore = new ProviderSessionStore();
