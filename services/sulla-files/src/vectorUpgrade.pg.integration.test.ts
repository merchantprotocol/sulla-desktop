// Real-Postgres tests for the pgvector upgrade and the SQL search cutover.
//   SULLA_FILES_VECTOR_TEST_DATABASE_URL   admin URL of a THROWAWAY server built from services/sulla-postgres
//   SULLA_FILES_VECTOR_STOCK_DATABASE_URL  admin URL of a THROWAWAY stock postgres:16-alpine server
// Each test creates (and drops) its own database. Never point these at a live Sulla database.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import { migrate } from './db.js';
import { healthPayload } from './health.js';
import { cosine } from './potionEmbedder.js';
import { FileSearch, SEMANTIC_POOL } from './search.js';
import { cosineOf, parseVectorText, reclaimJsonEmbeddings, VECTOR_INDEX, VectorSearchUpgrade } from './vectorUpgrade.js';

const vectorUrl = process.env.SULLA_FILES_VECTOR_TEST_DATABASE_URL;
const stockUrl = process.env.SULLA_FILES_VECTOR_STOCK_DATABASE_URL;
const DIM = 512;
const ROWS = Number(process.env.SULLA_FILES_VECTOR_TEST_ROWS ?? 20_000);
const quiet = () => undefined;
const bench = (line:string) => console.log(`BENCH ${ line }`);

// Deterministic PRNG so runs are comparable.
function rng(seed:number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 } }
function normalize(v:Float32Array):Float32Array { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n); if (n) for (let i = 0; i < v.length; i++) v[i] /= n; return v }

/** Bag-of-words embedder with a fixed pseudo-random vector per token (stands in for Potion). */
const fakeEmbedder = {
  dim: DIM,
  embed(text:string):Float32Array {
    const out = new Float32Array(DIM);
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const r = rng(createHash('sha256').update(token).digest().readUInt32LE(0));
      for (let i = 0; i < DIM; i++) out[i] += r() - 0.5;
    }
    return normalize(out);
  },
};

const WORDS = 'invoice contract roadmap budget design migration vector search index backup restore meeting notes travel recipe garden photo music report quarterly'.split(' ');

function urlFor(base:string, database:string) { const url = new URL(base); url.pathname = `/${ database }`; return url.toString() }

async function freshDatabase(base:string, template?:string):Promise<{ db:pg.Pool; drop:() => Promise<void>; name:string }> {
  const name = `pgvector_test_${ randomUUID().replace(/-/g, '').slice(0, 12) }`;
  const admin = new pg.Pool({ connectionString: base, max: 1 });
  await admin.query(`CREATE DATABASE ${ name }${ template ? ` TEMPLATE ${ template }` : '' }`);
  const db = new pg.Pool({ connectionString: urlFor(base, name), max: 6 });
  db.on('error', () => undefined); // a test deliberately terminates a backend
  return {
    db, name,
    drop: async() => { await db.end(); await admin.query(`DROP DATABASE IF EXISTS ${ name } WITH (FORCE)`); await admin.end() },
  };
}

/** Creates one collection with `files` files of `chunksPerFile` chunks, embeddings stored as JSON (the pre-upgrade layout). */
async function seed(db:pg.Pool, options:{ files:number; chunksPerFile:number; embed:(content:string, index:number) => Float32Array; content:(index:number) => string }) {
  await migrate(db);
  // The pre-upgrade live layout: no side table (pgvector was absent when 005 ran).
  await db.query('DROP TABLE IF EXISTS file_search_vectors');
  const collectionId = randomUUID();
  await db.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,compatibility_state)
    VALUES($1,'synthetic-principal','Synthetic','knowledge','desktop-only','{}','{}','native')`, [collectionId]);
  const fileIds:string[] = []; const versionIds:string[] = [];
  for (let i = 0; i < options.files; i++) { fileIds.push(randomUUID()); versionIds.push(randomUUID()) }
  await db.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size,updated_at)
    SELECT id,$2,'docs/file-'||ord||'.txt','user','synthetic-principal','text/plain',100,NOW()-(ord||' seconds')::interval
    FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id,ord)`, [fileIds, collectionId]);
  await db.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id)
    SELECT v,f,$3,100,'user','synthetic-principal','synthetic-device' FROM unnest($1::uuid[],$2::uuid[]) AS t(v,f)`, [versionIds, fileIds, collectionId]);
  await db.query('UPDATE files f SET current_version_id=t.v FROM unnest($1::uuid[],$2::uuid[]) AS t(f,v) WHERE f.id=t.f', [fileIds, versionIds]);
  const total = options.files * options.chunksPerFile; const batch = 500;
  for (let start = 0; start < total; start += batch) {
    const ids:string[] = []; const fs:string[] = []; const vs:string[] = []; const ords:number[] = []; const contents:string[] = []; const embeddings:string[] = [];
    for (let i = start; i < Math.min(total, start + batch); i++) {
      const file = Math.floor(i / options.chunksPerFile); const content = options.content(i);
      ids.push(randomUUID()); fs.push(fileIds[file]); vs.push(versionIds[file]); ords.push(i % options.chunksPerFile); contents.push(content);
      embeddings.push(JSON.stringify(Array.from(options.embed(content, i)))); // exactly what indexing.ts used to write
    }
    await db.query(`INSERT INTO file_search_chunks(id,file_id,version_id,ordinal,content,embedding_json)
      SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::int[],$5::text[],$6::jsonb[])`, [ids, fs, vs, ords, contents, embeddings]);
  }
  await db.query('ANALYZE');
  return { collectionId };
}

/** Clustered synthetic embeddings, closer to real text embeddings than uniform noise. */
function clusteredEmbedder(seedValue:number) {
  const r = rng(seedValue);
  const centers = Array.from({ length: 200 }, () => normalize(Float32Array.from({ length: DIM }, () => r() - 0.5)));
  return (_content:string, index:number) => {
    const local = rng(index + 1); const c = centers[Math.floor(local() * centers.length)];
    return normalize(Float32Array.from(c, x => x + (local() - 0.5) * 0.08));
  };
}

/** ~3,400 characters like the real 3,500-char chunks, so heap size and planner costs are realistic. */
function realisticChunk(i:number):string {
  const r = rng(i + 99); const words:string[] = [`chunk${ i }`];
  while (words.join(' ').length < 3_400) words.push(WORDS[Math.floor(r() * WORDS.length)]);
  return words.join(' ');
}

let seedDatabase:string | undefined;
async function benchmarkSeed(base:string):Promise<string> {
  if (seedDatabase) return seedDatabase;
  const started = Date.now();
  const { db, name } = await freshDatabase(base);
  await seed(db, { files: ROWS / 10, chunksPerFile: 10, embed: clusteredEmbedder(7), content: realisticChunk });
  await db.end();
  bench(`seeded ${ ROWS } chunks (512-dim JSONB) in ${ ((Date.now() - started) / 1000).toFixed(1) }s`);
  seedDatabase = name;
  return name;
}

function percentile(values:number[], p:number) { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }

test('pgvector image: CREATE EXTENSION vector works for the superuser', { skip: !vectorUrl }, async() => {
  const { db, drop } = await freshDatabase(vectorUrl!);
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');
    const version = (await db.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows[0].extversion;
    assert.equal(version, '0.8.7');
    assert.ok(Math.abs(Number((await db.query("SELECT '[1, 0]'::vector <=> '[0,1]'::vector d")).rows[0].d) - 1) < 1e-9);
  } finally { await drop() }
});

test('upgrade: backfill, verify, HNSW; recall@10 vs exact and vs the old Node cosine path; timings', { skip: !vectorUrl, timeout: 2_400_000 }, async() => {
  const { db, drop } = await freshDatabase(vectorUrl!, await benchmarkSeed(vectorUrl!));
  try {
    const logs:string[] = [];
    const upgrade = new VectorSearchUpgrade(db, fakeEmbedder, { pauseMs: 0, log: line => logs.push(line) });
    const queries = Array.from({ length: 50 }, (_, q) => clusteredEmbedder(7)('', (q * 397) % ROWS));
    const literal = (v:Float32Array) => `[${ Array.from(v).join(',') }]`;

    // "Before": the old path scored every candidate's JSON in Node (here: all rows, the exact old cosine()).
    const jsonRows = (await db.query<{ id:string; embedding_json:number[] }>('SELECT id,embedding_json FROM file_search_chunks')).rows;
    const oldLatency:number[] = []; const oldTop:string[][] = [];
    for (const q of queries) {
      const t = performance.now();
      const bounded = (await db.query<{ id:string; embedding_json:number[] }>(`SELECT sc.id,sc.embedding_json FROM files f JOIN file_versions v ON v.id=f.current_version_id
        JOIN file_search_chunks sc ON sc.file_id=f.id AND sc.version_id=v.id ORDER BY f.updated_at DESC LIMIT 800`)).rows;
      bounded.map(row => cosine(q, row.embedding_json)).sort((a, b) => b - a);
      oldLatency.push(performance.now() - t);
      oldTop.push(jsonRows.map(row => ({ id: row.id, s: cosine(q, row.embedding_json) })).sort((a, b) => b.s - a.s).slice(0, 10).map(row => row.id));
    }

    const t0 = Date.now();
    await upgrade.upgrade();
    const total = (Date.now() - t0) / 1000;
    const status = upgrade.status();
    assert.equal(status.vectorSearch, 'ready');
    assert.equal(status.chunks, ROWS); assert.equal(status.embedded, ROWS);
    assert.equal(status.indexValid, true);
    assert.equal(status.jsonColumn, true, 'reclaim is opt-in, so embedding_json stays by default');
    const backfillLine = logs.find(line => line.startsWith('vector backfill finished'))!;
    const seconds = Number(/in ([\d.]+)s/.exec(backfillLine)![1]);
    bench(`backfill ${ ROWS } rows in ${ seconds }s = ${ Math.round(ROWS / Math.max(seconds, 0.001)) } rows/s (pauseMs=0)`);
    bench(logs.find(line => line.startsWith('vector index built'))!);
    bench(logs.find(line => line.startsWith('vector verify'))!);
    bench(`whole upgrade ${ total.toFixed(1) }s`);

    const exact = async(q:Float32Array) => {
      const c = await db.connect();
      try {
        await c.query('BEGIN'); await c.query('SET LOCAL enable_indexscan=off');
        const rows = (await c.query('SELECT id FROM file_search_chunks ORDER BY embedding <=> $1::vector LIMIT 10', [literal(q)])).rows.map(r => r.id);
        await c.query('COMMIT'); return rows;
      } finally { c.release() }
    };
    let recall = 0; let agreeOld = 0; const newLatency:number[] = []; let usedIndex = false;
    for (const [i, q] of queries.entries()) {
      const truth = await exact(q);
      const c = await db.connect();
      let approx:string[];
      try {
        await c.query('BEGIN'); await c.query('SET LOCAL hnsw.ef_search=100'); await c.query("SET LOCAL hnsw.iterative_scan='strict_order'");
        if (i === 0) {
          const plan = (await c.query('EXPLAIN SELECT id FROM file_search_chunks ORDER BY embedding <=> $1::vector LIMIT 10', [literal(q)])).rows.map(row => row['QUERY PLAN']).join(' | ');
          usedIndex = plan.includes(VECTOR_INDEX); bench(`plan: ${ plan }`);
        }
        const t = performance.now();
        approx = (await c.query('SELECT id FROM file_search_chunks ORDER BY embedding <=> $1::vector LIMIT 10', [literal(q)])).rows.map(r => r.id);
        newLatency.push(performance.now() - t);
        await c.query('COMMIT');
      } finally { c.release() }
      recall += approx.filter(id => truth.includes(id)).length / 10;
      agreeOld += truth.filter(id => oldTop[i].includes(id)).length / 10;
    }
    recall /= queries.length; agreeOld /= queries.length;
    bench(`HNSW recall@10 vs exact SQL = ${ recall.toFixed(4) } over ${ queries.length } queries; exact SQL top-10 vs old Node cosine top-10 overlap = ${ agreeOld.toFixed(4) }`);
    bench(`p50 latency: old path (800-row JSON fetch + Node cosine) ${ percentile(oldLatency, 0.5).toFixed(1) }ms; new HNSW SQL ${ percentile(newLatency, 0.5).toFixed(1) }ms; index used=${ usedIndex }`);
    // End to end through FileSearch (filters + joins + FTS fusion): HNSW must be used.
    const collectionId = (await db.query('SELECT id FROM collections LIMIT 1')).rows[0].id;
    const scans = async() => Number((await db.query('SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname=$1', [VECTOR_INDEX])).rows[0].idx_scan);
    const search = new FileSearch(db, fakeEmbedder as any, upgrade);
    const scansBefore = await scans(); const searchLatency:number[] = [];
    for (const q of ['invoice budget', 'vector search index', 'garden photo', 'quarterly report', 'backup restore']) {
      const t = performance.now(); const response = await search.search({ query: q }, [{ collectionId }]); searchLatency.push(performance.now() - t);
      assert.ok(response.results.length > 0);
    }
    const legacyLatency:number[] = [];
    for (const q of ['invoice budget', 'vector search index', 'garden photo', 'quarterly report', 'backup restore']) {
      const t = performance.now(); await legacySearch(db, q, collectionId); legacyLatency.push(performance.now() - t);
    }
    bench(`legacy (pre-PR) search end-to-end p50 ${ percentile(legacyLatency, 0.5).toFixed(1) }ms over 5 queries (same data, JSON column still present)`);
    // Capture the semantic SQL FileSearch issues and show its plan.
    const originalConnect = db.connect.bind(db); let captured:{ sql:string; args:any[] } | undefined;
    (db as any).connect = async() => {
      const client = await originalConnect(); const query = client.query.bind(client);
      (client as any).query = (sql:any, args?:any) => { if (typeof sql === 'string' && sql.includes('<=>')) captured = { sql, args }; return query(sql, args) };
      return client;
    };
    await search.search({ query: 'invoice budget' }, [{ collectionId }]);
    (db as any).connect = originalConnect;
    {
      const c = await db.connect();
      try {
        await c.query('BEGIN'); await c.query(`SET LOCAL hnsw.ef_search=${ SEMANTIC_POOL }`); await c.query("SET LOCAL hnsw.iterative_scan='strict_order'");
        const plan = (await c.query(`EXPLAIN (ANALYZE) ${ captured!.sql }`, captured!.args)).rows.map(row => row['QUERY PLAN']);
        bench(`FileSearch semantic query: ${ plan.filter(line => /Index Scan using|Execution Time|Seq Scan on file_search_chunks/.test(line)).map(line => line.trim()).join(' | ') }`);
        await c.query('COMMIT');
      } finally { c.release() }
    }
    await new Promise(resolve => setTimeout(resolve, 700)); // stats collector flush
    const scansAfter = await scans();
    bench(`FileSearch.search end-to-end p50 ${ percentile(searchLatency, 0.5).toFixed(1) }ms over 5 queries; HNSW idx_scan +${ scansAfter - scansBefore }`);
    assert.ok(scansAfter > scansBefore, 'FileSearch semantic query used the HNSW index');
    assert.ok(usedIndex, 'planner uses the HNSW index');
    assert.ok(recall >= 0.95, `recall@10 ${ recall }`);
    assert.ok(agreeOld >= 0.999, `SQL exact cosine ordering matches the old Node cosine ordering (${ agreeOld })`);
  } finally { await drop() }
});

test('backfill is resumable: stopped mid-way, restarted, every row converted', { skip: !vectorUrl, timeout: 600_000 }, async() => {
  const { db, drop } = await freshDatabase(vectorUrl!, await benchmarkSeed(vectorUrl!));
  try {
    const first = new VectorSearchUpgrade(db, fakeEmbedder, { batchSize: 500, pauseMs: 20, log: quiet });
    const run = first.start();
    for (let i = 0; i < 400 && !((first.status().embedded ?? 0) >= 2_000); i++) await new Promise(resolve => setTimeout(resolve, 25));
    await first.stop(); await run;
    const partial = Number((await db.query('SELECT COUNT(embedding) n FROM file_search_chunks')).rows[0].n);
    assert.ok(partial > 0 && partial < ROWS, `partial backfill (${ partial })`);
    assert.notEqual(first.status().vectorSearch, 'ready');
    const second = new VectorSearchUpgrade(db, fakeEmbedder, { pauseMs: 0, log: quiet });
    await second.upgrade();
    assert.equal(second.status().vectorSearch, 'ready');
    const counts = (await db.query('SELECT COUNT(*)::int total, COUNT(embedding)::int embedded FROM file_search_chunks')).rows[0];
    assert.deepEqual(counts, { total: ROWS, embedded: ROWS });
    // Spot check the converted values are the JSON values.
    const rows = (await db.query('SELECT embedding::text v, embedding_json j FROM file_search_chunks ORDER BY random() LIMIT 50')).rows;
    for (const row of rows) assert.ok(cosineOf(parseVectorText(row.v), row.j) > 0.99999);
  } finally { await drop() }
});

test('index build interrupted mid-way leaves an INVALID index; the next start drops and rebuilds it', { skip: !vectorUrl, timeout: 600_000 }, async() => {
  const { db, drop } = await freshDatabase(vectorUrl!, await benchmarkSeed(vectorUrl!));
  try {
    const upgrade = new VectorSearchUpgrade(db, fakeEmbedder, { pauseMs: 0, log: quiet });
    const building = upgrade.upgrade().then(() => undefined, (error:unknown) => error);
    let killed = false;
    for (let i = 0; i < 2_000 && !killed; i++) {
      const pid = (await db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query ILIKE 'CREATE INDEX CONCURRENTLY%' AND state='active'")).rows[0]?.pid;
      if (pid) { await new Promise(resolve => setTimeout(resolve, 300)); await db.query('SELECT pg_terminate_backend($1)', [pid]); killed = true }
      else await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(killed, 'caught the index build in flight');
    assert.ok(await building instanceof Error, 'the interrupted upgrade run failed');
    const valid = (await db.query('SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=$1', [VECTOR_INDEX])).rows[0];
    assert.equal(valid?.indisvalid, false, 'interrupted CONCURRENTLY build left an INVALID index');
    const logs:string[] = [];
    const again = new VectorSearchUpgrade(db, fakeEmbedder, { pauseMs: 0, log: line => logs.push(line) });
    await again.upgrade();
    assert.equal(again.status().vectorSearch, 'ready');
    assert.ok(logs.some(line => line.includes('INVALID')));
    assert.equal((await db.query('SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=$1', [VECTOR_INDEX])).rows[0].indisvalid, true);
  } finally { await drop() }
});

test('opt-in reclaim drops embedding_json only after verification passes; failed gate keeps it', { skip: !vectorUrl, timeout: 600_000 }, async() => {
  const { db, drop } = await freshDatabase(vectorUrl!, await benchmarkSeed(vectorUrl!));
  try {
    // Gate failure: a vector that disagrees with its JSON must block the drop.
    const blocked = new VectorSearchUpgrade(db, fakeEmbedder, { pauseMs: 0, reclaim: true, spotChecks: 100_000, log: quiet });
    await (blocked as any).prepare(); await (blocked as any).backfill();
    await db.query(`UPDATE file_search_chunks SET embedding=('['||array_to_string(array_fill(1::real, ARRAY[${ DIM }]),',')||']')::vector
      WHERE id=(SELECT id FROM file_search_chunks ORDER BY id LIMIT 1)`);
    assert.equal(await blocked.verify(), false);
    const jsonStill = (await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='file_search_chunks' AND column_name='embedding_json'")).rowCount;
    assert.equal(jsonStill, 1);
    await db.query('UPDATE file_search_chunks SET embedding=embedding_json::text::vector WHERE id=(SELECT id FROM file_search_chunks ORDER BY id LIMIT 1)');

    const logs:string[] = [];
    const t = Date.now();
    const status = await reclaimJsonEmbeddings(db, fakeEmbedder, { pauseMs: 0, log: line => logs.push(line) });
    assert.equal(status.vectorSearch, 'ready');
    assert.equal(status.jsonColumn, false);
    assert.ok((status.reclaimedBytes ?? 0) > 0);
    bench(`${ logs.find(line => line.startsWith('vector reclaim'))! } (whole reclaim run ${ ((Date.now() - t) / 1000).toFixed(1) }s for ${ ROWS } rows)`);
    assert.equal((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='file_search_chunks' AND column_name='embedding_json'")).rowCount, 0);
    assert.equal(Number((await db.query('SELECT COUNT(embedding) n FROM file_search_chunks')).rows[0].n), ROWS);
    // Idempotent: a second start neither fails nor re-reclaims.
    const again = new VectorSearchUpgrade(db, fakeEmbedder, { pauseMs: 0, log: quiet });
    await again.upgrade();
    assert.equal(again.status().vectorSearch, 'ready');
  } finally { await drop() }
});

/** The pre-PR search algorithm, verbatim: bounded 800-row JSON fetch + Node cosine, fused with FTS. */
async function legacySearch(db:pg.Pool, query:string, collectionId:string) {
  const where = "f.collection_id=ANY($1::uuid[]) AND f.deleted_at IS NULL AND lower(f.path) !~ '(^|/)(master[.]key|wallet|vault|vaults)($|/)' AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)";
  const keyword = (await db.query(`SELECT f.id file_id,f.path,sc.content,ts_rank_cd(sc.search_vector,websearch_to_tsquery('simple',$2)) signal
    FROM files f JOIN file_versions v ON v.id=f.current_version_id LEFT JOIN file_search_chunks sc ON sc.file_id=f.id AND sc.version_id=v.id
    WHERE ${ where } AND sc.search_vector @@ websearch_to_tsquery('simple',$2) ORDER BY signal DESC,f.updated_at DESC LIMIT 60`, [[collectionId], query])).rows;
  const vector = fakeEmbedder.embed(query);
  const bounded = (await db.query(`SELECT f.id file_id,f.path,sc.content,sc.embedding_json FROM files f JOIN file_versions v ON v.id=f.current_version_id
    JOIN file_search_chunks sc ON sc.file_id=f.id WHERE ${ where } AND sc.version_id=v.id ORDER BY f.updated_at DESC LIMIT 800`, [[collectionId]])).rows;
  const semantic = bounded.map(row => ({ ...row, signal: cosine(vector, row.embedding_json) })).sort((a, b) => b.signal - a.signal).slice(0, 60).filter(row => row.signal >= 0.2);
  const fused = new Map<string, any>();
  const add = (c:any, source:string, rank:number) => {
    const cur = fused.get(c.file_id) ?? { ...c, rank: 0, sources: new Set<string>(), bestSignal: -Infinity };
    cur.rank += 1 / (60 + rank + 1); cur.sources.add(source);
    if (c.signal > cur.bestSignal) { cur.content = c.content; cur.bestSignal = c.signal }
    fused.set(c.file_id, cur);
  };
  keyword.forEach((row, rank) => add(row, 'keyword', rank)); semantic.forEach((row, rank) => add(row, 'meaning', rank));
  return [...fused.values()].sort((a, b) => b.rank - a.rank).slice(0, 100).map(row => ({
    id: row.file_id, rank: row.rank, why: row.sources.size > 1 ? 'keyword and meaning match' : row.sources.has('meaning') ? 'meaning match' : 'keyword match',
  }));
}

test('search regression: the HNSW SQL path returns the same results as the old JSON/Node path', { skip: !vectorUrl, timeout: 300_000 }, async() => {
  const { db, drop } = await freshDatabase(vectorUrl!);
  try {
    // < 800 chunks so the old bounded candidate set covers everything and the two paths are comparable.
    const r = rng(42);
    const text = (i:number) => Array.from({ length: 6 }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ') + ` item${ i }`;
    const { collectionId } = await seed(db, { files: 120, chunksPerFile: 5, embed: content => fakeEmbedder.embed(content), content: text });
    const queries = ['invoice budget', 'vector search index', 'garden photo music', 'quarterly report meeting', 'backup restore', 'travel recipe notes', 'design roadmap'];
    const before = await Promise.all(queries.map(q => legacySearch(db, q, collectionId)));
    const upgrade = new VectorSearchUpgrade(db, fakeEmbedder, { pauseMs: 0, log: quiet });
    await upgrade.upgrade();
    assert.equal(upgrade.status().vectorSearch, 'ready');
    const search = new FileSearch(db, fakeEmbedder as any, upgrade);
    let compared = 0;
    for (const [i, q] of queries.entries()) {
      const after = (await search.search({ query: q }, [{ collectionId }])).results;
      assert.deepEqual(after.map(row => row.id), before[i].map(row => row.id), `same ranked files for "${ q }"`);
      assert.deepEqual(after.map(row => row.why), before[i].map(row => row.why));
      after.forEach((row, k) => assert.ok(Math.abs(row.rank - before[i][k].rank) < 1e-12));
      compared += after.length;
    }
    assert.ok(compared > 50, `compared ${ compared } ranked results`);
  } finally { await drop() }
});

test('stock postgres:16-alpine: upgrade reports unavailable, nothing changes, full-text search still works', { skip: !stockUrl, timeout: 120_000 }, async() => {
  const { db, drop } = await freshDatabase(stockUrl!);
  try {
    const { collectionId } = await seed(db, { files: 20, chunksPerFile: 2, embed: content => fakeEmbedder.embed(content), content: i => `${ WORDS[i % WORDS.length] } stock ${ i }` });
    const logs:string[] = [];
    const upgrade = new VectorSearchUpgrade(db, fakeEmbedder, { pauseMs: 0, log: line => logs.push(line) });
    await upgrade.start();
    assert.equal(upgrade.status().vectorSearch, 'unavailable');
    assert.equal(upgrade.columnReady, false);
    assert.equal(logs.length, 1);
    assert.equal((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='file_search_chunks' AND column_name='embedding'")).rowCount, 0);
    const search = new FileSearch(db, fakeEmbedder as any, upgrade);
    const results = (await search.search({ query: 'invoice' }, [{ collectionId }])).results;
    assert.ok(results.length > 0);
    assert.ok(results.every(row => row.why === 'keyword match'));
    const health = JSON.parse(JSON.stringify(healthPayload({ mode: 'desktop' }, true, undefined, search.vectorStatus())));
    assert.equal(health.vectorSearch, 'unavailable');
  } finally { await drop() }
});

test.after(async() => {
  if (seedDatabase && vectorUrl) {
    const admin = new pg.Pool({ connectionString: vectorUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${ seedDatabase } WITH (FORCE)`); await admin.end();
  }
});
