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
    // risk: a runtime import outside the copied agent/ tree breaks the Tools container at startup.
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'tools-image-boundary-'));
    writeFixture('pkg/sulla-desktop/agent/entry.ts', [
      "import { X } from '@pkg/main/X';",
      "import type { Y } from '@pkg/main/Y';",
      // Dynamic import inside a function body: not evaluated at module load, so not a violation.
      "export async function loadSeam() { return await import('@pkg/main/Dynamic'); }",
    ].join('\n'));
    writeFixture('pkg/sulla-desktop/main/X.ts', 'export const X = 1;\n');
    writeFixture('pkg/sulla-desktop/main/Y.ts', 'export type Y = string;\n');
    writeFixture('pkg/sulla-desktop/main/Dynamic.ts', 'export const Dynamic = 2;\n');

    const boundary = new ToolsImageImportBoundary({
      root:        fixtureRoot,
      dockerfile:  'COPY pkg/sulla-desktop/agent ./pkg/sulla-desktop/agent\n',
      entrypoints: ['pkg/sulla-desktop/agent/entry.ts'],
    });

    expect(boundary.violations()).toEqual(['pkg/sulla-desktop/agent/entry.ts -> pkg/sulla-desktop/main/X.ts']);
  });
});
