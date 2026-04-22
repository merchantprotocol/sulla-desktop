/**
 * Routine-import IPC event handler.
 *
 * Accepts either a `.routine.zip` bundle or a folder the user picks from
 * disk, and lands it at `~/sulla/routines/<slug>/` so it shows up in the
 * My Templates tab. The DB is NOT touched — instantiation into a
 * runnable routine is a separate user action from the template card.
 *
 * Zip handling uses `yauzl` directly (pure-JS, already a transitive dep
 * of `extract-zip`) so we can validate every entry before writing a
 * single byte to disk. The alternative — extract-then-validate — leaks
 * partial trees on malformed input and is harder to reason about for
 * path-traversal defense.
 *
 * Layout expectation (what the importer requires inside the bundle):
 *
 *   <slug>/
 *     routine.yaml          REQUIRED
 *     AGENT.md              optional
 *     README.md             optional
 *     skills/ prompts/ ...  optional
 *     .routine-meta.yaml    optional (metadata only; not validated)
 *
 * Everything in the bundle must live under a single top-level directory
 * (the slug). Loose files at zip root are rejected.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { dialog } from 'electron';
import yaml from 'yaml';
import * as yauzl from 'yauzl';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

// ─── Security caps ───────────────────────────────────────────────
// These bound the worst-case behaviour of a malicious zip. A well-formed
// routine bundle is <1 MB; these are very generous.
const MAX_FILE_BYTES  = 100 * 1024 * 1024;   // 100 MB per file
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;   // 500 MB total per bundle
const MAX_ENTRIES     = 10_000;              // zip-bomb sanity cap

function getRoutinesDir(): string {
  const { resolveSullaRoutinesDir } = require('@pkg/agent/utils/sullaPaths');

  return resolveSullaRoutinesDir();
}

/** Kebab-case slugifier used for collision-suffix derivation. */
function slugify(input: string): string {
  const slug = String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'routine';
}

/**
 * Validates a zip entry's file name for path-traversal / escape.
 * Returns null if ok, or an error message if it should be rejected.
 */
function rejectUnsafePath(name: string): string | null {
  if (!name) return 'empty entry name';
  // Zip spec uses forward slashes. Anything else is suspicious.
  if (name.includes('\\')) return `backslash in entry path: ${ name }`;
  if (path.isAbsolute(name) || name.startsWith('/')) return `absolute path: ${ name }`;
  // Any `..` segment (anywhere) blocks directory traversal after join.
  const segments = name.split('/');
  if (segments.some(s => s === '..')) return `path traversal: ${ name }`;
  // Disallow null bytes — some tools strip them, some don't; always suspect.
  if (name.includes('\0')) return `null byte in path: ${ name }`;

  return null;
}

/**
 * Inspect a yauzl ZipEntry header and reject anything non-file/non-directory.
 * Symlinks set the high byte of externalFileAttributes on Unix-created zips;
 * we refuse to extract them because resolving them could escape the bundle.
 */
function rejectNonRegularEntry(entry: yauzl.Entry): string | null {
  // Top 16 bits of externalFileAttributes hold Unix stat mode on zips
  // created by modern tools (info-zip, libarchive, yazl). Symlink bit
  // = S_IFLNK = 0o120000 in the high word.
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const S_IFMT   = 0o170000;
  const S_IFLNK  = 0o120000;
  if (unixMode && (unixMode & S_IFMT) === S_IFLNK) {
    return `symlink entries are not allowed: ${ entry.fileName }`;
  }

  return null;
}

/** Recursively copy `src` to `dst`, rejecting symlinks we encounter. */
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

/**
 * Extract a zip file at `zipPath` into `destDir`. Rejects any entry that
 * fails the safety checks above. Throws on the first problem and leaves
 * the caller to clean up `destDir`.
 */
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

          return reject(new Error(`bundle total size exceeds cap`));
        }

        const outPath = path.join(destDir, entry.fileName);
        // Defence in depth: even after path validation, ensure the
        // resolved outPath lives under destDir. Catches anything
        // rejectUnsafePath might have missed.
        const resolved = path.resolve(outPath);
        if (!resolved.startsWith(path.resolve(destDir) + path.sep)
            && resolved !== path.resolve(destDir)) {
          zip.close();

          return reject(new Error(`entry escapes destination: ${ entry.fileName }`));
        }

        // Trailing slash = directory entry.
        if (/\/$/.test(entry.fileName)) {
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
          writeStream.on('error', (e) => { zip.close(); reject(e); });
          writeStream.on('close', () => zip.readEntry());
          readStream.on('error', (e) => { zip.close(); reject(e); });
          readStream.pipe(writeStream);
        });
      });

      zip.readEntry();
    });
  });
}

/**
 * After extracting, the bundle should have exactly one top-level
 * directory. Validates and returns its absolute path + the directory
 * name (which we'll treat as the slug candidate).
 */
function resolveBundleRoot(tmpdir: string): { rootPath: string; dirName: string } {
  const entries = fs.readdirSync(tmpdir, { withFileTypes: true });
  const dirs  = entries.filter(e => e.isDirectory());
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

/**
 * Read and parse the bundle's routine.yaml. Returns the parsed document
 * or throws on a problem the user can act on.
 */
function readAndValidateRoutineYaml(bundleRoot: string): Record<string, unknown> {
  const routinePath = path.join(bundleRoot, 'routine.yaml');
  if (!fs.existsSync(routinePath)) {
    throw new Error('bundle is missing routine.yaml at its root');
  }
  let doc: Record<string, unknown>;
  try {
    doc = yaml.parse(fs.readFileSync(routinePath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`routine.yaml is not valid YAML: ${ err instanceof Error ? err.message : String(err) }`);
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error('routine.yaml did not parse to an object');
  }
  // Minimum shape sanity — routine.schema.json is the full contract,
  // but these are the fields anything downstream crashes without.
  if (!doc.name || typeof doc.name !== 'string') {
    throw new Error('routine.yaml must have a `name` string field');
  }
  if (!Array.isArray(doc.nodes)) {
    throw new Error('routine.yaml must have a `nodes` array');
  }
  if (!Array.isArray(doc.edges)) {
    throw new Error('routine.yaml must have an `edges` array');
  }

  return doc;
}

/**
 * Pick the final installation slug. Starts from `preferred` (the zip's
 * top-level dir name, or a slugified routine name for folder imports)
 * and appends -2, -3, ... until an unused slot under ~/sulla/routines/
 * is found.
 */
function pickAvailableSlug(routinesDir: string, preferred: string): string {
  let candidate = preferred;
  let counter   = 1;
  while (fs.existsSync(path.join(routinesDir, candidate))) {
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

/**
 * Core import: take a staged bundle root (already validated) and move
 * it into place under `~/sulla/routines/<slug>/`. Returns the assigned
 * slug + the routine document.
 */
function installBundle(stagedRoot: string, preferredSlug: string): {
  slug:    string;
  routine: Record<string, unknown>;
} {
  const routinesDir = getRoutinesDir();
  fs.mkdirSync(routinesDir, { recursive: true });

  const routine = readAndValidateRoutineYaml(stagedRoot);
  const slug = pickAvailableSlug(routinesDir, preferredSlug);
  const targetPath = path.join(routinesDir, slug);

  // Move should be atomic on the same filesystem; fall back to copy on
  // EXDEV (cross-device, e.g. tmpdir on a different mount).
  try {
    fs.renameSync(stagedRoot, targetPath);
  } catch (err: any) {
    if (err?.code === 'EXDEV') {
      safeCopyTree(stagedRoot, targetPath);
      rmrfSync(stagedRoot);
    } else {
      throw err;
    }
  }

  return { slug, routine };
}

export function initSullaRoutineImportEvents(): void {
  // ── Import a routine bundle ──
  // Prompts for a .routine.zip file OR a folder, validates, installs
  // under ~/sulla/routines/<slug>/. Collision-safe. Never touches the
  // DB — appears as a template the user can instantiate.
  ipcMainProxy.handle('routines-import', async() => {
    // Electron's `openFile,openDirectory` combo lets the user pick
    // either on macOS. On win/linux the platforms split them in
    // separate dialogs; we default to the file picker and document the
    // alternate path in a log for now.
    const openResult = await dialog.showOpenDialog({
      title:      'Import Routine',
      properties: ['openFile', 'openDirectory', 'treatPackageAsDirectory'],
      filters:    [
        { name: 'Sulla Routine Bundle', extensions: ['zip'] },
        { name: 'All Files',            extensions: ['*'] },
      ],
    });

    if (openResult.canceled || openResult.filePaths.length === 0) {
      return { canceled: true as const };
    }

    const picked = openResult.filePaths[0];
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-import-'));

    try {
      let pickedStats: fs.Stats;
      try {
        pickedStats = fs.statSync(picked);
      } catch (err) {
        return { error: `cannot read picked path: ${ err instanceof Error ? err.message : String(err) }` };
      }

      let stagedRoot: string;
      let preferredSlug: string;

      if (pickedStats.isDirectory()) {
        // Folder import: copy the picked directory verbatim, use its
        // base name as the slug candidate. Folder contents are treated
        // as already-unpacked — so the picked dir IS the bundle root,
        // not a container of a bundle root.
        const folderName = path.basename(picked).trim();
        preferredSlug = slugify(folderName);
        stagedRoot = path.join(tmpdir, preferredSlug);
        safeCopyTree(picked, stagedRoot);
      } else if (pickedStats.isFile()) {
        // Zip import: extract into tmpdir, then resolve the single
        // top-level directory inside as the bundle root.
        if (!/\.zip$/i.test(picked)) {
          return { error: 'only .zip bundles are supported; for a folder, pick the folder directly.' };
        }
        await extractZipSafely(picked, tmpdir);
        const resolved = resolveBundleRoot(tmpdir);
        stagedRoot    = resolved.rootPath;
        preferredSlug = slugify(resolved.dirName);
      } else {
        return { error: 'picked path is neither a file nor a directory' };
      }

      // At this point stagedRoot holds the extracted bundle contents.
      // Validate + install. installBundle moves stagedRoot into place,
      // so we don't need to clean it up separately on success.
      const { slug, routine } = installBundle(stagedRoot, preferredSlug);

      console.log(`[Sulla] Imported routine bundle → ~/sulla/routines/${ slug }/ (name="${ routine.name }")`);

      return {
        slug,
        id:   String(routine.id ?? slug),
        name: String(routine.name ?? slug),
      };
    } catch (err) {
      console.error('[Sulla] Routine import failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      // If installBundle succeeded, stagedRoot was renamed out of tmpdir
      // so tmpdir is now empty and safe to rm. If something failed,
      // tmpdir still holds partial extraction — nuke it.
      rmrfSync(tmpdir);
    }
  });

  console.log('[Sulla] Routine import IPC handler initialized');
}
