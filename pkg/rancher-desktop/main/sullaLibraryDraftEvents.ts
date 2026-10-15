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

import yazl from 'yazl';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

const API_BASE = 'https://sulla-workers.merchantprotocol.workers.dev';
type DraftKind = 'skill' | 'function' | 'recipe' | 'integration';

// ─── Reference the manifest builder exposed from sullaLibraryEvents ─

async function readLocalManifest(
  kind: DraftKind,
  slug: string,
): Promise<{
  manifest: Record<string, unknown>;
  name:     string;
} | null> {
  const { buildLocalManifest } = require('./sullaLibraryEvents');
  const payload = await buildLocalManifest(kind, slug) as {
    template: { name: string; manifest: Record<string, unknown> };
  } | null;
  if (!payload) return null;

  return {
    manifest: payload.template.manifest,
    name:     payload.template.name,
  };
}

async function saveDraftToDatabase(draft: {
  kind: DraftKind; slug: string; name: string; manifest_json: Record<string, any>; files_json: Record<string, string>;
}): Promise<void> {
  const manifest = (draft.manifest_json.definition ?? draft.manifest_json) as Record<string, any>;
  const description = String(manifest.description ?? draft.manifest_json.metadata?.description ?? '');
  const version = String(manifest.version ?? draft.manifest_json.metadata?.version ?? '1.0.0');
  if (draft.kind === 'skill') {
    const skill = draft.files_json['SKILL.md'];
    if (!skill) throw new Error('Skill draft is missing SKILL.md');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-skill-draft-'));
    try {
      for (const [name, content] of Object.entries(draft.files_json)) {
        const target = path.join(root, name);
        if (!path.resolve(target).startsWith(`${ path.resolve(root) }${ path.sep }`)) throw new Error(`Unsafe draft path: ${ name }`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
      }
      const { importSkillFolder } = await import('@pkg/agent/services/SkillDefinitionService');
      const { skillsRegistry } = await import('@pkg/agent/database/registry/SkillsRegistry');
      await importSkillFolder(root, { sourceKind: 'user', force: true });
      await skillsRegistry.invalidate();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    return;
  }

  const { postgresClient } = await import('@pkg/agent/database/PostgresClient');
  if (draft.kind === 'function') {
    const runtime = String(manifest.spec?.runtime ?? manifest.runtime ?? '');
    await postgresClient.query(`INSERT INTO function_definitions (slug,name,description,manifest,runtime,files,source_kind,version,user_edited)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,'user',$7,true)
      ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,manifest=EXCLUDED.manifest,runtime=EXCLUDED.runtime,files=EXCLUDED.files,source_kind='user',version=EXCLUDED.version,user_edited=true,updated_at=now()`,
    [draft.slug, draft.name, description, JSON.stringify(manifest), runtime, JSON.stringify(draft.files_json), version]);
  } else if (draft.kind === 'integration') {
    manifest.id = draft.slug;
    await postgresClient.query(`INSERT INTO integration_definitions (slug,name,description,manifest,files,source_kind,version,user_edited)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'user',$6,true)
      ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,manifest=EXCLUDED.manifest,files=EXCLUDED.files,source_kind='user',version=EXCLUDED.version,user_edited=true,updated_at=now()`,
    [draft.slug, draft.name, description, JSON.stringify(manifest), JSON.stringify(draft.files_json), version]);
    const { refreshIntegrationCatalog } = await import('@pkg/agent/integrations/catalog');
    await refreshIntegrationCatalog();
  } else {
    const composeName = String(manifest.compose?.composeFile ?? manifest.composeFile ?? 'docker-compose.yml');
    const compose = draft.files_json[composeName] ?? draft.files_json['docker-compose.yml'] ?? draft.files_json['compose.yaml'];
    if (!compose) throw new Error('Recipe draft is missing its compose file');
    await postgresClient.query(`INSERT INTO recipe_definitions (slug,name,description,manifest,compose,files,source_kind,version,user_edited)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,'user',$7,true)
      ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,manifest=EXCLUDED.manifest,compose=EXCLUDED.compose,files=EXCLUDED.files,source_kind='user',version=EXCLUDED.version,user_edited=true,updated_at=now()`,
    [draft.slug, draft.name, description, JSON.stringify(manifest), compose, JSON.stringify(draft.files_json), version]);
  }
}

// ─── IPC handlers ───────────────────────────────────────────────────

export function initSullaLibraryDraftEvents(): void {
  ipcMainProxy.handle('library-fork', async(_event, kind: DraftKind, slug: string) => {
    try {
      if (kind !== 'skill' && kind !== 'function' && kind !== 'recipe' && kind !== 'integration') {
        return { error: `kind must be one of skill | function | recipe | integration (got "${ kind }")` };
      }

      const starter = await readLocalManifest(kind, slug);
      if (!starter) return { error: 'could not build manifest from Postgres' };

      const files: Record<string, string> = {};
      const { readDatabaseArtifact } = await import('@pkg/main/marketplace/databaseArtifacts');
      const source = await readDatabaseArtifact(kind, slug);
      for (const [name, stored] of Object.entries(source.files)) {
        if (typeof stored === 'string') files[name] = stored;
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
  // Commit a draft into the canonical Postgres definition table.
  ipcMainProxy.handle('library-draft-publish-local', async(_event, id: string, targetSlug?: string) => {
    try {
      const { LibraryDraftModel } = await import('@pkg/agent/database/models/LibraryDraftModel');
      const draft = await LibraryDraftModel.findById(id);
      if (!draft) return { error: 'draft not found' };

      const slug = (targetSlug?.trim() || draft.slug).replace(/[^a-z0-9-_.]/gi, '-').toLowerCase();
      if (!slug) return { error: 'target slug is required' };

      await saveDraftToDatabase({ ...draft, slug });

      return { path: `database:${ draft.kind }_definitions/${ slug }`, slug };
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

      // Build the zip contents from the database draft only.
      const entries: { zipPath: string; buffer: Buffer }[] = [];
      for (const [relPath, content] of Object.entries(draft.files_json)) {
        entries.push({
          zipPath: `${ draft.slug }/${ relPath }`,
          buffer:  Buffer.from(content, 'utf8'),
        });
      }

      const zipPath = await writeZip(entries);
      try {
        const zipBytes = fs.readFileSync(zipPath);

        // Step 1: submit-manifest
        const submitRes = await fetch(`${ API_BASE }/marketplace/submit-manifest`, {
          method:  'POST',
          headers: {
            Authorization:  `Bearer ${ token }`,
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
            Authorization:    `Bearer ${ token }`,
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
        try { fs.unlinkSync(zipPath) } catch { /* best effort */ }
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

async function writeZip(entries: { zipPath: string; buffer: Buffer }[]): Promise<string> {
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

  return outPath;
}
