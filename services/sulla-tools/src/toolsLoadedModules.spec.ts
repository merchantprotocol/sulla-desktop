// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ModuleExportContract } from '../test-support/ModuleExportContract';
import { ToolManifestEntrypoints } from '../test-support/ToolManifestEntrypoints';
import { ToolsLoadedModuleGraph } from '../test-support/ToolsLoadedModuleGraph';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const pendingCredentialsStub = 'services/sulla-tools/src/pendingCredentials.container.ts';
const pendingCredentialsDesktop = 'pkg/sulla-desktop/main/firstRun/pendingCredentials.ts';
// The Desktop modules that statically import the first-run credential store and run in the Tools image.
const pendingCredentialImporters = [
  'pkg/sulla-desktop/agent/services/oauth/custody/FirstRunMemoryCustody.ts',
  'pkg/sulla-desktop/main/cloud/session/SullaCloudAuthServiceProvider.ts',
];

describe('sulla-tools loaded modules', () => {
  it('loads no Desktop main/backend/window/pages module at container startup', async() => {
    // risk: a Desktop main-process module loaded in the Tools container crashes it at startup
    // ("Cannot find module" once the Dockerfile stops copying main/), which takes every tool down.
    // Startup = the static import closure of the Tools entrypoints. Lazy import() / require() edges run
    // only when a tool runs, and are reported by scripts/report-lazy-desktop-imports.ts instead.
    const graph = new ToolsLoadedModuleGraph({
      root:        repoRoot,
      dockerfile:  readFileSync(path.join(repoRoot, 'services/sulla-tools/Dockerfile'), 'utf8'),
      entrypoints: new ToolManifestEntrypoints(repoRoot).roots(),
    });
    expect(await graph.startupViolations()).toEqual([]);
  }, 120_000);

  it('reaches no Desktop-only module from the base tool class, even through lazy imports', async() => {
    // risk: agent/tools/base.ts runs in every tool. A lazy import() that reaches Desktop main (approval
    // inbox, first-run trace, Electron IPC) fails at the first tool call in the container, not at boot.
    // Approval goes through the injected ToolDecisionPort instead; Desktop registers the real inbox at startup.
    const graph = new ToolsLoadedModuleGraph({
      root:        repoRoot,
      dockerfile:  readFileSync(path.join(repoRoot, 'services/sulla-tools/Dockerfile'), 'utf8'),
      entrypoints: ['pkg/sulla-desktop/agent/tools/base.ts'],
    });
    expect(await graph.sensitiveInputs()).toEqual([]);
  }, 120_000);

  it('loads no Desktop-only module at startup through the container approval registration', async() => {
    // risk: the registration runs when the Tools container starts. Its static closure (DecisionService and what it
    // imports statically) must stay container-safe.
    const graph = new ToolsLoadedModuleGraph({
      root:        repoRoot,
      dockerfile:  readFileSync(path.join(repoRoot, 'services/sulla-tools/Dockerfile'), 'utf8'),
      entrypoints: ['services/sulla-tools/src/toolDecisionPortRegistration.ts'],
    });
    expect(await graph.startupViolations()).toEqual([]);
  }, 120_000);

  it('loads no first-run trace implementation in the Tools bundle, even through lazy imports', async() => {
    // risk: main/firstRun/firstRunTrace.ts needs Electron, userData and the support timeline. Any Tools-loaded module
    // that imports it (lazily or not) breaks the container at the first trace. Agent code records through
    // utils/firstRunTraceSink.ts, and Desktop main registers the real timeline at startup.
    const graph = new ToolsLoadedModuleGraph({
      root:        repoRoot,
      dockerfile:  readFileSync(path.join(repoRoot, 'services/sulla-tools/Dockerfile'), 'utf8'),
      entrypoints: new ToolManifestEntrypoints(repoRoot).roots(),
    });
    expect(await graph.loadedInputs()).not.toContain('pkg/sulla-desktop/main/firstRun/firstRunTrace.ts');
  }, 120_000);

  it('exports every name the Desktop credential importers take from the container stub', () => {
    // risk: a missing export is a load-time "No matching export" crash the first time the importer runs.
    const contract = new ModuleExportContract(repoRoot);
    const stubExports = contract.exportedNames(pendingCredentialsStub);
    for (const importer of pendingCredentialImporters) {
      const imported = contract.importedNames(importer, pendingCredentialsDesktop);
      expect(imported.length, `${ importer } imports nothing from pendingCredentials`).toBeGreaterThan(0);
      expect(imported.filter(name => !stubExports.includes(name)), importer).toEqual([]);
    }
  });
});
