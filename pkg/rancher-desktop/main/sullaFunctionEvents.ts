/**
 * Function IPC event handlers.
 *
 * Reads function definitions from Postgres and returns a normalized summary for the UI to
 * populate the Function node picker. Invocation itself happens through
 * the runtime containers (python/shell/node) — these handlers only
 * enumerate the catalog.
 */

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

export type FunctionRuntime = 'python' | 'shell' | 'node';

export interface FunctionIntegrationDep {
  /** Integration slug (e.g. "slack", "smtp") the function requires. */
  slug: string;
  /**
   * Map of env-var-name → integration-property-name. Keys become env vars
   * inside the runtime; values reference property names on the chosen
   * integration account.
   */
  env:  Record<string, string>;
}

export interface FunctionListItem {
  slug:         string;
  name:         string;
  description:  string;
  runtime:      FunctionRuntime;
  inputs:       Record<string, Record<string, unknown>>;
  outputs:      Record<string, Record<string, unknown>>;
  /**
   * Integrations this function declares. The UI uses this to render per-node
   * account pickers; the runtime derives env vars from the chosen account's
   * properties using each dep's `env` map. Always present (possibly empty).
   */
  integrations: FunctionIntegrationDep[];
}

function isValidRuntime(value: unknown): value is FunctionRuntime {
  return value === 'python' || value === 'shell' || value === 'node';
}

function normalizeSchema(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = v as Record<string, unknown>;
    } else {
      out[k] = {};
    }
  }

  return out;
}

function normalizeIntegrations(value: unknown): FunctionIntegrationDep[] {
  if (!Array.isArray(value)) return [];

  const out: FunctionIntegrationDep[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const slug = typeof rec.slug === 'string' ? rec.slug.trim() : '';

    if (!slug) continue;

    const envRaw = rec.env;
    const env: Record<string, string> = {};

    if (envRaw && typeof envRaw === 'object' && !Array.isArray(envRaw)) {
      for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
        if (typeof k === 'string' && k.trim() && typeof v === 'string' && v.trim()) {
          env[k.trim()] = v.trim();
        }
      }
    }

    out.push({ slug, env });
  }

  return out;
}

export function initSullaFunctionEvents(): void {
  ipcMainProxy.handle('functions-list', async(): Promise<FunctionListItem[]> => {
    const items: FunctionListItem[] = [];
    const { FunctionDefinitionModel } = await import('@pkg/agent/database/models/MarketplaceArtifactModel');
    for (const row of await FunctionDefinitionModel.list()) {
      const spec = row.manifest.spec ?? {};
      if (!isValidRuntime(row.runtime)) continue;
      items.push({
        slug:         row.slug,
        name:         row.name,
        description:  row.description,
        runtime:      row.runtime,
        inputs:       normalizeSchema(spec.inputs),
        outputs:      normalizeSchema(spec.outputs),
        integrations: normalizeIntegrations(spec.integrations),
      });
    }

    items.sort((a, b) => a.slug.localeCompare(b.slug));

    return items;
  });

  console.log('[Sulla] Function IPC event handlers initialized');
}
