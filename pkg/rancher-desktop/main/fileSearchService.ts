/**
 * File Search Service — tiered full-text search engine behind the file_search tool.
 *
 * Replaces the qmd/worker_threads implementation. All heavy work (SQLite FTS5,
 * enumeration, file reads) runs in an Electron utilityProcess sidecar so the
 * main process never blocks — and, unlike a worker_thread, a stuck sidecar can
 * simply be kill()ed. Terminating a worker parked inside a synchronous
 * better-sqlite3 native call segfaulted the whole app (SIGSEGV in
 * v8::Isolate::Dispose()), which forced an abandon-don't-terminate mitigation
 * that leaked stuck threads until OOM. Process isolation removes that hazard.
 *
 * Storage is a contentless FTS5 index (~/.cache/sulla-search/index.sqlite):
 * tokens only, never file bodies — the old qmd store kept full bodies and grew
 * to 692 MB over a ~5 MB corpus. Snippets are re-read from disk at query time.
 *
 * Tiering: roots with ≤ SMALL_TIER_MAX candidate text files are scanned live
 * on every search (always fresh, zero maintenance); larger roots use the FTS
 * index, built incrementally under a per-run byte budget with honest coverage
 * reporting via index_meta.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

export interface FileSearchResult {
  path:    string;
  name:    string;
  line:    number;
  preview: string;
  score:   number;
  source:  'fts' | 'filename' | 'scan';
}

/**
 * Honest-coverage numbers for the last FTS-tier search against a root.
 * Large-tier indexing is budgeted per pass, so the index can lag the corpus;
 * callers surface these instead of silently pretending full coverage.
 */
export interface SearchCoverage {
  indexedCount:   number;
  candidateCount: number;
  truncated:      boolean;
  lastPassAt:     number; // epoch ms of the last completed index pass
}

// ── Budgets and limits ──────────────────────────────────────────

const SEARCH_TIMEOUT_MS = 15_000;
const INDEX_TIMEOUT_MS = 120_000;
// Skip files larger than this in both tiers. Minified bundles / vendored blobs
// (one observed at 27 MB) add almost no search value but bloat the FTS index
// and make every query slower. ~1 MB covers all real source/docs.
const MAX_FILE_BYTES = 1_000_000;
// At or below this many candidate text files a root is scanned live on every
// search — always fresh, no index to maintain or go stale.
const SMALL_TIER_MAX = 2_000;
// Hard ceiling for large-tier indexing. Over this, indexDirectory refuses and
// asks the caller to narrow the dirPath rather than wedging the sidecar.
const MAX_INDEX_FILES = 500_000;
// One indexDirectory pass reads at most this many bytes of new/changed file
// bodies. Unread files simply aren't in the files table yet, so the next pass
// resumes where this one stopped — passes converge monotonically.
const INDEX_BYTE_BUDGET = 512 * 1024 * 1024;

// Upper bound on how long a request may sit in the sidecar's queue before it
// is actually picked up (the sidecar serializes work). Must comfortably exceed
// the longest op that could be ahead of it — an in-flight index. Until the
// sidecar acks that it has started a given request, only this cap applies, so
// a search never times out merely because an index is running ahead of it.
const QUEUE_TIMEOUT_MS = INDEX_TIMEOUT_MS + 30_000;

// Crash breaker: more than CRASH_LIMIT abnormal exits (crash or killed for
// timeout) within CRASH_WINDOW_MS puts the service in degraded mode for
// DEGRADED_MS — no respawn loops, no wedged app.
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 10 * 60_000;
const DEGRADED_MS = 10 * 60_000;

// ── Candidate-file rules ────────────────────────────────────────
// Defined once here and injected into the sidecar source at spawn time so the
// sidecar and the parent's degraded-mode direct scanner can never drift apart.

const TEXT_EXTENSIONS = [
  'md', 'txt', 'ts', 'js', 'vue', 'json', 'yaml', 'yml', 'jsx', 'tsx',
  'css', 'scss', 'html', 'py', 'sh', 'toml', 'cfg', 'ini', 'xml', 'svg',
];
const TEXT_FILE_GLOB = `**/*.{${ TEXT_EXTENSIONS.join(',') }}`;

// Directory names never traversed, in addition to any directory starting with
// '.' (existing behavior). Library (macOS) and AppData (Windows) hold app
// caches/state measured in millions of files with near-zero search value.
const EXCLUDE_DIRS = [
  'node_modules', '.git', '.cache', 'vendor', 'dist', 'build',
  '.Trash', '.Trashes', 'Library', 'AppData',
  '.local', '.npm', '.nvm', '.docker', '.kube',
];

// SENSITIVE denylist — non-configurable, enforced in both tiers and the
// walker: never enumerated, never indexed, never scanned. Contentless FTS
// stores no bodies, but tokens alone still leak secrets. Names starting with
// '.keychain' and the '.config/gcloud' subtree are also denied (in code).
const SENSITIVE_DIR_NAMES = ['.ssh', '.gnupg', '.aws', '.azure', '.password-store', 'wallets'];

// ── Errors ──────────────────────────────────────────────────────

export class SearchTimeoutError extends Error {
  constructor(action: string, ms: number) {
    super(`file search ${ action } timed out after ${ ms }ms`);
    this.name = 'SearchTimeoutError';
  }
}

export class SearchTooManyFilesError extends Error {
  constructor(public count: number, public limit: number, public dirPath: string) {
    super(`file search index aborted: ${ count } files in ${ dirPath } exceeds limit of ${ limit }. Narrow the dirPath.`);
    this.name = 'SearchTooManyFilesError';
  }
}

// ── Sidecar management ──────────────────────────────────────────

interface Pending {
  resolve: (v: any) => void;
  reject:  (e: Error) => void;
  timer:   NodeJS.Timeout;
  onAck:   () => void;
}

let _child: Electron.UtilityProcess | null = null;
let _requestId = 0;
const _pending = new Map<number, Pending>();
// Set before an intentional kill (timeout or shutdown) so the exit handler
// doesn't double-count the resulting non-zero exit as a fresh crash.
let _expectedExit = false;
let _crashTimes: number[] = [];
let _degradedUntil = 0;
const _lastCoverage = new Map<string, SearchCoverage | null>();

/**
 * Resolve the app root so the sidecar can find node_modules.
 * Walks up from Electron's app path (or cwd) looking for node_modules/better-sqlite3.
 *
 * Packaged builds: app.getAppPath() is .../Contents/Resources/app.asar and
 * node_modules lives inside the archive, so the existsSync below only matches
 * through Electron's asar-patched fs. That asar path is the CORRECT return
 * value — the sidecar's createRequire must resolve pure-JS deps (fast-glob)
 * from the archive, while better-sqlite3's native binary is unpacked to the
 * app.asar.unpacked sibling and redirected automatically. The explicit
 * unpacked check is a fallback for any case where the asar view misses it.
 */
function getAppRoot(): string {
  const { app } = require('electron');
  // app.getAppPath() returns e.g. /path/to/sulla-desktop/dist/app in dev
  let dir = app.getAppPath();

  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'node_modules', 'better-sqlite3'))) {
      return dir;
    }
    if (dir.endsWith('app.asar') &&
        fs.existsSync(path.join(`${ dir }.unpacked`, 'node_modules', 'better-sqlite3'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  console.error(`[file_search] app root not found walking up from ${ app.getAppPath() } — falling back to cwd ${ process.cwd() }`);

  return process.cwd();
}

function getSidecarPath(): string {
  const sidecarDir = path.join(os.homedir(), '.cache', 'sulla-search');

  fs.mkdirSync(sidecarDir, { recursive: true });

  const sidecarPath = path.join(sidecarDir, 'sidecar.cjs');

  fs.writeFileSync(sidecarPath, SIDECAR_SOURCE);

  return sidecarPath;
}

// Best-effort removal of the legacy qmd store (kept full file bodies; one
// observed at 692 MB). Runs once per app lifetime, on first sidecar spawn.
let _legacyCleaned = false;
function cleanupLegacyIndex(): void {
  if (_legacyCleaned) {
    return;
  }
  _legacyCleaned = true;
  const legacyDir = path.join(os.homedir(), '.cache', 'sulla-qmd');

  try {
    if (!fs.existsSync(legacyDir)) {
      return;
    }
    let bytes = 0;
    const stack = [legacyDir];

    while (stack.length > 0) {
      const dir = stack.pop() as string;

      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);

        if (ent.isDirectory()) {
          stack.push(p);
        } else if (ent.isFile()) {
          try {
            bytes += fs.statSync(p).size;
          } catch { /* being deleted underneath us — fine */ }
        }
      }
    }
    fs.rmSync(legacyDir, { recursive: true, force: true });
    console.log(`[file_search] removed legacy qmd index at ${ legacyDir } (reclaimed ${ (bytes / 1024 / 1024).toFixed(1) } MB)`);
  } catch (err) {
    console.warn('[file_search] legacy qmd index cleanup failed:', err);
  }
}

function isDegraded(): boolean {
  return Date.now() < _degradedUntil;
}

function recordCrash(reason: string): void {
  const now = Date.now();

  _crashTimes.push(now);
  _crashTimes = _crashTimes.filter(t => t > now - CRASH_WINDOW_MS);
  console.warn(`[file_search] sidecar abnormal exit (${ _crashTimes.length } in last 10m): ${ reason }`);
  if (_crashTimes.length > CRASH_LIMIT) {
    _degradedUntil = now + DEGRADED_MS;
    console.error(`[file_search] CRASH BREAKER OPEN: ${ _crashTimes.length } sidecar failures within ${ CRASH_WINDOW_MS / 60_000 }m — ` +
      `degraded mode (direct scan for small dirs only) until ${ new Date(_degradedUntil).toISOString() }`);
  }
}

function getChild(): Electron.UtilityProcess {
  if (_child) {
    return _child;
  }

  cleanupLegacyIndex();

  const { utilityProcess } = require('electron') as typeof import('electron');
  const constants = JSON.stringify({
    SMALL_TIER_MAX, MAX_INDEX_FILES, MAX_FILE_BYTES, INDEX_BYTE_BUDGET, INDEX_TIMEOUT_MS,
  });
  // Config rides in env, not argv — utilityProcess argv layout is not part of
  // the stable contract, and a misread argv[3] means JSON.parse throws before
  // the sidecar can even report why. stdio is piped so a crashing sidecar's
  // stderr lands in background.log instead of vanishing.
  const child = utilityProcess.fork(getSidecarPath(), [], {
    serviceName: 'sulla-file-search',
    stdio:       ['ignore', 'pipe', 'pipe'],
    env:         {
      ...process.env,
      SULLA_SEARCH_APP_ROOT:  getAppRoot(),
      SULLA_SEARCH_CONSTANTS: constants,
    },
  });

  child.stdout?.on('data', (d: Buffer) => {
    const line = d.toString().trim();

    if (line) {
      console.log(`[file_search][sidecar] ${ line }`);
    }
  });
  child.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim();

    if (line) {
      console.error(`[file_search][sidecar:stderr] ${ line }`);
    }
  });

  _child = child;

  child.on('message', (msg: any) => {
    // A sidecar that dies at boot reports the root cause before exiting so
    // the crash breaker log line is actionable, not just "exit code 1".
    if (msg?.bootError) {
      console.error(`[file_search] sidecar BOOT FAILURE: ${ msg.bootError }`);

      return;
    }
    const pending = _pending.get(msg?.id);

    if (!pending) {
      return;
    }
    // Sidecar signals it has dequeued and started this request: swap the queue
    // cap for the real per-request processing timeout.
    if (msg.ack) {
      pending.onAck();

      return;
    }
    clearTimeout(pending.timer);
    _pending.delete(msg.id);
    if (msg.error) {
      if (msg.errorName === 'SearchTooManyFilesError' && msg.errorCount && msg.errorLimit && msg.errorDirPath) {
        pending.reject(new SearchTooManyFilesError(msg.errorCount, msg.errorLimit, msg.errorDirPath));
      } else {
        pending.reject(new Error(msg.error));
      }
    } else {
      pending.resolve(msg.result);
    }
  });
  child.on('exit', (code: number) => {
    console.log(`[file_search] sidecar exited with code ${ code }`);
    if (_child === child) {
      _child = null;
    }
    if (_expectedExit) {
      _expectedExit = false;
    } else if (code !== 0) {
      recordCrash(`exit code ${ code }`);
    }
    for (const [id, pending] of _pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`file search sidecar exited with code ${ code }`));
      _pending.delete(id);
    }
  });

  return child;
}

// Kill the sidecar. Used when a request times out — the sidecar serializes
// work, so a stuck operation would block every subsequent call. Unlike the old
// worker_threads implementation (where terminate() mid-native-call segfaulted
// the whole app), killing a separate process is unconditionally safe — that is
// the point of the utilityProcess isolation. Next request respawns.
function killChild(reason: string): void {
  if (!_child) {
    return;
  }
  console.warn(`[file_search] killing sidecar: ${ reason }`);
  const child = _child;

  _child = null;

  for (const [id, pending] of _pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`file search sidecar killed: ${ reason }`));
    _pending.delete(id);
  }

  _expectedExit = true;
  recordCrash(reason);
  try {
    child.kill();
  } catch { /* already gone */ }
}

function postRequest(action: string, params: any, timeoutMs: number): Promise<any> {
  const id = ++_requestId;
  const child = getChild();

  return new Promise((resolve, reject) => {
    const fail = (ms: number, why: string) => {
      if (!_pending.has(id)) {
        return;
      }
      _pending.delete(id);
      killChild(`${ action } request ${ id } ${ why }`);
      reject(new SearchTimeoutError(action, ms));
    };

    const arm = (ms: number, why: string): NodeJS.Timeout => {
      const t = setTimeout(() => fail(ms, why), ms);

      // Don't keep the event loop alive on this timer.
      if (typeof t.unref === 'function') t.unref();

      return t;
    };

    // Phase 1: queue-wait cap. Phase 2 (on ack): real processing timeout. This
    // split is what stops a search from timing out while it's still queued
    // behind a long-running index in the sidecar.
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
    child.postMessage({ id, action, ...params });
  });
}

// ── Public API ──────────────────────────────────────────────────

export function closeFileSearch(): void {
  if (_child) {
    const child = _child;

    _child = null;
    _expectedExit = true;
    try {
      child.kill();
    } catch { /* shutting down */ }
  }
  for (const [id, pending] of _pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error('file search service closed'));
    _pending.delete(id);
  }
}

/**
 * Coverage numbers observed by the most recent search() against this root, or
 * null when the root was live-scanned (full coverage by construction) or never
 * searched. Lets callers report partial index coverage honestly.
 */
export function getLastCoverage(dirPath: string): SearchCoverage | null {
  return _lastCoverage.get(path.resolve(dirPath)) ?? null;
}

export async function indexDirectory(
  dirPath: string,
  glob?: string,
): Promise<{ indexed: number; updated: number; removed: number; candidateCount?: number; truncated?: boolean }> {
  if (isDegraded()) {
    throw new Error('file search engine unavailable (sidecar crash breaker open), retry shortly');
  }
  const t0 = Date.now();
  const result = await postRequest('index', { dirPath, glob }, INDEX_TIMEOUT_MS);

  console.log(`[file_search] index root=${ path.resolve(dirPath) } indexed=${ result.indexed } updated=${ result.updated } ` +
    `removed=${ result.removed } candidates=${ result.candidateCount ?? 'n/a' } truncated=${ result.truncated === true } totalMs=${ Date.now() - t0 }`);

  return result;
}

export async function search(
  query: string,
  dirPath: string,
  limit = 20,
): Promise<FileSearchResult[]> {
  const root = path.resolve(dirPath);
  const t0 = Date.now();

  if (isDegraded()) {
    return degradedDirectScan(query, root, limit, t0);
  }

  const res = await postRequest('search', { query, dirPath: root, limit }, SEARCH_TIMEOUT_MS);
  const coverage: SearchCoverage | null = res.coverage ?? null;

  _lastCoverage.set(root, coverage);
  logSearchTiming(root, res.results.length, res.timing, coverage, Date.now() - t0);

  return res.results;
}

// One structured line per search() resolution — this is the dataset that
// proves/disproves file_search as the subconscious-latency bottleneck.
function logSearchTiming(root: string, results: number, timing: any, coverage: SearchCoverage | null, totalMs: number): void {
  const parts = [`[file_search] tier=${ timing?.tier ?? 'unknown' }`, `root=${ root }`];

  for (const key of ['enumerateMs', 'scanMs', 'queryMs', 'snippetMs'] as const) {
    if (timing?.[key] !== undefined) {
      parts.push(`${ key }=${ timing[key] }`);
    }
  }
  parts.push(`totalMs=${ totalMs }`, `results=${ results }`);
  if (coverage) {
    parts.push(`coverage=indexed:${ coverage.indexedCount }/candidates:${ coverage.candidateCount }`,
      `indexAgeMs=${ Date.now() - coverage.lastPassAt }`);
  }
  console.log(parts.join(' '));
}

// ── Degraded-mode direct scan ───────────────────────────────────
// Fallback while the crash breaker is open: a bounded scan in the main process
// (async fs, no sidecar). Only viable for small-tier roots; anything larger is
// refused rather than blocking the main process on an unbounded read.

function isSensitiveDirName(name: string): boolean {
  return SENSITIVE_DIR_NAMES.includes(name) || name.startsWith('.keychain');
}

async function degradedDirectScan(query: string, root: string, limit: number, t0: number): Promise<FileSearchResult[]> {
  const candidates: { abs: string; rel: string; size: number }[] = [];
  const queue = [root];
  let exceeded = false;

  while (queue.length > 0 && !exceeded) {
    const dir = queue.shift() as string;
    let entries: fs.Dirent[];

    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const name = ent.name;

      if (ent.isSymbolicLink()) {
        continue;
      }
      if (ent.isDirectory()) {
        if (!name.startsWith('.') && !EXCLUDE_DIRS.includes(name) && !isSensitiveDirName(name)) {
          queue.push(path.join(dir, name));
        }
        continue;
      }
      if (!ent.isFile() || name.startsWith('.')) {
        continue;
      }
      const dot = name.lastIndexOf('.');

      if (dot <= 0 || !TEXT_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase())) {
        continue;
      }
      const abs = path.join(dir, name);
      let st: fs.Stats;

      try {
        st = await fs.promises.stat(abs);
      } catch {
        continue;
      }
      // Cloud placeholders: zero blocks but non-zero size means online-only;
      // reading would trigger a network download. blocks is undefined on Windows.
      if (name.endsWith('.icloud') || (typeof st.blocks === 'number' && st.blocks === 0 && st.size > 0)) {
        continue;
      }
      candidates.push({ abs, rel: path.relative(root, abs), size: st.size });
      if (candidates.length > SMALL_TIER_MAX) {
        exceeded = true;
        break;
      }
    }
  }

  if (exceeded) {
    throw new Error(`file search engine unavailable (sidecar crash breaker open) and ${ root } is too large for a direct scan — retry shortly or narrow the dirPath`);
  }

  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const results: FileSearchResult[] = [];

  if (terms.length > 0) {
    for (const c of candidates) {
      if (c.size > MAX_FILE_BYTES) {
        continue;
      }
      let body: string;

      try {
        body = await fs.promises.readFile(c.abs, 'utf-8');
      } catch {
        continue;
      }
      const lowerBody = body.toLowerCase();
      const lowerRel = c.rel.toLowerCase();
      let hits = 0;
      let nameHit = false;
      let all = true;

      for (const term of terms) {
        let count = 0;
        let idx = lowerBody.indexOf(term);

        while (idx !== -1 && count < 100) {
          count++;
          idx = lowerBody.indexOf(term, idx + term.length);
        }
        if (lowerRel.includes(term)) {
          nameHit = true;
        } else if (count === 0) {
          all = false;
          break;
        }
        hits += count;
      }
      if (!all) {
        continue;
      }
      let density = hits / Math.max(1, body.length / 1000);

      if (nameHit) {
        density += 2;
      }
      const lineHit = firstMatchingLine(body, terms);

      results.push({
        path:    c.abs,
        name:    path.basename(c.abs),
        line:    lineHit?.line ?? 0,
        preview: lineHit?.snippet ?? c.rel,
        score:   density / (1 + density),
        source:  nameHit && hits === 0 ? 'filename' : 'scan',
      });
    }
    results.sort((a, b) => b.score - a.score);
  }

  const top = results.slice(0, limit);

  // A completed direct scan is full coverage by construction — don't let a
  // stale FTS coverage entry from before the breaker opened linger.
  _lastCoverage.set(root, null);
  logSearchTiming(root, top.length, { tier: 'degraded-scan', scanMs: Date.now() - t0 }, null, Date.now() - t0);

  return top;
}

function firstMatchingLine(body: string, terms: string[]): { line: number; snippet: string } | null {
  const searchable = body.length > 50_000 ? body.slice(0, 50_000) : body;
  const lines = searchable.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();

    if (terms.some(t => lower.includes(t))) {
      return { line: i + 1, snippet: lines[i].trim().slice(0, 200) };
    }
  }

  return null;
}

// ── Inline sidecar source ───────────────────────────────────────
// Plain CommonJS, written to ~/.cache/sulla-search/sidecar.cjs at spawn time
// and run as an Electron utilityProcess. It owns the SQLite handle and all
// filesystem enumeration, keeping the main process responsive and making a
// hard kill() safe. NOTE: this is a template literal — backslashes in the
// regexes below are doubled so the generated file gets single ones, and the
// only ${ } interpolations are the deliberate constant injections.

const SIDECAR_SOURCE = `'use strict';
// sulla file-search sidecar (generated — source of truth is fileSearchService.ts)
// Config arrives via env (SULLA_SEARCH_APP_ROOT / SULLA_SEARCH_CONSTANTS),
// with argv[2]/argv[3] as a legacy fallback.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

// Any failure past this point that nothing catches would otherwise surface in
// the parent as a bare "exit code 1" — report the cause first, then die.
function reportFatal(prefix, err) {
  try {
    process.parentPort.postMessage({ bootError: prefix + ': ' + String((err && err.stack) || err) });
  } catch { /* parent gone — stderr below is the fallback */ }
  try { console.error('[sidecar] ' + prefix + ':', (err && err.stack) || err); } catch { /* stderr closed */ }
  process.exit(1);
}
process.on('uncaughtException', (err) => reportFatal('uncaughtException', err));
process.on('unhandledRejection', (err) => reportFatal('unhandledRejection', err));

let APP_ROOT;
let CONST;
let Database;
let fastGlob;
try {
  APP_ROOT = process.env.SULLA_SEARCH_APP_ROOT || process.argv[2];
  CONST = JSON.parse(process.env.SULLA_SEARCH_CONSTANTS || process.argv[3]);
  // Resolve deps from the app's node_modules, not from where this generated
  // file lives (~/.cache/sulla-search).
  const appRequire = createRequire(path.join(APP_ROOT, 'package.json'));
  // Packaged fallback: if resolution through the asar view fails (utility
  // process without asar-aware require, or the native dlopen redirect
  // missing), retry from the real-disk app.asar.unpacked copy — the full
  // sidecar dep tree is unpacked there (packaging/electron-builder.yml).
  function sidecarRequire(name) {
    try {
      return appRequire(name);
    } catch (err) {
      const i = APP_ROOT.indexOf('app.asar');
      if (i === -1) throw err;
      const unpacked = APP_ROOT.slice(0, i) + 'app.asar.unpacked';
      return createRequire(path.join(unpacked, 'package.json'))(name);
    }
  }
  Database = sidecarRequire('better-sqlite3');
  fastGlob = sidecarRequire('fast-glob');
} catch (err) {
  reportFatal('boot (appRoot=' + APP_ROOT + ')', err);
}

// ── Candidate-file rules (injected from fileSearchService.ts) ───
const TEXT_EXTS = new Set(${ JSON.stringify(TEXT_EXTENSIONS) });
const TEXT_FILE_GLOB = ${ JSON.stringify(TEXT_FILE_GLOB) };
const EXCLUDE_DIRS = new Set(${ JSON.stringify(EXCLUDE_DIRS) });
const SENSITIVE_DIRS = new Set(${ JSON.stringify(SENSITIVE_DIR_NAMES) });

// Sensitive trees are never enumerated, indexed, or scanned. Contentless FTS
// stores no bodies, but tokens alone still leak secrets — hard denylist.
function isSensitiveName(name) {
  return SENSITIVE_DIRS.has(name) || name.startsWith('.keychain');
}
function relPathIsSensitive(rel) {
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    if (isSensitiveName(segs[i])) return true;
    // .config itself is fine; .config/gcloud holds cloud credentials.
    if (segs[i] === '.config' && segs[i + 1] === 'gcloud') return true;
  }
  return false;
}

// Cloud placeholders (iCloud/OneDrive online-only files) report a size but
// occupy zero disk blocks; reading one triggers a network download. Skip them.
// Stats.blocks is undefined on Windows — guard.
function isCloudPlaceholder(st, name) {
  if (name.endsWith('.icloud')) return true;
  return typeof st.blocks === 'number' && st.blocks === 0 && st.size > 0;
}

// ── Capped enumeration ──────────────────────────────────────────
// Manual breadth-first walk rather than fast-glob because tier decisions need
// an early abort the moment the cap is crossed. BFS also yields the shallow-
// first ordering the scan tier wants for free. Skips dot-dirs, EXCLUDE_DIRS,
// sensitive trees, symlinks, non-text extensions, and cloud placeholders.
function cappedWalk(root, cap) {
  const candidates = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const name = ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (name.startsWith('.') || EXCLUDE_DIRS.has(name) || isSensitiveName(name)) continue;
        queue.push(path.join(dir, name));
        continue;
      }
      if (!ent.isFile() || name.startsWith('.')) continue;
      const dot = name.lastIndexOf('.');
      if (dot <= 0 || !TEXT_EXTS.has(name.slice(dot + 1).toLowerCase())) continue;
      const abs = path.join(dir, name);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (isCloudPlaceholder(st, name)) continue;
      candidates.push({ abs: abs, rel: path.relative(root, abs), size: st.size });
      if (candidates.length > cap) return { candidates: candidates, exceeded: true };
    }
  }
  return { candidates: candidates, exceeded: false };
}

// ── Index store — contentless FTS5 ──────────────────────────────
// The token index is the ONLY artifact; file bodies are never stored
// (content='') — storing bodies is what grew the old qmd store to 692 MB.
// Snippets are re-read from disk for the top-N hits at query time.
let _db = null;

function getDb() {
  if (_db) return _db;
  const dbDir = path.join(os.homedir(), '.cache', 'sulla-search');
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new Database(path.join(dbDir, 'index.sqlite'));
  // contentless_delete needs SQLite >= 3.43; better-sqlite3 12.x bundles >= 3.45.
  const ver = db.prepare('SELECT sqlite_version() AS v').get().v;
  const parts = String(ver).split('.').map(Number);
  if (parts[0] < 3 || (parts[0] === 3 && parts[1] < 43)) {
    db.close();
    throw new Error('SQLite ' + ver + ' lacks FTS5 contentless_delete (needs >= 3.43); check the bundled better-sqlite3');
  }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Retry on SQLITE_BUSY instead of throwing immediately — a previous sidecar
  // killed mid-write can hold the WAL lock briefly while its OS handles close.
  db.pragma('busy_timeout = 5000');
  // Bounded page cache (~16 MB) keeps this sidecar's memory footprint flat.
  db.pragma('cache_size = -16000');
  db.exec(
    'CREATE TABLE IF NOT EXISTS files (' +
    '  id INTEGER PRIMARY KEY,' +
    '  root TEXT NOT NULL,' +
    '  path TEXT NOT NULL,' +
    '  mtime_ms INTEGER NOT NULL,' +
    '  size INTEGER NOT NULL,' +
    '  active INTEGER NOT NULL DEFAULT 1,' +
    '  UNIQUE(root, path)' +
    ');' +
    'CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(' +
    "  name, body, content='', contentless_delete=1, tokenize='unicode61'" +
    ');' +
    'CREATE TABLE IF NOT EXISTS index_meta (' +
    '  root TEXT PRIMARY KEY,' +
    '  last_pass_at INTEGER NOT NULL,' +
    '  candidate_count INTEGER NOT NULL,' +
    '  indexed_count INTEGER NOT NULL,' +
    '  truncated INTEGER NOT NULL DEFAULT 0' +
    ');');
  _db = db;
  return db;
}

// ── FTS5 query construction ─────────────────────────────────────
// AND of quoted prefix terms; sanitizer strips everything FTS5 could parse as
// syntax so user input can never produce a malformed MATCH expression.
function sanitizeFTS5Term(term) {
  return term.replace(/[^\\p{L}\\p{N}']/gu, '').toLowerCase();
}
function buildFTS5Query(query) {
  const terms = (query || '').split(/\\s+/).map(sanitizeFTS5Term).filter(t => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map(t => '"' + t + '"*').join(' AND ');
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

// ── Small-tier live scan ────────────────────────────────────────
// Reads every candidate (all <= SMALL_TIER_MAX of them, each <= MAX_FILE_BYTES)
// and requires every term to appear in the body or the relative path. Ranked
// by term-hit density (hits per KB) with a flat filename-match boost, mapped
// to the same [0..1) score band as the FTS tier.
function scanSearch(candidates, query, limit) {
  const terms = (query || '').toLowerCase().split(/\\s+/).filter(t => t.length > 1);
  if (!terms.length) return [];
  const scored = [];
  for (const c of candidates) {
    if (c.size > CONST.MAX_FILE_BYTES) continue;
    let body;
    try { body = fs.readFileSync(c.abs, 'utf-8'); } catch { continue; }
    const lowerBody = body.toLowerCase();
    const lowerRel = c.rel.toLowerCase();
    let hits = 0;
    let nameHit = false;
    let all = true;
    for (const term of terms) {
      let count = 0;
      let idx = lowerBody.indexOf(term);
      while (idx !== -1 && count < 100) { count++; idx = lowerBody.indexOf(term, idx + term.length); }
      if (lowerRel.includes(term)) nameHit = true;
      else if (count === 0) { all = false; break; }
      hits += count;
    }
    if (!all) continue;
    let density = hits / Math.max(1, body.length / 1000);
    if (nameHit) density += 2;
    const snip = quickSnippet(body, query);
    scored.push({
      path: c.abs,
      name: path.basename(c.abs),
      line: snip ? snip.line : 0,
      preview: snip ? snip.snippet : c.rel,
      score: density / (1 + density),
      source: nameHit && hits === 0 ? 'filename' : 'scan',
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ── Search ──────────────────────────────────────────────────────
function handleSearch(msg) {
  const t0 = Date.now();
  const resolvedDir = path.resolve(msg.dirPath);
  const n = msg.limit || 20;
  const walk = cappedWalk(resolvedDir, CONST.SMALL_TIER_MAX);
  const enumerateMs = Date.now() - t0;

  if (!walk.exceeded) {
    const t1 = Date.now();
    const results = scanSearch(walk.candidates, msg.query, n);
    return { results: results, coverage: null, timing: { tier: 'scan', enumerateMs: enumerateMs, scanMs: Date.now() - t1 } };
  }

  // Large tier: FTS index. A never-indexed root returns [] — the caller
  // (meta_search) already handles empty-results-then-index-then-retry.
  const db = getDb();
  const metaRow = db.prepare('SELECT last_pass_at, candidate_count, indexed_count, truncated FROM index_meta WHERE root = ?').get(resolvedDir);
  const coverage = metaRow ? {
    indexedCount: metaRow.indexed_count,
    candidateCount: metaRow.candidate_count,
    truncated: !!metaRow.truncated,
    lastPassAt: metaRow.last_pass_at,
  } : null;
  const ftsQuery = buildFTS5Query(msg.query);
  if (!ftsQuery || !metaRow) {
    return { results: [], coverage: coverage, timing: { tier: 'fts', enumerateMs: enumerateMs, queryMs: 0, snippetMs: 0 } };
  }

  const t1 = Date.now();
  let ranked = [];
  try {
    // Weight the name column 5x — a filename token match should outrank an
    // incidental body mention. bm25 is negative (lower = better).
    ranked = db.prepare(
      'SELECT f.path AS rel_path, bm25(files_fts, 5.0, 1.0) AS s ' +
      'FROM files_fts JOIN files f ON f.id = files_fts.rowid ' +
      'WHERE files_fts MATCH ? AND f.active = 1 AND f.root = ? ' +
      'ORDER BY s LIMIT ?').all(ftsQuery, resolvedDir, n);
  } catch (err) {
    ranked = []; // malformed MATCH or schema mismatch — empty beats a throw
  }
  const queryMs = Date.now() - t1;

  const t2 = Date.now();
  const results = [];
  for (const r of ranked) {
    const absPath = path.resolve(resolvedDir, r.rel_path);
    // Snippets come from disk at query time — the index is contentless.
    let snip = null;
    try {
      const st = fs.statSync(absPath);
      if (st.size <= CONST.MAX_FILE_BYTES) {
        snip = quickSnippet(fs.readFileSync(absPath, 'utf-8'), msg.query);
      }
    } catch { /* moved/deleted since indexing — fall back to the path */ }
    results.push({
      path: absPath,
      name: path.basename(absPath),
      line: snip ? snip.line : 0,
      preview: snip ? snip.snippet : absPath,
      // bm25 (negative, lower is better) mapped into stable [0..1), higher = better.
      score: Math.abs(r.s) / (1 + Math.abs(r.s)),
      source: 'fts',
    });
  }
  return { results: results, coverage: coverage, timing: { tier: 'fts', enumerateMs: enumerateMs, queryMs: queryMs, snippetMs: Date.now() - t2 } };
}

// ── Incremental index ───────────────────────────────────────────
async function handleIndex(msg) {
  const t0 = Date.now();
  const resolvedDir = path.resolve(msg.dirPath);

  // Small-tier roots are deliberately NOT indexed: every search live-scans
  // them, so an index would only add staleness risk for zero win.
  const walk = cappedWalk(resolvedDir, CONST.SMALL_TIER_MAX);
  if (!walk.exceeded) {
    return { indexed: 0, updated: 0, removed: 0 };
  }

  const allFiles = await fastGlob(msg.glob || TEXT_FILE_GLOB, {
    cwd: resolvedDir,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: false,
    ignore: [...EXCLUDE_DIRS].map(d => '**/' + d + '/**'),
  });
  // Mirror the walker: no dot segments anywhere, and never sensitive trees.
  const files = allFiles.filter(f => !f.split('/').some(p => p.startsWith('.')) && !relPathIsSensitive(f));

  // Guardrail: refuse unbounded trees rather than wedging the sidecar.
  if (files.length > CONST.MAX_INDEX_FILES) {
    const err = new Error('file search index aborted: ' + files.length + ' files in ' + resolvedDir +
      ' exceeds limit of ' + CONST.MAX_INDEX_FILES + '. Narrow the dirPath.');
    err.name = 'SearchTooManyFilesError';
    err.count = files.length;
    err.limit = CONST.MAX_INDEX_FILES;
    err.dirPath = resolvedDir;
    throw err;
  }

  // Shallow-first so top-level docs land in the index before deep vendored
  // trees when a pass hits the byte budget or the deadline.
  files.sort((a, b) => {
    const da = a.split('/').length;
    const db2 = b.split('/').length;
    if (da !== db2) return da - db2;
    return a < b ? -1 : (a > b ? 1 : 0);
  });

  const db = getDb();
  const selectFile = db.prepare('SELECT id, mtime_ms, size, active FROM files WHERE root = ? AND path = ?');
  const insertFile = db.prepare('INSERT INTO files (root, path, mtime_ms, size, active) VALUES (?, ?, ?, ?, 1)');
  const updateFile = db.prepare('UPDATE files SET mtime_ms = ?, size = ?, active = 1 WHERE id = ?');
  const deactivate = db.prepare('UPDATE files SET active = 0 WHERE id = ?');
  const deleteFts = db.prepare('DELETE FROM files_fts WHERE rowid = ?');
  const insertFts = db.prepare('INSERT INTO files_fts (rowid, name, body) VALUES (?, ?, ?)');

  // Stop cleanly before the caller's INDEX_TIMEOUT would kill us mid-run.
  // WAL + per-batch transactions mean even a hard kill can't corrupt.
  const deadline = t0 + CONST.INDEX_TIMEOUT_MS - 10000;
  let indexed = 0;
  let updated = 0;
  let bytesRead = 0;
  let truncated = false;

  const processBatch = db.transaction((batch) => {
    for (const rel of batch) {
      // Per-run read budget: unread files aren't in the files table yet, so
      // the next pass resumes exactly here — passes converge monotonically.
      if (bytesRead > CONST.INDEX_BYTE_BUDGET || Date.now() > deadline) {
        truncated = true;
        return;
      }
      const abs = path.resolve(resolvedDir, rel);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.size > CONST.MAX_FILE_BYTES) continue;
      if (isCloudPlaceholder(st, path.basename(rel))) continue;
      const mtimeMs = Math.floor(st.mtimeMs);
      const existing = selectFile.get(resolvedDir, rel);
      // Unchanged mtime+size: skip WITHOUT reading the file — this is what
      // makes steady-state passes cheap.
      if (existing && existing.active === 1 && existing.mtime_ms === mtimeMs && existing.size === st.size) continue;
      let body;
      try { body = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
      bytesRead += st.size;
      if (existing) {
        deleteFts.run(existing.id);
        updateFile.run(mtimeMs, st.size, existing.id);
        insertFts.run(existing.id, rel, body);
        updated++;
      } else {
        const id = insertFile.run(resolvedDir, rel, mtimeMs, st.size).lastInsertRowid;
        insertFts.run(id, rel, body);
        indexed++;
      }
    }
  });

  const BATCH = 300;
  for (let i = 0; i < files.length && !truncated; i += BATCH) {
    processBatch(files.slice(i, i + BATCH));
  }

  // Enumerated-set diff: anything active in the DB but absent from this
  // (complete) enumeration was deleted/renamed. Safe even when truncated,
  // because enumeration always runs to completion — only reads are budgeted.
  const enumerated = new Set(files);
  const activeRows = db.prepare('SELECT id, path FROM files WHERE root = ? AND active = 1').all(resolvedDir);
  const toRemove = activeRows.filter(r => !enumerated.has(r.path));
  const removeBatch = db.transaction((rows) => {
    for (const row of rows) {
      deleteFts.run(row.id);
      deactivate.run(row.id);
    }
  });
  if (toRemove.length > 0) removeBatch(toRemove);
  const removed = toRemove.length;

  const indexedCount = db.prepare('SELECT COUNT(*) AS c FROM files WHERE root = ? AND active = 1').get(resolvedDir).c;
  db.prepare(
    'INSERT INTO index_meta (root, last_pass_at, candidate_count, indexed_count, truncated) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(root) DO UPDATE SET last_pass_at = excluded.last_pass_at, candidate_count = excluded.candidate_count, ' +
    'indexed_count = excluded.indexed_count, truncated = excluded.truncated')
    .run(resolvedDir, Date.now(), files.length, indexedCount, truncated ? 1 : 0);

  return { indexed: indexed, updated: updated, removed: removed, candidateCount: files.length, truncated: truncated };
}

// ── Message pump ────────────────────────────────────────────────
process.parentPort.on('message', async (e) => {
  const msg = e.data;
  if (!msg || typeof msg.id !== 'number') return;
  // Ack tells the parent we've dequeued and started work, so it can swap the
  // queue-wait cap for the real per-request processing timeout.
  try { process.parentPort.postMessage({ id: msg.id, ack: true }); } catch { /* parent gone */ }
  try {
    let result;
    if (msg.action === 'search') result = handleSearch(msg);
    else if (msg.action === 'index') result = await handleIndex(msg);
    else throw new Error('Unknown action: ' + msg.action);
    process.parentPort.postMessage({ id: msg.id, result: result });
  } catch (err) {
    const out = { id: msg.id, error: (err && err.message) || String(err) };
    if (err && err.name === 'SearchTooManyFilesError') {
      out.errorName = err.name;
      out.errorCount = err.count;
      out.errorLimit = err.limit;
      out.errorDirPath = err.dirPath;
    }
    process.parentPort.postMessage(out);
  }
});
`;
