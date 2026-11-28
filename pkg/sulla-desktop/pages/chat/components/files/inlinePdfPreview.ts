/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */

export const MAX_INLINE_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_INLINE_PDF_PAGES = 2_000;
export const MAX_INLINE_PDF_CANVAS_PIXELS = 16 * 1024 * 1024;
export const MAX_INLINE_PDF_CANVAS_DIMENSION = 8_192;
export const INLINE_PDF_LOAD_TIMEOUT_MS = 12_000;
export const INLINE_PDF_RENDER_TIMEOUT_MS = 8_000;

export type InlinePdfPreviewState = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'load-error' | 'render-error';
  pageNumber: number;
  pageCount: number;
  message?: string;
}>;

export interface InlinePdfPageViewport {
  width: number;
  height: number;
}

export interface InlinePdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface InlinePdfPage {
  getViewport(options: { scale: number }): InlinePdfPageViewport;
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: InlinePdfPageViewport }): InlinePdfRenderTask;
  cleanup?(): void;
}

export interface InlinePdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<InlinePdfPage>;
  destroy(): Promise<void> | void;
}

export interface InlinePdfDocumentLoader {
  load(bytes: Uint8Array, signal?: AbortSignal): Promise<InlinePdfDocument>;
}

export interface InlinePdfWorker {
  destroy(): Promise<void> | void;
}

export interface InlinePdfLoadingTask<Document extends InlinePdfDocument = InlinePdfDocument> {
  promise: Promise<Document>;
  destroy(): Promise<void> | void;
}

export interface InlinePdfRuntime {
  getDocument(options: {
    data: Uint8Array;
    worker: InlinePdfWorker;
    isEvalSupported: false;
    disableAutoFetch: true;
    disableStream: true;
    useWorkerFetch: false;
    enableXfa: false;
    useWasm: false;
    maxImageSize: number;
    stopAtErrors: true;
  }): InlinePdfLoadingTask;
}

export interface InlinePdfWorkerFactory {
  create(): InlinePdfWorker;
}

/**
 * Loads PDF bytes only, through a dedicated PDF.js worker.  This deliberately
 * never accepts a URL and fixes PDF.js's eval, streaming, XFA, and worker-fetch
 * switches at their safe values.
 */
export class PdfJsInlineDocumentLoader implements InlinePdfDocumentLoader {
  constructor(
    private readonly runtime: InlinePdfRuntime,
    private readonly workerFactory: InlinePdfWorkerFactory,
  ) {}

  async load(bytes: Uint8Array, signal?: AbortSignal): Promise<InlinePdfDocument> {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

    const worker = this.workerFactory.create();
    let task: InlinePdfLoadingTask | undefined;
    let disposed = false;
    let disposePromise: Promise<void> | undefined;
    let documentReady = false;
    const dispose = (): Promise<void> => {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async() => {
        try { await task?.destroy(); } catch { /* PDF.js teardown is best-effort after cancellation. */ }
        try { await worker.destroy(); } catch { /* The worker may already have stopped itself. */ }
      })();
      return disposePromise;
    };
    const abort = (): void => { void dispose(); };

    try {
      // PDF.js transfers the input buffer to its worker. Keep the parent card's
      // authorized bytes intact so replacing/unmounting the card remains safe.
      const data = new Uint8Array(bytes);
      task = this.runtime.getDocument({
        data,
        worker,
        isEvalSupported: false,
        disableAutoFetch: true,
        disableStream: true,
        useWorkerFetch: false,
        enableXfa: false,
        useWasm: false,
        maxImageSize: MAX_INLINE_PDF_CANVAS_PIXELS,
        stopAtErrors: true,
      });
      signal?.addEventListener('abort', abort, { once: true });
      const document = await task.promise;
      if (signal?.aborted || disposed) throw new DOMException('The operation was aborted.', 'AbortError');

      documentReady = true;
      return {
        numPages: document.numPages,
        getPage: (pageNumber: number) => document.getPage(pageNumber),
        destroy: async() => {
          signal?.removeEventListener('abort', abort);
          await dispose();
        },
      };
    } catch (error) {
      signal?.removeEventListener('abort', abort);
      await dispose();
      throw error;
    } finally {
      if (!documentReady) signal?.removeEventListener('abort', abort);
    }
  }
}

/** Owns one loaded PDF and exactly one in-flight page render for an inline card. */
export class InlinePdfPreviewController {
  private state: InlinePdfPreviewState = { status: 'idle', pageNumber: 1, pageCount: 0 };
  private document?: InlinePdfDocument;
  private canvas?: HTMLCanvasElement;
  private renderTask?: InlinePdfRenderTask;
  private loadAbortController?: AbortController;
  private lifecycle = 0;
  private renderSequence = 0;

  constructor(
    private readonly loader: InlinePdfDocumentLoader,
    private readonly loadTimeoutMs = INLINE_PDF_LOAD_TIMEOUT_MS,
    private readonly renderTimeoutMs = INLINE_PDF_RENDER_TIMEOUT_MS,
  ) {}

  snapshot(): InlinePdfPreviewState {
    return { ...this.state };
  }

  async open(bytes: Uint8Array, canvas: HTMLCanvasElement): Promise<InlinePdfPreviewState> {
    const lifecycle = ++this.lifecycle;
    this.loadAbortController?.abort();
    this.state = { status: 'loading', pageNumber: 1, pageCount: 0 };
    await this.disposeCurrentDocument();
    if (lifecycle !== this.lifecycle) return this.snapshot();
    this.canvas = canvas;

    if (bytes.byteLength > MAX_INLINE_PDF_BYTES) {
      return this.fail('This PDF is outside the 20 MB inline preview limit. Open it in a tab to view the full file.');
    }
    if (bytes.byteLength === 0) return this.fail('This PDF is empty or damaged. Open it in a tab to view it.');

    const abortController = new AbortController();
    this.loadAbortController = abortController;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let loadTimedOut = false;
    try {
      const document = await Promise.race([
        this.loader.load(bytes, abortController.signal),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            loadTimedOut = true;
            abortController.abort();
            reject(new Error('PDF preview timed out.'));
          }, this.loadTimeoutMs);
        }),
      ]);
      if (lifecycle !== this.lifecycle || abortController.signal.aborted) {
        await document.destroy();
        return this.snapshot();
      }
      if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) {
        await document.destroy();
        return this.fail('This PDF is empty or damaged. Open it in a tab to view it.');
      }
      if (document.numPages > MAX_INLINE_PDF_PAGES) {
        await document.destroy();
        return this.fail(`This PDF has more than ${ MAX_INLINE_PDF_PAGES.toLocaleString() } pages. Open it in a tab to view it.`);
      }

      this.document = document;
      this.state = { status: 'ready', pageNumber: 1, pageCount: document.numPages };
      await this.renderPage(1, lifecycle);
      return this.snapshot();
    } catch (error) {
      if (lifecycle !== this.lifecycle || abortController.signal.aborted && !loadTimedOut) return this.snapshot();
      const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
      const message = name === 'PasswordException' || /password/i.test(error instanceof Error ? error.message : '')
        ? 'This PDF is password-protected. Open it in a tab to view it.'
        : error instanceof Error && error.message === 'PDF preview timed out.'
          ? 'This PDF took too long to preview. Open it in a tab to view it.'
          : 'This PDF could not be previewed. Open it in a tab to view it.';
      return this.fail(message);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (lifecycle === this.lifecycle) this.loadAbortController = undefined;
    }
  }

  async previousPage(): Promise<InlinePdfPreviewState> {
    return this.goToPage(this.state.pageNumber - 1);
  }

  async nextPage(): Promise<InlinePdfPreviewState> {
    return this.goToPage(this.state.pageNumber + 1);
  }

  handleKey(key: string): Promise<InlinePdfPreviewState> | undefined {
    if (key === 'ArrowLeft') return this.previousPage();
    if (key === 'ArrowRight') return this.nextPage();
    return undefined;
  }

  async goToPage(pageNumber: number): Promise<InlinePdfPreviewState> {
    if (!this.document || !Number.isFinite(pageNumber)) return this.snapshot();
    const boundedPage = Math.max(1, Math.min(this.state.pageCount, Math.trunc(pageNumber)));
    if (boundedPage === this.state.pageNumber) return this.snapshot();

    this.cancelRender();
    this.state = { ...this.state, status: 'ready', pageNumber: boundedPage, message: undefined };
    const lifecycle = this.lifecycle;
    await this.renderPage(boundedPage, lifecycle);
    return this.snapshot();
  }

  async destroy(): Promise<void> {
    this.lifecycle += 1;
    this.cancelRender();
    this.loadAbortController?.abort();
    this.loadAbortController = undefined;
    await this.disposeCurrentDocument();
    this.canvas = undefined;
    this.state = { status: 'idle', pageNumber: 1, pageCount: 0 };
  }

  private async renderPage(pageNumber: number, lifecycle: number): Promise<void> {
    const document = this.document;
    const canvas = this.canvas;
    if (!document || !canvas) return;

    const renderSequence = ++this.renderSequence;
    let page: InlinePdfPage | undefined;
    let task: InlinePdfRenderTask | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let renderTimedOut = false;
    try {
      const renderTimeout = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          renderTimedOut = true;
          reject(new Error('PDF page render timed out.'));
          try { task?.cancel(); } catch { /* PDF.js cancellation is best-effort after timeout. */ }
        }, this.renderTimeoutMs);
      });
      const pageLoad = document.getPage(pageNumber).then(loadedPage => {
        if (renderTimedOut) loadedPage.cleanup?.();
        return loadedPage;
      });
      page = await Promise.race([pageLoad, renderTimeout]);
      if (!this.isCurrentRender(lifecycle, renderSequence)) {
        page.cleanup?.();
        return;
      }
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');

      const originalViewport = page.getViewport({ scale: 1 });
      if (!(originalViewport.width > 0) || !(originalViewport.height > 0)
        || !Number.isFinite(originalViewport.width) || !Number.isFinite(originalViewport.height)) throw new Error('Invalid PDF page dimensions');
      const availableWidth = canvas.parentElement?.clientWidth || canvas.clientWidth || originalViewport.width;
      const devicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
      const pixelRatio = Math.max(1, Math.min(devicePixelRatio, 2));
      const scaleByArea = Math.sqrt(MAX_INLINE_PDF_CANVAS_PIXELS / (originalViewport.width * originalViewport.height)) / pixelRatio;
      const scaleByDimension = MAX_INLINE_PDF_CANVAS_DIMENSION / (Math.max(originalViewport.width, originalViewport.height) * pixelRatio);
      const scale = Math.min(availableWidth / originalViewport.width, 2, scaleByArea, scaleByDimension);
      if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('PDF page exceeds the render limit');
      const viewport = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      task = page.render({ canvasContext: context, viewport });
      this.renderTask = task;
      await Promise.race([task.promise, renderTimeout]);
      if (!this.isCurrentRender(lifecycle, renderSequence)) return;
      this.state = { ...this.state, status: 'ready', message: undefined };
    } catch (error) {
      if (!this.isCurrentRender(lifecycle, renderSequence)) return;
      this.state = {
        ...this.state,
        status: 'render-error',
        message: error instanceof Error && error.message === 'PDF page render timed out.'
          ? 'This PDF page took too long to render. Open it in a tab to view it.'
          : 'This PDF page could not be rendered. Open it in a tab to view it.',
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.renderTask && this.renderSequence === renderSequence) this.renderTask = undefined;
      page?.cleanup?.();
    }
  }

  private isCurrentRender(lifecycle: number, renderSequence: number): boolean {
    return lifecycle === this.lifecycle && renderSequence === this.renderSequence;
  }

  private cancelRender(): void {
    this.renderSequence += 1;
    const task = this.renderTask;
    this.renderTask = undefined;
    task?.cancel();
  }

  private async disposeCurrentDocument(): Promise<void> {
    this.cancelRender();
    this.loadAbortController?.abort();
    this.loadAbortController = undefined;
    const document = this.document;
    this.document = undefined;
    if (!document) return;
    try { await document.destroy(); } catch { /* PDF.js teardown is best-effort after cancellation. */ }
  }

  private fail(message: string): InlinePdfPreviewState {
    this.state = { ...this.state, status: 'load-error', message };
    return this.snapshot();
  }
}
