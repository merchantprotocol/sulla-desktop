// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as fs from 'fs/promises';
import * as path from 'path';

import { redisClient } from '../database/RedisClient';

import paths from '@pkg/utils/paths';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * Subconscious runs (memory elephant/goldfish, reflex trainer, summarizer,
 * digester) get a fresh `subconscious_<ts>_<n>` conversation id per run and
 * are never resumed after it ends, so their provider sessions only need to
 * outlive one run. Keeping them for the 7-day default piled up hundreds of
 * dead keys in Redis and provider-sessions.json.
 */
const EPHEMERAL_SESSION_TTL_SECONDS = 60 * 60;
const MAX_ENTRIES = 2_000;

/** True for `<provider>_session:subconscious_…` keys. */
export function isEphemeralSessionKey(key: string): boolean {
  const separator = key.indexOf(':');
  return separator >= 0 && key.slice(separator + 1).startsWith('subconscious_');
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
  ephemeralTtlSeconds?: number;
  now?:        () => number;
}

// All instances in this process share the mutation queue because they write one file.
let mutationQueue = Promise.resolve();

export class ProviderSessionStore {
  private readonly filePath: string;
  private readonly cache: SessionCache;
  private readonly ttlSeconds: number;
  private readonly ephemeralTtlSeconds: number;
  private readonly now: () => number;

  constructor(options: ProviderSessionStoreOptions = {}) {
    this.filePath = options.filePath ?? path.join(paths.appHome, 'provider-sessions.json');
    this.cache = options.cache ?? redisClient;
    this.ttlSeconds = options.ttlSeconds ?? SESSION_TTL_SECONDS;
    this.ephemeralTtlSeconds = Math.min(this.ttlSeconds, options.ephemeralTtlSeconds ?? EPHEMERAL_SESSION_TTL_SECONDS);
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const cached = await this.cache.get(key);
      if (cached) return cached;
    } catch { /* Durable storage is the fallback when Redis is unavailable. */ }

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
    const now = this.now();
    const ttlSeconds = this.ttlFor(key);
    await Promise.all([
      this.mutate(entries => {
        entries[key] = { sessionId, updatedAt: now, expiresAt: now + ttlSeconds * 1_000 };
      }),
      this.cache.set(key, sessionId, ttlSeconds).catch(() => undefined),
    ]);
  }

  private ttlFor(key: string): number {
    return isEphemeralSessionKey(key) ? this.ephemeralTtlSeconds : this.ttlSeconds;
  }

  async delete(key: string): Promise<void> {
    await Promise.all([
      this.mutate(entries => delete entries[key]),
      this.cache.del(key).catch(() => undefined),
    ]);
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
        // Entries written before the short subconscious TTL still carry a
        // 7-day expiry; age them out by their last update instead.
        else if (isEphemeralSessionKey(key) && entry.updatedAt + this.ephemeralTtlSeconds * 1_000 <= now) delete file.entries[key];
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
