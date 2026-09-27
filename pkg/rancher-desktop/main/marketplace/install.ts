/**
 * Marketplace install pipeline — shared by the Marketplace tab (IPC) and the
 * agent's `marketplace/*` tools, so both land artifacts in the same place
 * with the same safety checks.
 *
 *   routine     → ~/sulla/routines/<dir>/
 *   skill       → ~/sulla/skills/<dir>/
 *   function    → ~/sulla/functions/<dir>/
 *   recipe      → ~/sulla/recipes/<dir>/      (Library → Recipes; recipe-start runs compose)
 *   integration → ~/sulla/integrations/<dir>/ (+ bundled functions/skills fanned out)
 *
 * <dir> is the bundle's single top-level directory, which is not always the
 * marketplace slug (e.g. slug "twenty-crm" ships as "twenty/"). Every install
 * writes a `.marketplace.json` marker so "already installed" and "update
 * available" are keyed on the template id, not on directory names.
 *
 * Zip safety: no symlinks, no path traversal, bounded entry count / size,
 * single top-level dir.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import yaml from 'yaml';
import * as yauzl from 'yauzl';

import {
  resolveSullaFunctionsDir,
  resolveSullaRecipesDir,
  resolveSullaRoutinesDir,
  resolveSullaUserIntegrationsDir,
  resolveSullaUserSkillsDir,
} from '@pkg/agent/utils/sullaPaths';
import { fetchPublicTemplate, publicFetch, type MarketplaceKind } from '@pkg/main/marketplace/client';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

export const MARKETPLACE_KINDS: MarketplaceKind[] = ['routine', 'skill', 'function', 'recipe', 'integration'];

// ─── Security caps (mirror sullaRoutineImportEvents.ts) ──────────
const MAX_FILE_BYTES = 100 * 1024 * 1024;   // 100 MB per file
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;   // 500 MB total per bundle
const MAX_ENTRIES = 10_000;              // zip-bomb sanity cap

// The server caps bundle uploads at 25 MB, so anything above that is
// already a sign something's wrong on the way out of R2.
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export function kindTargetDir(kind: MarketplaceKind): string {
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

// ─── Install marker ────────────────────────────────────────────────

export const INSTALL_MARKER = '.marketplace.json';

export interface InstallMarker {
  templateId:  string;
  kind:        MarketplaceKind;
  slug:        string;
  name:        string;
  version:     string;
  installedAt: string;
  /** Bundled artifacts an integration fanned out, so updates can replace them. */
  bundled?:    { functions: string[]; skills: string[] };
}

export interface InstalledArtifact extends InstallMarker {
  path: string;
}

function readMarker(dir: string): InstallMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, INSTALL_MARKER), 'utf8')) as InstallMarker;

    return m && typeof m.templateId === 'string' ? m : null;
  } catch {
    return null;
  }
}

function writeMarker(dir: string, marker: InstallMarker): void {
  fs.writeFileSync(path.join(dir, INSTALL_MARKER), `${ JSON.stringify(marker, null, 2) }\n`, 'utf8');
}

/** Every artifact on disk that was installed from the marketplace. */
export function listInstalled(kinds: MarketplaceKind[] = MARKETPLACE_KINDS): InstalledArtifact[] {
  const out: InstalledArtifact[] = [];

  for (const kind of kinds) {
    let base: string;
    try { base = kindTargetDir(kind) } catch { continue }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(base, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(base, e.name);
      const marker = readMarker(dir);
      if (marker) out.push({ ...marker, path: dir });
    }
  }

  return out;
}

export function findInstalled(templateId: string): InstalledArtifact | null {
  return listInstalled().find(a => a.templateId === templateId) ?? null;
}

/** Most recently installed copy of (kind, slug), if any came from the marketplace. */
export function findInstalledBySlug(kind: MarketplaceKind, slug: string): InstalledArtifact | null {
  const hits = listInstalled([kind]).filter(a => a.slug === slug);
  hits.sort((a, b) => b.installedAt.localeCompare(a.installedAt));

  return hits[0] ?? null;
}

// ─── Download ──────────────────────────────────────────────────────

async function downloadBundleToTmp(id: string): Promise<{ zipPath: string; tmpdir: string }> {
  const res = await publicFetch(`/marketplace/templates/${ encodeURIComponent(id) }/download`);
  if (!res.ok) {
    throw new Error(`download failed: ${ res.status } ${ res.statusText }`);
  }
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('zip')) {
    throw new Error(`expected a zip bundle but got content-type "${ contentType }"`);
  }
  if (!res.body) {
    throw new Error('download response has no body');
  }

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-marketplace-'));
  const zipPath = path.join(tmpdir, 'bundle.zip');
  const writeStream = fs.createWriteStream(zipPath);
  const reader = res.body.getReader();
  let received = 0;
  let failure: unknown = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) {
          throw new Error(`download exceeded max bundle size (${ MAX_DOWNLOAD_BYTES } bytes)`);
        }
        if (!writeStream.write(Buffer.from(value))) {
          await new Promise<void>(resolve => writeStream.once('drain', () => resolve()));
        }
      }
    }
  } catch (err) {
    failure = err;
  } finally {
    await new Promise<void>(resolve => writeStream.end(() => resolve()));
  }
  if (failure) {
    rmrfSync(tmpdir);
    throw failure;
  }

  return { zipPath, tmpdir };
}

/**
 * Download and safely extract a template into a temp dir. Caller owns
 * `tmpdir` and must remove it.
 */
export async function fetchAndExtract(templateId: string): Promise<{ tmpdir: string; rootPath: string; dirName: string }> {
  const { zipPath, tmpdir } = await downloadBundleToTmp(templateId);

  try {
    const stageDir = path.join(tmpdir, 'staged');
    fs.mkdirSync(stageDir, { recursive: true });
    await extractZipSafely(zipPath, stageDir);
    const { rootPath, dirName } = resolveBundleRoot(stageDir);

    return { tmpdir, rootPath, dirName };
  } catch (err) {
    rmrfSync(tmpdir);
    throw err;
  }
}

// ─── Install ───────────────────────────────────────────────────────

export interface InstallResult {
  kind:              MarketplaceKind;
  slug:              string;
  path:              string;
  name:              string;
  version:           string;
  /** True when nothing was written because this template was already installed. */
  alreadyInstalled?: boolean;
  /** Version on disk before this call, when it was already installed. */
  previousVersion?:  string;
  /** True when an existing install was replaced in place. */
  updated?:          boolean;
}

function moveDir(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err;
    safeCopyTree(src, dst);
    rmrfSync(src);
  }
}

/**
 * Install a marketplace template.
 *
 * - Not installed → lands in a free directory under the kind's root.
 * - Already installed and `overwrite` false → no-op, `alreadyInstalled: true`.
 * - Already installed and `overwrite` true → replaced in place; the old copy
 *   (and an integration's bundled functions/skills) is set aside first and
 *   restored if anything fails.
 */
export async function installTemplate(
  templateId: string,
  opts: {
    overwrite?: boolean;
    /**
     * Template id of an older install this replaces. A new version can be a
     * separate listing (re-submissions get a new id), so updates identify the
     * copy on disk by its old id.
     */
    replaces?:  string;
  } = {},
): Promise<InstallResult> {
  if (!templateId || typeof templateId !== 'string') throw new Error('template id is required');

  const detail = await fetchPublicTemplate(templateId);
  const kind = detail?.kind;
  if (!MARKETPLACE_KINDS.includes(kind)) {
    throw new Error(`Unknown marketplace kind "${ kind }"`);
  }

  const existing = findInstalled(templateId) ?? (opts.replaces ? findInstalled(opts.replaces) : null);
  if (existing && !opts.overwrite) {
    return {
      kind,
      slug:             existing.slug,
      path:             existing.path,
      name:             existing.name,
      version:          existing.version,
      alreadyInstalled: true,
      previousVersion:  existing.version,
    };
  }

  const { tmpdir, rootPath, dirName } = await fetchAndExtract(templateId);
  const backups: { from: string; to: string }[] = [];
  let targetPath = '';
  let placedNew = false;
  let bundledMoves: BundledMoves = { functions: [], skills: [] };

  try {
    const targetBase = kindTargetDir(kind);
    fs.mkdirSync(targetBase, { recursive: true });

    if (existing) {
      // Set the current install (and its fanned-out companions) aside so a
      // failed update can be rolled back to exactly what was there.
      targetPath = existing.path;
      const stamp = Date.now();
      const aside = [existing.path, ...(existing.bundled?.functions ?? []), ...(existing.bundled?.skills ?? [])];
      for (const from of aside) {
        if (!fs.existsSync(from)) continue;
        const to = `${ from }.sulla-update-${ stamp }`;
        fs.renameSync(from, to);
        backups.push({ from, to });
      }
    } else {
      targetPath = path.join(targetBase, pickAvailableSlug(targetBase, dirName));
    }

    const finalDirName = path.basename(targetPath);
    moveDir(rootPath, targetPath);
    placedNew = true;

    // integration.yaml's `id` must match its directory name for the loader.
    if (kind === 'integration' && finalDirName !== dirName) {
      rewriteIntegrationId(path.join(targetPath, 'integration.yaml'), finalDirName);
    }
    if (kind === 'integration') {
      bundledMoves = fanOutBundledArtifacts(targetPath, finalDirName);
    }

    writeMarker(targetPath, {
      templateId,
      kind,
      slug:        detail.slug,
      name:        detail.name ?? detail.slug,
      version:     detail.version,
      installedAt: new Date().toISOString(),
      ...(kind === 'integration'
? {
        bundled: {
          functions: bundledMoves.functions.map(m => m.dst),
          skills:    bundledMoves.skills.map(m => m.dst),
        },
      }
: {}),
    });

    for (const b of backups) rmrfSync(b.to);
    console.log(`[Sulla] ${ existing ? 'Updated' : 'Installed' } marketplace ${ kind } ${ detail.slug } v${ detail.version } → ${ targetPath }`);

    return {
      kind,
      slug:            detail.slug,
      path:            targetPath,
      name:            detail.name ?? detail.slug,
      version:         detail.version,
      previousVersion: existing?.version,
      updated:         !!existing,
    };
  } catch (err) {
    rollbackBundledMoves(bundledMoves);
    // Only remove what this call placed — never the original install.
    if (placedNew) rmrfSync(targetPath);
    for (const b of backups) {
      try { fs.renameSync(b.to, b.from) } catch (restoreErr) {
        console.error(`[Sulla] marketplace rollback could not restore ${ b.from } from ${ b.to }:`, restoreErr);
      }
    }
    throw err;
  } finally {
    rmrfSync(tmpdir);
  }
}
