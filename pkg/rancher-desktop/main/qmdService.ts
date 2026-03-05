/**
 * QMD Search Service — main-process wrapper around @tobilu/qmd.
 *
 * Provides file indexing and hybrid search (BM25 full-text + filename matching)
 * for the AgentEditor's FileSearch component.
 */

import * as path from 'path';
import * as fs from 'fs';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

// Lazy-loaded qmd modules (native deps — must not be imported at module level
// to avoid breaking renderer bundles if this file is ever transitively imported).
let _store: any = null;
let _storePath: string | null = null;

const TEXT_FILE_GLOB = '**/*.{md,txt,ts,js,vue,json,yaml,yml,jsx,tsx,css,scss,html,py,sh,toml,cfg,ini,xml,svg}';

export interface QmdSearchResult {
  path: string;
  name: string;
  line: number;
  preview: string;
  score: number;
  source: 'fts' | 'filename';
}

function getDbPath(): string {
  const os = require('os');

  return path.join(os.homedir(), '.cache', 'sulla-qmd', 'index.sqlite');
}

function ensureDbDir(): void {
  const dbPath = getDbPath();

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

function getStore(): any {
  if (_store) {
    return _store;
  }
  ensureDbDir();
  const { createStore } = require('@tobilu/qmd/dist/store.js');

  _store = createStore(getDbPath());
  _storePath = getDbPath();

  return _store;
}

/**
 * Close the store and release the SQLite handle.
 */
export function closeQmdStore(): void {
  if (_store) {
    try {
      _store.close();
    } catch { /* ignore */ }
    _store = null;
    _storePath = null;
  }
}

/**
 * Derive a safe collection name from a directory path.
 */
function collectionName(dirPath: string): string {
  return dirPath.replace(/\//g, '_').replace(/^_/, '');
}

/**
 * Index all text files in a directory into qmd.
 * Adds/updates documents, deactivates removed files.
 */
export async function indexDirectory(
  dirPath: string,
  glob: string = TEXT_FILE_GLOB,
): Promise<{ indexed: number; updated: number; removed: number }> {
  const store = getStore();
  const resolvedDir = path.resolve(dirPath);
  const colName = collectionName(resolvedDir);
  const now = new Date().toISOString();

  // Register the collection in qmd's YAML config
  const collections = require('@tobilu/qmd/dist/collections.js');

  collections.addCollection(colName, resolvedDir, glob);

  // Walk files using fast-glob (same as qmd internally uses)
  const fastGlob = require('fast-glob');
  const excludeDirs = ['node_modules', '.git', '.cache', 'vendor', 'dist', 'build'];
  const allFiles: string[] = await fastGlob(glob, {
    cwd:                  resolvedDir,
    onlyFiles:            true,
    followSymbolicLinks:  false,
    dot:                  false,
    ignore:               excludeDirs.map((d: string) => `**/${ d }/**`),
  });

  // Filter hidden files
  const files = allFiles.filter((file: string) => {
    const parts = file.split('/');

    return !parts.some((part: string) => part.startsWith('.'));
  });

  const { hashContent, extractTitle, handelize } = require('@tobilu/qmd/dist/store.js');

  let indexed = 0;
  let updated = 0;

  for (const relativeFile of files) {
    const filepath = path.resolve(resolvedDir, relativeFile);
    const normalizedPath = handelize(relativeFile);

    let content: string;

    try {
      content = fs.readFileSync(filepath, 'utf-8');
    } catch {
      continue;
    }
    if (!content.trim()) {
      continue;
    }

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

      store.insertDocument(
        colName,
        normalizedPath,
        title,
        hash,
        stat ? new Date(stat.birthtime).toISOString() : now,
        stat ? new Date(stat.mtime).toISOString() : now,
      );
      indexed++;
    }
  }

  // Deactivate documents that no longer exist on disk
  const activePaths = store.getActiveDocumentPaths(colName);
  const currentPaths = new Set(files.map((f: string) => handelize(f)));
  let removed = 0;

  for (const activePath of activePaths) {
    if (!currentPaths.has(activePath)) {
      store.deactivateDocument(colName, activePath);
      removed++;
    }
  }

  console.log(`[QMD] Indexed ${ dirPath }: ${ indexed } new, ${ updated } updated, ${ removed } removed`);

  return { indexed, updated, removed };
}

/**
 * Search files using qmd's BM25 full-text search + filename matching.
 * Merges and deduplicates results from both sources.
 */
export function search(query: string, dirPath: string, limit = 20): QmdSearchResult[] {
  const store = getStore();
  const resolvedDir = path.resolve(dirPath);
  const colName = collectionName(resolvedDir);

  const results: QmdSearchResult[] = [];
  const seenPaths = new Set<string>();

  // 1. Full-text search (BM25 via FTS5)
  try {
    const ftsResults = store.searchFTS(query, limit, colName);

    for (const r of ftsResults) {
      if (seenPaths.has(r.filepath)) {
        continue;
      }
      seenPaths.add(r.filepath);

      const { extractSnippet } = require('@tobilu/qmd/dist/store.js');
      const body = store.getDocumentBody(r) || '';
      const snippet = extractSnippet(body, query);

      results.push({
        path:    r.filepath,
        name:    path.basename(r.filepath),
        line:    snippet?.line ?? 0,
        preview: snippet?.snippet ?? r.title ?? '',
        score:   r.score,
        source:  'fts',
      });
    }
  } catch (err) {
    console.error('[QMD] FTS search error:', err);
  }

  // 2. Filename matching
  try {
    const similarFiles = store.findSimilarFiles(query, 5, limit);

    for (const filepath of similarFiles) {
      if (seenPaths.has(filepath)) {
        continue;
      }
      seenPaths.add(filepath);
      results.push({
        path:    filepath,
        name:    path.basename(filepath),
        line:    0,
        preview: filepath,
        score:   0.5,
        source:  'filename',
      });
    }
  } catch (err) {
    console.error('[QMD] Filename search error:', err);
  }

  // Sort by score descending, limit
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}
