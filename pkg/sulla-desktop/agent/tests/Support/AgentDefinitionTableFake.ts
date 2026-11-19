// SPDX-License-Identifier: GPL-2.0-or-later
// In-memory stand-in for the agent_definitions table and the built-in seed ledger.
// It answers the exact SQL AgentDefinitionModel and seedBuiltinAgents send, stores
// jsonb columns as objects the way pg returns them, and keeps compare-and-set on
// updated_at. Specs pass it to a mocked postgresClient so the real model code
// (category policy, rowToDefinition, front-door marker) builds every row they read.

const JSONB_COLUMNS = new Set(['model_priority', 'config', 'prompt_files', 'model_choice']);

type Row = Record<string, unknown>;

function columnValue(column: string, value: unknown): unknown {
  return JSONB_COLUMNS.has(column) && typeof value === 'string' ? JSON.parse(value) : value;
}

export class AgentDefinitionTableFake {
  readonly rows = new Map<string, Row>();
  readonly ledger = new Set<string>();
  /** Every agent_definitions UPDATE that matched a row, in order. */
  readonly updates: { id: string; columns: Row }[] = [];
  private clock = Date.parse('2026-11-18T00:00:00.000Z');

  /** A stored row exactly as pg would return it (for assertions). */
  stored(slug: string): Row | undefined {
    const row = [...this.rows.values()].find(item => item.slug === slug);
    return row ? structuredClone(row) : undefined;
  }

  /** Simulate a write from outside the seeder (editor, SQL, tool). */
  write(slug: string, columns: Row): void {
    const row = [...this.rows.values()].find(item => item.slug === slug);
    if (!row) throw new Error(`No row ${ slug }`);
    for (const [column, value] of Object.entries(columns)) row[column] = columnValue(column, value);
    row.updated_at = this.tick();
  }

  query(sql: string, params: unknown[] = []): Promise<Row[]> {
    return Promise.resolve().then(() => this.runQuery(sql, params));
  }

  queryOne(sql: string, params: unknown[] = []): Promise<Row | null> {
    return Promise.resolve().then(() => this.runQueryOne(sql, params));
  }

  private runQuery(sql: string, params: unknown[]): Row[] {
    if (sql.includes('SELECT slug FROM agent_builtin_seed_ledger')) return [...this.ledger].map(slug => ({ slug }));
    if (sql.includes('INSERT INTO agent_builtin_seed_ledger')) {
      this.ledger.add(String(params[0]));
      return [];
    }
    throw new Error(`AgentDefinitionTableFake: unexpected query ${ sql }`);
  }

  private runQueryOne(sql: string, params: unknown[]): Row | null {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('SELECT * FROM agent_definitions WHERE id = $1')) return this.copy(this.rows.get(String(params[0])));
    if (text.startsWith('SELECT * FROM agent_definitions WHERE slug = $1')) return this.copy([...this.rows.values()].find(row => row.slug === params[0]));
    if (text.startsWith('INSERT INTO agent_definitions (')) return this.insert(text, params);
    if (text.startsWith('UPDATE agent_definitions SET front_door = $2 WHERE slug = $1 AND front_door IS NULL AND NOT jsonb_exists(config, $3)')) {
      const row = [...this.rows.values()].find(item => item.slug === params[0]);
      if (row?.front_door !== null || Object.prototype.hasOwnProperty.call(row.config ?? {}, String(params[2]))) return null;
      row.front_door = params[1];
      return { id: row.id };
    }
    if (text.startsWith('UPDATE agent_definitions SET ')) return this.update(text, params);
    throw new Error(`AgentDefinitionTableFake: unexpected queryOne ${ text }`);
  }

  private insert(text: string, params: unknown[]): Row {
    const columns = /^INSERT INTO agent_definitions \((.*?)\) VALUES/.exec(text)![1].split(',').map(column => column.trim());
    if (columns.length !== params.length) throw new Error('AgentDefinitionTableFake: column/parameter mismatch');
    if ([...this.rows.values()].some(row => row.slug === params[columns.indexOf('slug')])) throw new Error('duplicate key value violates unique constraint "agent_definitions_slug_key"');
    const row: Row = Object.fromEntries(columns.map((column, index) => [column, columnValue(column, params[index])]));
    row.created_at = this.tick();
    row.updated_at = row.created_at;
    this.rows.set(String(row.id), row);
    return structuredClone(row);
  }

  private update(text: string, params: unknown[]): Row | null {
    const [, setText, whereText] = /^UPDATE agent_definitions SET (.*) WHERE (.*) RETURNING \*$/.exec(text)!;
    const id = String(params[Number(/id = \$(\d+)/.exec(whereText)![1]) - 1]);
    const row = this.rows.get(id);
    if (!row) return null;
    const cas = /updated_at - \$(\d+)::timestamptz/.exec(whereText);
    if (cas) {
      const expected = Date.parse(String(params[Number(cas[1]) - 1]));
      if (Math.abs((row.updated_at as Date).getTime() - expected) >= 2) return null;
    }
    const columns: Row = {};
    for (const match of setText.matchAll(/(\w+) = \$(\d+)/g)) columns[match[1]] = columnValue(match[1], params[Number(match[2]) - 1]);
    Object.assign(row, columns);
    row.updated_at = this.tick();
    this.updates.push({ id, columns: structuredClone(columns) });
    return structuredClone(row);
  }

  private tick(): Date {
    this.clock += 1000;
    return new Date(this.clock);
  }

  private copy(row: Row | undefined): Row | null {
    return row ? structuredClone(row) : null;
  }
}
