import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

interface ProjectsDatabaseContext { tenantId: string; client?: PoolClient }
const databaseContext = new AsyncLocalStorage<ProjectsDatabaseContext>();

export class ProjectsDatabase {
  private readonly pool: Pool;
  constructor(connectionString: string, max = 12) {
    this.pool = new Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  }
  withTenant<T>(tenantId: string, callback: () => Promise<T>): Promise<T> {
    const normalized = tenantId.trim();
    if (!normalized || normalized.length > 200) throw new Error('Projects tenant identity is invalid');
    const current = databaseContext.getStore();
    if (current?.client && current.tenantId !== normalized) throw new Error('Projects transaction cannot switch tenants');
    if (current?.tenantId === normalized) return callback();
    return databaseContext.run({ tenantId: normalized }, callback);
  }
  currentTenant(): string {
    const tenantId = databaseContext.getStore()?.tenantId;
    if (!tenantId) throw new Error('Projects database access requires an authenticated tenant');
    return tenantId;
  }
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const context = databaseContext.getStore();
    if (!context) throw new Error('Projects database access requires an authenticated tenant');
    if (context.client) return callback(context.client);
    const client = await this.pool.connect();
    let reusable = true;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [this.currentTenant()]);
      const result = await databaseContext.run({ tenantId: context.tenantId, client }, () => callback(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { reusable = false }
      throw error;
    } finally { client.release(reusable ? undefined : new Error('Projects transaction rollback failed')) }
  }
  async queryWithResult<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    const client = databaseContext.getStore()?.client;
    if (client) return client.query<T>(sql, values);
    return this.transaction(client => client.query<T>(sql, values));
  }
  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
    return (await this.queryWithResult(sql, values)).rows as T[];
  }
  async queryOne<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T | null> {
    return (await this.query<T>(sql, values))[0] ?? null;
  }
  async healthcheck(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ unsafe: boolean }>(`SELECT rolsuper OR rolbypassrls AS unsafe
        FROM pg_roles WHERE rolname=current_user`);
      if (result.rows.length !== 1 || result.rows[0].unsafe) {
        throw new Error('Projects runtime database role must enforce row-level security');
      }
    } finally { client.release() }
  }
  end(): Promise<void> { return this.pool.end() }
}

let configured: ProjectsDatabase | undefined;
export function configureProjectsDatabase(connectionString: string): ProjectsDatabase {
  if (configured) throw new Error('Projects database is already configured');
  configured = new ProjectsDatabase(connectionString);
  return configured;
}
export function getProjectsDatabase(): ProjectsDatabase {
  if (!configured) throw new Error('Projects database has not been configured');
  return configured;
}

/** Compatibility-shaped facade for service-owned persistence modules. */
export const postgresClient = {
  query: <T = Record<string, unknown>>(sql: string, values?: unknown[]) => getProjectsDatabase().query<T>(sql, values),
  queryOne: <T = Record<string, unknown>>(sql: string, values?: unknown[]) => getProjectsDatabase().queryOne<T>(sql, values),
  queryAll: <T = Record<string, unknown>>(sql: string, values?: unknown[]) => getProjectsDatabase().query<T>(sql, values),
  queryWithResult: <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) => getProjectsDatabase().queryWithResult<T>(sql, values),
  transaction: <T>(callback: (client: PoolClient) => Promise<T>) => getProjectsDatabase().transaction(callback),
};
