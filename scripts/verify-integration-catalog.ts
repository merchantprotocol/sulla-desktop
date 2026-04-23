/**
 * Round-trip verify: load the YAML manifests written by the migration and
 * compare them field-by-field against the hardcoded nativeIntegrations.
 *
 * Run with:
 *   node scripts/ts-wrapper.js scripts/verify-integration-catalog.ts
 */

import { loadCatalog } from '../pkg/rancher-desktop/agent/integrations/loader';
import { nativeIntegrations } from '../pkg/rancher-desktop/agent/integrations/native';

import type { Integration } from '../pkg/rancher-desktop/agent/integrations/types';

function canonical(i: Integration): Integration {
  // connected is runtime state — always false at load time.
  return { ...i, connected: false };
}

function main(): void {
  const { integrations, errors } = loadCatalog();

  const loadedIds = new Set(Object.keys(integrations));
  const nativeIds = new Set(Object.values(nativeIntegrations).map(i => i.id));

  const missing = [...nativeIds].filter(id => !loadedIds.has(id));
  const extra = [...loadedIds].filter(id => !nativeIds.has(id));

  console.log(`Loader: ${ loadedIds.size } manifests loaded, ${ errors.length } validation errors`);
  console.log(`Native: ${ nativeIds.size } integrations in TS source`);

  if (errors.length > 0) {
    console.log('\nValidation errors:');
    for (const e of errors) console.log(`  - ${ e.slug } [${ e.source }]: ${ e.errors.join('; ') }`);
  }

  if (missing.length > 0) console.log(`\nMissing from loader (in TS, not in YAML): ${ missing.join(', ') }`);
  if (extra.length > 0) console.log(`\nExtra in loader (in YAML, not in TS): ${ extra.join(', ') }`);

  // Field-level diff
  const mismatches: string[] = [];

  for (const native of Object.values(nativeIntegrations)) {
    const loaded = integrations[native.id];

    if (!loaded) continue; // already reported in `missing`

    const a = JSON.stringify(canonical(native), Object.keys(native).sort());
    const b = JSON.stringify(canonical(loaded), Object.keys(native).sort());

    if (a !== b) mismatches.push(native.id);
  }

  if (mismatches.length > 0) {
    console.log(`\nField mismatches (${ mismatches.length }):`);
    for (const id of mismatches.slice(0, 5)) {
      console.log(`  - ${ id }`);
      console.log(`    native: ${ JSON.stringify(canonical(nativeIntegrations[id] ?? Object.values(nativeIntegrations).find(i => i.id === id)!)).slice(0, 200) }`);
      console.log(`    loaded: ${ JSON.stringify(canonical(integrations[id])).slice(0, 200) }`);
    }
  }

  const pass = errors.length === 0 && missing.length === 0 && extra.length === 0 && mismatches.length === 0;

  console.log(`\n${ pass ? '✓ PASS' : '✗ FAIL' } — round-trip ${ pass ? 'succeeded' : 'has mismatches' }`);
  process.exit(pass ? 0 : 1);
}

main();
