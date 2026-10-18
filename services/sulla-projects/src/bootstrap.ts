import { Pool } from 'pg';

import type { ProjectsConfig } from './config.js';

const ident = (value: string) => `"${ value.replace(/"/g, '""') }"`;
const literal = (value: string) => `'${ value.replace(/'/g, "''") }'`;

/** Idempotently creates the isolated Projects database and least-privilege runtime role. */
export async function bootstrapDatabase(config: ProjectsConfig): Promise<void> {
  if (!config.adminDatabaseUrl) return;
  if (!config.runtimePassword) throw new Error('SULLA_PROJECTS_DATABASE_PASSWORD is required for database bootstrap');
  const pool = new Pool({ connectionString: config.adminDatabaseUrl, max: 1 });
  try {
    const role = ident(config.runtimeRole);
    const password = literal(config.runtimePassword);
    const exists = await pool.query<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists', [config.runtimeRole]);
    if (exists.rows[0]?.exists) {
      await pool.query(`ALTER ROLE ${ role } LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${ password }`);
    } else {
      await pool.query(`CREATE ROLE ${ role } LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${ password }`);
    }
    const database = await pool.query<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS exists', [config.databaseName]);
    if (!database.rows[0]?.exists) {
      await pool.query(`CREATE DATABASE ${ ident(config.databaseName) } OWNER ${ ident(config.databaseOwner) }`);
    }
    await pool.query(`GRANT CONNECT ON DATABASE ${ ident(config.databaseName) } TO ${ role }`);
  } finally { await pool.end() }
}
