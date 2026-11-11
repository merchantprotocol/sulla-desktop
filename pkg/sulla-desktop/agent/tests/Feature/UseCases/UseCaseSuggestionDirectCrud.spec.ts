// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Direct definition CRUD → suggestion index, end to end on the real schema:
// the Desktop migration registry runs on an in-process PGlite database
// (synthetic rows only), the real Skill/Agent/Workflow models write to it,
// and their post-commit announcements travel through the real
// RedisUseCaseChangeTransport over an in-memory Redis stand-in to a real
// UseCaseChangeBus feeding a real UseCaseSuggestionIndex.

import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { RedisPubSubConnection, UseCaseChangeTransport } from '../../../useCases/UseCaseChangeBus';
import type { UseCaseChangeEvent } from '../../../useCases/UseCaseSuggestionIndex';

const boundary = vi.hoisted(() => ({ db: undefined as any, redis: undefined as any }));

vi.mock('../../../database/PostgresClient', () => ({
  postgresClient: {
    query:    (sql: string, params?: unknown[]) => boundary.db.query(sql, params),
    queryAll: (sql: string, params?: unknown[]) => boundary.db.query(sql, params),
    queryOne: async(sql: string, params?: unknown[]) => (await boundary.db.query(sql, params))[0] ?? null,
  },
}));
vi.mock('../../../database/RedisClient', () => ({ redisClient: { getClient: () => boundary.redis } }));

const { migrationsRegistry } = await import('../../../database/migrations');
const { SkillDefinitionModel } = await import('../../../database/models/SkillDefinitionModel');
const { AgentDefinitionModel } = await import('../../../database/models/AgentDefinitionModel');
const { WorkflowModel } = await import('../../../database/models/WorkflowModel');
const { PostgresUseCaseCatalogSource } = await import('../../../useCases/PostgresUseCaseCatalogSource');
const { RedisUseCaseChangeTransport, UseCaseChangeAnnouncer, UseCaseChangeBus, USE_CASE_CHANGE_CHANNEL } = await import('../../../useCases/UseCaseChangeBus');
const { UseCaseSuggestionCompositionRoot, UseCaseSuggestionIndex } = await import('../../../useCases/UseCaseSuggestionIndex');

/** Real Postgres (WASM) with the Desktop migrations applied; PostgresClient-shaped `query`. */
class MigratedPglite {
  readonly db = new PGlite();
  readonly skipped: string[] = [];

  async migrate(): Promise<void> {
    const client = { query: (sql: string, params?: unknown[]) => this.raw(sql, params) };
    for (const migration of migrationsRegistry) {
      await this.db.exec('BEGIN');
      try {
        if (typeof migration.up === 'function') await migration.up(client as any);
        else await this.db.exec(migration.up);
        await this.db.exec('COMMIT');
      } catch (error) {
        // Only extension-backed migrations (pg_trgm, pgcrypto, pg_stat_statements) and their dependants fail here.
        await this.db.exec('ROLLBACK');
        this.skipped.push(`${ migration.name }: ${ String(error).slice(0, 80) }`);
      }
    }
  }

  async query<T = any>(sql: string, params?: unknown[]): Promise<T[]> { return (await this.raw(sql, params)).rows as T[] }

  private async raw(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (params?.length) {
      const result = await this.db.query(sql, params as any[]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }
    const results = await this.db.exec(sql);
    const last = results.at(-1);
    return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0 };
  }
}

/** In-memory stand-in for ioredis pub/sub: same surface the transport uses, asynchronous delivery. */
class MemoryRedisHub {
  status = 'ready';
  readonly subscribers = new Set<MemoryRedisConnection>();
  connection(): MemoryRedisConnection { return new MemoryRedisConnection(this) }
}
class MemoryRedisConnection implements RedisPubSubConnection {
  private readonly channels = new Set<string>();
  private readonly messageListeners: ((channel: string, message: string) => void)[] = [];
  constructor(private readonly hub: MemoryRedisHub) {}
  get status(): string { return this.hub.status }
  async publish(channel: string, message: string): Promise<number> {
    let receivers = 0;
    for (const subscriber of this.hub.subscribers) {
      if (!subscriber.channels.has(channel)) continue;
      receivers++;
      setTimeout(() => subscriber.messageListeners.forEach(listener => listener(channel, message)), 0);
    }
    return receivers;
  }
  async subscribe(channel: string): Promise<unknown> { this.channels.add(channel); this.hub.subscribers.add(this); return 1 }
  async unsubscribe(channel: string): Promise<unknown> { this.channels.delete(channel); return 0 }
  on(event: string, listener: (...args: any[]) => void): unknown { if (event === 'message') this.messageListeners.push(listener); return this }
  duplicate(): RedisPubSubConnection { return new MemoryRedisConnection(this.hub) }
  disconnect(): void { this.hub.subscribers.delete(this) }
}

/** Deterministic bag-of-words embedder: cosine equals word overlap, so ranking is predictable. */
class WordEmbedder {
  readonly dim = 128;
  embed(text: string): Float32Array {
    const vector = new Float32Array(this.dim);
    for (const word of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
      let hash = 0;
      for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % this.dim;
      vector[hash] += 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map(value => value / norm);
  }
}

/** Real catalog source that counts full-catalog reads, so a test can prove an update came from an event, not a reconcile. */
class CountingCatalogSource extends PostgresUseCaseCatalogSource {
  fingerprints = 0;
  lists = 0;
  override async fingerprint(): Promise<string> { this.fingerprints++; return super.fingerprint() }
  override async listPublished() { this.lists++; return super.listPublished() }
}

const quiet = { info: () => {} };
const BUILTIN = ['ledger-close-helper', 'payroll-helper'];
const database = new MigratedPglite();
const hub = new MemoryRedisHub();

class Harness {
  readonly source = new CountingCatalogSource(database, BUILTIN);
  readonly bus = new UseCaseChangeBus(new RedisUseCaseChangeTransport({ getClient: () => hub.connection() }), quiet);
  readonly clock = { t: 1_000 };
  readonly index: InstanceType<typeof UseCaseSuggestionIndex>;
  constructor(reconcileEveryMs = 1e12) {
    this.index = new UseCaseSuggestionIndex(async() => new WordEmbedder(), this.source, this.bus, quiet, () => this.clock.t, { reconcileEveryMs });
  }
  async start(): Promise<void> { await this.bus.start(); await this.index.warm() }
  async slugs(text: string): Promise<string[]> { return (await this.index.suggest(text, { limit: 50 })).map(row => `${ row.type }:${ row.slug }`) }
  async stop(): Promise<void> { this.index.dispose(); await this.bus.stop() }
}

beforeAll(async() => {
  await database.migrate();
  boundary.db = database;
  boundary.redis = hub.connection();
  for (const table of ['skill_definitions', 'agent_definitions', 'workflows', 'function_definitions', 'recipe_definitions', 'installed_package_items', 'workflow_history']) {
    expect((await database.query(`SELECT to_regclass($1) AS t`, [table]))[0].t, `${ table } must exist after migrations`).not.toBeNull();
  }
}, 180_000);

afterAll(async() => { await database.db.close() });

describe('direct definition CRUD invalidates suggestions through the change bus', () => {
  it('skill create, update, disable and delete through SkillDefinitionModel reach the index without a reconcile', async() => {
    // risk: data accuracy — UI edits and agent tools write the model directly; suggestions must follow within one event.
    const h = new Harness();
    await h.start();
    const reads = { fingerprints: h.source.fingerprints, lists: h.source.lists };

    const created = await SkillDefinitionModel.create({ slug: 'ledger-close-helper', title: 'Ledger close helper', description: 'month end ledger close checklist' });
    await vi.waitFor(async() => expect(await h.slugs('month end ledger close')).toContain('skill:ledger-close-helper'));

    await SkillDefinitionModel.update(created.id, { description: 'quarterly tax filing checklist' });
    await vi.waitFor(async() => expect(await h.slugs('quarterly tax filing')).toContain('skill:ledger-close-helper'));
    expect(await h.slugs('month end')).not.toContain('skill:ledger-close-helper');

    await SkillDefinitionModel.update(created.id, { enabled: false });
    await vi.waitFor(async() => expect(await h.slugs('quarterly tax filing')).not.toContain('skill:ledger-close-helper'));

    await SkillDefinitionModel.update(created.id, { enabled: true });
    await vi.waitFor(async() => expect(await h.slugs('quarterly tax filing')).toContain('skill:ledger-close-helper'));
    await SkillDefinitionModel.update(created.id, { deleted: true });
    await vi.waitFor(async() => expect(await h.slugs('quarterly tax filing')).not.toContain('skill:ledger-close-helper'));

    expect({ fingerprints: h.source.fingerprints, lists: h.source.lists }).toEqual(reads);
    await h.stop();
  });

  it('a draft skill written directly never reaches suggestions', async() => {
    // risk: data accuracy — Jonathon's rule: drafts must never reach agent context.
    const h = new Harness();
    await h.start();
    const draft = await SkillDefinitionModel.create({ slug: `draft-${ randomUUID().slice(0, 8) }`, title: 'Draft payroll runner', description: 'unpublished payroll runner draft' });
    await SkillDefinitionModel.update(draft.id, { description: 'unpublished payroll runner draft edited' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await h.slugs('unpublished payroll runner draft')).filter(slug => slug.includes(draft.slug))).toEqual([]);
    await h.stop();
  });

  it('agent create, update and delete through AgentDefinitionModel reach the index', async() => {
    // risk: data accuracy — the team directory must drop a deleted agent immediately.
    const h = new Harness();
    await h.start();
    const reads = h.source.fingerprints;
    const agent = await AgentDefinitionModel.create({ slug: 'freight-quoter', name: 'Freight quoter', description: 'quotes freight shipping rates', status: 'production' });
    await vi.waitFor(async() => expect(await h.slugs('freight shipping rates')).toContain('agent:freight-quoter'));

    await AgentDefinitionModel.update(agent.id, { description: 'drafts warehouse inventory reports' });
    await vi.waitFor(async() => expect(await h.slugs('warehouse inventory reports')).toContain('agent:freight-quoter'));

    await AgentDefinitionModel.setStatus(agent.id, 'draft');
    await vi.waitFor(async() => expect(await h.slugs('warehouse inventory reports')).not.toContain('agent:freight-quoter'));
    await AgentDefinitionModel.setStatus(agent.id, 'production');
    await vi.waitFor(async() => expect(await h.slugs('warehouse inventory reports')).toContain('agent:freight-quoter'));

    expect(await AgentDefinitionModel.delete(agent.id)).toBe(true);
    await vi.waitFor(async() => expect(await h.slugs('warehouse inventory reports')).not.toContain('agent:freight-quoter'));
    expect(h.source.fingerprints).toBe(reads);
    await h.stop();
  });

  it('workflow upsert, disable, enable and delete through WorkflowModel reach the index', async() => {
    // risk: data accuracy — set_workflow_status and canvas saves must update suggestions; a disabled routine must not be offered.
    const h = new Harness();
    await h.start();
    const reads = h.source.fingerprints;
    await WorkflowModel.upsertFromDefinition({ id: 'invoice-chaser', name: 'Invoice chaser', description: 'chases overdue customer invoices' }, { status: 'production' });
    await vi.waitFor(async() => expect(await h.slugs('chase overdue customer invoices')).toContain('workflow:invoice-chaser'));

    expect(await WorkflowModel.setEnabled('invoice-chaser', false)).toBe(true);
    await vi.waitFor(async() => expect(await h.slugs('chase overdue customer invoices')).not.toContain('workflow:invoice-chaser'));
    await WorkflowModel.setEnabled('invoice-chaser', true);
    await vi.waitFor(async() => expect(await h.slugs('chase overdue customer invoices')).toContain('workflow:invoice-chaser'));

    await WorkflowModel.updateStatus('invoice-chaser', 'draft');
    await vi.waitFor(async() => expect(await h.slugs('chase overdue customer invoices')).not.toContain('workflow:invoice-chaser'));
    await WorkflowModel.updateStatus('invoice-chaser', 'production');
    await vi.waitFor(async() => expect(await h.slugs('chase overdue customer invoices')).toContain('workflow:invoice-chaser'));

    await WorkflowModel.deleteById('invoice-chaser');
    await vi.waitFor(async() => expect(await h.slugs('chase overdue customer invoices')).not.toContain('workflow:invoice-chaser'));
    expect(h.source.fingerprints).toBe(reads);
    await h.stop();
  });
});

describe('post-commit safety', () => {
  it('a committed write succeeds while Redis is down, and the fingerprint reconcile repairs the index', async() => {
    // risk: irreversible side effects — a broadcast failure must never fail or roll back a committed write.
    const h = new Harness(15_000);
    await h.start();
    const created = await SkillDefinitionModel.create({ slug: 'payroll-helper', title: 'Payroll helper', description: 'biweekly payroll export' });
    await vi.waitFor(async() => expect(await h.slugs('biweekly payroll export')).toContain('skill:payroll-helper'));

    hub.status = 'connecting';
    try {
      const updated = await SkillDefinitionModel.update(created.id, { description: 'contractor timesheet approvals' });
      expect(updated?.description).toBe('contractor timesheet approvals');
      expect((await database.query(`SELECT description FROM skill_definitions WHERE id=$1`, [created.id]))[0].description).toBe('contractor timesheet approvals');
      await new Promise(resolve => setTimeout(resolve, 20));
      // The hint was lost, so the index is stale until the backstop runs.
      expect(await h.slugs('contractor timesheet approvals')).not.toContain('skill:payroll-helper');
    } finally { hub.status = 'ready' }

    h.clock.t += 15_001;
    await h.index.suggest('contractor timesheet approvals');
    await vi.waitFor(async() => expect(await h.slugs('contractor timesheet approvals')).toContain('skill:payroll-helper'));
    await SkillDefinitionModel.update(created.id, { deleted: true });
    await h.stop();
  });

  it('an announcer whose transport throws synchronously never throws to the writer', () => {
    // risk: irreversible side effects — announce runs after commit and must not surface as a write failure.
    const announcer = new UseCaseChangeAnnouncer({ publish: () => { throw new Error('boom') }, subscribe: async() => async() => undefined } as any, quiet);
    expect(() => announcer.announce({ type: 'skill', slug: 'x', change: 'updated' })).not.toThrow();
  });
});

describe('cross-process delivery', () => {
  it('delivers another process\'s change once, the bus\'s own change once, and ignores malformed broadcasts', async() => {
    // risk: data accuracy — an echo must not double-apply, and garbage on the channel must not reach the index.
    const bus = new UseCaseChangeBus(new RedisUseCaseChangeTransport({ getClient: () => hub.connection() }), quiet);
    const seen: string[] = [];
    bus.subscribe(event => seen.push(`${ event.change }:${ event.type }:${ event.slug }`));
    await bus.start();

    new UseCaseChangeAnnouncer(new RedisUseCaseChangeTransport({ getClient: () => hub.connection() }), quiet).announce({ type: 'recipe', slug: 'other-process', change: 'installed' });
    bus.announce({ type: 'function', slug: 'same-process', change: 'updated' });
    const raw = hub.connection();
    await raw.publish(USE_CASE_CHANGE_CHANNEL, 'not json');
    await raw.publish(USE_CASE_CHANGE_CHANNEL, JSON.stringify({ v: 1, origin: 'x', type: 'integration', slug: 'nope', change: 'updated' }));
    await raw.publish(USE_CASE_CHANGE_CHANNEL, JSON.stringify({ v: 1, origin: 'x', type: 'skill', slug: '', change: 'updated' }));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(seen.sort()).toEqual(['installed:recipe:other-process', 'updated:function:same-process']);
    await bus.stop();
  });
});

describe('PostgresUseCaseCatalogSource SQL on the migrated schema', () => {
  it('lists, finds and fingerprints exactly the published rows', async() => {
    // risk: data accuracy — published-only filters run against the real column types, not a fake DB.
    const id = () => randomUUID();
    await database.query(`INSERT INTO skill_definitions (id,slug,title,description,tags,triggers,use_case_version_id) VALUES
      ('s1','sql-published-skill','Published skill','published skill body',ARRAY['finance'],ARRAY['close the books'],$1),
      ('s2','sql-draft-skill','Draft skill','draft only',ARRAY[]::text[],ARRAY[]::text[],NULL)`, [id()]);
    await database.query(`INSERT INTO skill_definitions (id,slug,title,description,use_case_version_id,deleted_at) VALUES ('s3','sql-deleted-skill','Deleted','gone',$1,now())`, [id()]);
    await database.query(`INSERT INTO agent_definitions (id,slug,name,description,status,enabled,when_to_call) VALUES
      ('a1','sql-prod-agent','Prod agent','ships things','production',true,'when shipping'),
      ('a2','sql-draft-agent','Draft agent','not yet','draft',true,''),
      ('a3','sql-off-agent','Off agent','paused','production',false,'')`);
    await database.query(`INSERT INTO workflows (id,name,description,status,enabled,definition) VALUES
      ('sql-prod-flow','Prod flow','runs monthly','production',true,$1::jsonb),
      ('sql-draft-flow','Draft flow','not yet','draft',true,'{}'::jsonb)`,
    [JSON.stringify({ spec: { inputs: { month: { label: 'Month', required: true }, apiToken: { label: 'API token' } } }, nodes: [{ config: { password: 'never-indexed' } }] })]);
    await database.query(`INSERT INTO function_definitions (slug,name,description,manifest,runtime,source_kind,use_case_version_id) VALUES
      ('sql-published-fn','Published fn','published function','{}'::jsonb,'python','user',$1),
      ('sql-draft-fn','Draft fn','user draft','{}'::jsonb,'python','user',NULL),
      ('sql-packaged-fn','Packaged fn','from a package','{}'::jsonb,'node','user',NULL)`, [id()]);
    await database.query(`INSERT INTO installed_packages (slug,template_id,version,name,title,manifest) VALUES ('sql-pack','tpl-sql-pack','1.0.0','sql-pack','SQL pack','{}'::jsonb)`);
    await database.query(`INSERT INTO installed_package_items (package_slug,kind,item_slug,installed_template_id) VALUES ('sql-pack','function','sql-packaged-fn','tpl-sql-pack')`);
    await database.query(`INSERT INTO recipe_definitions (slug,name,description,manifest,compose,source_kind) VALUES
      ('sql-market-recipe','Market recipe','from marketplace','{}'::jsonb,'services: {}','marketplace'),
      ('sql-user-recipe','User recipe','user draft','{}'::jsonb,'services: {}','user')`);

    const source = new PostgresUseCaseCatalogSource(database, ['sql-builtin-skill']);
    const listed = (await source.listPublished()).filter(row => row.slug.startsWith('sql-')).map(row => `${ row.type }:${ row.slug }`).sort();
    expect(listed).toEqual(['agent:sql-prod-agent', 'function:sql-packaged-fn', 'function:sql-published-fn', 'recipe:sql-market-recipe', 'skill:sql-published-skill', 'workflow:sql-prod-flow']);

    const skill = await source.findPublished('skill', 'sql-published-skill');
    expect(skill).toMatchObject({ title: 'Published skill', tags: ['finance'], triggers: ['close the books'] });
    expect(await source.findPublished('skill', 'sql-draft-skill')).toBeNull();
    expect(await source.findPublished('agent', 'sql-off-agent')).toBeNull();
    expect(await source.findPublished('function', 'sql-draft-fn')).toBeNull();
    expect(await source.findPublished('recipe', 'sql-user-recipe')).toBeNull();
    const flow = await source.findPublished('workflow', 'sql-prod-flow');
    expect(flow?.inputs).toEqual([{ name: 'month', label: 'Month', required: true }]);
    expect(JSON.stringify(flow)).not.toContain('never-indexed');

    const first = await source.fingerprint();
    expect(await source.fingerprint()).toBe(first);
    await database.query(`UPDATE skill_definitions SET body='internal body only' WHERE id='s1'`);
    expect(await source.fingerprint()).toBe(first);
    await database.query(`UPDATE skill_definitions SET description='published skill changed' WHERE id='s1'`);
    const changed = await source.fingerprint();
    expect(changed).not.toBe(first);
    await database.query(`UPDATE agent_definitions SET enabled=false WHERE id='a1'`);
    expect(await source.fingerprint()).not.toBe(changed);
  });
});

describe('bus lifecycle', () => {
  it('stop never waits on a subscription that is still connecting', async() => {
    // risk: availability — Redis down at shutdown must not hang app quit.
    const never: RedisPubSubConnection = Object.assign(hub.connection(), { subscribe: () => new Promise<unknown>(() => undefined) });
    const bus = new UseCaseChangeBus(new RedisUseCaseChangeTransport({ getClient: () => ({ ...never, status: 'ready', duplicate: () => never } as any) }), quiet);
    void bus.start();
    const outcome = await Promise.race([bus.stop().then(() => 'stopped'), new Promise(resolve => setTimeout(() => resolve('hung'), 200))]);
    expect(outcome).toBe('stopped');
  });
});

describe('per-operation publisher injection', () => {
  it('model writes announce on the publisher the caller injects, after the row commits', async() => {
    // risk: data accuracy — writers own their publisher per call; no hidden model-level service.
    const heard: UseCaseChangeEvent[] = [];
    const publisher = { announce: (event: UseCaseChangeEvent) => { heard.push(event) } };
    const skill = await SkillDefinitionModel.create({ slug: `inj-${ randomUUID().slice(0, 8) }`, title: 'Injected', description: 'x' }, publisher);
    await SkillDefinitionModel.update(skill.id, { enabled: false }, undefined, publisher);
    const agent = await AgentDefinitionModel.create({ slug: `inj-agent-${ randomUUID().slice(0, 8) }`, name: 'Injected agent', status: 'production' }, publisher);
    await AgentDefinitionModel.setStatus(agent.id, 'draft', publisher);
    await AgentDefinitionModel.delete(agent.id, publisher);
    await WorkflowModel.upsertFromDefinition({ id: 'inj-flow', name: 'Injected flow' }, { status: 'production', useCaseChanges: publisher });
    await WorkflowModel.setEnabled('inj-flow', false, publisher);
    await WorkflowModel.updateStatus('inj-flow', 'draft', { useCaseChanges: publisher });
    await WorkflowModel.deleteById('inj-flow', { useCaseChanges: publisher });
    expect(heard.map(event => `${ event.change }:${ event.type }`)).toEqual([
      'updated:skill', 'updated:skill', 'updated:agent', 'updated:agent', 'deleted:agent',
      'updated:workflow', 'updated:workflow', 'updated:workflow', 'deleted:workflow',
    ]);
    // A compare-and-set miss writes nothing and announces nothing.
    const before = heard.length;
    expect(await SkillDefinitionModel.update(skill.id, { description: 'y' }, '2000-01-01T00:00:00Z', publisher)).toBeNull();
    expect(heard.length).toBe(before);
  });
});

describe('transport and start-order failures', () => {
  it('disconnects the duplicate connection when subscribe rejects', async() => {
    // risk: resource leak — a failed subscribe must not leave a retrying Redis connection behind.
    let disconnected = 0;
    const failing = Object.assign(hub.connection(), {
      subscribe: async() => { throw new Error('NOPERM') },
      disconnect: () => { disconnected++ },
    });
    const transport = new RedisUseCaseChangeTransport({ getClient: () => ({ status: 'ready', duplicate: () => failing } as any) });
    await expect(transport.subscribe(USE_CASE_CHANGE_CHANNEL, () => undefined)).rejects.toThrow('NOPERM');
    expect(disconnected).toBe(1);
  });

  it('disconnects without waiting for unsubscribe when subscribe rejects offline', async() => {
    // risk: availability — an unsubscribe that never resolves must not hang startup.
    let disconnected = 0;
    const failing = Object.assign(hub.connection(), {
      subscribe: async() => { throw new Error('offline') },
      unsubscribe: () => new Promise<never>(() => undefined),
      disconnect: () => { disconnected++ },
    });
    const transport = new RedisUseCaseChangeTransport({ getClient: () => ({ status: 'ready', duplicate: () => failing } as any) });
    await expect(transport.subscribe(USE_CASE_CHANGE_CHANNEL, () => undefined)).rejects.toThrow('offline');
    expect(disconnected).toBe(1);
  });

  it('a write committed while the subscription is still connecting is indexed once it connects, without the 15 s backstop', async() => {
    // risk: data accuracy — events fired before the subscription lands must not be lost until the next reconcile.
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve });
    const redis = new RedisUseCaseChangeTransport({ getClient: () => hub.connection() });
    const gated: UseCaseChangeTransport = {
      publish:   (channel, message) => redis.publish(channel, message),
      subscribe: async(channel, onMessage) => { await gate; return redis.subscribe(channel, onMessage) },
    };
    const root = new UseCaseSuggestionCompositionRoot(database, ['gate-skill'], gated, async() => new WordEmbedder());
    root.start();
    await vi.waitFor(() => expect(root.index.isReady).toBe(true));

    const skill = await SkillDefinitionModel.create({ slug: 'gate-skill', title: 'Gate skill', description: 'vendor onboarding packet' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await root.index.suggest('vendor onboarding packet')).map(row => row.slug)).not.toContain('gate-skill');

    open();
    await vi.waitFor(async() => expect((await root.index.suggest('vendor onboarding packet')).map(row => row.slug)).toContain('gate-skill'));
    root.stop();
    await SkillDefinitionModel.update(skill.id, { deleted: true });
  });
});
