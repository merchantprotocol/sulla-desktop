/** Enable query instrumentation when the PostgreSQL container preloads it. */
export const up = `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`;
export const down = `DROP EXTENSION IF EXISTS pg_stat_statements;`;
