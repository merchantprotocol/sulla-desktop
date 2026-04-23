/**
 * One-shot migration: convert the hardcoded `native/*.ts` integration catalog
 * into YAML manifests under `~/sulla/resources/integrations/<slug>/integration.yaml`.
 *
 * Output location mirrors the convention for skills/workflows/agents — shipped
 * defaults live in `~/sulla/resources/`, managed as a clone of the
 * sulla-resources repo. After this migration runs, those 300+ YAML files are
 * the authoritative catalog and should be committed to sulla-resources.
 *
 * Run with:
 *   node scripts/ts-wrapper.js scripts/migrate-integration-catalog.ts
 *
 * Idempotent — rerunning overwrites integration.yaml files with fresh output
 * without touching sibling files (INTEGRATION.md, proxy auth YAMLs).
 */

import fs from 'fs';
import path from 'path';

import yaml from 'yaml';

import { nativeIntegrations } from '../pkg/rancher-desktop/agent/integrations/native';
import { validateIntegrationManifest } from '../pkg/rancher-desktop/agent/integrations/schema';
import { resolveSullaIntegrationsDir } from '../pkg/rancher-desktop/agent/utils/sullaPaths';

import type { IntegrationManifest } from '../pkg/rancher-desktop/agent/integrations/schema';
import type { Integration } from '../pkg/rancher-desktop/agent/integrations/types';

const MANIFESTS_DIR = resolveSullaIntegrationsDir();

function toManifest(entry: Integration): IntegrationManifest {
  const {
    // strip runtime-only state
    connected: _connected,
    // everything else maps 1:1
    ...rest
  } = entry;

  // Compact manifest: drop undefined keys so YAML stays readable.
  const compact: Record<string, unknown> = {
    apiVersion:  'sulla/v1',
    kind:        'Integration',
    id:          rest.id,
    name:        rest.name,
    description: rest.description,
    category:    rest.category,
    version:     rest.version,
    lastUpdated: rest.lastUpdated,
    developer:   rest.developer,
    sort:        rest.sort,
    paid:        rest.paid,
    beta:        rest.beta,
    comingSoon:  rest.comingSoon,
    builtin:     true,
  };

  if (rest.icon !== undefined) compact.icon = rest.icon;
  if (rest.authType !== undefined) compact.authType = rest.authType;
  if (rest.oauth !== undefined) compact.oauth = rest.oauth;
  if (rest.oauthProviderId !== undefined) compact.oauthProviderId = rest.oauthProviderId;
  if (rest.sullaManagedOAuth !== undefined) compact.sullaManagedOAuth = rest.sullaManagedOAuth;
  if (rest.formGuide !== undefined) compact.formGuide = rest.formGuide;
  if (rest.installationGuide !== undefined) compact.installationGuide = rest.installationGuide;
  if (rest.media !== undefined) compact.media = rest.media;
  if (rest.features !== undefined) compact.features = rest.features;
  if (rest.guideLinks !== undefined) compact.guideLinks = rest.guideLinks;
  if (rest.properties !== undefined) compact.properties = rest.properties;

  return compact as unknown as IntegrationManifest;
}

function writeManifest(manifest: IntegrationManifest): void {
  const dir = path.join(MANIFESTS_DIR, manifest.id);
  const file = path.join(dir, 'integration.yaml');

  fs.mkdirSync(dir, { recursive: true });

  const body = yaml.stringify(manifest, {
    lineWidth:   0,        // don't wrap long description strings
    singleQuote: true,
    blockQuote:  'literal', // multi-line installationGuide content reads cleanly
  });

  fs.writeFileSync(file, body, 'utf8');
}

function main(): void {
  const entries = Object.entries(nativeIntegrations);

  console.log(`Migrating ${ entries.length } integrations → ${ MANIFESTS_DIR }`);

  let ok = 0;
  let fail = 0;
  const failures: { slug: string; reason: string }[] = [];
  const keyIdMismatch: { key: string; id: string }[] = [];

  for (const [key, integration] of entries) {
    // entry.id is the authoritative slug (matches vault integration_id). Some
    // TS records have a key that doesn't match their id (e.g. meta_ads vs
    // meta-ads) — track those so the TS data can be fixed post-migration.
    if (key !== integration.id) keyIdMismatch.push({ key, id: integration.id });

    const slug = integration.id;

    try {
      const manifest = toManifest(integration);
      const check = validateIntegrationManifest(manifest, slug);

      if (!check.valid) {
        fail += 1;
        failures.push({ slug, reason: check.errors.join('; ') });
        continue;
      }

      writeManifest(manifest);
      ok += 1;
    } catch (err) {
      fail += 1;
      failures.push({ slug, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (keyIdMismatch.length > 0) {
    console.log(`\nNote: ${ keyIdMismatch.length } record key/id mismatches (record spread key ≠ entry.id) — migration used entry.id:`);
    for (const m of keyIdMismatch) console.log(`  - key="${ m.key }" → id="${ m.id }"`);
  }

  console.log(`✓ ${ ok } migrated, ✗ ${ fail } failed`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${ f.slug }: ${ f.reason }`);
    process.exit(1);
  }
}

main();
