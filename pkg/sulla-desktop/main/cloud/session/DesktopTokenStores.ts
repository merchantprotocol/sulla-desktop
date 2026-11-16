// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AuthSession, InProcessRefreshLock, TokenPair, type PendingRevocationQueue, type TokenStore } from '@sulla/domain';
import type { Resolver } from '@sulla/foundation';

/** One lock for every Desktop refresh of the Cloud session (legacy and first-run), so one refresh token is never spent twice at once. */
export class DesktopRefreshLocks {
  static readonly shared = new InProcessRefreshLock();
}

/** The session dispatcher has no listeners in Desktop, so nothing is ever resolved. */
export class NoListenerResolver implements Resolver {
  make<T>(): T { throw new Error('The Desktop session events have no listeners'); }
  has(): boolean { return false; }
}

/** The stored Cloud session as Desktop keeps it today (keys and formats unchanged). */
export interface StoredCloudSession {
  userId: string;
  activeContractorId: string;
  contractors: unknown;
  tokens: { accessToken: string; refreshToken: string };
}

/** Where the legacy / first-run session lives today. The adapter never adds a place. */
export interface CloudSessionStorage<S extends StoredCloudSession> {
  load(): Promise<S | null>;
  save(session: S): Promise<void>;
  /** Deletes the stored session (sign-out). Throws when it could not, so the server revoke is never sent first. */
  clear(): Promise<void>;
}

/**
 * TokenStore over the existing Desktop storage. The storage has no revision column, so compare-and-set re-reads and
 * compares the refresh token. `invalidate()` (called by sign-out first) makes every session read earlier fail its
 * compare-and-set, so a refresh that finishes after logout never re-writes tokens.
 *
 * A refresh the server rejects does NOT clear tokens here (`clear()` returns false): Desktop has never deleted the
 * session on a failed refresh, and sign-out stays the only thing that does.
 */
export class LegacyTokenStore<S extends StoredCloudSession> implements TokenStore {
  private revision = 0;
  private generation = 0;
  private readonly readAt = new WeakMap<AuthSession, number>();

  constructor(private readonly storage: CloudSessionStorage<S>) {}

  async read(): Promise<AuthSession | null> {
    const stored = await this.storage.load();
    if (!stored) return null;
    return this.track(stored);
  }

  async compareAndSet(expected: AuthSession | null, next: AuthSession): Promise<boolean> {
    if (!expected || !this.isCurrent(expected)) return false;
    const stored = await this.storage.load();
    if (!stored || !this.isCurrent(expected)) return false;
    if (!expected.matches(this.toSession(stored))) return false;
    this.revision = next.revision;
    await this.storage.save({ ...stored, tokens: { accessToken: next.tokens.accessToken, refreshToken: next.tokens.refreshToken } });
    return true;
  }

  async clear(_expected?: AuthSession | null): Promise<boolean> {
    return false;
  }

  /** Sign-out started: nothing read before now may be written back. */
  invalidate(): void {
    this.generation += 1;
  }

  private isCurrent(session: AuthSession): boolean {
    return this.readAt.get(session) === this.generation;
  }

  private track(stored: S): AuthSession | null {
    if (!stored.tokens.accessToken || !stored.tokens.refreshToken) return null;
    const session = this.toSession(stored);
    this.readAt.set(session, this.generation);
    return session;
  }

  private toSession(stored: S): AuthSession {
    return new AuthSession(stored.userId, stored.activeContractorId, new TokenPair(stored.tokens.accessToken, stored.tokens.refreshToken), this.revision);
  }
}

/**
 * The TokenStore `SignOutService` uses. Reads go through the legacy store; `clear()` really deletes the stored session
 * (unlike `LegacyTokenStore.clear`, which a rejected refresh must not trigger) and first invalidates every earlier read,
 * so no refresh can write tokens back. Sign-out never writes, so compare-and-set always refuses.
 */
export class LegacySignOutTokenStore<S extends StoredCloudSession> implements TokenStore {
  constructor(private readonly legacy: LegacyTokenStore<S>, private readonly storage: CloudSessionStorage<S>) {}

  read(): Promise<AuthSession | null> {
    return this.legacy.read();
  }

  async compareAndSet(_expected: AuthSession | null, _next: AuthSession): Promise<boolean> {
    return false;
  }

  async clear(_expected?: AuthSession | null): Promise<boolean> {
    this.legacy.invalidate();
    await this.storage.clear();
    return true;
  }
}

/**
 * Desktop server mode has no supported durable store for refresh tokens awaiting a revoke (the session's own storage is
 * deleted by sign-out, and first-run credentials live only in memory). Rather than pretend with an in-memory queue that
 * a restart loses, `push` refuses: `SignOutService` reports `queued: false`, and an unrevoked Cloud session simply
 * expires on the server.
 */
export class UnavailableRevocationQueue implements PendingRevocationQueue {
  async push(_refreshToken: string): Promise<void> {
    throw new Error('Desktop has no durable store for pending Cloud revocations');
  }

  async drain(): Promise<string[]> {
    return [];
  }

  async remove(_refreshToken: string): Promise<void> {}
}

/** TokenStore over one first-run pending entry (main-process memory). A rejected refresh is remembered, tokens stay as before. */
export class PendingEntryTokenStore implements TokenStore {
  private revision = 0;
  private rejectedByServer = false;

  constructor(private readonly entry: { values: Record<string, string> }) {}

  async read(): Promise<AuthSession | null> {
    const { access_token: access, refresh_token: refresh } = this.entry.values;
    if (!access || !refresh) return null;
    return new AuthSession(this.entry.values.user_id ?? '', this.entry.values.active_contractor_id ?? '', new TokenPair(access, refresh), this.revision);
  }

  async compareAndSet(expected: AuthSession | null, next: AuthSession): Promise<boolean> {
    if (!expected || !expected.matches(await this.read())) return false;
    this.revision = next.revision;
    this.entry.values.access_token = next.tokens.accessToken;
    this.entry.values.refresh_token = next.tokens.refreshToken;
    return true;
  }

  async clear(_expected?: AuthSession | null): Promise<boolean> {
    this.rejectedByServer = true;
    return true;
  }

  wasRejected(): boolean {
    return this.rejectedByServer;
  }
}
