/**
 * Postgres-backed integration catalog loader.
 */

import {
  IntegrationManifest,
  manifestToIntegration,
  validateIntegrationManifest,
} from './schema';

import type { Integration } from './types';

export type ManifestSource = 'database' | 'resources' | 'user';

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
  return { integrations: {}, manifests: {}, sources: {}, errors: [] };
}

/** Load the runtime catalog exclusively from Postgres. */
export async function loadCatalogWithDatabase(): Promise<LoadResult> {
  const loaded = loadCatalog();
  const { IntegrationDefinitionModel } = await import('../database/models/MarketplaceArtifactModel');
  for (const row of await IntegrationDefinitionModel.list()) {
    const result = validateIntegrationManifest(row.manifest, row.slug);
    if (!result.valid || !result.data) {
      loaded.errors.push({ slug: row.slug, source: 'database', errors: result.errors });
      continue;
    }
    loaded.manifests[row.slug] = result.data;
    loaded.sources[row.slug] = 'database';
    loaded.integrations[row.slug] = manifestToIntegration(result.data);
  }
  return loaded;
}

/** Resolve the on-disk path to an integration's icon file, if any. */
export function iconPathFor(
  slug: string,
  manifests: Record<string, IntegrationManifest>,
  sources: Record<string, ManifestSource>,
): string | null {
  const manifest = manifests[slug];

  if (!manifest?.icon) return null;
  return null;
}

/** Resolve the directory holding an integration's package contents. */
export function packageDirFor(slug: string, source: ManifestSource): string {
  throw new Error(`Database integration ${ slug } has no persistent package directory (${ source })`);
}
