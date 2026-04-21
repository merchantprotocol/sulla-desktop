/**
 * Routine-export IPC event handlers.
 *
 * Exports a single routine row from the workflows table to disk in
 * the new `sulla/v2 Routine` envelope shape. This is intentionally
 * distinct from the legacy YAML workflow format: it carries an
 * explicit apiVersion + kind, metadata at the top level, and nests
 * the full JSONB definition under `spec.definition` so downstream
 * tools can evolve the envelope without rewriting the definition.
 *
 * Kept in its own file (rather than bolted onto sullaWorkflowEvents
 * or sullaRoutineTemplateEvents) because the export flow owns the
 * native save dialog + filesystem I/O, which is orthogonal to both
 * the DB CRUD and the template-registry domains.
 */
import * as fs from 'fs';
import * as path from 'path';

import { dialog } from 'electron';
import yaml from 'yaml';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

/**
 * Dynamic import of WorkflowModel — keeps the Postgres layer out of
 * the main-process startup bundle, matching the pattern used in
 * sullaRoutineTemplateEvents.ts and sullaWorkflowEvents.ts.
 */
async function importWorkflowModel() {
  const mod = await import('@pkg/agent/database/models/WorkflowModel');

  return mod.WorkflowModel;
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

export function initSullaRoutineExportEvents(): void {
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
    const description = (attrs.description ?? null) as string | null;
    const version = (attrs.version ?? null) as string | null;
    const status = String(attrs.status ?? 'draft');
    const definition = (attrs.definition ?? {}) as Record<string, unknown>;

    // created_at / updated_at come off the model as Date after casting.
    const createdAt = attrs.created_at instanceof Date
      ? attrs.created_at.toISOString()
      : (attrs.created_at ? String(attrs.created_at) : null);
    const updatedAt = attrs.updated_at instanceof Date
      ? attrs.updated_at.toISOString()
      : (attrs.updated_at ? String(attrs.updated_at) : null);

    const envelope = {
      apiVersion: 'sulla/v2',
      kind:       'Routine',
      metadata:   {
        id,
        name,
        description,
        version,
        status,
        createdAt,
        updatedAt,
        exportedAt: new Date().toISOString(),
      },
      spec: {
        definition,
      },
    };

    const defaultFilename = `${ slugify(name) }.routine.yaml`;
    const saveResult = await dialog.showSaveDialog({
      title:       'Export Routine',
      defaultPath: defaultFilename,
      filters:     [
        { name: 'YAML', extensions: ['yaml', 'yml'] },
        { name: 'JSON', extensions: ['json'] },
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { canceled: true as const };
    }

    const targetPath = saveResult.filePath;
    const ext = path.extname(targetPath).toLowerCase();
    const body = ext === '.json'
      ? JSON.stringify(envelope, null, 2)
      : yaml.stringify(envelope, { lineWidth: 0 });

    fs.writeFileSync(targetPath, body, 'utf-8');
    console.log(`[Sulla] Exported routine "${ id }" → ${ targetPath }`);

    return { path: targetPath };
  });

  console.log('[Sulla] Routine export IPC handlers initialized');
}
