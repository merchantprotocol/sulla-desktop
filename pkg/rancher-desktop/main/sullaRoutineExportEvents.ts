/**
 * Routine-export IPC event handlers.
 *
 * Exports a routine or a template as a `.routine.zip` bundle. Two paths:
 *
 *   - `routines-export`           DB routine → bundle.
 *                                 Loads the source template folder (if any)
 *                                 into a tmpdir, overwrites `routine.yaml`
 *                                 with the current DB definition (runtime
 *                                 state stripped), updates `.routine-meta.yaml`,
 *                                 zips the tmpdir, writes to a user-picked
 *                                 destination. Never writes back to
 *                                 `~/sulla/routines/`.
 *
 *   - `routines-export-template`  Template folder → zip, as-is.
 *                                 DB is not involved; this is just a
 *                                 convenience wrapper that zips
 *                                 `~/sulla/routines/<slug>/` to a user-picked
 *                                 destination.
 *
 * Bundle format is documented in docs/routines/schema/folder-layout.md.
 *
 * Zip creation uses `yazl` (pure-JS, ~5KB). Symmetric with `yauzl` which
 * `extract-zip` already bundles for the import path.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { dialog } from 'electron';
import yaml from 'yaml';
import * as yazl from 'yazl';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

const BUNDLE_SCHEMA_VERSION = 1;

async function importWorkflowModel() {
  const mod = await import('@pkg/agent/database/models/WorkflowModel');

  return mod.WorkflowModel;
}

function getRoutinesDir(): string {
  const { resolveSullaRoutinesDir } = require('@pkg/agent/utils/sullaPaths');

  return resolveSullaRoutinesDir();
}

/** Minimal kebab-case slugifier for default filenames. */
function slugify(input: string): string {
  const slug = String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'routine';
}

/**
 * Strip runtime-only fields from the definition before export. The DB
 * carries transient execution state on nodes (live status, last-run
 * output, etc.) that must not travel with the bundle — otherwise an
 * imported routine would show stale "running" badges until the user
 * reset them. See folder-layout.md §5.
 */
function stripRuntime(definition: Record<string, unknown>): Record<string, unknown> {
  const cleaned = JSON.parse(JSON.stringify(definition)) as Record<string, any>;
  if (Array.isArray(cleaned.nodes)) {
    for (const node of cleaned.nodes) {
      if (node && typeof node === 'object' && node.data && typeof node.data === 'object') {
        delete node.data.execution;
        delete node.data.lastRunId;
        delete node.data.lastRunOutput;
      }
    }
  }

  return cleaned;
}

/** Recursively list files under a directory as absolute paths. */
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

function sha256(filePath: string): string {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));

  return `sha256:${ h.digest('hex') }`;
}

/**
 * Build the checksums map for `.routine-meta.yaml`. The meta file
 * itself is excluded (its checksum would be self-referential and would
 * change whenever any other file changed).
 */
function buildChecksums(bundleRoot: string): Record<string, string> {
  const files = listFilesRecursive(bundleRoot)
    .filter(f => path.basename(f) !== '.routine-meta.yaml');

  const checksums: Record<string, string> = {};
  for (const file of files) {
    const rel = path.relative(bundleRoot, file).split(path.sep).join('/');
    checksums[rel] = sha256(file);
  }

  return checksums;
}

/**
 * Produce a .zip of `sourceDir`'s contents at `zipPath`. Every entry in
 * the zip is prefixed with `<slug>/` so users who drag the archive into
 * Finder see a single root folder, not loose files.
 *
 * Pure-JS via yazl — no subprocess, no binary deps.
 */
function zipDirectory(sourceDir: string, slug: string, zipPath: string): Promise<void> {
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const files = listFilesRecursive(sourceDir);

    for (const absFile of files) {
      const relPath = path.relative(sourceDir, absFile).split(path.sep).join('/');
      // Prefix with slug so the archive expands to a single root dir.
      zip.addFile(absFile, `${ slug }/${ relPath }`);
    }

    zip.end();

    const out = fs.createWriteStream(zipPath);
    out.on('error', reject);
    out.on('close', () => resolve());
    zip.outputStream.on('error', reject).pipe(out);
  });
}

function rmrfSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[Sulla] Failed to clean tmp path ${ target }:`, err);
  }
}

function writeRoutineMeta(
  bundleRoot: string,
  payload: {
    sourceTemplateSlug: string | null;
    sourceRoutineId:    string | null;
  },
): void {
  const meta: Record<string, unknown> = {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    exportedAt:          new Date().toISOString(),
    exportedBy:          {
      host:         os.hostname(),
      sullaVersion: process.env.npm_package_version ?? null,
    },
    sourceTemplateSlug: payload.sourceTemplateSlug,
    sourceRoutineId:    payload.sourceRoutineId,
    checksums:          buildChecksums(bundleRoot),
  };

  fs.writeFileSync(
    path.join(bundleRoot, '.routine-meta.yaml'),
    yaml.stringify(meta, { lineWidth: 0 }),
    'utf-8',
  );
}

/** Seed a fresh bundle dir for routines with no source template. */
function seedMinimalBundle(bundleRoot: string, routineName: string): void {
  const readme = `# ${ routineName }\n\nExported from Sulla Desktop on ${ new Date().toISOString() }.\n\nAdd supporting docs (AGENT.md, skills/, prompts/, references/, assets/)\nbefore re-zipping to share a richer template. See the Sulla docs on\nroutine folder layout for the full set of optional files.\n`;

  fs.writeFileSync(path.join(bundleRoot, 'README.md'), readme, 'utf-8');
}

export function initSullaRoutineExportEvents(): void {
  // ── Export a DB routine ──
  // Pulls the routine from Postgres, merges with the source template's
  // sibling files (if any), writes routine.yaml + .routine-meta.yaml,
  // zips, and saves to the user's chosen destination.
  ipcMainProxy.handle('routines-export', async(_event: unknown, workflowId: string) => {
    if (!workflowId || typeof workflowId !== 'string') {
      throw new Error('routines-export: workflowId is required');
    }

    const WorkflowModel = await importWorkflowModel();
    const row = await WorkflowModel.findById(workflowId);
    if (!row) {
      throw new Error(`Routine not found: ${ workflowId }`);
    }

    const attrs = row.attributes as Record<string, unknown>;
    const id = String(attrs.id ?? workflowId);
    const name = String(attrs.name ?? 'routine');
    const sourceTemplateSlug = (attrs.source_template_slug ?? null) as string | null;
    const definition = (attrs.definition ?? {}) as Record<string, unknown>;

    const exportSlug = slugify(name);
    const defaultFilename = `${ exportSlug }.routine.zip`;

    const saveResult = await dialog.showSaveDialog({
      title:       'Export Routine',
      defaultPath: defaultFilename,
      filters:     [{ name: 'Sulla Routine Bundle', extensions: ['zip'] }],
      properties:  ['createDirectory', 'showOverwriteConfirmation'],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { canceled: true as const };
    }

    const targetZipPath = saveResult.filePath;

    // Everything below this point is best-effort with mandatory tmpdir
    // cleanup — we don't want a failed export to leak bytes into the
    // system temp dir.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-export-'));
    try {
      // 1. Seed the bundle from the source template folder (if any exists)
      //    or a minimal stub.
      let seededFromTemplate = false;
      if (sourceTemplateSlug) {
        const sourceDir = path.join(getRoutinesDir(), sourceTemplateSlug);
        if (fs.existsSync(sourceDir) && fs.statSync(sourceDir).isDirectory()) {
          fs.cpSync(sourceDir, tmpRoot, { recursive: true });
          seededFromTemplate = true;
        }
      }
      if (!seededFromTemplate) {
        seedMinimalBundle(tmpRoot, name);
      }

      // 2. Overwrite routine.yaml with the current DB definition
      //    (runtime state stripped). This is the whole point of the
      //    merge — sibling files come from the template, the DAG comes
      //    from the DB. A stale `.routine-meta.yaml` copied from the
      //    source folder is about to be regenerated in step 4, so we
      //    don't strip it here.
      const cleanedDefinition = stripRuntime(definition);
      fs.writeFileSync(
        path.join(tmpRoot, 'routine.yaml'),
        yaml.stringify(cleanedDefinition, { lineWidth: 0 }),
        'utf-8',
      );

      // 3. Regenerate .routine-meta.yaml with fresh checksums.
      writeRoutineMeta(tmpRoot, {
        sourceTemplateSlug,
        sourceRoutineId: id,
      });

      // 4. Zip to the user's chosen location.
      await zipDirectory(tmpRoot, exportSlug, targetZipPath);

      console.log(`[Sulla] Exported routine "${ id }" → ${ targetZipPath } (${ seededFromTemplate ? `merged from template ${ sourceTemplateSlug }` : 'minimal seed' })`);

      return { path: targetZipPath };
    } catch (err) {
      console.error(`[Sulla] Export failed for routine "${ id }":`, err);

      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      rmrfSync(tmpRoot);
    }
  });

  // ── Export a template (zip the folder as-is) ──
  // No DB involvement. The template on disk is already the artifact —
  // this just wraps Finder-revealing + zipping in a single menu item.
  ipcMainProxy.handle('routines-export-template', async(_event: unknown, slug: string) => {
    if (!slug || typeof slug !== 'string') {
      throw new Error('routines-export-template: slug is required');
    }

    const sourceDir = path.join(getRoutinesDir(), slug);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error(`Template not found: ${ slug }`);
    }

    const defaultFilename = `${ slug }.routine.zip`;
    const saveResult = await dialog.showSaveDialog({
      title:       'Export Template',
      defaultPath: defaultFilename,
      filters:     [{ name: 'Sulla Routine Bundle', extensions: ['zip'] }],
      properties:  ['createDirectory', 'showOverwriteConfirmation'],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { canceled: true as const };
    }

    const targetZipPath = saveResult.filePath;

    try {
      await zipDirectory(sourceDir, slug, targetZipPath);
      console.log(`[Sulla] Exported template "${ slug }" → ${ targetZipPath }`);

      return { path: targetZipPath };
    } catch (err) {
      console.error(`[Sulla] Template export failed for "${ slug }":`, err);

      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  console.log('[Sulla] Routine export IPC handlers initialized');
}
