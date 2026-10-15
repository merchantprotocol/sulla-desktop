/**
 * Integration catalog — loaded dynamically from YAML manifests at startup.
 *
 * Source of truth: `~/sulla/resources/integrations/<slug>/integration.yaml`
 * (built-in defaults, shipped via sulla-resources) merged with
 * `~/sulla/integrations/<slug>/integration.yaml` (marketplace installs).
 *
 * The previous hardcoded catalog in `native/*.ts` has been migrated to YAML
 * via `scripts/migrate-integration-catalog.ts` and should be removed once the
 * YAML catalog is verified in a full rebuild.
 */

import { loadCatalog, loadCatalogWithDatabase } from './loader';
import { nativeIntegrations } from './native';

import type { Integration } from './types';

export type { Integration } from './types';

const loaded = loadCatalog();

// Surface load-time validation failures in the main-process log so malformed
// marketplace installs are discoverable without reading the UI.
if (loaded.errors.length > 0) {
  for (const err of loaded.errors) {
    console.warn(`[integrations] skipped ${ err.source }/${ err.slug }: ${ err.errors.join('; ') }`);
  }
}

// Merge native integrations as fallback if YAML catalog is empty (migration in progress)
const hasYamlIntegrations = Object.keys(loaded.integrations).length > 0;

if (hasYamlIntegrations) {
  console.log(`[integrations] Loaded ${ Object.keys(loaded.integrations).length } integrations from YAML manifests`);
} else {
  console.log(`[integrations] No YAML manifests found, falling back to native catalog with ${ Object.keys(nativeIntegrations).length } integrations`);
}

// CLI engines ship with the app rather than the separately versioned
// integration resource pack. Keep these native cards visible even when the
// YAML catalog is present; YAML definitions win as soon as they are shipped.
const bundledCliEngines = Object.fromEntries(
  ['opencode', 'cursor']
    .filter(id => nativeIntegrations[id])
    .map(id => [id, nativeIntegrations[id]]),
);

export const integrations: Record<string, Integration> = hasYamlIntegrations
  ? { ...bundledCliEngines, ...loaded.integrations }
  : { ...nativeIntegrations };

/** Access the raw manifests (for uninstall, bundled-artifact fan-out, UI). */
export const integrationManifests = loaded.manifests;

/** Source of each loaded manifest (used by packageDirFor / iconPathFor). */
export const integrationSources = loaded.sources;

/** Refresh the long-lived exported objects after DB startup or an install. */
export async function refreshIntegrationCatalog(): Promise<void> {
  const next = await loadCatalogWithDatabase();
  const nextIntegrations = Object.keys(next.integrations).length
    ? { ...bundledCliEngines, ...next.integrations }
    : { ...nativeIntegrations };
  for (const key of Object.keys(integrations)) delete integrations[key];
  Object.assign(integrations, nextIntegrations);
  for (const key of Object.keys(integrationManifests)) delete integrationManifests[key];
  Object.assign(integrationManifests, next.manifests);
  for (const key of Object.keys(integrationSources)) delete integrationSources[key];
  Object.assign(integrationSources, next.sources);
}
