/**
 * QMD Search Service — main-process wrapper around @tobilu/qmd.
 *
 * All heavy work (SQLite queries, file indexing) runs in a Worker thread
 * so the Electron main process and UI never block.
 *
 * qmd is an ESM package with top-level await, so the worker uses dynamic import().
 */

import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

export interface QmdSearchResult {
  path: string;
  name: string;
  line: number;
  preview: string;
  score: number;
  source: 'fts' | 'filename';
}

// ── Worker management ───────────────────────────────────────────

let _worker: Worker | null = null;
let _requestId = 0;
const _pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

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

  _worker = new Worker(workerPath, { workerData: { appRoot } });
  _worker.on('message', (msg: any) => {
    const pending = _pending.get(msg.id);

    if (!pending) {
      return;
    }
    _pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error));
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
      pending.reject(new Error(`Worker exited with code ${ code }`));
      _pending.delete(id);
    }
  });

  return _worker;
}

function postRequest(action: string, params: any): Promise<any> {
  const id = ++_requestId;
  const worker = getWorker();

  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    worker.postMessage({ id, action, ...params });
  });
}

// ── Public API ──────────────────────────────────────────────────

export function closeQmdStore(): void {
  if (_worker) {
    _worker.terminate();
    _worker = null;
  }
}

export async function indexDirectory(
  dirPath: string,
  glob?: string,
): Promise<{ indexed: number; updated: number; removed: number }> {
  return postRequest('index', { dirPath, glob });
}

export async function search(
  query: string,
  dirPath: string,
  limit = 20,
): Promise<QmdSearchResult[]> {
  return postRequest('search', { query, dirPath, limit });
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
  const excludeDirs = ['node_modules', '.git', '.cache', 'vendor', 'dist', 'build'];
  const allFiles = await fastGlob.default(glob || TEXT_FILE_GLOB, {
    cwd: resolvedDir, onlyFiles: true, followSymbolicLinks: false, dot: false,
    ignore: excludeDirs.map(d => '**/' + d + '/**'),
  });
  const files = allFiles.filter(file => !file.split('/').some(p => p.startsWith('.')));
  const { hashContent, extractTitle, handelize } = await getStoreModule();
  let indexed = 0, updated = 0;
  for (const relativeFile of files) {
    const filepath = path.resolve(resolvedDir, relativeFile);
    const normalizedPath = handelize(relativeFile);
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
  const results = [];
  const seenPaths = new Set();
  try {
    const ftsResults = store.searchFTS(query, limit || 20, colName);
    for (const r of ftsResults) {
      // r.filepath is a virtual path like "qmd://ColName/handlized/path.ext"
      // Use the store's resolveVirtualPath to map it back to the real filesystem path
      // via the collection's pwd, avoiding the doubled-path bug where the collection
      // name (e.g. "Users_jonathonbyrdziak_sulla") was treated as a relative directory.
      const absPath = store.resolveVirtualPath(r.filepath) || path.resolve(resolvedDir, r.displayPath || r.filepath);
      if (seenPaths.has(absPath)) continue;
      seenPaths.add(absPath);
      const snippet = quickSnippet(r.body, query);
      results.push({
        path: absPath,
        name: path.basename(absPath),
        line: snippet?.line ?? 0,
        preview: snippet?.snippet ?? r.title ?? absPath,
        score: r.score,
        source: 'fts',
      });
    }
  } catch (err) {
    // FTS error - return empty results
  }
  return results;
}

parentPort.on('message', async (msg) => {
  try {
    let result;
    if (msg.action === 'index') result = await handleIndex(msg);
    else if (msg.action === 'search') result = await handleSearch(msg);
    else throw new Error('Unknown action: ' + msg.action);
    parentPort.postMessage({ id: msg.id, result });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, error: err?.message || String(err) });
  }
});
`;
