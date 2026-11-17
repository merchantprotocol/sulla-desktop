// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { ProfileBoundary, ProfileGeneration } from '@sulla/vault-profiles';
import type pg from 'pg';
import type { Database } from '../db.js';

export interface ProfileContext {
  readonly profileId: string;
  readonly generation: ProfileGeneration;
}

/** Binds a vault authority to one pool and fences every query/transaction against current identity. */
export class VaultProfileSession {
  private invalidated = false;
  private readonly scopedDatabase: Database;

  constructor(
    readonly context: ProfileContext,
    private readonly pool: Database,
    private readonly boundary = new ProfileBoundary(),
    private readonly activeProfile: () => ProfileContext = () => context,
  ) {
    this.scopedDatabase = this.guardPool(pool);
  }

  get database(): Database { return this.scopedDatabase; }

  /** Create a fresh query fence for the same profile after a lock invalidates this session. */
  renew(): VaultProfileSession {
    return new VaultProfileSession(this.context, this.pool, this.boundary, this.activeProfile);
  }

  assertCurrent(): void {
    if (this.invalidated) throw new Error('Stale vault profile');
    const active = this.activeProfile();
    if (active.profileId !== this.context.profileId) throw new Error('Stale vault profile');
    this.boundary.assertCurrent(this.context.generation, active.generation);
  }

  invalidate(): void { this.invalidated = true; }

  private guardPool(pool: Database): Database {
    const session = this;
    const stale = (args: unknown[]): Promise<never> | undefined => {
      const error = new Error('Stale vault profile');
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        // Callback-style callers ignore the return value; returning a rejected promise here would be unhandled.
        queueMicrotask(() => (callback as (error: Error) => void)(error));
        return undefined;
      }
      return Promise.reject(error);
    };
    return new Proxy(pool, {
      get(target, property, receiver) {
        if (property === 'query') return (...args: unknown[]) => {
          try { session.assertCurrent(); } catch { return stale(args); }
          return target.query(...args as Parameters<pg.Pool['query']>);
        };
        if (property === 'connect') return (...args: unknown[]) => {
          try { session.assertCurrent(); } catch { return stale(args); }
          return Promise.resolve(target.connect(...args as Parameters<pg.Pool['connect']>)).then(client => {
          return new Proxy(client, { get(connection, key, proxyReceiver) {
            if (key === 'query') return (...queryArgs: unknown[]) => {
              try { session.assertCurrent(); } catch { return stale(queryArgs); }
              return connection.query(...queryArgs as Parameters<pg.PoolClient['query']>);
            };
            return Reflect.get(connection, key, proxyReceiver);
          } });
          });
        };
        return Reflect.get(target, property, receiver);
      },
    });
  }
}
