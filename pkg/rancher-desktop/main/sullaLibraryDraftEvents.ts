/**
 * Library draft IPC handlers.
 *
 * Drafts are the editable DB rows users work in after forking a library
 * item. Four CRUD handlers plus fork/publish-local/publish-marketplace:
 *
 *   library-fork                       → copy a disk item into a draft row
 *   library-drafts-list                → list drafts (optional kind filter)
 *   library-draft-get                  → full draft incl. manifest + files
 *   library-draft-save                 → patch draft fields
 *   library-draft-delete               → drop draft row
 *   library-draft-publish-local        → materialise draft back to ~/sulla/<kind>s/<slug>/
 *   library-draft-publish-marketplace  → submit to sulla cloud (v3 two-step)
 *
 * Forking reads every text file under the source slug directory into
 * `files_json`. Binary files are skipped with a log line — they stay on
 * disk and can be re-added at publish time from the base_slug dir.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as yauzl from 'yauzl';
import yazl from 'yazl';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

const API_BASE = 'https://sulla-workers.jonathon-44b.workers.dev';
const MAX_TEXT_FILE_BYTES = 1 * 1024 * 1024;   // 1 MB per file on fork
const MAX_FILES_ON_FORK   = 2_000;

type DraftKind = 'skill' | 'function' | 'recipe';
type KindPlural = 'routines' | 'skills' | 'functions' | 'recipes';

function kindPlural(k: DraftKind): KindPlural {
  return ({ skill: 'skills', function: 'functions', recipe: 'recipes' } as const)[k];
}

function kindBaseDir(k: DraftKind): string {
  const p = require('@pkg/agent/utils/sullaPaths');

  switch (k) {
  case 'skill':    return p.resolveSullaUserSkillsDir();
  case 'function': return p.resolveSullaFunctionsDir();
  case 'recipe':   return p.resolveSullaRecipesDir();
  }
}

function coreDocFor(kind: DraftKind): string {
  return ({ skill: 'SKILL.md', function: 'function.yaml', recipe: 'manifest.yaml' } as const)[kind];
}

/**
 * Detect whether a Buffer's bytes decode as valid UTF-8 with no
 * replacement chars. Avoids false positives on binary content that
 * happens to contain printable bytes.
 */
function isUtf8Text(buf: Buffer): boolean {
  // Fast path: look for the null byte, which never appears in UTF-8 text.
  for (let i = 0; i < Math.min(buf.length, 4096); i++) {
    if (buf[i] === 0) return false;
  }
  try {
    const decoded = buf.toString('utf8');

    // If there are replacement chars (U+FFFD), we decoded invalid bytes.
    return !decoded.includes('\uFFFD');
  } catch {
    return false;
  }
}

/**
 * Walk a directory recursively, returning every file's path relative to
 * `root` along with its Buffer contents.
 */
function walkFiles(root: string): Array<{ relPath: string; buffer: Buffer }> {
  const results: Array<{ relPath: string; buffer: Buffer }> = [];

  const walk = (abs: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${ rel }/${ entry.name }` : entry.name;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const buf = fs.readFileSync(childAbs);
        results.push({ relPath: childRel, buffer: buf });
      } catch (err) {
        console.warn(`[Sulla] fork: could not read ${ childAbs }:`, err);
      }
      if (results.length >= MAX_FILES_ON_FORK) return;
    }
  };
  walk(root, '');

  return results;
}

// ─── Reference the manifest builder exposed from sullaLibraryEvents ─

async function readLocalManifest(
  kind: DraftKind,
  slug: string,
): Promise<{
  manifest: Record<string, unknown>;
  name:     string;
} | null> {
  const { buildLocalManifest } = require('./sullaLibraryEvents');
  const payload = buildLocalManifest(kind, slug) as {
    template: { name: string; manifest: Record<string, unknown> };
  } | null;
  if (!payload) return null;

  return {
    manifest: payload.template.manifest,
    name:     payload.template.name,
  };
}

// ─── IPC handlers ───────────────────────────────────────────────────

export function initSullaLibraryDraftEvents(): void {
  ipcMainProxy.handle('library-fork', async(_event, kind: DraftKind, slug: string) => {
    try {
      if (kind !== 'skill' && kind !== 'function' && kind !== 'recipe') {
        return { error: `kind must be one of skill | function | recipe (got "${ kind }")` };
      }

      const base = path.join(kindBaseDir(kind), slug);
      if (!fs.existsSync(base)) {
        return { error: `no library item at ${ kindPlural(kind) }/${ slug }` };
      }

      const starter = await readLocalManifest(kind, slug);
      if (!starter) return { error: 'could not build manifest from disk' };

      const files: Record<string, string> = {};
      const all = walkFiles(base);
      for (const { relPath, buffer } of all) {
        if (buffer.byteLength > MAX_TEXT_FILE_BYTES) {
          console.warn(`[Sulla] fork: skipping ${ relPath } (too large)`);
          continue;
        }
        if (!isUtf8Text(buffer)) {
          console.warn(`[Sulla] fork: skipping ${ relPath } (binary — will re-pull from base_slug at publish)`);
          continue;
        }
        files[relPath] = buffer.toString('utf8');
      }

      const { LibraryDraftModel } = await import('@pkg/agent/database/models/LibraryDraftModel');
      const draft = await LibraryDraftModel.create({
        kind,
        slug:          `${ slug }-fork`,
        base_slug:     slug,
        name:          starter.name,
        manifest_json: starter.manifest,
        files_json:    files,
      });

      return { id: draft.id };
    } catch (err) {
      console.error('[Sulla] library-fork failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMainProxy.handle('library-drafts-list', async(_event, kind) => {
    try {
      const { LibraryDraftModel } = await import('@pkg/agent/database/models/LibraryDraftModel');

      return await LibraryDraftModel.listAll(kind);
    } catch (err) {
      console.error('[Sulla] library-drafts-list failed:', err);

      return [];
    }
  });

  ipcMainProxy.handle('library-draft-get', async(_event, id: string) => {
    try {
      const { LibraryDraftModel } = await import('@pkg/agent/database/models/LibraryDraftModel');
      const draft = await LibraryDraftModel.findById(id);
      if (!draft) return { error: 'draft not found' };

      return draft as any;
    } catch (err) {
      console.error('[Sulla] library-draft-get failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMainProxy.handle('library-draft-save', async(_event, id: string, patch) => {
    try {
      const { LibraryDraftModel } = await import('@pkg/agent/database/models/LibraryDraftModel');

      // Keep `name` column in sync with manifest metadata.name when the
      // manifest is patched so the Drafts list shows the current title
      // without a separate save step.
      const nextName = (() => {
        const m = patch?.manifest_json as any;

        return typeof m?.metadata?.name === 'string' ? m.metadata.name : undefined;
      })();

      const updated = await LibraryDraftModel.update(id, {
        ...patch,
        ...(nextName ? { name: nextName } : {}),
      });
      if (!updated) return { error: 'draft not found' };

      return { ok: true as const };
    } catch (err) {
      console.error('[Sulla] library-draft-save failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMainProxy.handle('library-draft-delete', async(_event, id: string) => {
    try {
      const { LibraryDraftModel } = await import('@pkg/agent/database/models/LibraryDraftModel');
      const ok = await LibraryDraftModel.delete(id);
      if (!ok) return { error: 'draft not found' };

      return { ok: true as const };
    } catch (err) {
      console.error('[Sulla] library-draft-delete failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Phase 3: Publish local ────────────────────────────────
  // Materialise a draft back to ~/sulla/<kind>s/<targetSlug>/. The
  // original base_slug directory is untouched unless targetSlug matches
  // it — the user can overwrite-in-place by passing the original slug,
  // or create a new directory by passing anything else.
  ipcMainProxy.handle('library-draft-publish-local', async(_event, id: string, targetSlug?: string) => {
    try {
      const { LibraryDraftModel } = await import('@pkg/agent/database/models/LibraryDraftModel');
      const draft = await LibraryDraftModel.findById(id);
      if (!draft) return { error: 'draft not found' };

      const slug = (targetSlug?.trim() || draft.slug).replace(/[^a-z0-9-_.]/gi, '-').toLowerCase();
      if (!slug) return { error: 'target slug is required' };

      const baseDir = kindBaseDir(draft.kind as DraftKind);
      fs.mkdirSync(baseDir, { recursive: true });
      const target = path.join(baseDir, slug);

      // Merge with base_slug contents when the draft only carries text
      // files — binary assets from the original bundle survive the fork.
      const fromBase = draft.base_slug
        ? walkFiles(path.join(baseDir, draft.base_slug))
        : [];
      const baseMap = new Map(fromBase.map(f => [f.relPath, f.buffer]));

      // Ensure target dir exists, wipe if overwriting in place.
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      fs.mkdirSync(target, { recursive: true });

      // Write draft-supplied text files first (they win over base copies).
      const writtenPaths = new Set<string>();
      for (const [relPath, content] of Object.entries(draft.files_json)) {
        const outPath = path.join(target, relPath);
        if (!path.resolve(outPath).startsWith(path.resolve(target) + path.sep)) {
          return { error: `refusing to write outside target: ${ relPath }` };
        }
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, content, 'utf8');
        writtenPaths.add(relPath);
      }

      // Backfill binary files from the base_slug dir.
      for (const [relPath, buf] of baseMap.entries()) {
        if (writtenPaths.has(relPath)) continue;
        const outPath = path.join(target, relPath);
        if (!path.resolve(outPath).startsWith(path.resolve(target) + path.sep)) continue;
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, buf);
      }

      return { path: target, slug };
    } catch (err) {
      console.error('[Sulla] library-draft-publish-local failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Phase 3: Publish to marketplace ───────────────────────
  // Builds a zip bundle from the draft's text files (+ any binary files
  // pulled forward from base_slug) and runs the v3 two-step submission.
  ipcMainProxy.handle('library-draft-publish-marketplace', async(_event, id: string) => {
    try {
      const token = await getCurrentAccessToken();
      if (!token) return { error: 'Sign in to Sulla Cloud to publish to the marketplace.' };

      const { LibraryDraftModel } = await import('@pkg/agent/database/models/LibraryDraftModel');
      const draft = await LibraryDraftModel.findById(id);
      if (!draft) return { error: 'draft not found' };

      // Build the zip contents: draft text files + base-slug binary files.
      const entries: Array<{ zipPath: string; buffer: Buffer }> = [];
      for (const [relPath, content] of Object.entries(draft.files_json)) {
        entries.push({
          zipPath: `${ draft.slug }/${ relPath }`,
          buffer:  Buffer.from(content, 'utf8'),
        });
      }
      if (draft.base_slug) {
        const baseDir = path.join(kindBaseDir(draft.kind as DraftKind), draft.base_slug);
        const existingPaths = new Set(entries.map(e => e.zipPath));
        for (const { relPath, buffer } of walkFiles(baseDir)) {
          const zipPath = `${ draft.slug }/${ relPath }`;
          if (!existingPaths.has(zipPath) && !isUtf8Text(buffer)) {
            entries.push({ zipPath, buffer });
          }
        }
      }

      const zipPath = await writeZip(entries);
      try {
        const zipBytes = fs.readFileSync(zipPath);

        // Step 1: submit-manifest
        const submitRes = await fetch(`${ API_BASE }/marketplace/submit-manifest`, {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${ token }`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            kind:        draft.kind,
            name:        draft.name,
            description: (draft.manifest_json as any)?.metadata?.description ?? '',
            version:     (draft.manifest_json as any)?.metadata?.version ?? '1.0.0',
            tags:        (draft.manifest_json as any)?.metadata?.tags ?? [],
            manifest:    draft.manifest_json,
          }),
        });
        if (!submitRes.ok) {
          const body = await submitRes.text().catch(() => '');

          return { error: `submit-manifest failed: ${ submitRes.status } ${ body.slice(0, 200) }` };
        }
        const submitJson = await submitRes.json() as {
          template: { id: string; bundle_upload_url: string };
        };

        // Step 2: PUT bundle
        const putRes = await fetch(`${ API_BASE }${ submitJson.template.bundle_upload_url }`, {
          method:  'PUT',
          headers: {
            'Authorization':  `Bearer ${ token }`,
            'Content-Type':   'application/zip',
            'Content-Length': String(zipBytes.byteLength),
          },
          // Node's undici fetch accepts BodyInit; a Buffer (which is a
          // Uint8Array view) satisfies the type in practice but the
          // DOM-flavored lib.d.ts doesn't advertise Uint8Array on BodyInit,
          // so we cast to Blob-ish to keep TS quiet without stripping safety.
          body: zipBytes as unknown as BodyInit,
        });
        if (!putRes.ok) {
          const body = await putRes.text().catch(() => '');

          return { error: `bundle upload failed: ${ putRes.status } ${ body.slice(0, 200) }` };
        }
        const putJson = await putRes.json() as { template: { bundle_status: string } };

        return {
          templateId:   submitJson.template.id,
          bundleStatus: putJson.template.bundle_status,
        };
      } finally {
        try { fs.unlinkSync(zipPath); } catch { /* best effort */ }
      }
    } catch (err) {
      console.error('[Sulla] library-draft-publish-marketplace failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  console.log('[Sulla] Library draft IPC handlers initialized');
}

// ─── Zip writer helper ──────────────────────────────────────────────
// Uses yazl (already a dep, used by the export handler). Writes to a
// tmp file so we can pass its path to readFileSync for the HTTP body.

async function writeZip(entries: Array<{ zipPath: string; buffer: Buffer }>): Promise<string> {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-draft-zip-'));
  const outPath = path.join(tmpdir, 'bundle.zip');
  const zip = new yazl.ZipFile();
  for (const { zipPath, buffer } of entries) {
    zip.addBuffer(buffer, zipPath);
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    zip.outputStream.pipe(out);
    zip.outputStream.on('error', reject);
    out.on('close', () => resolve());
    out.on('error', reject);
  });

  // Prevent unused-import lint on yauzl if it's not referenced later.
  void yauzl;

  return outPath;
}
