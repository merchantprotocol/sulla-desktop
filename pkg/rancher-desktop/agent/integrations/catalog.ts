/**
 * Integration catalog backed by integration_definitions. Two app-native CLI
 * engines remain code-defined; every YAML-backed integration is loaded from Postgres.
 */

import { loadCatalogWithDatabase } from './loader';
import { nativeIntegrations } from './native';

import type { Integration } from './types';

export type { Integration } from './types';

// CLI engines ship with the app rather than the separately versioned
// integration resource pack. Keep these native cards visible even when the
// YAML catalog is present; YAML definitions win as soon as they are shipped.
const bundledCliEngines = Object.fromEntries(
  ['opencode', 'cursor']
    .filter(id => nativeIntegrations[id])
    .map(id => [id, nativeIntegrations[id]]),
);

export const integrations: Record<string, Integration> = { ...bundledCliEngines };

/** Access the raw manifests (for uninstall, bundled-artifact fan-out, UI). */
export const integrationManifests: Record<string, import('./schema').IntegrationManifest> = {};

/** Source of each loaded manifest (used by packageDirFor / iconPathFor). */
export const integrationSources: Record<string, import('./loader').ManifestSource> = {};

/** Refresh the long-lived exported objects after DB startup or an install. */
export async function refreshIntegrationCatalog(): Promise<void> {
  const next = await loadCatalogWithDatabase();
  const nextIntegrations = { ...bundledCliEngines, ...next.integrations };
  for (const key of Object.keys(integrations)) delete integrations[key];
  Object.assign(integrations, nextIntegrations);
  for (const key of Object.keys(integrationManifests)) delete integrationManifests[key];
  Object.assign(integrationManifests, next.manifests);
  for (const key of Object.keys(integrationSources)) delete integrationSources[key];
  Object.assign(integrationSources, next.sources);
}
