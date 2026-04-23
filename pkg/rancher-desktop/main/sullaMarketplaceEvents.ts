/**
 * Marketplace IPC handlers.
 *
 * Three channels, all routed through the Sulla Cloud marketplace API on
 * Cloudflare Workers:
 *
 *   marketplace-browse         → GET    /marketplace/browse
 *   marketplace-detail         → GET    /marketplace/templates/:id
 *   marketplace-install        → GET    /marketplace/templates/:id/download
 *                                + safe-unzip + install into the right local dir
 *   marketplace-my-submissions → GET    /marketplace/mine
 *   marketplace-takedown       → DELETE /marketplace/templates/:id
 *
 * Installation targets (matches what the respective scanners already
 * look for on disk):
 *
 *   routine   → ~/sulla/routines/<slug>/      (picked up by Studio → Library → Routines)
 *   skill     → ~/sulla/skills/<slug>/        (Studio → Library → Skills)
 *   function  → ~/sulla/functions/<slug>/     (Studio → Library → Functions + existing functions-list)
 *   recipe    → ~/sulla/recipes/<slug>/       (Studio → Library → Recipes; Docker extension
 *                                              system handles the image pull + runtime)
 *
 * Auth: `getCurrentAccessToken()` returns the current JWT and silently
 * refreshes when it's close to expiry. An empty string means the user
 * isn't signed in — we surface that as a user-actionable `{ error }`
 * rather than hitting the API with no auth.
 *
 * Zip safety: we download the bundle to a tmp path, extract it with the
 * same hardening posture used by the routine-import handler — no symlinks,
 * no path traversal, bounded entry count / size, single top-level dir.
 * The logic is duplicated here rather than shared so a refactor in one
 * handler can't silently weaken the other.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import yaml from 'yaml';
import * as yauzl from 'yauzl';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

const API_BASE = 'https://sulla-workers.jonathon-44b.workers.dev';

// ─── Security caps (mirror sullaRoutineImportEvents.ts) ──────────
const MAX_FILE_BYTES = 100 * 1024 * 1024;   // 100 MB per file
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;   // 500 MB total per bundle
const MAX_ENTRIES = 10_000;              // zip-bomb sanity cap

// The server caps bundle uploads at 25 MB, so anything above that is
// already a sign something's wrong on the way out of R2.
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

type MarketplaceKind = 'routine' | 'skill' | 'function' | 'recipe' | 'integration';

function kindTargetDir(kind: MarketplaceKind): string {
  // Require via `require` to match the pattern used across main/ — keeps
  // the circular-free imports the agent utils rely on.
  const {
    resolveSullaRoutinesDir,
    resolveSullaFunctionsDir,
    resolveSullaUserSkillsDir,
    resolveSullaRecipesDir,
    resolveSullaUserIntegrationsDir,
  } = require('@pkg/agent/utils/sullaPaths');

  switch (kind) {
  case 'routine': return resolveSullaRoutinesDir();
  case 'function': return resolveSullaFunctionsDir();
  case 'skill': return resolveSullaUserSkillsDir();
  case 'recipe': return resolveSullaRecipesDir();
  case 'integration': return resolveSullaUserIntegrationsDir();
  default:
    throw new Error(`no install target for kind "${ kind }"`);
  }
}

function rejectUnsafePath(name: string): string | null {
  if (!name) return 'empty entry name';
  if (name.includes('\\')) return `backslash in entry path: ${ name }`;
  if (path.isAbsolute(name) || name.startsWith('/')) return `absolute path: ${ name }`;
  if (name.split('/').some(s => s === '..')) return `path traversal: ${ name }`;
  if (name.includes('\0')) return `null byte in path: ${ name }`;

  return null;
}

function rejectNonRegularEntry(entry: yauzl.Entry): string | null {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const S_IFMT = 0o170000;
  const S_IFLNK = 0o120000;
  if (unixMode && (unixMode & S_IFMT) === S_IFLNK) {
    return `symlink entries are not allowed: ${ entry.fileName }`;
  }

  return null;
}

function safeCopyTree(src: string, dst: string): void {
  const stats = fs.lstatSync(src);
  if (stats.isSymbolicLink()) {
    throw new Error(`symlink not allowed: ${ src }`);
  }
  if (stats.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      safeCopyTree(path.join(src, entry.name), path.join(dst, entry.name));
    }

    return;
  }
  if (stats.isFile()) {
    fs.copyFileSync(src, dst);

    return;
  }
  throw new Error(`refusing to copy non-regular file: ${ src }`);
}

function extractZipSafely(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));

      let entryCount = 0;
      let totalBytes = 0;

      zip.on('error', reject);
      zip.on('end', () => resolve());

      zip.on('entry', (entry: yauzl.Entry) => {
        entryCount++;
        if (entryCount > MAX_ENTRIES) {
          zip.close();

          return reject(new Error(`zip has too many entries (>${ MAX_ENTRIES })`));
        }

        const pathErr = rejectUnsafePath(entry.fileName);
        if (pathErr) {
          zip.close();

          return reject(new Error(pathErr));
        }

        const nonRegErr = rejectNonRegularEntry(entry);
        if (nonRegErr) {
          zip.close();

          return reject(new Error(nonRegErr));
        }

        if (entry.uncompressedSize > MAX_FILE_BYTES) {
          zip.close();

          return reject(new Error(`entry exceeds max file size: ${ entry.fileName }`));
        }
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_TOTAL_BYTES) {
          zip.close();

          return reject(new Error('bundle total size exceeds cap'));
        }

        const outPath = path.join(destDir, entry.fileName);
        const resolved = path.resolve(outPath);
        if (!resolved.startsWith(path.resolve(destDir) + path.sep) &&
            resolved !== path.resolve(destDir)) {
          zip.close();

          return reject(new Error(`entry escapes destination: ${ entry.fileName }`));
        }

        if (entry.fileName.endsWith('/')) {
          fs.mkdirSync(outPath, { recursive: true });
          zip.readEntry();

          return;
        }

        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        zip.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            zip.close();

            return reject(streamErr ?? new Error('openReadStream failed'));
          }
          const writeStream = fs.createWriteStream(outPath);
          writeStream.on('error', (e) => { zip.close(); reject(e) });
          writeStream.on('close', () => zip.readEntry());
          readStream.on('error', (e) => { zip.close(); reject(e) });
          readStream.pipe(writeStream);
        });
      });

      zip.readEntry();
    });
  });
}

function resolveBundleRoot(tmpdir: string): { rootPath: string; dirName: string } {
  const entries = fs.readdirSync(tmpdir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory());
  const loose = entries.filter(e => !e.isDirectory());
  if (loose.length > 0) {
    throw new Error(`bundle has loose files at the root: ${ loose.map(l => l.name).join(', ') }. All files must live under a single top-level directory.`);
  }
  if (dirs.length !== 1) {
    throw new Error(`bundle must contain exactly one top-level directory, found ${ dirs.length }`);
  }
  const dirName = dirs[0].name;

  return { rootPath: path.join(tmpdir, dirName), dirName };
}

function pickAvailableSlug(targetDir: string, preferred: string): string {
  let candidate = preferred;
  let counter = 1;
  while (fs.existsSync(path.join(targetDir, candidate))) {
    counter++;
    candidate = `${ preferred }-${ counter }`;
    if (counter > 100) {
      throw new Error(`cannot find a free slug near "${ preferred }" after 100 attempts`);
    }
  }

  return candidate;
}

function rmrfSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[Sulla] Failed to clean tmp path ${ target }:`, err);
  }
}

// ─── Integration bundled artifact fan-out ──────────────────────────
//
// An integration package may ship companion functions and skills:
//
//   <integration-slug>/
//     integration.yaml
//     functions/<name>/function.yaml
//     skills/<name>/SKILL.md
//
// After the integration lands at its target dir, bundled subdirectories
// are MOVED (not copied) into their respective runtime locations with a
// `<integration-slug>-` prefix so loaders find them and uninstall can
// clean them up via the integration's manifest.

interface BundledMoves {
  functions: { src: string; dst: string }[];
  skills:    { src: string; dst: string }[];
}

function fanOutBundledArtifacts(integrationPath: string, integrationSlug: string): BundledMoves {
  const manifestPath = path.join(integrationPath, 'integration.yaml');
  const text = fs.readFileSync(manifestPath, 'utf8');
  const manifest = yaml.parse(text) as { bundled?: { functions?: string[]; skills?: string[] } } | null;
  const bundled = manifest?.bundled;

  if (!bundled) return { functions: [], skills: [] };

  const {
    resolveSullaFunctionsDir,
    resolveSullaUserSkillsDir,
  } = require('@pkg/agent/utils/sullaPaths');

  const moves: BundledMoves = { functions: [], skills: [] };
  const planned = {
    functions: (bundled.functions ?? []).map(name => ({
      src: path.join(integrationPath, 'functions', name),
      dst: path.join(resolveSullaFunctionsDir(), `${ integrationSlug }-${ name }`),
    })),
    skills: (bundled.skills ?? []).map(name => ({
      src: path.join(integrationPath, 'skills', name),
      dst: path.join(resolveSullaUserSkillsDir(), `${ integrationSlug }-${ name }`),
    })),
  };

  // Pre-flight all destinations before touching disk. If ANY collides, fail
  // the whole install — the integration slug itself was already collision-
  // resolved, so a collision here means a prior unrelated artifact. Clean
  // rollback keeps the rest of the user's library intact.
  for (const kind of ['functions', 'skills'] as const) {
    for (const { src, dst } of planned[kind]) {
      if (!fs.existsSync(src)) {
        throw new Error(`bundled ${ kind.slice(0, -1) } declared in manifest but missing on disk: ${ path.basename(src) }`);
      }
      if (fs.existsSync(dst)) {
        throw new Error(`bundled ${ kind.slice(0, -1) } collides with existing artifact: ${ dst }`);
      }
    }
  }

  // All pre-flights passed — perform moves. fs.renameSync is a rename
  // within the same filesystem; fall back to copy+rm for cross-FS cases
  // (same EXDEV handling used for the integration dir itself).
  const tryMove = (src: string, dst: string) => {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fs.renameSync(src, dst);
    } catch (err: any) {
      if (err?.code === 'EXDEV') {
        safeCopyTree(src, dst);
        rmrfSync(src);
      } else {
        throw err;
      }
    }
  };

  for (const entry of planned.functions) {
    tryMove(entry.src, entry.dst);
    moves.functions.push(entry);
  }
  for (const entry of planned.skills) {
    tryMove(entry.src, entry.dst);
    moves.skills.push(entry);
  }

  // Remove the now-empty bundled/ subdirs from the integration package so
  // the on-disk shape matches "source of truth = manifest.bundled[]".
  rmrfSync(path.join(integrationPath, 'functions'));
  rmrfSync(path.join(integrationPath, 'skills'));

  return moves;
}

/** Rollback bundled moves on failure — best-effort, log but don't throw. */
function rollbackBundledMoves(moves: BundledMoves): void {
  for (const { dst } of [...moves.functions, ...moves.skills]) {
    rmrfSync(dst);
  }
}

/**
 * Rewrite the `id` field of an integration.yaml file to match a new slug.
 * Parses, mutates, and re-serialises so comments and formatting are preserved
 * where possible (yaml lib keeps anchors/style for round-trip).
 */
function rewriteIntegrationId(manifestPath: string, newId: string): void {
  const text = fs.readFileSync(manifestPath, 'utf8');
  const doc = yaml.parseDocument(text);

  doc.set('id', newId);
  fs.writeFileSync(manifestPath, doc.toString(), 'utf8');
}

// ─── HTTP helpers ───────────────────────────────────────────────

async function authHeaders(): Promise<{ Authorization: string } | null> {
  const token = await getCurrentAccessToken();
  if (!token) return null;

  return { Authorization: `Bearer ${ token }` };
}

async function readJsonOrError(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`marketplace returned non-JSON response (${ res.status }): ${ text.slice(0, 200) }`);
  }
}

// ─── Install pipeline ──────────────────────────────────────────

async function downloadBundleToTmp(id: string, headers: Record<string, string>): Promise<{
  zipPath: string;
  tmpdir:  string;
}> {
  const res = await fetch(`${ API_BASE }/marketplace/templates/${ encodeURIComponent(id) }/download`, {
    headers,
  });
  if (!res.ok) {
    throw new Error(`download failed: ${ res.status } ${ res.statusText }`);
  }
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('zip')) {
    throw new Error(`expected a zip bundle but got content-type "${ contentType }". The marketplace may not have migrated to the v3 manifest+bundle model yet.`);
  }

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-marketplace-'));
  const zipPath = path.join(tmpdir, 'bundle.zip');

  // Stream the body into the file so we can abort if it exceeds the cap
  // before buffering everything into memory.
  if (!res.body) {
    throw new Error('download response has no body');
  }

  const writeStream = fs.createWriteStream(zipPath);
  const reader = res.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) {
          throw new Error(`download exceeded max bundle size (${ MAX_DOWNLOAD_BYTES } bytes)`);
        }
        writeStream.write(Buffer.from(value));
      }
    }
  } finally {
    await new Promise<void>((resolve) => writeStream.end(() => resolve()));
  }

  return { zipPath, tmpdir };
}

export function initSullaMarketplaceEvents(): void {
  // ── Browse approved templates ──
  ipcMainProxy.handle('marketplace-browse', async(_event, opts = {}) => {
    try {
      const headers = await authHeaders();
      if (!headers) return { error: 'Sign in to Sulla Cloud to browse the marketplace.' };

      const params = new URLSearchParams();
      if (opts.kind) params.set('kind', opts.kind);
      if (opts.q) params.set('q', opts.q);
      if (opts.sort) params.set('sort', opts.sort);
      if (opts.page) params.set('page', String(opts.page));
      if (opts.limit) params.set('limit', String(opts.limit));

      const url = `${ API_BASE }/marketplace/browse${ params.toString() ? `?${ params }` : '' }`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const body = await readJsonOrError(res).catch(() => null) as { error?: string } | null;

        return { error: body?.error ?? `Marketplace browse failed: ${ res.status } ${ res.statusText }` };
      }

      const data = await readJsonOrError(res) as {
        templates: unknown;
        total:     number;
        page:      number;
        limit:     number;
      };

      return data as any;
    } catch (err) {
      console.error('[Sulla] marketplace-browse failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Template detail + full manifest ──
  ipcMainProxy.handle('marketplace-detail', async(_event, id: string) => {
    try {
      if (!id || typeof id !== 'string') {
        return { error: 'marketplace-detail requires a template id' };
      }
      const headers = await authHeaders();
      if (!headers) return { error: 'Sign in to Sulla Cloud to view template details.' };

      const res = await fetch(`${ API_BASE }/marketplace/templates/${ encodeURIComponent(id) }`, { headers });
      if (!res.ok) {
        const body = await readJsonOrError(res).catch(() => null) as { error?: string } | null;

        return { error: body?.error ?? `Marketplace detail failed: ${ res.status } ${ res.statusText }` };
      }

      const data = await readJsonOrError(res);

      return data as any;
    } catch (err) {
      console.error('[Sulla] marketplace-detail failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Install into the right local directory ──
  ipcMainProxy.handle('marketplace-install', async(_event, id: string) => {
    if (!id || typeof id !== 'string') {
      return { error: 'marketplace-install requires a template id' };
    }
    const headers = await authHeaders();
    if (!headers) return { error: 'Sign in to Sulla Cloud to install marketplace templates.' };

    // Fetch detail first — we need the kind to pick the install directory,
    // and the slug as our preferred on-disk name. Cheap round-trip, saves
    // us from having to re-derive anything from zip custom metadata.
    let detail: { template: { id: string; kind: MarketplaceKind; slug: string; name: string; version: string } };
    try {
      const res = await fetch(`${ API_BASE }/marketplace/templates/${ encodeURIComponent(id) }`, { headers });
      if (!res.ok) {
        const body = await readJsonOrError(res).catch(() => null) as { error?: string } | null;

        return { error: body?.error ?? `Marketplace detail failed: ${ res.status } ${ res.statusText }` };
      }
      detail = await readJsonOrError(res) as typeof detail;
    } catch (err) {
      console.error('[Sulla] marketplace-install detail fetch failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }

    const kind = detail.template?.kind;
    if (kind !== 'routine' && kind !== 'skill' && kind !== 'function' && kind !== 'recipe' && kind !== 'integration') {
      return { error: `Unknown marketplace kind "${ kind }"` };
    }

    let downloadCtx: { zipPath: string; tmpdir: string };
    try {
      downloadCtx = await downloadBundleToTmp(id, headers);
    } catch (err) {
      console.error('[Sulla] marketplace-install download failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }

    const { zipPath, tmpdir } = downloadCtx;
    const stageDir = path.join(tmpdir, 'staged');

    try {
      fs.mkdirSync(stageDir, { recursive: true });
      await extractZipSafely(zipPath, stageDir);
      const { rootPath, dirName } = resolveBundleRoot(stageDir);

      const targetBase = kindTargetDir(kind);
      fs.mkdirSync(targetBase, { recursive: true });

      const slug = pickAvailableSlug(targetBase, dirName);
      const targetPath = path.join(targetBase, slug);

      try {
        fs.renameSync(rootPath, targetPath);
      } catch (renameErr: any) {
        if (renameErr?.code === 'EXDEV') {
          safeCopyTree(rootPath, targetPath);
          rmrfSync(rootPath);
        } else {
          throw renameErr;
        }
      }

      // Collision rename cascade: if pickAvailableSlug picked a different
      // slug than the bundle's preferred name, the integration.yaml's `id`
      // field is now stale. Rewrite it so loader validation (which checks
      // that manifest.id matches the directory name) accepts it.
      if (kind === 'integration' && slug !== dirName) {
        rewriteIntegrationId(path.join(targetPath, 'integration.yaml'), slug);
      }

      // For integrations, fan out bundled functions/skills to their runtime
      // locations. On failure, roll back BOTH the fan-out moves and the
      // integration dir so the install is atomic from the user's POV.
      let bundledMoves: BundledMoves = { functions: [], skills: [] };

      if (kind === 'integration') {
        try {
          bundledMoves = fanOutBundledArtifacts(targetPath, slug);
        } catch (fanOutErr) {
          rollbackBundledMoves(bundledMoves);
          rmrfSync(targetPath);
          throw fanOutErr;
        }
      }

      console.log(`[Sulla] Installed marketplace ${ kind } → ${ targetPath }`);
      if (kind === 'integration' && (bundledMoves.functions.length || bundledMoves.skills.length)) {
        console.log(`[Sulla]   + bundled ${ bundledMoves.functions.length } function(s), ${ bundledMoves.skills.length } skill(s)`);
      }

      return {
        kind,
        slug,
        path: targetPath,
        name: detail.template.name ?? slug,
      };
    } catch (err) {
      console.error('[Sulla] marketplace-install failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      rmrfSync(tmpdir);
    }
  });

  // ── List the signed-in user's own submissions ──
  // Returns every submission the caller authored, regardless of status —
  // pending, approved, and rejected — so the "My Submissions" view can
  // render the full history without a second round-trip per row.
  ipcMainProxy.handle('marketplace-my-submissions', async(_event, opts: { page?: number; limit?: number } = {}) => {
    try {
      const { listMySubmissions } = await import('@pkg/main/marketplace/client');
      const page = typeof opts.page === 'number' && opts.page > 0 ? opts.page : 1;
      const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 50;
      const data = await listMySubmissions(page, limit);

      return data as any;
    } catch (err) {
      console.error('[Sulla] marketplace-my-submissions failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── User-initiated takedown of their own submission ──
  // Author-scoped (server enforces caller == author). Renderer already
  // confirms with the user; main-process just calls through. Response's
  // `action` field tells the UI whether the row was hard-deleted (pending
  // or already-rejected submissions) or soft-withdrawn (approved → flips
  // status to 'rejected', keeps the row so the author can see what they
  // withdrew in /mine).
  ipcMainProxy.handle('marketplace-takedown', async(_event, id: string) => {
    try {
      if (!id || typeof id !== 'string') {
        return { error: 'marketplace-takedown requires a template id' };
      }
      const { takedownTemplate } = await import('@pkg/main/marketplace/client');
      const result = await takedownTemplate(id);

      return result as any;
    } catch (err) {
      console.error('[Sulla] marketplace-takedown failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  console.log('[Sulla] Marketplace IPC handlers initialized');
}
