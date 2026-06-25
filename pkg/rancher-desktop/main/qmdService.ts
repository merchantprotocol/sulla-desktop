/**
 * QMD Search Service — main-process wrapper around @tobilu/qmd.
 *
 * All heavy work (SQLite queries, file indexing) runs in a Worker thread
 * so the Electron main process and UI never block.
 *
 * qmd is an ESM package with top-level await, so the worker uses dynamic import().
 */

import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

export interface QmdSearchResult {
  path:    string;
  name:    string;
  line:    number;
  preview: string;
  score:   number;
  source:  'fts' | 'filename';
}

// ── Worker management ───────────────────────────────────────────

const SEARCH_TIMEOUT_MS = 15_000;
const INDEX_TIMEOUT_MS = 120_000;
const MAX_INDEX_FILES = 10_000;
// Skip files larger than this when indexing. Minified bundles / vendored blobs
// (one observed at 27 MB) add almost no search value but bloat the FTS index
// and make every query slower. ~1 MB covers all real source/docs.
const MAX_FILE_BYTES = 1_000_000;

export class QmdTimeoutError extends Error {
  constructor(action: string, ms: number) {
    super(`qmd ${ action } timed out after ${ ms }ms`);
    this.name = 'QmdTimeoutError';
  }
}

export class QmdTooManyFilesError extends Error {
  constructor(public count: number, public limit: number, public dirPath: string) {
    super(`qmd index aborted: ${ count } files in ${ dirPath } exceeds limit of ${ limit }. Narrow the dirPath.`);
    this.name = 'QmdTooManyFilesError';
  }
}

// Upper bound on how long a request may sit in the worker's queue before it is
// actually picked up (the worker is single-threaded). Must comfortably exceed
// the longest op that could be ahead of it — an in-flight index. Until the
// worker acks that it has started a given request, only this cap applies, so a
// search never times out merely because an index is running ahead of it.
const QUEUE_TIMEOUT_MS = INDEX_TIMEOUT_MS + 30_000;

interface Pending {
  resolve: (v: any) => void;
  reject:  (e: Error) => void;
  timer:   NodeJS.Timeout;
  onAck:   () => void;
}

let _worker: Worker | null = null;
let _requestId = 0;
const _pending = new Map<number, Pending>();

/**
 * Resolve the app root so the worker can find node_modules.
 * Walks up from Electron's app path (or cwd) looking for node_modules/@tobilu/qmd.
 */
function getAppRoot(): string {
  const { app } = require('electron');
  // app.getAppPath() returns e.g. /path/to/sulla-desktop/dist/app in dev
  let dir = app.getAppPath();

  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'node_modules', '@tobilu', 'qmd'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return process.cwd();
}

function getWorkerPath(): string {
  const os = require('os');
  const workerDir = path.join(os.homedir(), '.cache', 'sulla-qmd');

  fs.mkdirSync(workerDir, { recursive: true });

  const workerPath = path.join(workerDir, 'worker.mjs');

  fs.writeFileSync(workerPath, WORKER_SOURCE);

  return workerPath;
}

function getWorker(): Worker {
  if (_worker) {
    return _worker;
  }

  const workerPath = getWorkerPath();
  const appRoot = getAppRoot();

  _worker = new Worker(workerPath, { workerData: { appRoot, MAX_INDEX_FILES, MAX_FILE_BYTES } });
  _worker.on('message', (msg: any) => {
    const pending = _pending.get(msg.id);

    if (!pending) {
      return;
    }
    // Worker signals it has dequeued and started this request: swap the queue
    // cap for the real per-request processing timeout.
    if (msg.ack) {
      pending.onAck();

      return;
    }
    clearTimeout(pending.timer);
    _pending.delete(msg.id);
    if (msg.error) {
      if (msg.errorName === 'QmdTooManyFilesError' && msg.errorCount && msg.errorLimit && msg.errorDirPath) {
        pending.reject(new QmdTooManyFilesError(msg.errorCount, msg.errorLimit, msg.errorDirPath));
      } else {
        pending.reject(new Error(msg.error));
      }
    } else {
      pending.resolve(msg.result);
    }
  });
  _worker.on('error', (err: Error) => {
    console.error('[QMD Worker] error:', err);
  });
  _worker.on('exit', (code: number) => {
    console.log(`[QMD Worker] exited with code ${ code }`);
    _worker = null;
    for (const [id, pending] of _pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Worker exited with code ${ code }`));
      _pending.delete(id);
    }
  });

  return _worker;
}

// Abandon the worker. Used when a request times out — the worker is
// single-threaded and serializes work, so a stuck operation would block every
// subsequent call. The next getWorker() call spins up a fresh one; the SQLite
// store on disk is durable and the in-memory _realPathMap is rebuilt on the
// next index.
//
// We deliberately do NOT call worker.terminate() here. Terminate disposes the
// worker's V8 isolate immediately; if the thread is parked inside a synchronous
// better-sqlite3 native call at that instant (which it always is during a slow
// FTS query), the isolate teardown races the native call and segfaults the
// WHOLE Electron process — observed as a SIGSEGV in v8::Isolate::Dispose().
// Instead we detach our listeners, reject anything pending, unref the thread so
// it can't keep the process alive, and post a cooperative __exit it will honor
// once its current native call returns. A briefly-leaked thread is a far better
// failure mode than crashing the app.
function killWorker(reason: string): void {
  if (!_worker) {
    return;
  }
  console.warn(`[QMD Worker] abandoning: ${ reason }`);
  const w = _worker;
  _worker = null;

  for (const [id, pending] of _pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`QMD worker abandoned: ${ reason }`));
    _pending.delete(id);
  }

  w.removeAllListeners('message');
  w.removeAllListeners('exit');
  w.removeAllListeners('error');
  w.on('error', () => { /* swallow — this worker is orphaned */ });
  try {
    w.postMessage({ id: -1, action: '__exit' });
  } catch { /* already gone */ }
  w.unref();
}

function postRequest(action: string, params: any, timeoutMs: number): Promise<any> {
  const id = ++_requestId;
  const worker = getWorker();

  return new Promise((resolve, reject) => {
    const fail = (ms: number, why: string) => {
      if (!_pending.has(id)) return;
      _pending.delete(id);
      killWorker(`${ action } request ${ id } ${ why }`);
      reject(new QmdTimeoutError(action, ms));
    };

    const arm = (ms: number, why: string): NodeJS.Timeout => {
      const t = setTimeout(() => fail(ms, why), ms);
      // Don't keep the event loop alive on this timer.
      if (typeof t.unref === 'function') t.unref();

      return t;
    };

    // Phase 1: queue-wait cap. Phase 2 (on ack): real processing timeout. This
    // split is what stops a search from timing out while it's still queued
    // behind a long-running index in the single worker thread.
    const entry: Pending = {
      resolve,
      reject,
      timer: arm(QUEUE_TIMEOUT_MS, `stuck in queue > ${ QUEUE_TIMEOUT_MS }ms`),
      onAck: () => {
        clearTimeout(entry.timer);
        entry.timer = arm(timeoutMs, `exceeded ${ timeoutMs }ms`);
      },
    };
    _pending.set(id, entry);
    worker.postMessage({ id, action, ...params });
  });
}

// ── Public API ──────────────────────────────────────────────────

export function closeQmdStore(): void {
  if (_worker) {
    // Only reached on app shutdown; the process is exiting anyway so the
    // mid-native-call terminate hazard is moot. Guard against throws regardless.
    _worker.terminate().catch(() => { /* shutting down */ });
    _worker = null;
  }
}

export async function indexDirectory(
  dirPath: string,
  glob?: string,
): Promise<{ indexed: number; updated: number; removed: number }> {
  return postRequest('index', { dirPath, glob }, INDEX_TIMEOUT_MS);
}

export async function search(
  query: string,
  dirPath: string,
  limit = 20,
): Promise<QmdSearchResult[]> {
  return postRequest('search', { query, dirPath, limit }, SEARCH_TIMEOUT_MS);
}

// ── Inline worker source ────────────────────────────────────────
// This ESM script runs in a separate thread. It owns the SQLite handle
// and performs all qmd operations, keeping the main process responsive.

const WORKER_SOURCE = `
import { parentPort, workerData } from 'worker_threads';
import { createRequire } from 'module';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Create a require function rooted at the app so we can find node_modules
const appRequire = createRequire(path.join(workerData.appRoot, 'package.json'));

// Resolve qmd module paths relative to the app's node_modules
const qmdStorePath = appRequire.resolve('@tobilu/qmd/dist/store.js');
const qmdCollectionsPath = appRequire.resolve('@tobilu/qmd/dist/collections.js');
const fastGlobPath = appRequire.resolve('fast-glob');

const TEXT_FILE_GLOB = '**/*.{md,txt,ts,js,vue,json,yaml,yml,jsx,tsx,css,scss,html,py,sh,toml,cfg,ini,xml,svg}';

let _store = null;
let _storeModule = null;
let _collectionsModule = null;
let _fastGlobModule = null;

// Map from "collectionName/handleizedPath" to original relative file path.
// Built during indexing, used during search to resolve real filesystem paths
// since handelize() is lossy (dots→hyphens, uppercase→lowercase).
const _realPathMap = new Map();

// FTS5 query construction — mirrors qmd's internal (unexported) buildFTS5Query
// so our direct-SQL ranking path produces the same matches as store.searchFTS.
function sanitizeFTS5Term(term) {
  return term.replace(/[^\\p{L}\\p{N}']/gu, '').toLowerCase();
}
function buildFTS5Query(query) {
  const terms = (query || '').split(/\\s+/).map(sanitizeFTS5Term).filter(t => t.length > 0);
  if (terms.length === 0) return null;
  if (terms.length === 1) return '"' + terms[0] + '"*';
  return terms.map(t => '"' + t + '"*').join(' AND ');
}


async function getStoreModule() {
  if (!_storeModule) _storeModule = await import(qmdStorePath);
  return _storeModule;
}
async function getCollectionsModule() {
  if (!_collectionsModule) _collectionsModule = await import(qmdCollectionsPath);
  return _collectionsModule;
}
async function getFastGlob() {
  if (!_fastGlobModule) _fastGlobModule = await import(fastGlobPath);
  return _fastGlobModule;
}

function getDbPath() {
  return path.join(os.homedir(), '.cache', 'sulla-qmd', 'index.sqlite');
}

async function getStore() {
  if (_store) return _store;
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { createStore } = await getStoreModule();
  _store = createStore(dbPath);
  return _store;
}

function collectionName(dirPath) {
  return dirPath.replace(/\\//g, '_').replace(/^_/, '');
}

function quickSnippet(body, query) {
  if (!body) return null;
  const terms = query.toLowerCase().split(/\\s+/).filter(t => t.length > 1);
  if (!terms.length) return null;
  const searchable = body.length > 50000 ? body.slice(0, 50000) : body;
  const lines = searchable.split('\\n');
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (terms.some(t => lower.includes(t))) {
      return { line: i + 1, snippet: lines[i].trim().slice(0, 200) };
    }
  }
  return null;
}

async function handleIndex({ dirPath, glob }) {
  const store = await getStore();
  const resolvedDir = path.resolve(dirPath);
  const colName = collectionName(resolvedDir);
  const now = new Date().toISOString();
  const collections = await getCollectionsModule();
  collections.addCollection(colName, resolvedDir, glob || TEXT_FILE_GLOB);
  const fastGlob = await getFastGlob();
  const excludeDirs = ['node_modules', '.git', '.cache', 'vendor', 'dist', 'build', '.Trash', '.Trashes', 'Library', '.local', '.npm', '.nvm', '.docker', '.kube'];
  const allFiles = await fastGlob.default(glob || TEXT_FILE_GLOB, {
    cwd: resolvedDir, onlyFiles: true, followSymbolicLinks: false, dot: false,
    ignore: excludeDirs.map(d => '**/' + d + '/**'),
  });
  const files = allFiles.filter(file => !file.split('/').some(p => p.startsWith('.')));
  // Guardrail: refuse to index unbounded trees. Without this, a request like
  // dirPath="~/Sites" enumerates and reads every text file across hundreds of
  // repos and wedges the single-threaded worker.
  const maxFiles = workerData.MAX_INDEX_FILES || 10000;
  if (files.length > maxFiles) {
    const err = new Error('qmd index aborted: ' + files.length + ' files in ' + resolvedDir + ' exceeds limit of ' + maxFiles + '. Narrow the dirPath.');
    err.name = 'QmdTooManyFilesError';
    err.count = files.length;
    err.limit = maxFiles;
    err.dirPath = resolvedDir;
    throw err;
  }
  const { hashContent, extractTitle, handelize } = await getStoreModule();
  let indexed = 0, updated = 0;
  const maxBytes = workerData.MAX_FILE_BYTES || 1000000;
  for (const relativeFile of files) {
    const filepath = path.resolve(resolvedDir, relativeFile);
    // Skip oversized files before reading them into memory — minified bundles
    // and vendored blobs bloat the FTS index and slow every later search.
    try { if (fs.statSync(filepath).size > maxBytes) continue; } catch { continue; }
    const normalizedPath = handelize(relativeFile);
    // Store mapping so search can recover the real filesystem path
    _realPathMap.set(colName + '/' + normalizedPath, relativeFile);
    let content;
    try { content = fs.readFileSync(filepath, 'utf-8'); } catch { continue; }
    if (!content.trim()) continue;
    const hash = await hashContent(content);
    const title = extractTitle(content, relativeFile);
    const existing = store.findActiveDocument(colName, normalizedPath);
    if (existing) {
      if (existing.hash !== hash) {
        store.insertContent(hash, content, now);
        const stat = fs.statSync(filepath);
        store.updateDocument(existing.id, title, hash, stat ? new Date(stat.mtime).toISOString() : now);
        updated++;
      }
    } else {
      store.insertContent(hash, content, now);
      const stat = fs.statSync(filepath);
      store.insertDocument(colName, normalizedPath, title, hash,
        stat ? new Date(stat.birthtime).toISOString() : now,
        stat ? new Date(stat.mtime).toISOString() : now);
      indexed++;
    }
  }
  const activePaths = store.getActiveDocumentPaths(colName);
  const currentPaths = new Set(files.map(f => handelize(f)));
  let removed = 0;
  for (const activePath of activePaths) {
    if (!currentPaths.has(activePath)) {
      store.deactivateDocument(colName, activePath);
      removed++;
    }
  }
  return { indexed, updated, removed };
}

async function handleSearch({ query, dirPath, limit }) {
  const store = await getStore();
  const resolvedDir = path.resolve(dirPath);
  const colName = collectionName(resolvedDir);
  const ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return [];
  const n = limit || 20;

  // Rank using ONLY the FTS index + the small documents table. We deliberately
  // do NOT join the content blob table here. qmd's store.searchFTS joins
  // content.doc (full file bodies — gigabytes total, individual docs up to tens
  // of MB) for EVERY match before applying LIMIT, which made each query take
  // 30s+, pinned the single worker thread, and triggered the force-terminate
  // SIGSEGV. Bodies for the final top-N are read from disk below instead.
  let ranked;
  try {
    ranked = store.db.prepare(
      "SELECT d.collection || '/' || d.path AS display_path, d.title AS title, d.path AS rel_path, " +
      "bm25(documents_fts, 10.0, 1.0) AS bm25_score " +
      "FROM documents_fts f JOIN documents d ON d.id = f.rowid " +
      "WHERE documents_fts MATCH ? AND d.active = 1 AND d.collection = ? " +
      "ORDER BY bm25_score ASC LIMIT ?",
    ).all(ftsQuery, colName, n);
  } catch (err) {
    // Malformed FTS query or schema mismatch — return empty rather than throw.
    return [];
  }

  const results = [];
  const seenPaths = new Set();
  const maxBytes = workerData.MAX_FILE_BYTES || 1000000;
  for (const r of ranked) {
    // display_path is "collection/handleizedPath". Recover the real relative
    // path via our index-time map (handelize is lossy: dots→hyphens, case-fold);
    // fall back to resolveVirtualPath, then the stored path.
    const realRelative = _realPathMap.get(r.display_path);
    let absPath;
    if (realRelative) {
      absPath = path.resolve(resolvedDir, realRelative);
    } else {
      try {
        absPath = store.resolveVirtualPath(r.display_path) || path.resolve(resolvedDir, r.rel_path);
      } catch {
        absPath = path.resolve(resolvedDir, r.rel_path);
      }
    }
    if (seenPaths.has(absPath)) continue;
    seenPaths.add(absPath);

    let snippet = null;
    try {
      const st = fs.statSync(absPath);
      if (st.size <= maxBytes) {
        snippet = quickSnippet(fs.readFileSync(absPath, 'utf-8'), query);
      }
    } catch { /* file moved/deleted since indexing — fall back to title */ }

    // Convert bm25 (negative, lower is better) into stable [0..1), higher = better.
    const score = Math.abs(r.bm25_score) / (1 + Math.abs(r.bm25_score));
    results.push({
      path: absPath,
      name: path.basename(absPath),
      line: snippet?.line ?? 0,
      preview: snippet?.snippet ?? r.title ?? absPath,
      score,
      source: 'fts',
    });
  }
  return results;
}

parentPort.on('message', async (msg) => {
  // Cooperative shutdown: the main process abandons (does not terminate) a
  // worker whose request timed out, then sends __exit. We honor it once the
  // current native call unwinds — exiting ourselves avoids the terminate()
  // isolate-disposal segfault.
  if (msg && msg.action === '__exit') {
    process.exit(0);
    return;
  }
  // Tell the main process we've dequeued and are starting work, so it can start
  // the real processing-timeout clock (instead of counting time spent queued
  // behind other requests in this single-threaded worker).
  try { parentPort.postMessage({ id: msg.id, ack: true }); } catch {}
  try {
    let result;
    if (msg.action === 'index') result = await handleIndex(msg);
    else if (msg.action === 'search') result = await handleSearch(msg);
    else throw new Error('Unknown action: ' + msg.action);
    parentPort.postMessage({ id: msg.id, result });
  } catch (err) {
    const out = { id: msg.id, error: err?.message || String(err) };
    if (err && err.name === 'QmdTooManyFilesError') {
      out.errorName = err.name;
      out.errorCount = err.count;
      out.errorLimit = err.limit;
      out.errorDirPath = err.dirPath;
    }
    parentPort.postMessage(out);
  }
});
`;
