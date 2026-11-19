// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// PostgresClient.ts — upgraded to pg.Pool + proper shutdown

import { AsyncLocalStorage } from 'node:async_hooks';

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { hostPort } from '@pkg/utils/instance';

import { DatabaseOutageState, DatabaseUnavailableClassifier } from './DatabaseAvailability';

// Node's AsyncLocalStorage is unsafe in an Electron renderer: there the async
// context slot is shared with Blink, so getStore() can read a Blink object and
// V8 aborts the whole renderer (it took down the password vault on its first
// query). Statement timeouts are only set from the main process, so renderers
// skip AsyncLocalStorage entirely.
const IN_RENDERER = typeof process !== 'undefined' && process.type === 'renderer';
/** Approved ride-out for a refused or stalled dial. */
const SAFE_POOL_CONNECT_OUTAGE_MS = 90_000;
const SAFE_POOL_CONNECT_MAX_BACKOFF_MS = 1_000;
const DEFAULT_POOL_CONNECT_TIMEOUT_MS = 10_000;
/**
 * pg-pool (3.13) emits this exact message as a bare Error, with no code or cause,
 * only from the pending-checkout timer. That timer keeps running after the waiter
 * is handed to a new dial. A new dial that hits connectionTimeoutMillis is
 * "Connection terminated due to connection timeout" (with cause) and stays retryable.
 */
const POOL_CAPACITY_WAIT_MESSAGE = 'timeout exceeded when trying to connect';

/**
 * Finite checkout budget: the 90s outage, the attempt already in flight when
 * the database returns, at most one backoff, and one recovering connect.
 * A checkout starts only when its full connect timeout still fits.
 */
function acquisitionRetryWindowMs(connectTimeoutMs: number): number {
  return SAFE_POOL_CONNECT_OUTAGE_MS + (2 * connectTimeoutMs) + SAFE_POOL_CONNECT_MAX_BACKOFF_MS;
}

function monotonicNow(): number {
  return globalThis.performance.now();
}

function poolConnectTimeoutMs(pool: Pool): number {
  const configured = pool.options?.connectionTimeoutMillis;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return configured;
  const fromEnv = Number(process.env.SULLA_DATABASE_CONNECT_TIMEOUT_MS ?? DEFAULT_POOL_CONNECT_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_POOL_CONNECT_TIMEOUT_MS;
}

function isPoolCapacityWait(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code !== 'string' && message === POOL_CAPACITY_WAIT_MESSAGE;
}

export class PostgresClient {
  private pool: Pool | null = null;
  private connected = false;
  private shuttingDown = false;
  private statementTimeout: AsyncLocalStorage<number> | null = IN_RENDERER ? null : new AsyncLocalStorage<number>();
  private readonly socketOutage = new DatabaseOutageState();
  private classifier: DatabaseUnavailableClassifier | null = null;

  /** Host port the pool connects to (honours SULLA_DATABASE_URL). */
  get databasePort(): number | undefined {
    const url = process.env.SULLA_DATABASE_URL;
    if (!url) return hostPort(30116);
    try {
      return Number(new URL(url).port || 5432);
    } catch {
      return undefined;
    }
  }

  /** Classifies errors that only mean "the database is not reachable right now". */
  get unavailableClassifier(): DatabaseUnavailableClassifier {
    this.classifier ??= new DatabaseUnavailableClassifier(this.databasePort);

    return this.classifier;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Password callback for the host pool. node-postgres calls it once for every
   * new connection, so a rotated service secret reaches the next connection
   * instead of staying pinned to the value read at boot. An arrow property so
   * the pool can call it unbound.
   */
  private readonly servicePassword = async(): Promise<string> => {
    // The provider reads settings, whose model imports this client. Load it only on use;
    // value() never syncs through this client, so it cannot wait on itself.
    const { serviceSecretProvider } = await import('../app/Providers/ServiceSecretServiceProvider');

    return serviceSecretProvider.value();
  };

  public async initialize(): Promise<void> {
    if (this.shuttingDown) return; // Don't reconnect during shutdown
    if (this.pool) return; // Already initialized

    const connectionString = process.env.SULLA_DATABASE_URL;
    // Read once up front so a secret that cannot be resolved still fails
    // initialize() as before; the pool then re-reads it per connection.
    if (!connectionString) await this.servicePassword();

    this.pool = new Pool({
      ...(connectionString ? { connectionString } : {
        host: '127.0.0.1', port: hostPort(30116), user: 'sulla', password: this.servicePassword, database: 'sulla',
      }),
      max:                     Number(process.env.SULLA_DATABASE_POOL_MAX ?? 20),
      idleTimeoutMillis:       30000,   // close idle after 30s
      keepAlive:               true,
      keepAliveInitialDelayMillis: 10_000,
      // Also bounds the wait for a free pooled client. That pending-checkout
      // timeout is pool capacity and is not retried, except while a socket
      // outage is already known. A stalled new dial is a different error and
      // is retried inside the acquisition window.
      connectionTimeoutMillis: Number(process.env.SULLA_DATABASE_CONNECT_TIMEOUT_MS ?? 10000),
    });

    // pg-pool only listens for 'error' on a client while it sits idle in the
    // pool and removes that listener while the client is checked out. When
    // Postgres restarts (VM stop, cold boot) every checked-out client emits
    // 'error' with no listener, and Node turns each one into an
    // UncaughtException "Connection terminated unexpectedly". Give every
    // client a permanent listener; the in-flight query still rejects with the
    // same error, so callers see the real failure.
    this.pool.on('connect', (client) => {
      client.on('error', err => this.handleSocketError('client', err));
      const downForMs = this.socketOutage.markAvailable();
      if (downForMs !== null) {
        console.log(`[PostgresPool] Connection restored after ${ Math.round(downForMs / 1000) }s`);
      }
    });
    this.pool.on('error', err => this.handleSocketError('idle client', err));

    await this.connect();
  }

  /**
   * A pooled socket died. Logged once per outage so a Postgres restart does
   * not print one line per open connection.
   */
  private handleSocketError(kind: 'client' | 'idle client', err: Error): void {
    this.connected = false;
    if (this.shuttingDown) return; // suppress noise during shutdown
    if (!this.unavailableClassifier.isUnavailable(err)) {
      console.error(`[PostgresPool] Unexpected error on ${ kind }`, err);

      return;
    }
    if (this.socketOutage.markUnavailable()) {
      console.warn(`[PostgresPool] Database connection lost (${ err.message }); pooled connections will reconnect when it is back`);
    }
  }

  /**
   * Connect to the database and set up search_path
   * @returns true if connection was successful, false otherwise
   */
  private async connect(): Promise<boolean> {
    if (this.connected) return true;

    try {
      const client = await this.pool!.connect();
      await client.query('SELECT 1');

      // Set search_path once on first connect (matches your psql behavior)
      await client.query(`SET search_path TO "$user", public`);

      client.release();
      this.connected = true;
      console.log('[PostgresClient] Pool connected and healthy');
      return true;
    } catch (error: any) {
      console.error('[PostgresClient] Pool init failed:', error.message);
      this.connected = false;
      return false;
    }
  }

  async getClient(): Promise<PoolClient> {
    if (this.shuttingDown) {
      throw new Error('PostgreSQL is shutting down — refusing new connections');
    }
    if (!this.connected) {
      await this.initialize();
    }
    const pool = this.pool;
    if (!pool) throw new Error('PostgreSQL pool is not initialized');
    // Retries stay inside this checkout, before any SQL. Per-thread saves already
    // wait for the whole call, so this does not add a process-wide write queue.
    const timeoutMs = poolConnectTimeoutMs(pool);
    const windowMs = acquisitionRetryWindowMs(timeoutMs);
    const startedAt = monotonicNow();
    let attempt = 0;
    let lastError: unknown;
    while (monotonicNow() - startedAt <= windowMs) {
      if (this.shuttingDown) throw new Error('PostgreSQL is shutting down — refusing new connections');
      const remainingMs = windowMs - (monotonicNow() - startedAt);
      if (remainingMs < timeoutMs) break;
      try {
        const client = await pool.connect();
        this.connected = true;
        const downForMs = this.socketOutage.markAvailable();
        if (downForMs !== null) console.log(`[PostgresPool] Connection restored after ${ Math.round(downForMs / 1000) }s`);
        return client;
      } catch (error) {
        if (isPoolCapacityWait(error)) {
          // Ordinary capacity surfaces once and never marks the pool disconnected.
          // While a socket outage is already known, every slot is a failing dial,
          // so a queued checkout timeout is that outage and rides the same window.
          if (this.shuttingDown || !this.socketOutage.isDown) throw error;
        } else {
          this.connected = false;
          if (this.shuttingDown || !this.unavailableClassifier.isUnavailable(error)) throw error;
          if (this.socketOutage.markUnavailable()) {
            console.warn('[PostgresPool] PostgreSQL client acquisition failed; retrying a safe connection checkout');
          }
        }
        lastError = error;
        const backoffRoomMs = windowMs - (monotonicNow() - startedAt) - timeoutMs;
        if (backoffRoomMs < 1) break;
        attempt += 1;
        const backoffMs = Math.min(250 * attempt, SAFE_POOL_CONNECT_MAX_BACKOFF_MS, backoffRoomMs);
        if (backoffMs < 1) break;
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
    if (lastError) throw lastError;
    throw new Error('PostgreSQL client acquisition retry window exhausted');
  }

  async withStatementTimeout<T>(timeoutMs: number, callback: () => Promise<T>): Promise<T> {
    const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));

    if (!this.statementTimeout) return callback();

    return this.statementTimeout.run(boundedTimeoutMs, callback);
  }

  private async applyStatementTimeout(client: PoolClient, local: boolean): Promise<boolean> {
    const timeoutMs = this.statementTimeout?.getStore();
    if (!timeoutMs) return false;
    await client.query("SELECT set_config('statement_timeout', $1, $2)", [`${ timeoutMs }ms`, local]);
    return true;
  }

  async queryWithResult<T extends QueryResultRow = any>(text: string, params: any[] = []): Promise<QueryResult<T>> {
    if (this.shuttingDown) {
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as QueryResult<T>;
    }
    const client = await this.getClient();
    let timeoutApplied = false;
    try {
      timeoutApplied = await this.applyStatementTimeout(client, false);
      const res = await client.query(text, params);
      return res;
    } finally {
      try {
        if (timeoutApplied) await client.query('RESET statement_timeout');
      } finally {
        client.release();
      }
    }
  }

  async query<T = any>(text: string, params: any[] = []): Promise<T[]> {
    if (this.shuttingDown) {
      return [];
    }
    const client = await this.getClient();
    let timeoutApplied = false;
    try {
      timeoutApplied = await this.applyStatementTimeout(client, false);
      const res = await client.query(text, params);
      return res.rows;
    } finally {
      try {
        if (timeoutApplied) await client.query('RESET statement_timeout');
      } finally {
        client.release();
      }
    }
  }

  async queryOne<T = any>(text: string, params: any[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async queryAll<T = any>(text: string, params: any[] = []): Promise<T[]> {
    return this.query<T>(text, params);
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      await this.applyStatementTimeout(client, true);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* preserve the original operation/commit error */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Wait until PostgreSQL is actually reachable from the host.
   * Called by ServiceLifecycleManager before DatabaseManager starts.
   *
   * The default is intentionally unbounded: the lifecycle manager treats a
   * rejected service start as permanently unavailable for this process, so a
   * finite boot retry budget can brick every DB-dependent service after a
   * slow cold start. Callers that need a bounded probe can still pass an
   * explicit maxAttempts value.
   */
  async waitForReady(maxAttempts = Number.POSITIVE_INFINITY, intervalMs = 1000): Promise<void> {
    for (let i = 1; i <= maxAttempts; i++) {
      let probe: Pool | null = null;
      // Outside the try: a secret that cannot be resolved rejects at once, as
      // before. Read per attempt so a secret that changes mid-wait is used.
      const password = await this.servicePassword();

      try {
        probe = new Pool({
          host:                    '127.0.0.1',
          port:                    hostPort(30116),
          user:                    'sulla',
          password,
          database:                'sulla',
          max:                     1,
          connectionTimeoutMillis: 2000,
        });
        // A socket that dies after the probe query must not become an
        // UncaughtException; the probe is ended right after anyway.
        probe.on('error', () => { /* probe is disposable */ });
        await probe.query('SELECT 1');
        console.log(`[PostgresClient] Host database port reachable (attempt ${ i })`);

        return;
      } catch (error: unknown) {
        const reason = this.describeConnectFailure(error);

        if (i === maxAttempts) {
          throw new Error(`PostgreSQL not reachable after ${ maxAttempts } attempts (${ reason.summary })`);
        }
        const attemptLabel = Number.isFinite(maxAttempts) ? `${ i }/${ maxAttempts }` : `${ i }`;
        if (reason.authFailed) {
          console.error(`[PostgresClient] waitForReady attempt ${ attemptLabel }: authentication failed (${ reason.summary }); the database rejected the service secret, retrying...`);
        } else {
          console.log(`[PostgresClient] waitForReady attempt ${ attemptLabel } failed (${ reason.summary }), retrying...`);
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      } finally {
        try { await probe?.end() } catch { /* ignore */ }
      }
    }
  }

  /**
   * Names why a readiness probe failed without echoing the error message,
   * which can carry connection details. A Postgres error reports its SQLSTATE
   * and class; a socket error its Node code. 28P01 (invalid_password) and 28000
   * (invalid_authorization_specification) mean the server answered but refused
   * the secret, which is not the same as "not up yet".
   */
  private describeConnectFailure(error: unknown): { authFailed: boolean; summary: string } {
    const { code, severity } = (error && typeof error === 'object' ? error : {}) as { code?: unknown; severity?: unknown };

    if (typeof code === 'string' && typeof severity === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return { authFailed: code === '28P01' || code === '28000', summary: `SQLSTATE ${ code }, class ${ code.slice(0, 2) }` };
    }
    if (typeof code === 'string' && /^[A-Z_]+$/.test(code)) {
      return { authFailed: false, summary: `unreachable: ${ code }` };
    }

    return { authFailed: false, summary: 'unreachable: no error code' };
  }

  async end(): Promise<void> {
    this.shuttingDown = true;
    if (!this.pool) return;

    try {
      await this.pool.end();
      console.log('[PostgresClient] Pool ended gracefully');
    } catch (err: any) {
      console.warn('[PostgresClient] Pool end warning:', err.message);
    } finally {
      this.pool = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export const postgresClient = new PostgresClient();
