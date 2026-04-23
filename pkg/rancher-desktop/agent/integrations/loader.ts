/**
 * Dynamic catalog loader.
 *
 * Integration manifests live alongside the other dynamic artifacts in Sulla
 * Home. Two sources are merged into a single catalog:
 *
 *   1. `~/sulla/resources/integrations/<slug>/integration.yaml` — shipped
 *      defaults (managed as a git clone of the `sulla-resources` repo; see
 *      bootstrapSullaHome). These carry `builtin: true`.
 *
 *   2. `~/sulla/integrations/<slug>/integration.yaml` — marketplace installs.
 *      These carry `builtin: false`.
 *
 * On slug collision the user directory wins. Collision is expected to be rare
 * because marketplace install auto-renames on collision (Phase 2), but a user
 * override of a builtin's metadata is legitimate and must be allowed.
 *
 * Validation failures are logged and the offending manifest is skipped — a
 * single malformed file must never take down the whole catalog.
 */

import fs from 'fs';
import path from 'path';

import yaml from 'yaml';

import {
  IntegrationManifest,
  manifestToIntegration,
  validateIntegrationManifest,
} from './schema';
import {
  resolveSullaIntegrationsDir,
  resolveSullaUserIntegrationsDir,
} from '../utils/sullaPaths';

import type { Integration } from './types';

export type ManifestSource = 'resources' | 'user';

export interface LoadResult {
  /** Merged catalog, keyed by integration id — drop-in for the previous static `integrations` export. */
  integrations: Record<string, Integration>;
  /** Manifests as loaded; used by uninstall, bundled-artifact fan-out, UI. */
  manifests:    Record<string, IntegrationManifest>;
  /** Tracks which source each manifest came from (useful for uninstall/path resolution). */
  sources:      Record<string, ManifestSource>;
  /** Per-slug validation errors surfaced to UI/logs. */
  errors:       { slug: string; source: ManifestSource; errors: string[] }[];
}

export function loadCatalog(): LoadResult {
  const errors:    LoadResult['errors'] = [];
  const manifests: Record<string, IntegrationManifest> = {};
  const sources:   Record<string, ManifestSource> = {};

  const dirs: { path: string; source: ManifestSource }[] = [
    { path: resolveSullaIntegrationsDir(), source: 'resources' },
    { path: resolveSullaUserIntegrationsDir(), source: 'user' },
  ];

  for (const { path: dir, source } of dirs) {
    for (const entry of readManifestDir(dir, source, errors)) {
      manifests[entry.manifest.id] = entry.manifest;
      sources[entry.manifest.id] = source;
    }
  }

  const integrations: Record<string, Integration> = {};

  for (const [slug, manifest] of Object.entries(manifests)) {
    integrations[slug] = manifestToIntegration(manifest);
  }

  return {
    integrations, manifests, sources, errors,
  };
}

interface LoadedEntry {
  slug:     string;
  manifest: IntegrationManifest;
}

function readManifestDir(
  dir: string,
  source: ManifestSource,
  errors: LoadResult['errors'],
): LoadedEntry[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const results: LoadedEntry[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const slug = entry.name;
    const manifestPath = path.join(dir, slug, 'integration.yaml');

    if (!fs.existsSync(manifestPath)) continue;

    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const parsed = yaml.parse(raw);
      const result = validateIntegrationManifest(parsed, slug);

      if (!result.valid || !result.data) {
        errors.push({ slug, source, errors: result.errors });
        continue;
      }

      results.push({ slug, manifest: result.data });
    } catch (err) {
      errors.push({
        slug,
        source,
        errors: [`failed to read/parse integration.yaml: ${ err instanceof Error ? err.message : String(err) }`],
      });
    }
  }

  return results;
}

/** Resolve the on-disk path to an integration's icon file, if any. */
export function iconPathFor(
  slug: string,
  manifests: Record<string, IntegrationManifest>,
  sources: Record<string, ManifestSource>,
): string | null {
  const manifest = manifests[slug];

  if (!manifest?.icon) return null;

  return path.join(packageDirFor(slug, sources[slug] ?? 'resources'), manifest.icon);
}

/** Resolve the directory holding an integration's package contents. */
export function packageDirFor(slug: string, source: ManifestSource): string {
  const root = source === 'resources'
    ? resolveSullaIntegrationsDir()
    : resolveSullaUserIntegrationsDir();

  return path.join(root, slug);
}
