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

import { loadCatalog } from './loader';
import { nativeAiInfrastructureIntegrations } from './native/ai_infrastructure';

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
  console.log(`[integrations] No YAML manifests found, falling back to native catalog with ${ Object.keys(nativeAiInfrastructureIntegrations).length } integrations`);
}

export const integrations: Record<string, Integration> = hasYamlIntegrations
  ? loaded.integrations
  : nativeAiInfrastructureIntegrations;

/** Access the raw manifests (for uninstall, bundled-artifact fan-out, UI). */
export const integrationManifests = loaded.manifests;

/** Source of each loaded manifest (used by packageDirFor / iconPathFor). */
export const integrationSources = loaded.sources;
