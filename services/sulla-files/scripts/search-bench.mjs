#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { PotionEmbedder, vectorLiteral } from '../dist/potionEmbedder.js';

const url = process.env.DATABASE_URL;
const model = process.env.POTION_MODEL;
if (!url || !model) throw new Error('DATABASE_URL and POTION_MODEL are required');
const runs = Number(process.env.BENCH_RUNS ?? 20);
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 4);
const db = new pg.Pool({ connectionString:url, max:concurrency + 2 });
const embedder = PotionEmbedder.load(model);
const dimensions = embedder.dim;
if (dimensions !== 512) throw new Error(`Expected 512 dimensions, received ${dimensions}`);

const sample = (await db.query(`SELECT collection_id,left(path,greatest(strpos(path,'/'),1)) folder
  FROM files WHERE deleted_at IS NULL AND current_version_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`)).rows[0];
if (!sample) throw new Error('Corpus has no searchable files');
const queries = [
  { name:'common-unscoped', text:'error' }, { name:'rare-unscoped', text:'checksum' },
  { name:'multi-unscoped', text:'connection refused' },
  { name:'common-collection', text:'service', collection:sample.collection_id },
  { name:'published-collection', text:'document', collection:sample.collection_id, published:true },
  { name:'multi-folder', text:'request failed', folder:sample.folder },
];
const vectorAvailable = Boolean((await db.query("SELECT to_regclass('file_search_vectors') name")).rows[0]?.name);
const samples = new Map();
const cheap = [];
let stopCheap = false;
function record(name, ms) { const values=samples.get(name) ?? []; values.push(ms); samples.set(name,values) }
function whereFor(q,args) {
  const where=["f.deleted_at IS NULL", "NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)"];
  if(q.collection) where.push(`f.collection_id=$${args.push(q.collection)}::uuid`);
  if(q.folder) where.push(`f.path LIKE $${args.push(q.folder.replace(/[\\%_]/g,v=>`\\${v}`)+'%')} ESCAPE '\\'`);
  if(q.published) where.push('f.published_version_id IS NOT NULL AND f.current_version_id=f.published_version_id');
  return where;
}
async function keyword(q) {
  const args=[]; const where=whereFor(q,args); args.push(q.text); const started=performance.now();
  await db.query(`WITH matches AS MATERIALIZED (SELECT file_id,version_id,search_vector FROM file_search_chunks
    WHERE search_vector @@ websearch_to_tsquery('simple',$${args.length}) LIMIT 200)
    SELECT f.id FROM matches sc JOIN files f ON f.id=sc.file_id
    WHERE sc.version_id=f.current_version_id AND ${where.join(' AND ')}
    ORDER BY ts_rank_cd(sc.search_vector,websearch_to_tsquery('simple',$${args.length})) DESC LIMIT 60`,args);
  record(`keyword:${q.name}`,performance.now()-started);
}
async function semantic(q) {
  const args=[]; const where=whereFor(q,args); args.push(vectorLiteral(embedder.embed(q.text))); const started=performance.now();
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    if(vectorAvailable) { await client.query("SET LOCAL hnsw.ef_search=100"); await client.query("SET LOCAL hnsw.iterative_scan=strict_order"); }
    const result = vectorAvailable ? await client.query(`SELECT f.id,f.collection_id,f.path FROM files f
      JOIN file_search_chunks sc ON sc.file_id=f.id AND sc.version_id=f.current_version_id
      JOIN file_search_vectors sv ON sv.chunk_id=sc.id WHERE ${where.join(' AND ')}
      ORDER BY sv.embedding <=> $${args.length}::halfvec LIMIT 60`,args) : await client.query(`SELECT f.id,f.collection_id,f.path FROM files f
      JOIN file_search_chunks sc ON sc.file_id=f.id AND sc.version_id=f.current_version_id
      WHERE ${where.join(' AND ')} ORDER BY f.updated_at DESC LIMIT 800`,args.slice(0,-1));
    if(q.collection && result.rows.some(r=>r.collection_id!==q.collection)) throw new Error('collection scope violation');
    if(q.folder && result.rows.some(r=>!r.path.startsWith(q.folder))) throw new Error('folder scope violation');
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  record(`semantic:${q.name}`,performance.now()-started);
}
async function cheapLoop() {
  while(!stopCheap) {
    let started=performance.now(); await db.query('SELECT revision FROM fuse_tree_state WHERE singleton=TRUE'); cheap.push(performance.now()-started);
    started=performance.now(); await db.query('SELECT id FROM files WHERE collection_id=$1 AND deleted_at IS NULL ORDER BY path LIMIT 100',[sample.collection_id]); cheap.push(performance.now()-started);
  }
}
const jobs=[]; for(let i=0;i<runs;i++) for(const q of queries) { jobs.push(()=>keyword(q)); jobs.push(()=>semantic(q)); }
const cheapJob=cheapLoop(); let next=0;
await Promise.all(Array.from({length:concurrency},async()=>{ while(next<jobs.length) await jobs[next++]() })); stopCheap=true; await cheapJob;
function stats(values) { values=[...values].sort((a,b)=>a-b); const at=p=>values[Math.min(values.length-1,Math.floor(values.length*p))]; return {n:values.length,p50_ms:+at(.50).toFixed(1),p95_ms:+at(.95).toFixed(1),max_ms:+values.at(-1).toFixed(1)} }
const recall={};
if(vectorAvailable) for(const q of queries.filter(q=>q.collection||q.folder)) {
  const args=[]; const where=whereFor(q,args); args.push(vectorLiteral(embedder.embed(q.text)));
  const sql=`SELECT sc.id FROM files f JOIN file_search_chunks sc ON sc.file_id=f.id AND sc.version_id=f.current_version_id JOIN file_search_vectors sv ON sv.chunk_id=sc.id WHERE ${where.join(' AND ')} ORDER BY sv.embedding <=> $${args.length}::halfvec LIMIT 60`;
  const approximate=new Set((await db.query(sql,args)).rows.map(r=>r.id)); const client=await db.connect(); let exact;
  try { await client.query('BEGIN'); await client.query('SET LOCAL enable_indexscan=off'); exact=(await client.query(sql,args)).rows; await client.query('COMMIT') } catch(e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  recall[q.name]=+(exact.filter(r=>approximate.has(r.id)).length/Math.max(exact.length,1)).toFixed(3);
}
const output={corpus:{files:Number((await db.query('SELECT count(*) n FROM files')).rows[0].n),chunks:Number((await db.query('SELECT count(*) n FROM file_search_chunks')).rows[0].n),vector_index:vectorAvailable},concurrency,runs,scoped_recall_at_60:recall,categories:{}};
for(const [name,values] of samples) output.categories[name]=stats(values); output.cheap_queries=stats(cheap);
console.log(JSON.stringify(output,null,2)); await db.end();
