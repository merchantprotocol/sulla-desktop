/**
 * Real-Postgres check of the SQL recall fast path and the writer's
 * paraphrase gate. Opt-in (SUBCONSCIOUS_PG_IT=1): needs the local Sulla
 * Postgres. Creates and drops its own scratch database; never touches `sulla`.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { Pool } from 'pg';

const run = process.env.SUBCONSCIOUS_PG_IT === '1' ? describe : describe.skip;
const conn = { host: '127.0.0.1', port: Number(process.env.SULLA_PG_PORT ?? 30116), user: 'sulla', password: process.env.SULLA_PG_PASSWORD ?? 'sulla_dev_password' };
const dbName = `sulla_subc_it_${ process.pid }_${ Date.now() }`;
const holder: { pool: Pool | null } = { pool: null };

jest.unstable_mockModule('../../PostgresClient', () => ({
  postgresClient: {
    query:    async(sql: string, params: unknown[] = []) => (await holder.pool!.query(sql, params as any[])).rows,
    queryAll: async(sql: string, params: unknown[] = []) => (await holder.pool!.query(sql, params as any[])).rows,
  },
}));

const { IdentityObservationsModel } = await import('../IdentityObservationsModel');
const { ConversationKeywordsModel } = await import('../ConversationKeywordsModel');
const { up: keywordsTable } = await import('../../migrations/0057_create_conversation_keywords_table');
const { up: trigramIndex } = await import('../../migrations/0097_add_trigram_index_to_identity_observations');

run('subconscious SQL recall against real Postgres', () => {
  let admin: Pool;

  beforeAll(async() => {
    admin = new Pool({ ...conn, database: 'postgres', max: 1 });
    await admin.query(`CREATE DATABASE "${ dbName }"`);
    holder.pool = new Pool({ ...conn, database: dbName, max: 4 });
    await IdentityObservationsModel.ensureTable();
    await holder.pool.query(trigramIndex);
    await holder.pool.query(`CREATE TABLE conversation_history (
      id TEXT PRIMARY KEY, thread_id TEXT, title TEXT, summary TEXT, last_summary TEXT, last_active_at TIMESTAMPTZ,
      log_file TEXT, channel_id TEXT, agent_id TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
    await holder.pool.query(keywordsTable);

    // A realistic human domain: two relevant rows among many generic "Jonathon wants…" rows.
    await IdentityObservationsModel.insert({ domain: 'human', level: 3, content: 'Jonathon keeps an unencrypted password vault export in Downloads that should be deleted.' });
    await IdentityObservationsModel.insert({ domain: 'human', level: 2, content: 'Jonathon expects the password vault to survive total loss via encrypted backups.' });
    for (let i = 0; i < 40; i++) {
      await IdentityObservationsModel.insert({ domain: 'human', level: 2, content: `Jonathon wants Sulla to handle routine chore number ${ i } directly and report back briefly.` });
    }
    await IdentityObservationsModel.insert({ domain: 'business', level: 3, content: 'Jonathon wants a simple JavaScript game demo for TrueUp that anyone understands instantly.' });

    await holder.pool.query(`INSERT INTO conversation_history (id, thread_id, title, summary, last_active_at) VALUES
      ('ch1','t-vault','Vault hardening','Chose key wrapping and encrypted snapshots.', now() - interval '2 days'),
      ('ch2','t-tabs','Browser tabs','Throttled hidden tabs.', now() - interval '1 day'),
      ('ch3','t-now','Current chat','', now())`);
    await ConversationKeywordsModel.upsertMany({ thread_id: 't-vault', conversation_history_id: 'ch1', terms: ['password vault', 'key wrapping', 'encrypted snapshots'] });
    await ConversationKeywordsModel.upsertMany({ thread_id: 't-tabs', conversation_history_id: 'ch2', terms: ['browser tabs', 'hidden tab throttling'] });
    await ConversationKeywordsModel.upsertMany({ thread_id: 't-now', conversation_history_id: 'ch3', terms: ['password vault', 'key wrapping'] });
  });

  afterAll(async() => {
    await holder.pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${ dbName }"`);
    await admin?.end();
  });

  it('ranks the relevant rows and ignores terms common to the whole domain', async() => {
    const t0 = Date.now();
    const hits = await IdentityObservationsModel.recallRelevant('human', ['jonathon', 'password', 'vault', 'export', 'wants']);

    expect(Date.now() - t0).toBeLessThan(1000);
    expect(hits.map(h => h.content)).toEqual([
      'Jonathon keeps an unencrypted password vault export in Downloads that should be deleted.',
      'Jonathon expects the password vault to survive total loss via encrypted backups.',
    ]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('returns nothing when the turn shares no distinctive terms with the domain', async() => {
    expect(await IdentityObservationsModel.recallRelevant('human', ['kubernetes', 'helm', 'ingress'])).toEqual([]);
    expect(await IdentityObservationsModel.recallRelevant('human', [])).toEqual([]);
  });

  it('treats LIKE wildcards in terms literally', async() => {
    expect(await IdentityObservationsModel.recallRelevant('human', ['%', '_', 'vault%'])).toEqual([]);
  });

  it('finds a paraphrase in another domain but not an unrelated fact', async() => {
    const similar = await IdentityObservationsModel.findSimilar('Jonathon wants a simple JavaScript game demo for TrueUp that is instantly understandable.');

    expect(similar?.domain).toBe('business');
    expect(similar!.similarity).toBeGreaterThanOrEqual(0.5);
    expect(await IdentityObservationsModel.findSimilar('Carleigh prefers hiking trips in the Selkirk mountains on weekends.')).toBeNull();
  });

  it('recalls prior threads by distinctive keywords and excludes the current one', async() => {
    const hits = await ConversationKeywordsModel.recallThreads(['vault', 'wrapping', 'password'], { excludeThreadIds: ['t-now'] });

    expect(hits.map(h => h.thread_id)).toEqual(['t-vault']);
    expect(hits[0].title).toBe('Vault hardening');
    expect(hits[0].summary).toBe('Chose key wrapping and encrypted snapshots.');
    expect(hits[0].matched_terms).toEqual(expect.arrayContaining(['vault', 'wrapping', 'password']));
  });
});
