#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const scale = process.argv.includes('--scale') ? 1_000_000 : 200_000;
const folderCount = Math.ceil(scale / 20);
const versionCount = scale * 3;
const pgUrl = process.env.PGURL;
if (!pgUrl) throw new Error('Set PGURL to a disposable Postgres 16+ database URL');
const freeBytes = fs.statfsSync('/mnt/worktrees').bavail * fs.statfsSync('/mnt/worktrees').bsize;
if (freeBytes < 4 * 1024 ** 3) throw new Error(`Refusing seed: less than 4 GiB free (${Math.round(freeBytes / 1024 ** 3)} GiB)`);
const maxDbBytes = 1.5 * 1024 ** 3;
const { Client } = pg;
const client = new Client({ connectionString: pgUrl, application_name: 'sulla-files-scale-harness' });
const uuid = "(substr(md5($$seed$$ || n::text),1,8)||'-'||substr(md5($$seed$$ || n::text),9,4)||'-4'||substr(md5($$seed$$ || n::text),14,3)||'-a'||substr(md5($$seed$$ || n::text),18,3)||'-'||substr(md5($$seed$$ || n::text),21,12))::uuid";
const report = [];
const budget = { rows: Number(process.env.MAX_ROWS ?? 10_000), bytes: Number(process.env.MAX_RESULT_BYTES ?? 16 * 1024 ** 2), memory: Number(process.env.MAX_MEMORY_BYTES ?? 64 * 1024 ** 2) };

async function sizeGuard() {
  const { rows } = await client.query('SELECT pg_database_size(current_database()) AS bytes');
  const bytes = Number(rows[0].bytes);
  if (bytes > maxDbBytes) throw new Error(`Database cap exceeded: ${bytes} > ${maxDbBytes}`);
}
async function runCase(name, sql, params = []) {
  const before = process.memoryUsage();
  const plan = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
  const result = await client.query(sql, params);
  const after = process.memoryUsage();
  const resultBytes = result.rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  const memoryDelta = Math.max(0, ...['rss','heapUsed','external','arrayBuffers'].map(k => after[k] - before[k]));
  const detail = plan.rows.map(r => r['QUERY PLAN']).join('\n');
  const timing = detail.match(/Execution Time: ([\d.]+) ms/);
  const entry = { path: name, rows: result.rowCount, resultBytes, elapsedMs: Number(timing?.[1] ?? 0), memoryDelta, pass: result.rowCount <= budget.rows && resultBytes <= budget.bytes && memoryDelta <= budget.memory, plan: detail };
  report.push(entry);
  console.log(`${name}: ${entry.rows} rows, ${entry.resultBytes} bytes, ${entry.elapsedMs} ms, memory delta ${entry.memoryDelta} bytes ${entry.pass ? 'PASS' : 'FAIL'}`);
  return entry;
}

try {
  await client.connect();
  const existing = await client.query("SELECT to_regclass('public.files') AS files");
  if (existing.rows[0].files) throw new Error('PGURL must target a fresh empty database; public.files already exists');
  for (const file of fs.readdirSync(path.join(root, 'services/sulla-files/migrations')).filter(f => f.endsWith('.sql')).sort()) {
    await client.query(fs.readFileSync(path.join(root, 'services/sulla-files/migrations', file), 'utf8'));
  }
  const collection = '00000000-0000-4000-a000-000000000001';
  await client.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encryption,encrypted_data_key,dedup_key_ciphertext) VALUES($1,'scale-harness','Scale Harness','knowledge','desktop-only','org-readable','{}','{}') ON CONFLICT DO NOTHING`, [collection]);
  await client.query('BEGIN');
  await client.query(`INSERT INTO file_folders(collection_id,path,created_by_id)
    SELECT $1,'folder-'||n,'scale-harness' FROM generate_series(1,$2) n ON CONFLICT DO NOTHING`, [collection, folderCount]);
  await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size,search_text)
    SELECT ${uuid},$1,'folder-'||((n-1)%$2+1)||'/file-'||n||'.txt','user','scale-harness','text/plain',128,'synthetic scale candidate' FROM generate_series(1,$3) n ON CONFLICT DO NOTHING`, [collection, folderCount, scale]);
  await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id,created_at,message)
    SELECT gen_random_uuid(),f.id,$1,128,'user','scale-harness','synthetic',NOW()-(v||' minutes')::interval,'synthetic metadata'
    FROM files f CROSS JOIN generate_series(1,3) v WHERE f.collection_id=$1 AND f.path LIKE 'folder-%/file-%'`, [collection]);
  await client.query(`UPDATE files f SET current_version_id=v.id FROM file_versions v WHERE v.file_id=f.id AND f.collection_id=$1 AND v.created_at=(SELECT MAX(v2.created_at) FROM file_versions v2 WHERE v2.file_id=f.id)`, [collection]);
  await client.query('COMMIT');
  await sizeGuard();
  const docs = await client.query(`SELECT id FROM files WHERE collection_id=$1 ORDER BY path LIMIT 3`, [collection]);
  for (const file of docs.rows) {
    await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id,created_at,message)
      SELECT gen_random_uuid(),$1,$2,128,'user','scale-harness','synthetic',NOW()-(n||' seconds')::interval,'synthetic automerge history'
      FROM generate_series(4,1000) n`, [file.id, collection]);
    const versions = await client.query('SELECT id FROM file_versions WHERE file_id=$1 ORDER BY created_at DESC LIMIT 1000', [file.id]);
    const blob = Buffer.alloc(100_000, 65);
    await client.query('INSERT INTO file_automerge_docs(file_id,document,heads) VALUES($1,$2,$3) ON CONFLICT(file_id) DO UPDATE SET document=EXCLUDED.document', [file.id, blob, JSON.stringify(['synthetic-head'])]);
    await client.query('INSERT INTO file_automerge_versions(version_id,file_id,document,heads) SELECT id,$1,$2,$3 FROM unnest($4::uuid[]) id ON CONFLICT DO NOTHING', [file.id, blob, JSON.stringify(['synthetic-head']), versions.rows.map(x => x.id)]);
    await sizeGuard();
  }
  await client.query('ANALYZE');

  const samples = [
    ['FUSE tree snapshot files (unbounded query from app.ts loadFuseTreeSnapshot)', `SELECT f.id,f.collection_id,f.path,f.mime,f.size,f.updated_at,f.current_version_id FROM files f JOIN collections c ON c.id=f.collection_id WHERE c.id=$1 AND f.deleted_at IS NULL ORDER BY f.collection_id,f.path`, [collection]],
    ['File listing (collection page)', `SELECT id,path,mime,size,current_version_id FROM files WHERE collection_id=$1 AND deleted_at IS NULL ORDER BY path LIMIT 1000`, [collection]],
    ['Folder listing', `SELECT path,description,naming_hint FROM file_folders WHERE collection_id=$1 AND deleted_at IS NULL ORDER BY path LIMIT 1000`, [collection]],
    ['Cloud heads diff (journal batch)', `SELECT seq,file_id,version_id,op FROM journal WHERE collection_id=$1 AND seq>$2 ORDER BY seq LIMIT 1000`, [collection, 0]],
    ['Version history page', `SELECT id,parent_version_id,size,created_at,message FROM file_versions WHERE file_id=(SELECT id FROM files WHERE collection_id=$1 ORDER BY path LIMIT 1) ORDER BY created_at DESC LIMIT 1000`, [collection]],
    ['Automerge save current document read', `SELECT document,heads FROM file_automerge_docs WHERE file_id=(SELECT id FROM files WHERE collection_id=$1 ORDER BY path LIMIT 1)`, [collection]],
    ['Search candidates', `SELECT id,path,mime,size FROM files WHERE collection_id=$1 AND search_vector @@ plainto_tsquery('simple',$2) ORDER BY path LIMIT 1000`, [collection, 'synthetic scale']],
  ];
  for (const [name, sql, params] of samples) await runCase(name, sql, params);
  const summary = { generatedAt: new Date().toISOString(), postgres: (await client.query('SHOW server_version')).rows[0].server_version, scale: { files: scale, folders: folderCount, versions: versionCount, automergeDocs: 3, automergeHistoryEach: 1000 }, budget, databaseBytes: Number((await client.query('SELECT pg_database_size(current_database()) bytes')).rows[0].bytes), results: report };
  const markdown = ['# Sulla Files query scale report', '', `Generated ${summary.generatedAt}; PostgreSQL ${summary.postgres}.`, '', `Seed: ${scale.toLocaleString()} files, ${folderCount.toLocaleString()} folders, ${versionCount.toLocaleString()} versions, 3 live docs × 1,000 history entries.`, '', `Budgets: ≤${budget.rows} rows, ≤${budget.bytes} result bytes, ≤${budget.memory} Node memory-delta bytes/request. Database size: ${summary.databaseBytes} bytes.`, '', '| Path | Rows | Result bytes | Query ms | Node memory delta | Result |', '|---|---:|---:|---:|---:|---|', ...report.map(x => `| ${x.path} | ${x.rows} | ${x.resultBytes} | ${x.elapsedMs} | ${x.memoryDelta} | ${x.pass ? 'PASS' : 'FAIL'} |`), '', '## EXPLAIN (ANALYZE, BUFFERS)', ...report.map(x => `### ${x.path}\n\n\`\`\`text\n${x.plan}\n\`\`\``), ''].join('\n');
  fs.writeFileSync(path.join(here, 'REPORT.md'), markdown);
  fs.writeFileSync(path.join(here, 'report.json'), JSON.stringify(summary, null, 2));
  if (report.some(x => !x.pass)) process.exitCode = 1;
} finally { await client.end().catch(() => {}); }
