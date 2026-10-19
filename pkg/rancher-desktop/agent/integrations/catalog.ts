/**
 * Integration catalog. Every built-in integration (model providers, CLI
 * engines, SaaS integrations) is hard-coded in ./native and always present.
 * Postgres (integration_definitions) only adds marketplace installs and
 * user-edited definitions on top; those win by slug. Nothing is read from
 * folders on disk.
 */

import { loadCatalogWithDatabase } from './loader';
import { nativeIntegrations } from './native';

import type { Integration } from './types';

export type { Integration } from './types';

const builtinIntegrations: Record<string, Integration> = { ...nativeIntegrations };

export const integrations: Record<string, Integration> = { ...builtinIntegrations };

/** Access the raw manifests (for uninstall, bundled-artifact fan-out, UI). */
export const integrationManifests: Record<string, import('./schema').IntegrationManifest> = {};

/** Source of each loaded manifest (used by packageDirFor / iconPathFor). */
export const integrationSources: Record<string, import('./loader').ManifestSource> = {};

/** Refresh the long-lived exported objects after DB startup or an install. */
export async function refreshIntegrationCatalog(): Promise<void> {
  const next = await loadCatalogWithDatabase();
  const nextIntegrations = { ...builtinIntegrations, ...next.integrations };
  for (const key of Object.keys(integrations)) delete integrations[key];
  Object.assign(integrations, nextIntegrations);
  for (const key of Object.keys(integrationManifests)) delete integrationManifests[key];
  Object.assign(integrationManifests, next.manifests);
  for (const key of Object.keys(integrationSources)) delete integrationSources[key];
  Object.assign(integrationSources, next.sources);
}
