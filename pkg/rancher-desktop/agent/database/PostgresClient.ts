// PostgresClient.ts — upgraded to pg.Pool + proper shutdown

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { SullaSettingsModel } from './models/SullaSettingsModel';

export class PostgresClient {
  private pool: Pool | null = null;
  private connected = false;

  public async initialize(): Promise<void> {
    if (this.pool) return; // Already initialized

    // Get password from settings
    const password = await SullaSettingsModel.get('sullaServicePassword', 'sulla_dev_password');

    this.pool = new Pool({
      host:                    '127.0.0.1',
      port:                    30116,
      user:                    'sulla',
      password,
      database:                'sulla',
      max:                     20,                    // max connections in pool
      idleTimeoutMillis:       30000,   // close idle after 30s
      connectionTimeoutMillis: 2000,
    });

    // Graceful pool error handling
    this.pool.on('error', (err) => {
      console.error('[PostgresPool] Unexpected error on idle client', err);
      this.connected = false;
    });

    await this.connect();
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
    if (!this.connected) {
      await this.initialize();
    }
    return this.pool!.connect();
  }

  async queryWithResult<T extends QueryResultRow = any>(text: string, params: any[] = []): Promise<QueryResult<T>> {
    const client = await this.getClient();
    try {
      const res = await client.query(text, params);
      return res;
    } finally {
      client.release();
    }
  }

  async query<T = any>(text: string, params: any[] = []): Promise<T[]> {
    const client = await this.getClient();
    try {
      const res = await client.query(text, params);
      return res.rows;
    } finally {
      client.release();
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
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Wait until PostgreSQL is actually reachable from the host.
   * Called by ServiceLifecycleManager before DatabaseManager starts.
   */
  async waitForReady(maxAttempts = 30, intervalMs = 1000): Promise<void> {
    const password = await SullaSettingsModel.get('sullaServicePassword', 'sulla_dev_password');

    for (let i = 1; i <= maxAttempts; i++) {
      let probe: Pool | null = null;

      try {
        probe = new Pool({
          host: '127.0.0.1', port: 30116, user: 'sulla',
          password, database: 'sulla', max: 1,
          connectionTimeoutMillis: 2000,
        });
        await probe.query('SELECT 1');
        console.log(`[PostgresClient] Host port 30116 reachable (attempt ${ i })`);

        return;
      } catch {
        if (i === maxAttempts) {
          throw new Error(`PostgreSQL not reachable after ${ maxAttempts } attempts`);
        }
        console.log(`[PostgresClient] waitForReady attempt ${ i }/${ maxAttempts } failed, retrying...`);
        await new Promise(r => setTimeout(r, intervalMs));
      } finally {
        try { await probe?.end(); } catch { /* ignore */ }
      }
    }
  }

  async end(): Promise<void> {
    if (!this.pool || !this.connected) return;

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
