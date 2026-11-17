// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolManifestEntrypoints } from '../test-support/ToolManifestEntrypoints';
import { ToolsImageImportBoundary } from '../test-support/ToolsImageImportBoundary';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('sulla-tools image import boundary', () => {
  it('keeps runtime imports reachable from Tools entrypoints inside copied image paths', () => {
    // risk: a missing copied path only fails at runtime inside the Tools image.
    const boundary = new ToolsImageImportBoundary({
      root:        repoRoot,
      dockerfile:  readFileSync(path.join(repoRoot, 'services/sulla-tools/Dockerfile'), 'utf8'),
      entrypoints: new ToolManifestEntrypoints(repoRoot).roots(),
    });
    expect(boundary.violations()).toEqual([]);
  });
});

describe('ToolsImageImportBoundary against a fixture image', () => {
  let fixtureRoot: string | undefined;

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  });

  function writeFixture(relativePath: string, text: string): void {
    const absolute = path.join(fixtureRoot as string, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }

  it('reports exactly the runtime import that the image does not copy', () => {
    // risk: a static @pkg/main import in a files tool breaks the Tools container at startup (files/list regression).
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'tools-image-boundary-'));
    writeFixture('pkg/sulla-desktop/agent/tools/files/list.ts', [
      "import { X } from '@pkg/main/X';",
      "import type { Y } from '@pkg/main/Y';",
      // A word "import" in prose must not be read as an edge to the quoted path.
      "// Shared helpers import the lister from '@pkg/main/Commented' at build time.",
      // Dynamic import inside a function body: not evaluated at module load, so not a violation.
      "export async function loadSeam() { return await import('@pkg/main/Dynamic'); }",
    ].join('\n'));
    writeFixture('pkg/sulla-desktop/main/X.ts', 'export const X = 1;\n');
    writeFixture('pkg/sulla-desktop/main/Y.ts', 'export type Y = string;\n');
    writeFixture('pkg/sulla-desktop/main/Commented.ts', 'export const Commented = 3;\n');
    writeFixture('pkg/sulla-desktop/main/Dynamic.ts', 'export const Dynamic = 2;\n');

    const boundary = new ToolsImageImportBoundary({
      root:        fixtureRoot,
      dockerfile:  'COPY pkg/sulla-desktop/agent ./pkg/sulla-desktop/agent\n',
      entrypoints: ['pkg/sulla-desktop/agent/tools/files/list.ts'],
    });

    expect(boundary.violations()).toEqual(['pkg/sulla-desktop/agent/tools/files/list.ts -> pkg/sulla-desktop/main/X.ts']);
  });

  it('does not descend into copied modules outside the followed tool, files and Tools scope', () => {
    // risk: deep agent/ edges that tsx elides or that the image never loads must not fail the boundary.
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'tools-image-boundary-'));
    writeFixture('services/sulla-tools/src/index.ts', "import { Model } from '../../../pkg/sulla-desktop/agent/languagemodels/Model';\nexport { Model };\n");
    writeFixture('pkg/sulla-desktop/agent/languagemodels/Model.ts', "import { Secret } from '@pkg/main/Secret';\nexport const Model = Secret;\n");
    writeFixture('pkg/sulla-desktop/main/Secret.ts', 'export const Secret = 4;\n');

    const boundary = new ToolsImageImportBoundary({
      root:        fixtureRoot,
      dockerfile:  'COPY pkg/sulla-desktop/agent ./pkg/sulla-desktop/agent\nCOPY services/sulla-tools/src ./services/sulla-tools/src\n',
      entrypoints: ['services/sulla-tools/src/index.ts'],
    });

    expect(boundary.violations()).toEqual([]);
  });

  it('reads an override source and resolves its imports from the destination path', () => {
    // risk: the Dockerfile replaces a Desktop file with a container stub; the stub's imports are what the image runs.
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'tools-image-boundary-'));
    writeFixture('pkg/sulla-desktop/agent/tools/creds.ts', "import { hasPendingCredential } from '@pkg/main/firstRun/pendingCredentials';\nexport const has = hasPendingCredential;\n");
    writeFixture('pkg/sulla-desktop/main/firstRun/pendingCredentials.ts', 'export const hasPendingCredential = (_id: string) => true;\n');
    writeFixture('services/sulla-tools/src/pendingCredentials.container.ts', [
      "import { Forbidden } from '@pkg/main/Forbidden';",
      "import { Sibling } from './Sibling';",
      'export const hasPendingCredential = (_id: string) => Forbidden !== Sibling;',
    ].join('\n'));
    writeFixture('pkg/sulla-desktop/main/Forbidden.ts', 'export const Forbidden = 5;\n');
    writeFixture('pkg/sulla-desktop/main/firstRun/Sibling.ts', 'export const Sibling = 6;\n');

    const boundary = new ToolsImageImportBoundary({
      root:        fixtureRoot,
      dockerfile:  [
        'COPY pkg/sulla-desktop/agent ./pkg/sulla-desktop/agent',
        'COPY services/sulla-tools/src/pendingCredentials.container.ts ./pkg/sulla-desktop/main/firstRun/pendingCredentials.ts',
        '',
      ].join('\n'),
      entrypoints: ['pkg/sulla-desktop/agent/tools/creds.ts'],
    });

    // Sibling resolves from the destination folder (main/firstRun/), not from services/sulla-tools/src/.
    expect(boundary.violations()).toEqual([
      'pkg/sulla-desktop/main/firstRun/pendingCredentials.ts -> pkg/sulla-desktop/main/Forbidden.ts',
      'pkg/sulla-desktop/main/firstRun/pendingCredentials.ts -> pkg/sulla-desktop/main/firstRun/Sibling.ts',
    ]);
  });
});
