/**
 * Throwaway verifier: parses and validates the staged QuickBooks
 * integration.yaml against the same schema the desktop loader uses.
 * Run with:
 *   node scripts/ts-wrapper.js scripts/verify-quickbooks-manifest.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import yaml from 'yaml';

import { validateIntegrationManifest } from '../pkg/rancher-desktop/agent/integrations/schema';

const manifestPath = path.join(os.homedir(), 'sulla', 'integrations', 'quickbooks', 'integration.yaml');
const text = fs.readFileSync(manifestPath, 'utf8');
const parsed = yaml.parse(text);
const result = validateIntegrationManifest(parsed, 'quickbooks');

if (result.valid) {
  console.log('✓ QuickBooks manifest is valid');
  console.log(`  id:         ${ result.data?.id }`);
  console.log(`  name:       ${ result.data?.name }`);
  console.log(`  authType:   ${ result.data?.authType }`);
  console.log(`  provider:   ${ result.data?.oauthProviderId }`);
  console.log(`  properties: ${ result.data?.properties?.length ?? 0 } field(s)`);
  console.log(`  guideSteps: ${ result.data?.installationGuide?.steps?.length ?? 0 }`);
  process.exit(0);
} else {
  console.error('✗ QuickBooks manifest failed validation:');
  for (const err of result.errors) console.error(`  - ${ err }`);
  process.exit(1);
}
