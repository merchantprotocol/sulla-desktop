/**
 * Function IPC event handlers.
 *
 * Scans ~/sulla/functions/<slug>/ for directories containing a
 * function.yaml manifest and returns a normalized summary for the UI to
 * populate the Function node picker. Invocation itself happens through
 * the runtime containers (python/shell/node) — these handlers only
 * enumerate the catalog.
 */

import * as fs from 'fs';
import * as path from 'path';

import yaml from 'yaml';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

export type FunctionRuntime = 'python' | 'shell' | 'node';

export interface FunctionListItem {
  slug:        string;
  name:        string;
  description: string;
  runtime:     FunctionRuntime;
  inputs:      Record<string, Record<string, unknown>>;
  outputs:     Record<string, Record<string, unknown>>;
  /**
   * Permissions declared by the function manifest. `env` is the list of env
   * var names the function expects to be bound to vault accounts at the
   * node-config level. Always present so the UI can iterate safely.
   */
  permissions: { env: string[] };
}

function getFunctionsDir(): string {
  const { resolveSullaFunctionsDir } = require('@pkg/agent/utils/sullaPaths');

  return resolveSullaFunctionsDir();
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

function normalizeEnvPermissions(permissions: unknown): string[] {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return [];
  const env = (permissions as Record<string, unknown>).env;
  if (!Array.isArray(env)) return [];

  return env
    .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    .map(e => e.trim());
}

export function initSullaFunctionEvents(): void {
  ipcMainProxy.handle('functions-list', async(): Promise<FunctionListItem[]> => {
    const root = getFunctionsDir();

    if (!fs.existsSync(root)) {
      return [];
    }

    const entries = fs.readdirSync(root, { withFileTypes: true });
    const items: FunctionListItem[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      const yamlPath = path.join(root, entry.name, 'function.yaml');
      if (!fs.existsSync(yamlPath)) continue;

      try {
        const raw = fs.readFileSync(yamlPath, 'utf-8');
        const parsed: any = yaml.parse(raw) || {};
        const spec = parsed.spec ?? {};
        const runtime = spec.runtime;

        if (!isValidRuntime(runtime)) {
          console.warn(`[Sulla] Skipping function "${ entry.name }" — invalid runtime: ${ runtime }`);
          continue;
        }

        const slug = typeof parsed.slug === 'string' && parsed.slug.trim() ? parsed.slug.trim() : entry.name;

        items.push({
          slug,
          name:        typeof parsed.name === 'string' ? parsed.name : slug,
          description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
          runtime,
          inputs:      normalizeSchema(spec.inputs),
          outputs:     normalizeSchema(spec.outputs),
          permissions: { env: normalizeEnvPermissions(spec.permissions) },
        });
      } catch (err) {
        console.warn(`[Sulla] Failed to parse function.yaml in ${ entry.name }:`, err);
      }
    }

    items.sort((a, b) => a.slug.localeCompare(b.slug));

    return items;
  });

  console.log('[Sulla] Function IPC event handlers initialized');
}
