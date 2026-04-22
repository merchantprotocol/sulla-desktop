/**
 * Bundle IPC — cross-kind install + publish.
 *
 * Two IPC endpoints:
 *
 *  - `bundles-install-from-marketplace`  Fetch + land + activate a
 *    bundle from the sulla/v3 marketplace. One-step "download into
 *    library" flow. Does NOT auto-start recipes — the user clicks
 *    Launch from the library surface as a separate action.
 *
 *  - `bundles-publish`  Build a sulla/v3 manifest from an existing
 *    local bundle, two-step submit (manifest then zip) to the workers
 *    API. Returns the `tpl_<id>` on success.
 *
 * Kind detection is driven by the sulla/v3 manifest we get from the
 * marketplace detail endpoint, so we know exactly where to land the
 * files before we even download the zip.
 *
 * Zip extraction + security reuses the same yauzl-based path as the
 * local `routines-import` handler (see sullaRoutineImportEvents.ts).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as yauzl from 'yauzl';
import * as yazl from 'yazl';

import paths from '@pkg/utils/paths';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

import {
  downloadBundleToFile,
  fetchTemplateDetail,
  submitManifest,
  uploadBundle,
  type MarketplaceKind,
  type MarketplaceTemplateDetail,
} from './marketplace/client';
import { buildManifest } from './marketplace/manifestBuilder';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

// ─── Constants shared with sullaRoutineImportEvents ─────────────────
const MAX_FILE_BYTES  = 100 * 1024 * 1024;   // 100 MB per file
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;   // 500 MB per bundle
const MAX_ENTRIES     = 10_000;

// ─── Utils ──────────────────────────────────────────────────────────

function rmrfSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[Sulla] Failed to clean tmp path ${ target }:`, err);
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
  if (unixMode && (unixMode & 0o170000) === 0o120000) {
    return `symlink entries are not allowed: ${ entry.fileName }`;
  }

  return null;
}

/**
 * Stream-extract a zip into `destDir` with the full path-traversal +
 * symlink + size-cap + entry-count safety net. Same logic as the local
 * import path; kept inline here rather than extracted to a shared util
 * to keep this file self-contained and to avoid coupling two IPC
 * handlers through a third shared file that hasn't earned its keep yet.
 */
function extractZipSafely(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));

      let entryCount = 0;
      let totalBytes = 0;

      zip.on('error', reject);
      zip.on('end',   () => resolve());

      zip.on('entry', (entry: yauzl.Entry) => {
        entryCount++;
        if (entryCount > MAX_ENTRIES) {
          zip.close();

          return reject(new Error(`zip has too many entries (>${ MAX_ENTRIES })`));
        }

        const pathErr = rejectUnsafePath(entry.fileName);
        if (pathErr) { zip.close(); return reject(new Error(pathErr)); }

        const nonRegErr = rejectNonRegularEntry(entry);
        if (nonRegErr) { zip.close(); return reject(new Error(nonRegErr)); }

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
        const resolved = path.resolve(outPath);
        if (!resolved.startsWith(path.resolve(destDir) + path.sep)
            && resolved !== path.resolve(destDir)) {
          zip.close();

          return reject(new Error(`entry escapes destination: ${ entry.fileName }`));
        }

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
          readStream .on('error', (e) => { zip.close(); reject(e); });
          readStream.pipe(writeStream);
        });
      });

      zip.readEntry();
    });
  });
}

function resolveBundleRoot(tmpdir: string): { rootPath: string; dirName: string } {
  const entries = fs.readdirSync(tmpdir, { withFileTypes: true });
  const dirs  = entries.filter(e => e.isDirectory());
  const loose = entries.filter(e => !e.isDirectory());
  if (loose.length > 0) {
    throw new Error(`bundle has loose files at the root: ${ loose.map(l => l.name).join(', ') }`);
  }
  if (dirs.length !== 1) {
    throw new Error(`bundle must contain exactly one top-level directory, found ${ dirs.length }`);
  }

  return { rootPath: path.join(tmpdir, dirs[0].name), dirName: dirs[0].name };
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }

  return out;
}

function zipDirectory(sourceDir: string, slug: string, zipPath: string): Promise<void> {
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();

    for (const absFile of listFilesRecursive(sourceDir)) {
      const relPath = path.relative(sourceDir, absFile).split(path.sep).join('/');
      zip.addFile(absFile, `${ slug }/${ relPath }`);
    }
    zip.end();

    const out = fs.createWriteStream(zipPath);
    out.on('error', reject);
    out.on('close', () => resolve());
    zip.outputStream.on('error', reject).pipe(out);
  });
}

async function safeCopyTree(src: string, dst: string): Promise<void> {
  const stats = fs.lstatSync(src);
  if (stats.isSymbolicLink()) {
    throw new Error(`symlink not allowed: ${ src }`);
  }
  if (stats.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      await safeCopyTree(path.join(src, entry.name), path.join(dst, entry.name));
    }

    return;
  }
  if (stats.isFile()) {
    fs.copyFileSync(src, dst);

    return;
  }
  throw new Error(`refusing to copy non-regular file: ${ src }`);
}

// ─── Per-kind landing targets ───────────────────────────────────────

/**
 * Resolve the on-disk directory where a bundle of `kind` should live.
 * Routines/skills/functions use `~/sulla/<kind>s/<slug>/`; recipes use
 * the existing extension root (paths.extensionRoot) keyed by the
 * installation.yaml `id` field.
 */
async function resolveInstallTarget(
  kind:       MarketplaceKind,
  stagedRoot: string,
  fallbackSlug: string,
): Promise<{ targetDir: string; finalSlugOrId: string }> {
  if (kind === 'recipe') {
    const installYamlPath = path.join(stagedRoot, 'installation.yaml');
    if (!fs.existsSync(installYamlPath)) {
      throw new Error('recipe bundle missing installation.yaml at root');
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('yaml');
    const doc = yaml.parse(fs.readFileSync(installYamlPath, 'utf-8')) as { id?: string; version?: string };
    if (!doc?.id) throw new Error('installation.yaml missing required `id` field');

    return {
      targetDir:     path.join(paths.extensionRoot, doc.id),
      finalSlugOrId: doc.id,
    };
  }

  // For routines / skills / functions: land under ~/sulla/<kind>s/<slug>/
  // Pick an available slug (suffix -2, -3… on collision).
  const { resolveSullaHomeDir } = require('@pkg/agent/utils/sullaPaths');
  const homeDir: string = resolveSullaHomeDir();
  const rootDir = path.join(homeDir, `${ kind }s`); // routines / skills / functions

  fs.mkdirSync(rootDir, { recursive: true });

  let candidate = fallbackSlug;
  let counter   = 1;
  while (fs.existsSync(path.join(rootDir, candidate))) {
    counter++;
    candidate = `${ fallbackSlug }-${ counter }`;
    if (counter > 100) throw new Error(`cannot find a free slug near "${ fallbackSlug }"`);
  }

  return {
    targetDir:     path.join(rootDir, candidate),
    finalSlugOrId: candidate,
  };
}

/**
 * For recipes only: after the files are moved into place, run the
 * existing extension install pipeline against the local assets. Does
 * NOT auto-start — marketplace installs land in the library; the user
 * clicks Launch to run `start()` separately.
 */
async function activateRecipeAfterInstall(extensionDir: string): Promise<void> {
  const { createRecipeExtensionFromLocalDir } = await import('@pkg/main/extensions/recipeExtension');
  const ext = await createRecipeExtensionFromLocalDir(extensionDir);

  await ext.installFromLocalAssets(extensionDir, { autoStart: false });

  const mainEvents = (await import('@pkg/main/mainEvents')).default;

  mainEvents.emit('extensions/changed' as any);
}

// ─── Install IPC ────────────────────────────────────────────────────

export function initSullaBundleEvents(): void {
  /**
   * `bundles-install-from-marketplace(templateId)`
   *
   * Fetch manifest → derive kind → download bundle → extract + validate
   * → move into place → if recipe, trigger local-install pipeline.
   * All-or-nothing; tmp dirs cleaned up regardless.
   */
  ipcMainProxy.handle('bundles-install-from-marketplace', async(_event: unknown, templateId: string) => {
    if (!templateId || typeof templateId !== 'string') {
      throw new Error('bundles-install-from-marketplace: templateId is required');
    }

    const tmpdirZip  = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-mp-dl-'));
    const tmpdirStage = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-mp-stage-'));
    const zipFile = path.join(tmpdirZip, 'bundle.zip');

    try {
      // 1. Fetch detail (including the inlined manifest) so we know the kind
      //    before downloading 25 MB of bytes we might not accept.
      const detail: MarketplaceTemplateDetail = await fetchTemplateDetail(templateId);

      if (detail.status !== 'approved') {
        return { error: `template is not approved (status=${ detail.status })` };
      }
      if (detail.bundle_status !== 'uploaded') {
        return { error: `template bundle is not available (bundle_status=${ detail.bundle_status })` };
      }

      // 2. Download zip to tmp.
      await downloadBundleToFile(templateId, zipFile);

      // 3. Extract + validate.
      await extractZipSafely(zipFile, tmpdirStage);
      const { rootPath: stagedRoot, dirName: zipSlug } = resolveBundleRoot(tmpdirStage);

      // 4. Resolve landing target — recipes key off installation.yaml.id
      //    (not the slug), everything else keys off the zip's top-level dir.
      const preferredSlug = detail.slug || zipSlug;
      const { targetDir, finalSlugOrId } = await resolveInstallTarget(detail.kind, stagedRoot, preferredSlug);

      // 5. Move stagedRoot → targetDir. Rename first; fall back to copy on
      //    cross-device tmp (common on containerized runners).
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      if (fs.existsSync(targetDir)) {
        // Should only happen for recipes (slug-suffix logic already avoided
        // this for the other kinds). For recipes, the existing extension
        // manager handles upgrade/reinstall; we refuse a naive overwrite here.
        return {
          error: `install target already exists at ${ targetDir } — uninstall the existing ${ detail.kind } first`,
        };
      }
      try {
        fs.renameSync(stagedRoot, targetDir);
      } catch (err: any) {
        if (err?.code === 'EXDEV') {
          await safeCopyTree(stagedRoot, targetDir);
          rmrfSync(stagedRoot);
        } else {
          throw err;
        }
      }

      // 6. For recipes: run the existing install pipeline against local
      //    assets (no start). For other kinds: the drop-in is complete.
      if (detail.kind === 'recipe') {
        await activateRecipeAfterInstall(targetDir);
      }

      console.log(`[marketplace-install] ok kind=${ detail.kind } tpl=${ templateId } → ${ targetDir }`);

      return {
        kind:         detail.kind,
        slug:         finalSlugOrId,
        templateId:   detail.id,
        name:         detail.name,
        installedAt:  targetDir,
      };
    } catch (err) {
      console.error(`[marketplace-install] failed tpl=${ templateId }`, err);

      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      rmrfSync(tmpdirZip);
      rmrfSync(tmpdirStage);
    }
  });

  /**
   * `bundles-publish(args)`
   *
   * Build a sulla/v3 manifest from a local bundle on disk, then do the
   * two-step submit:
   *   POST /submit-manifest  → tpl_<id>
   *   PUT  /templates/:id/bundle
   *
   * `args.source` tells us how to find the bundle on disk:
   *   - For routines   : { kind: 'routine',  routineId: <DB id> }        (re-exports via routine export flow)
   *   - For templates  : { kind: 'routine',  templateSlug: <slug> }      (zip template folder)
   *   - For skills     : { kind: 'skill',    slug: <slug> }              (zip ~/sulla/skills/<slug>/)
   *   - For functions  : { kind: 'function', slug: <slug> }              (zip ~/sulla/functions/<slug>/)
   *   - For recipes    : { kind: 'recipe',   extensionId: <id> }         (zip paths.extensionRoot/<id>/)
   *
   * Only the routine-templateSlug, skill-slug, function-slug, and recipe-
   * extensionId paths are wired today. DB-routine publish (routineId)
   * requires the in-place routine export flow and is left as follow-up.
   */
  ipcMainProxy.handle('bundles-publish', async(_event: unknown, args: {
    kind:         MarketplaceKind;
    slug?:        string;
    extensionId?: string;
    overrides?:   { name?: string; description?: string; version?: string; tags?: string[] };
  }) => {
    const { kind, overrides } = args ?? ({} as any);
    if (!kind) throw new Error('bundles-publish: kind is required');

    // 1. Resolve source directory on disk.
    let sourceDir: string;
    let slug:      string;
    if (kind === 'recipe') {
      if (!args.extensionId) throw new Error('bundles-publish(recipe): extensionId is required');
      sourceDir = path.join(paths.extensionRoot, args.extensionId);
      slug      = args.extensionId;
    } else {
      if (!args.slug) throw new Error(`bundles-publish(${ kind }): slug is required`);
      const { resolveSullaHomeDir } = require('@pkg/agent/utils/sullaPaths');
      const home: string = resolveSullaHomeDir();
      sourceDir = path.join(home, `${ kind }s`, args.slug);
      slug      = args.slug;
    }

    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      return { error: `bundle source does not exist: ${ sourceDir }` };
    }

    // 2. Build the sulla/v3 manifest from the bundle on disk.
    let manifest: Record<string, unknown>;
    try {
      manifest = buildManifest(kind, { slug, bundleRoot: sourceDir, overrides });
    } catch (err) {
      return { error: `manifest build failed: ${ err instanceof Error ? err.message : String(err) }` };
    }

    // 3. Zip the bundle to tmp.
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-publish-'));
    const zipPath = path.join(tmpdir, `${ slug }.zip`);

    try {
      await zipDirectory(sourceDir, slug, zipPath);

      // 4. Two-step submit.
      const submit = await submitManifest({
        kind,
        name:        String((manifest.metadata as any)?.name ?? slug),
        description: String((manifest.metadata as any)?.description ?? ''),
        version:     String((manifest.metadata as any)?.version ?? '1.0.0'),
        tags:        Array.isArray((manifest.metadata as any)?.tags) ? (manifest.metadata as any).tags : [],
        manifest,
      });

      const upload = await uploadBundle(submit.id, zipPath);

      console.log(`[marketplace-publish] ok kind=${ kind } slug=${ slug } → tpl=${ submit.id }`);

      return {
        templateId:    submit.id,
        slug:          submit.slug,
        bundle_status: upload.bundle_status,
        bundle_size:   upload.bundle_size,
        status:        upload.status,
      };
    } catch (err) {
      console.error(`[marketplace-publish] failed kind=${ kind } slug=${ slug }`, err);

      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      rmrfSync(tmpdir);
    }
  });

  /**
   * `bundles-publish-bulk-from-dir(args)` — iterate a directory of
   * sibling bundle folders and publish each one. Designed for the
   * first-party sulla-recipes import: point at
   * `/Users/.../sulla-recipes/recipes`, get 25 recipes pushed up in
   * one pass. Continues on individual errors; returns per-folder results.
   */
  ipcMainProxy.handle('bundles-publish-bulk-from-dir', async(_event: unknown, args: {
    sourceDir:  string;                             // parent dir holding <slug>/<bundle-files>
    kind:       MarketplaceKind;
    filter?:    string[];                           // optional whitelist of slugs
    dryRun?:    boolean;                            // build manifests + zips, skip network
  }) => {
    if (!args?.sourceDir || !args?.kind) {
      throw new Error('bundles-publish-bulk-from-dir: sourceDir and kind are required');
    }
    if (!fs.existsSync(args.sourceDir) || !fs.statSync(args.sourceDir).isDirectory()) {
      return { error: `sourceDir does not exist: ${ args.sourceDir }` };
    }

    const entries = fs.readdirSync(args.sourceDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .filter(e => !args.filter || args.filter.includes(e.name))
      .map(e => e.name)
      .sort();

    const results: Array<{
      slug:       string;
      status:     'ok' | 'skipped' | 'error';
      templateId?: string;
      message?:   string;
    }> = [];

    for (const slug of entries) {
      const bundleRoot = path.join(args.sourceDir, slug);
      const tmpdir     = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-bulk-'));
      const zipPath    = path.join(tmpdir, `${ slug }.zip`);

      try {
        const manifest = buildManifest(args.kind, { slug, bundleRoot });

        if (args.dryRun) {
          await zipDirectory(bundleRoot, slug, zipPath);
          const zipSize = fs.statSync(zipPath).size;

          results.push({
            slug,
            status:  'ok',
            message: `[dry-run] manifest built + zipped (${ zipSize } bytes)`,
          });
          continue;
        }

        // Real publish: two-step submit.
        await zipDirectory(bundleRoot, slug, zipPath);

        const submit = await submitManifest({
          kind:        args.kind,
          name:        String((manifest.metadata as any)?.name ?? slug),
          description: String((manifest.metadata as any)?.description ?? ''),
          version:     String((manifest.metadata as any)?.version ?? '1.0.0'),
          tags:        Array.isArray((manifest.metadata as any)?.tags) ? (manifest.metadata as any).tags : [],
          manifest,
        });

        await uploadBundle(submit.id, zipPath);

        results.push({ slug, status: 'ok', templateId: submit.id });
        console.log(`[bulk-publish] ok slug=${ slug } → ${ submit.id }`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        results.push({ slug, status: 'error', message: msg });
        console.warn(`[bulk-publish] failed slug=${ slug }: ${ msg }`);
      } finally {
        rmrfSync(tmpdir);
      }
    }

    const okCount    = results.filter(r => r.status === 'ok').length;
    const errorCount = results.filter(r => r.status === 'error').length;

    console.log(`[bulk-publish] summary: ok=${ okCount } error=${ errorCount } total=${ results.length }`);

    return { results, summary: { ok: okCount, error: errorCount, total: results.length } };
  });

  console.log('[Sulla] Bundle IPC handlers (install + publish + bulk-publish) initialized');
}
