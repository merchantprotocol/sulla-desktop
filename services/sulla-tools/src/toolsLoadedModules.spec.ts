// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ToolManifestEntrypoints } from '../test-support/ToolManifestEntrypoints';
import { ToolsLoadedModuleGraph } from '../test-support/ToolsLoadedModuleGraph';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('sulla-tools loaded modules', () => {
  it('loads no Desktop main/backend/window/pages module from the Tools entrypoints', async() => {
    // risk: a Desktop main-process module loaded in the Tools container crashes it at startup
    // ("Cannot find module" once the Dockerfile stops copying main/), which takes every tool down.
    const graph = new ToolsLoadedModuleGraph({
      root:        repoRoot,
      dockerfile:  readFileSync(path.join(repoRoot, 'services/sulla-tools/Dockerfile'), 'utf8'),
      entrypoints: new ToolManifestEntrypoints(repoRoot).roots(),
    });
    expect(await graph.sensitiveEdges()).toEqual([]);
    expect(await graph.violations()).toEqual([]);
  }, 120_000);
});
