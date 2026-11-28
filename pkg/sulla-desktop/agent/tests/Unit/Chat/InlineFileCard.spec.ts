// @vitest-environment jsdom
/*
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import InlineFileCard from '../../../../pages/chat/components/files/InlineFileCard.vue';
import InlineFileCardFixture from './fixtures/InlineFileCardFixture.vue';
import { INLINE_HTML_PREVIEW_PARTITION } from '@pkg/shared/inlineHtmlPreview';
import {
  MAX_INLINE_HTML_SOURCE_CHARACTERS,
  InlineHtmlPreviewDocument,
  InlineImagePreviewSource,
  MAX_INLINE_IMAGE_BYTES,
  type InlineFileActionReference,
  type InlineFileCardViewModel,
  type ObjectUrlFactory,
} from '../../../../pages/chat/components/files/inlineFilePreview';

const htmlFile: InlineFileCardViewModel = {
  fileId: 'fixture-html-file',
  name: 'sample-preview.html',
  path: 'Projects/synthetic/sample-preview.html',
  sizeLabel: '1 KB',
  status: 'ready',
  preview: {
    kind: 'html',
    assetBaseUrl: 'sulla-files-preview://fixture-token/Projects/synthetic/sample-preview.html',
    source: '<!doctype html><html><head><title>Scripted preview</title><style>@font-face{font-family:PreviewFace;src:url("./fonts/preview.woff2")} .hero{background-image:url("../images/hero.png")}</style></head><body><h1 class="hero" style="color: rebeccapurple">Scripted content</h1><img src="../images/hero.png" alt="Preview hero"><script>document.documentElement.dataset.previewRan = "yes";</script></body></html>',
  },
};
const htmlSource = htmlFile.preview?.kind === 'html' ? htmlFile.preview.source : '';
const htmlBaseUrl = htmlFile.preview?.kind === 'html' ? htmlFile.preview.assetBaseUrl : '';

const actionReference: InlineFileActionReference = {
  fileId: htmlFile.fileId,
  name: htmlFile.name,
  path: htmlFile.path,
};

class TestIntersectionObserver {
  static current: TestIntersectionObserver | undefined;
  private target?: Element;

  constructor(private readonly callback: IntersectionObserverCallback) { TestIntersectionObserver.current = this; }
  observe(target: Element): void { this.target = target; }
  intersect(): void {
    if (!this.target) throw new Error('Preview root was not observed.');
    this.callback([{ isIntersecting: true, target: this.target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  disconnect(): void {}
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

const originalGlobalObserver = globalThis.IntersectionObserver;
const originalWindowObserver = window.IntersectionObserver;

function assignObserver(target: object, observer: unknown): void {
  if (observer === undefined) Reflect.deleteProperty(target, 'IntersectionObserver');
  else Object.defineProperty(target, 'IntersectionObserver', { configurable: true, writable: true, value: observer });
}

beforeEach(() => {
  TestIntersectionObserver.current = undefined;
  assignObserver(globalThis, TestIntersectionObserver);
  assignObserver(window, TestIntersectionObserver);
});
afterEach(() => {
  assignObserver(globalThis, originalGlobalObserver);
  assignObserver(window, originalWindowObserver);
});

describe('InlineFileCard', () => {
  it('renders HTML in the isolated guest partition with its Files base after the doctype', async() => {
    // risk: data integrity and renderer isolation — scripts stay intact in a separate guest process, without giving HTML a chat-renderer iframe.
    const wrapper = mount(InlineFileCard, { props: { file: htmlFile } });
    TestIntersectionObserver.current?.intersect();
    await nextTick();
    const guest = wrapper.get('webview');

    expect(wrapper.findAll('iframe')).toHaveLength(0);
    expect(wrapper.findAll('webview')).toHaveLength(1);
    expect(guest.attributes('partition')).toBe(INLINE_HTML_PREVIEW_PARTITION);
    expect(guest.attributes('webpreferences')).toBe('nodeIntegration=no,contextIsolation=yes,sandbox=yes,webSecurity=yes,disableDialogs=yes,nodeIntegrationInSubFrames=no,nodeIntegrationInWorker=no');
    expect(guest.attributes('allowpopups')).toBeUndefined();
    const previewUrl = guest.attributes('src') ?? '';
    expect(previewUrl.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    const document = decodeURIComponent(previewUrl.slice('data:text/html;charset=utf-8,'.length));
    const baseTag = `<base href="${htmlBaseUrl}">`;

    expect(document).toContain(baseTag);
    expect(document.replace(baseTag, '')).toBe(htmlSource);
    expect(document.startsWith('<!doctype html>')).toBe(true);
    expect(document).toContain('<script>document.documentElement.dataset.previewRan = "yes";</script>');
    expect(document).toContain('<style>@font-face{font-family:PreviewFace;src:url("./fonts/preview.woff2")} .hero{background-image:url("../images/hero.png")}</style>');
    expect(document).toContain('<img src="../images/hero.png" alt="Preview hero">');
    expect(document).toContain('style="color: rebeccapurple"');

    wrapper.unmount();
  });

  it('does not move the doctype when a page has no head element', async() => {
    const source = '<!doctype html><html lang="en"><body><script>window.ran = true;</script></body></html>';
    const file: InlineFileCardViewModel = {
      ...htmlFile,
      preview: { kind: 'html', source, assetBaseUrl: htmlBaseUrl },
    };
    const wrapper = mount(InlineFileCard, { props: { file } });
    TestIntersectionObserver.current?.intersect();
    await nextTick();
    const encoded = wrapper.get('webview').attributes('src') ?? '';
    const document = decodeURIComponent(encoded.slice('data:text/html;charset=utf-8,'.length));

    expect(document.startsWith('<!doctype html><html lang="en"><base')).toBe(true);
    expect(document).toContain('<script>window.ran = true;</script>');
    wrapper.unmount();
  });

  it('uses the same isolated guest when Full screen opens and restores focus after the native dialog closes', async() => {
    // risk: renderer isolation — expanding a preview must not weaken iframe policy or strand keyboard focus.
    const wrapper = mount(InlineFileCard, { props: { file: htmlFile }, attachTo: document.body });
    TestIntersectionObserver.current?.intersect();
    await nextTick();
    const fullScreenButton = wrapper.get('[title="Full screen"]');
    expect(document.body.contains(fullScreenButton.element)).toBe(true);
    await fullScreenButton.trigger('click');
    await nextTick();

    const dialog = wrapper.get('dialog');
    expect((dialog.element as HTMLDialogElement).open).toBe(true);
    expect(wrapper.findAll('iframe')).toHaveLength(0);
    expect(wrapper.findAll('webview')).toHaveLength(2);
    for (const guest of wrapper.findAll('webview')) {
      expect(guest.attributes('partition')).toBe(INLINE_HTML_PREVIEW_PARTITION);
      expect(guest.attributes('webpreferences')).toContain('sandbox=yes');
      const previewUrl = guest.attributes('src') ?? '';
      const document = decodeURIComponent(previewUrl.slice('data:text/html;charset=utf-8,'.length));
      expect(document.replace(`<base href="${htmlBaseUrl}">`, '')).toBe(htmlSource);
    }

    const nativeDialog = dialog.element as HTMLDialogElement;
    const closeEvent = new Promise<void>(resolve => {
      nativeDialog.addEventListener('close', () => resolve(), { once: true });
    });
    if (typeof nativeDialog.close === 'function') {
      nativeDialog.close();
    } else {
      // jsdom does not implement HTMLDialogElement.close(); model its closed state and event.
      nativeDialog.removeAttribute('open');
      nativeDialog.dispatchEvent(new Event('close'));
    }
    await closeEvent;
    await nextTick();

    expect(document.activeElement).toBe(fullScreenButton.element);

    // Native Escape/cancel follows the same focus-return path as the close
    // event, rather than restoring focus while the modal is still active.
    await fullScreenButton.trigger('click');
    nativeDialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    await nextTick();
    expect(document.activeElement).toBe(fullScreenButton.element);

    wrapper.unmount();
  });

  it('limits oversized HTML to the preview cap and exposes the full-file action', async() => {
    // risk: resource limits — a large authorized HTML file must not be sanitized or rendered unbounded in the chat renderer.
    const oversizedFile: InlineFileCardViewModel = {
      ...htmlFile,
      preview: { kind: 'html', source: 'x'.repeat(MAX_INLINE_HTML_SOURCE_CHARACTERS) + 'tail-marker' },
    };
    const wrapper = mount(InlineFileCard, { props: { file: oversizedFile } });
    TestIntersectionObserver.current?.intersect();
    await nextTick();
    const previewUrl = wrapper.get('webview').attributes('src') ?? '';
    const document = decodeURIComponent(previewUrl.slice('data:text/html;charset=utf-8,'.length));

    expect(wrapper.find('.file-cap').exists()).toBe(true);
    expect(wrapper.get('.file-cap button').exists()).toBe(true);
    expect(document.length).toBe(MAX_INLINE_HTML_SOURCE_CHARACTERS);
    expect(document).not.toContain('tail-marker');
    wrapper.unmount();
  });

  // risk: content integrity — a source cap must not leave an unmatched high surrogate at the end of the HTML document.
  it('backs the HTML source cap off a split UTF-16 surrogate pair', () => {
    const source = 'x'.repeat(MAX_INLINE_HTML_SOURCE_CHARACTERS - 1) + '\uD83D\uDE00';
    const html = new InlineHtmlPreviewDocument().toHtml(source);

    expect(html).toBe('x'.repeat(MAX_INLINE_HTML_SOURCE_CHARACTERS - 1));
    expect(html.charCodeAt(html.length - 1)).not.toBeGreaterThanOrEqual(0xD800);
  });

  // risk: chat availability — expensive preview guests start only near the viewport and a dead/unresponsive guest can be recovered without restarting chat.
  it.each([
    ['render-process-gone', 'stopped unexpectedly'],
    ['unresponsive', 'not responding'],
  ])('mounts on intersection and offers Reload after %s', async(eventName, errorText) => {
    const wrapper = mount(InlineFileCard, { props: { file: htmlFile } });
    expect(wrapper.find('webview').exists()).toBe(false);

    TestIntersectionObserver.current?.intersect();
    await nextTick();
    expect(wrapper.find('webview').exists()).toBe(true);

    const firstGuest = wrapper.get('webview').element;
    await wrapper.get('webview').trigger(eventName);
    expect(wrapper.get('[role="alert"]').text()).toContain(errorText);
    expect(wrapper.find('webview').exists()).toBe(false);
    expect(wrapper.get('.preview-error button').exists()).toBe(true);
    await wrapper.get('.preview-error button').trigger('click');

    expect(wrapper.get('webview').element).not.toBe(firstGuest);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('emits a bounded file reference when the user opens the file in a tab', async() => {
    // risk: authorization boundary — UI actions pass the file identity only; they do not fetch or persist bytes.
    const wrapper = mount(InlineFileCardFixture, { props: { file: htmlFile } });
    await wrapper.get('.file-actions [title="Open in tab"]').trigger('click');

    expect(wrapper.findComponent(InlineFileCard).emitted('open-in-tab')?.[0]?.[0]).toEqual(actionReference);
    wrapper.unmount();
  });

  it('does not render preview bytes or actions for an access-denied model', () => {
    // risk: permissions — denied file content must stay out of the renderer even when a stale preview is present.
    const deniedFile: InlineFileCardViewModel = {
      ...htmlFile,
      status: 'access-denied',
      message: 'Permission unavailable',
    };
    const wrapper = mount(InlineFileCard, { props: { file: deniedFile } });

    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(wrapper.find('.file-actions').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Benign fixture');
    wrapper.unmount();
  });

  it('keeps archive previews compact and emits Files/Download actions without archive extraction', async() => {
    // risk: resource limits — the archive shell receives only a bounded metadata list, never expanded file contents.
    const archiveFile: InlineFileCardViewModel = {
      fileId: 'fixture-archive-file',
      name: 'handoff.zip',
      path: 'Projects/synthetic/handoff.zip',
      sizeLabel: '2 MB',
      preview: {
        kind: 'archive',
        totalEntries: 11,
        entries: [
          { name: 'readme.md' },
          { name: 'plan.md' },
          { name: 'screens/one.png' },
          { name: 'screens/two.png' },
          { name: 'source/index.ts' },
          { name: 'source/theme.css' },
        ],
      },
    };
    const wrapper = mount(InlineFileCardFixture, { props: { file: archiveFile } });
    const card = wrapper.findComponent(InlineFileCard);
    const expectedReference = {
      fileId: archiveFile.fileId,
      name: archiveFile.name,
      path: archiveFile.path,
    };

    expect(wrapper.findAll('.archive-preview li')).toHaveLength(4);
    await wrapper.get('[aria-label="Show handoff.zip in Files"]').trigger('click');
    await wrapper.get('[aria-label="Download handoff.zip"]').trigger('click');
    expect(card.emitted('show-in-files')?.[0]?.[0]).toEqual(expectedReference);
    expect(card.emitted('download')?.[0]?.[0]).toEqual(expectedReference);
    wrapper.unmount();
  });
});

describe('InlineImagePreviewSource', () => {
  it('creates only ephemeral raster-image URLs and revokes the previous URL on replacement/release', () => {
    // risk: data exfiltration — image content is parent-authorized bytes, never a remote URL or persistent capability.
    const createdTypes: string[] = [];
    const revoked: string[] = [];
    let nextUrl = 0;
    const objectUrls: ObjectUrlFactory = {
      createObjectURL(blob) {
        createdTypes.push(blob.type);
        nextUrl += 1;
        return 'blob:synthetic-preview-' + nextUrl;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    };
    const source = new InlineImagePreviewSource(objectUrls);
    const firstUrl = source.replace(new Uint8Array([1, 2, 3]), 'image/png');
    const secondUrl = source.replace(new Uint8Array([4, 5]), 'image/jpeg');

    expect(firstUrl).toBe('blob:synthetic-preview-1');
    expect(secondUrl).toBe('blob:synthetic-preview-2');
    expect(createdTypes).toEqual(['image/png', 'image/jpeg']);
    expect(revoked).toEqual([firstUrl]);
    expect(() => source.replace(new Uint8Array([6]), 'image/svg+xml')).toThrow();
    expect(() => source.replace(new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1), 'image/png')).toThrow();
    source.release();
    expect(revoked).toEqual([firstUrl, secondUrl]);
  });
});
