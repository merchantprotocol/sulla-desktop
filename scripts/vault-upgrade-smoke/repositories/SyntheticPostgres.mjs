// SPDX-License-Identifier: GPL-2.0-or-later
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const POSTGRES_IMAGE = 'postgres:16-alpine';
const PG_PORT = 55432;

/** Throwaway PostgreSQL holding only synthetic vault rows. SQL runs from files through a one-shot psql container. */
export class SyntheticPostgres {
  constructor(runtime, name, workdir) {
    this.runtime = runtime;
    this.name = name;
    this.sqlDir = join(workdir, 'sql');
    this.password = randomBytes(18).toString('base64url');
    this.counter = 0;
    mkdirSync(this.sqlDir, { recursive: true, mode: 0o755 });
    chmodSync(this.sqlDir, 0o755);
  }

  get url() { return `postgresql://smoke:${ this.password }@127.0.0.1:${ PG_PORT }/vault_smoke`; }

  async start() {
    this.runtime.startAnchor(this.name, [
      '-e', 'POSTGRES_USER=smoke', '-e', `POSTGRES_PASSWORD=${ this.password }`,
      '-e', 'POSTGRES_DB=vault_smoke', '-e', `PGPORT=${ PG_PORT }`,
    ], POSTGRES_IMAGE);
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        if (this.query('SELECT 1') === '1') return;
      } catch { /* not accepting connections yet */ }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 1000));
    }
    throw new Error('synthetic PostgreSQL did not become ready');
  }

  query(sql) {
    const file = `q${ ++this.counter }.sql`;
    writeFileSync(join(this.sqlDir, file), `${ sql };\n`, { mode: 0o644 });
    return this.runtime.runOnce(
      ['-v', `${ this.sqlDir }:/sql:ro`, '-e', `PGPASSWORD=${ this.password }`],
      POSTGRES_IMAGE,
      ['psql', '-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'smoke', '-d', 'vault_smoke', '-v', 'ON_ERROR_STOP=1', '-At', '-f', `/sql/${ file }`],
    );
  }

  /** One line per item: id:sha256(full row text). */
  itemRows() {
    return this.query(`SELECT id::text || ':' || encode(sha256(convert_to(i::text, 'UTF8')), 'hex') FROM items i ORDER BY id`)
      .split('\n').filter(Boolean);
  }

  /** The vault key row: id:sha256(full row text):xmin:ctid. */
  keyRow() {
    return this.query(`SELECT id::text || ':' || encode(sha256(convert_to(u::text, 'UTF8')), 'hex') || ':' || xmin::text || ':' || ctid::text FROM users u ORDER BY id`)
      .split('\n').filter(Boolean);
  }
}
