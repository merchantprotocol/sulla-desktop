// @vitest-environment node
/*
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const fixture = new Uint8Array(readFileSync(new URL('../Files/fixtures/inline-pdf-fixture.pdf', import.meta.url)));

describe('legacy PDF.js runtime', () => {
  it('parses the real fixture and loads its first page without a native canvas', async() => {
    // risk: Electron runtime compatibility — real legacy PDF.js must parse bytes and build page operators without native canvas.
    const previousWorkerSource = GlobalWorkerOptions.workerSrc;
    GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
    const loadingTask = getDocument({
      data: fixture.slice(),
      isEvalSupported: false,
      disableAutoFetch: true,
      disableStream: true,
      useWorkerFetch: false,
      enableXfa: false,
      useWasm: false,
    });

    try {
      const pdf = await loadingTask.promise;
      expect(pdf.numPages).toBe(1);

      const page = await pdf.getPage(1);
      expect(page.pageNumber).toBe(1);
      const operatorList = await page.getOperatorList();
      expect(operatorList.fnArray.length).toBeGreaterThan(0);
    } finally {
      await loadingTask.destroy();
      GlobalWorkerOptions.workerSrc = previousWorkerSource;
    }
  });
});
