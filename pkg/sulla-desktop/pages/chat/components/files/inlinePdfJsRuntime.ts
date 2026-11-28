/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */

import * as pdfjs from 'pdfjs-dist';

import {
  PdfJsInlineDocumentLoader,
  type InlinePdfDocumentLoader,
  type InlinePdfRuntime,
  type InlinePdfWorkerFactory,
} from './inlinePdfPreview';

class PdfJsWorkerFactory implements InlinePdfWorkerFactory {
  create(): InstanceType<typeof pdfjs.PDFWorker> {
    const port = new Worker(/* webpackChunkName: "inlinePdf.worker" */ new URL('./inlinePdfWorker.ts', import.meta.url), {
      type: 'module',
      name: 'sulla-inline-pdf-preview',
    });
    try { return new pdfjs.PDFWorker({ port }); }
    catch (error) { port.terminate(); throw error; }
  }
}

/** Creates one isolated PDF.js worker per card; the loader itself remains state-free. */
export class InlinePdfJsDocumentLoaderFactory {
  create(): InlinePdfDocumentLoader {
    return new PdfJsInlineDocumentLoader(
      pdfjs as unknown as InlinePdfRuntime,
      new PdfJsWorkerFactory(),
    );
  }
}
