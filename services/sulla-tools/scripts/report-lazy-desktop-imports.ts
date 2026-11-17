// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/*
 * Prints the lazy (import() / require()) edges from the Tools container into Desktop-only trees.
 * Report only: it asserts nothing. Run it with `tsx` from services/sulla-tools to refresh the
 * violations list in the Projects/sulla-desktop TASKS.md. Startup safety is enforced by toolsLoadedModules.spec.ts.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolManifestEntrypoints } from '../test-support/ToolManifestEntrypoints';
import { ToolsLoadedModuleGraph } from '../test-support/ToolsLoadedModuleGraph';

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const graph = new ToolsLoadedModuleGraph({
    root:        repoRoot,
    dockerfile:  readFileSync(path.join(repoRoot, 'services/sulla-tools/Dockerfile'), 'utf8'),
    entrypoints: new ToolManifestEntrypoints(repoRoot).roots(),
  });
  const inputs = await graph.sensitiveInputs();
  const edges = await graph.sensitiveEdges();
  const startup = await graph.startupViolations();

  process.stdout.write(`Desktop-only inputs loaded from the Tools roots (all edges): ${ inputs.length }\n`);
  process.stdout.write(`Desktop-only inputs at startup (static imports): ${ startup.length }\n`);
  process.stdout.write(`Desktop-only first-hop edges (lazy included): ${ edges.length }\n\n`);
  for (const edge of edges) process.stdout.write(`${ edge }\n`);
}

main().catch(error => {
  process.stderr.write(`${ error instanceof Error ? error.stack ?? error.message : String(error) }\n`);
  process.exitCode = 1;
});
