#!/usr/bin/env node
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Writes resources/tool-placements.json from the tool manifests and
// tool-placement-policy.json, through the same resolver the registry uses.
// Hermetic: no network, no running Sulla. `--check` exits 1 if the file is stale.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { register } from 'tsx/esm/api';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'resources/tool-placements.json');
const toolsDir = path.join(root, 'pkg/sulla-desktop/agent/tools');

register();
const { allToolManifests } = await import(pathToFileURL(path.join(toolsDir, 'allManifests.ts')).href);
const { renderToolPlacementCatalog } = await import(pathToFileURL(path.join(toolsDir, 'toolPlacementCatalog.ts')).href);

const rendered = renderToolPlacementCatalog(allToolManifests);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(outputPath, 'utf8');
  } catch {
    // A missing file is stale.
  }
  if (current !== rendered) {
    console.error('resources/tool-placements.json is stale. Run: node scripts/gen-tool-placements.mjs');
    process.exit(1);
  }
  console.log('resources/tool-placements.json is up to date.');
} else {
  writeFileSync(outputPath, rendered);
  console.log(`Wrote ${ Object.keys(JSON.parse(rendered).tools).length } tools to resources/tool-placements.json`);
}
