// @vitest-environment jsdom
/*
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import InlineFileCard from '../../../../pages/chat/components/files/InlineFileCard.vue';
import InlinePdfPreview from '../../../../pages/chat/components/files/InlinePdfPreview.vue';
import {
  InlinePdfPreviewController,
  MAX_INLINE_PDF_CANVAS_PIXELS,
  MAX_INLINE_PDF_PAGES,
  PdfJsInlineDocumentLoader,
  type InlinePdfDocument,
  type InlinePdfDocumentLoader,
  type InlinePdfPage,
  type InlinePdfRenderTask,
  type InlinePdfRuntime,
  type InlinePdfWorker,
} from '../../../../pages/chat/components/files/inlinePdfPreview';

const fixture = new Uint8Array(readFileSync(path.join(process.cwd(), 'pkg/sulla-desktop/agent/tests/Unit/Files/fixtures/inline-pdf-fixture.pdf')));

function deferred<T>(): { promise:Promise<T>; resolve(value:T):void; reject(reason?:unknown):void } {
  let resolve!: (value:T) => void;
  let reject!: (reason?:unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function canvasSurface(): { canvas:HTMLCanvasElement; fillRect:ReturnType<typeof vi.fn> } {
  const fillRect = vi.fn();
  const context = { fillStyle:'', fillRect } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width:0,
    height:0,
    clientWidth:600,
    parentElement:{ clientWidth:600 },
    getContext:vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
  return { canvas, fillRect };
}

function pageWith(task:InlinePdfRenderTask = { promise:Promise.resolve(), cancel:vi.fn() }):InlinePdfPage {
  return {
    getViewport:({ scale }) => ({ width:612 * scale, height:792 * scale }),
    render:vi.fn(() => task),
    cleanup:vi.fn(),
  };
}

function documentWith(pageCount:number, pages:Map<number, InlinePdfPage> = new Map()):InlinePdfDocument {
  return {
    numPages:pageCount,
    getPage:vi.fn(async(pageNumber:number) => pages.get(pageNumber) ?? pageWith()),
    destroy:vi.fn(),
  };
}

function loaderFor(document:InlinePdfDocument):InlinePdfDocumentLoader {
  return { load:vi.fn(async() => document) };
}

describe('PDF.js inline document loader', () => {
  it('loads only byte data with scripting/eval and remote-fetch paths disabled', async() => {
    // risk: renderer isolation — untrusted PDF actions must not execute and parsing must not fetch URLs.
    const document = documentWith(1);
    const worker:InlinePdfWorker = { destroy:vi.fn() };
    const task = { promise:Promise.resolve(document), destroy:vi.fn() };
    let options:Parameters<InlinePdfRuntime['getDocument']>[0] | undefined;
    const runtime:InlinePdfRuntime = {
      getDocument:vi.fn(input => { options = input; return task; }),
    };
    const loader = new PdfJsInlineDocumentLoader(runtime, { create:vi.fn(() => worker) });
    const source = fixture.slice();
    const loaded = await loader.load(source);

    expect(options?.data).not.toBe(source);
    expect(options?.data).toEqual(source);
    expect(options?.worker).toBe(worker);
    expect(options?.isEvalSupported).toBe(false);
    expect(options?.disableAutoFetch).toBe(true);
    expect(options?.disableStream).toBe(true);
    expect(options?.useWorkerFetch).toBe(false);
    expect(options?.enableXfa).toBe(false);
    expect(options?.useWasm).toBe(false);
    expect(options?.maxImageSize).toBe(MAX_INLINE_PDF_CANVAS_PIXELS);
    expect(options?.stopAtErrors).toBe(true);
    expect(options).not.toHaveProperty('url');
    await loaded.destroy();
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(worker.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('bounded inline PDF paging', () => {
  it('keeps a 500-page document responsive with on-demand paging, clamps bounds, and handles arrow keys', async() => {
    // risk: responsiveness — only requested pages render, with first/last navigation bounds.
    const document = documentWith(500);
    const view = canvasSurface();
    const controller = new InlinePdfPreviewController(loaderFor(document));
    await controller.open(fixture, view.canvas);

    expect(controller.snapshot()).toMatchObject({ status:'ready', pageNumber:1, pageCount:500 });
    expect(document.getPage).toHaveBeenCalledTimes(1);
    await controller.previousPage();
    expect(controller.snapshot().pageNumber).toBe(1);
    await controller.goToPage(501);
    expect(controller.snapshot().pageNumber).toBe(500);
    await controller.nextPage();
    expect(controller.snapshot().pageNumber).toBe(500);
    await controller.handleKey('ArrowLeft');
    expect(controller.snapshot().pageNumber).toBe(499);
    await controller.handleKey('ArrowRight');
    expect(controller.snapshot().pageNumber).toBe(500);
    expect(controller.handleKey('Enter')).toBeUndefined();
    await controller.destroy();
  });

  it('rejects unreasonable page counts before requesting any page', async() => {
    // risk: resource bounds — malicious page trees cannot trigger unbounded page iteration.
    const document = documentWith(MAX_INLINE_PDF_PAGES + 1);
    const controller = new InlinePdfPreviewController(loaderFor(document));
    const result = await controller.open(fixture, canvasSurface().canvas);

    expect(result.status).toBe('load-error');
    expect(result.message).toContain('pages');
    expect(document.getPage).not.toHaveBeenCalled();
    await controller.destroy();
  });

  it('reports an empty PDF as damaged rather than a size-cap error', async() => {
    // risk: data availability — empty binaries need an accurate, actionable fallback.
    const controller = new InlinePdfPreviewController(loaderFor(documentWith(1)));
    const result = await controller.open(new Uint8Array(), canvasSurface().canvas);

    expect(result.status).toBe('load-error');
    expect(result.message).toContain('empty or damaged');
    expect(result.message).toContain('tab');
  });

  it('keeps page navigation available after a page render error', async() => {
    // risk: data availability — one bad page render must not lock navigation to other pages.
    const firstPageTask:InlinePdfRenderTask = { promise:Promise.reject(new Error('rasterization failed')), cancel:vi.fn() };
    const document = documentWith(2, new Map([[1, pageWith(firstPageTask)], [2, pageWith()]]));
    const controller = new InlinePdfPreviewController(loaderFor(document));

    const firstPage = await controller.open(fixture, canvasSurface().canvas);
    expect(firstPage).toMatchObject({ status:'render-error', pageNumber:1, pageCount:2 });

    const secondPage = await controller.nextPage();
    expect(secondPage).toMatchObject({ status:'ready', pageNumber:2, pageCount:2 });
    expect(document.getPage).toHaveBeenCalledTimes(2);
    await controller.destroy();
  });

  it('keeps the next-page control enabled after a page render error', async() => {
    // risk: usability — a failed canvas render cannot disable navigation to another loaded page.
    const firstPageTask:InlinePdfRenderTask = { promise:Promise.reject(new Error('rasterization failed')), cancel:vi.fn() };
    const pdfDocument = documentWith(2, new Map([[1, pageWith(firstPageTask)], [2, pageWith()]]));
    const context = { fillStyle:'', fillRect:vi.fn() } as unknown as CanvasRenderingContext2D;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    const wrapper = mount(InlineFileCard, {
      props:{
        pdfDocumentLoader:loaderFor(pdfDocument),
        file:{
          fileId:'fixture-pdf', name:'inline-pdf-fixture.pdf', path:'fixtures/inline-pdf-fixture.pdf',
          status:'ready', canOpenInTab:true, preview:{ kind:'pdf', bytes:fixture },
        },
      },
    });
    const preview = wrapper.findComponent(InlinePdfPreview);
    const latestState = () => preview.emitted('state-change')?.at(-1)?.[0];
    await vi.waitFor(() => expect(latestState()).toMatchObject({ status:'render-error', pageNumber:1, pageCount:2 }));
    const nextPageButton = wrapper.get('[title="Next page"]');
    expect((nextPageButton.element as HTMLButtonElement).disabled).toBe(false);

    await nextPageButton.trigger('click');
    await vi.waitFor(() => expect(latestState()).toMatchObject({ status:'ready', pageNumber:2, pageCount:2 }));
    expect(pdfDocument.getPage).toHaveBeenCalledTimes(2);
    wrapper.unmount();
    getContext.mockRestore();
  });

  it('cancels an in-flight page render before requesting the next page', async() => {
    // risk: responsiveness — fast paging must cancel the prior canvas render and never overlap work.
    const firstRender = deferred<void>();
    let firstRenderStarted!: () => void;
    const renderStarted = new Promise<void>(resolve => { firstRenderStarted = resolve; });
    const firstTask:InlinePdfRenderTask = {
      promise:firstRender.promise,
      cancel:vi.fn(() => firstRender.reject(new Error('render cancelled'))),
    };
    const secondTask:InlinePdfRenderTask = { promise:Promise.resolve(), cancel:vi.fn() };
    const firstPage:InlinePdfPage = {
      getViewport:({ scale }) => ({ width:612 * scale, height:792 * scale }),
      render:vi.fn(() => { firstRenderStarted(); return firstTask; }),
      cleanup:vi.fn(),
    };
    const document = documentWith(2, new Map([
      [1, firstPage],
      [2, pageWith(secondTask)],
    ]));
    vi.mocked(document.getPage).mockImplementation(async(pageNumber:number) => {
      return pageNumber === 1 ? firstPage : pageWith(secondTask);
    });
    const controller = new InlinePdfPreviewController(loaderFor(document), 12_000, 15);
    const opening = controller.open(fixture, canvasSurface().canvas);
    await renderStarted;

    const pageChange = controller.nextPage();
    expect(firstTask.cancel).toHaveBeenCalledTimes(1);
    await Promise.all([opening, pageChange]);
    expect(controller.snapshot()).toMatchObject({ status:'ready', pageNumber:2, pageCount:2 });
    expect(document.getPage).toHaveBeenCalledTimes(2);
    await controller.destroy();
  });

  it.each([
    { name:'password-protected', error:Object.assign(new Error('Password required'), { name:'PasswordException' }), expected:'password-protected' },
    { name:'corrupt', error:new Error('bad PDF header'), expected:'could not be previewed' },
  ])('shows a clear tab fallback for $name PDFs', async({ error, expected }) => {
    // risk: data availability — rejected PDFs must fail safely with an actionable fallback.
    const loader:InlinePdfDocumentLoader = { load:vi.fn(async() => { throw error; }) };
    const controller = new InlinePdfPreviewController(loader);
    const result = await controller.open(fixture, canvasSurface().canvas);

    expect(result.status).toBe('load-error');
    expect(result.message).toContain(expected);
    expect(result.message).toContain('tab');
  });

  it('bounds PDF loading time and aborts the loader when the timeout expires', async() => {
    // risk: responsiveness — broken or hostile files cannot leave a preview loading indefinitely.
    let loaderSignal:AbortSignal | undefined;
    const loader:InlinePdfDocumentLoader = {
      load:vi.fn((_bytes, signal) => {
        loaderSignal = signal;
        return new Promise<InlinePdfDocument>(() => undefined);
      }),
    };
    const controller = new InlinePdfPreviewController(loader, 5, 20);
    const result = await controller.open(fixture, canvasSurface().canvas);

    expect(result.status).toBe('load-error');
    expect(result.message).toContain('too long');
    expect(loaderSignal?.aborted).toBe(true);
  });

  it('bounds page acquisition time and cleans up a page that resolves after timeout', async() => {
    // risk: responsiveness — a hostile page tree cannot stall a card while PDF.js resolves the requested page.
    const pendingPage = deferred<InlinePdfPage>();
    const latePage = pageWith();
    const document:InlinePdfDocument = {
      numPages:1,
      getPage:vi.fn(() => pendingPage.promise),
      destroy:vi.fn(),
    };
    const controller = new InlinePdfPreviewController(loaderFor(document), 12_000, 5);
    const result = await controller.open(fixture, canvasSurface().canvas);

    expect(result.status).toBe('render-error');
    expect(result.message).toContain('too long');
    pendingPage.resolve(latePage);
    await Promise.resolve();
    expect(latePage.cleanup).toHaveBeenCalledTimes(1);
    await controller.destroy();
  }, 1_000);

  it('cancels rendering and destroys the worker-backed document when the component unmounts', async() => {
    // risk: resource lifecycle — closing a chat card must release its render task and worker.
    const started = deferred<void>();
    const pending = deferred<void>();
    const renderTask:InlinePdfRenderTask = {
      promise:pending.promise,
      cancel:vi.fn(() => pending.reject(new Error('render cancelled'))),
    };
    const page:InlinePdfPage = {
      getViewport:({ scale }) => ({ width:612 * scale, height:792 * scale }),
      render:vi.fn(() => { started.resolve(); return renderTask; }),
      cleanup:vi.fn(),
    };
    const document = documentWith(1, new Map([[1, page]]));
    const loader = loaderFor(document);
    const context = { fillStyle:'', fillRect:vi.fn() } as unknown as CanvasRenderingContext2D;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    vi.mocked(document.getPage).mockImplementation(async() => page);
    const wrapper = mount(InlinePdfPreview, { props:{ bytes:fixture, documentLoader:loader } });
    await started.promise;

    wrapper.unmount();

    expect(renderTask.cancel).toHaveBeenCalledTimes(1);
    expect(document.destroy).toHaveBeenCalledTimes(1);
    getContext.mockRestore();
  });

  it('pages the real PDF card from focused-card arrow keys and button actions', async() => {
    // risk: usability — keyboard and button paging must reach the same bounded renderer.
    const context = { fillStyle:'', fillRect:vi.fn() } as unknown as CanvasRenderingContext2D;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    const pdfDocument = documentWith(2);
    const wrapper = mount(InlineFileCard, {
      attachTo:document.body,
      props:{
        pdfDocumentLoader:loaderFor(pdfDocument),
        file:{
          fileId:'fixture-pdf', name:'inline-pdf-fixture.pdf', path:'fixtures/inline-pdf-fixture.pdf',
          status:'ready', canOpenInTab:true, preview:{ kind:'pdf', bytes:fixture },
        },
      },
    });
    const preview = wrapper.findComponent(InlinePdfPreview);
    const latestState = () => preview.emitted('state-change')?.at(-1)?.[0];
    await vi.waitFor(() => expect(latestState()).toMatchObject({ status:'ready', pageNumber:1, pageCount:2 }));

    const card = wrapper.get('article');
    (card.element as HTMLElement).focus();
    expect(document.activeElement).toBe(card.element);
    for (const modifier of [{ altKey:true }, { metaKey:true }, { ctrlKey:true }]) {
      await card.trigger('keydown', { key:'ArrowRight', ...modifier });
      expect(latestState()).toMatchObject({ pageNumber:1, pageCount:2 });
      expect(document.activeElement).toBe(card.element);
    }

    await card.trigger('keydown', { key:'ArrowLeft' });
    expect(document.activeElement).toBe(wrapper.get('[title="Next page"]').element);
    expect(latestState()).toMatchObject({ pageNumber:1, pageCount:2 });

    (card.element as HTMLElement).focus();
    expect(document.activeElement).toBe(card.element);
    await card.trigger('keydown', { key:'ArrowRight' });
    await vi.waitFor(() => expect(latestState()).toMatchObject({ status:'ready', pageNumber:2, pageCount:2 }));

    await card.trigger('keydown', { key:'ArrowRight' });
    expect(document.activeElement).toBe(wrapper.get('[title="Previous page"]').element);
    expect(latestState()).toMatchObject({ pageNumber:2, pageCount:2 });

    await wrapper.get('[title="Previous page"]').trigger('click');
    await vi.waitFor(() => expect(latestState()).toMatchObject({ status:'ready', pageNumber:1, pageCount:2 }));
    await vi.waitFor(() => expect(document.activeElement).toBe(wrapper.get('[title="Next page"]').element));

    await wrapper.get('[title="Next page"]').trigger('click');
    await vi.waitFor(() => expect(latestState()).toMatchObject({ status:'ready', pageNumber:2, pageCount:2 }));
    await vi.waitFor(() => expect(document.activeElement).toBe(wrapper.get('[title="Previous page"]').element));
    expect(pdfDocument.getPage).toHaveBeenCalledTimes(4);
    wrapper.unmount();
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
    getContext.mockRestore();
  });
});
