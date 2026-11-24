// @vitest-environment jsdom
/*
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import InlineFileCard from '../../../../pages/chat/components/files/InlineFileCard.vue';
import InlineFileCardFixture from './fixtures/InlineFileCardFixture.vue';
import {
  MAX_INLINE_HTML_SOURCE_CHARACTERS,
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
    source: '<!doctype html><html><head><title>Static preview</title><meta http-equiv="refresh" content="1; url=https://example.invalid/"></head><body><h1>Benign fixture</h1><p>Static content only.</p><a href="https://example.invalid/preview">External example link</a></body></html>',
  },
};

const actionReference: InlineFileActionReference = {
  fileId: htmlFile.fileId,
  name: htmlFile.name,
  path: htmlFile.path,
};

describe('InlineFileCard', () => {
  it('keeps the static HTML preview inside empty-sandbox srcdoc frames with a deny-by-default CSP', () => {
    // risk: renderer isolation — preview content must never gain app, script, or same-origin capabilities.
    const wrapper = mount(InlineFileCard, { props: { file: htmlFile } });
    const frames = wrapper.findAll('iframe');

    expect(frames).toHaveLength(1);
    for (const frame of frames) {
      expect(frame.attributes('sandbox')).toBe('');
      expect(frame.attributes('allow')).toBeUndefined();
      expect(frame.attributes('src')).toBeUndefined();
      const document = frame.attributes('srcdoc') ?? '';
      expect(document).toContain("default-src 'none'");
      expect(document).toContain("script-src 'none'");
      expect(document).toContain("form-action 'none'");
      expect(document).not.toMatch(/<script\b|<form\b|<iframe\b|<object\b|<meta[^>]+refresh/i);
      expect(document).not.toContain('https://example.invalid');
      expect(document).toContain('Benign fixture');
    }

    wrapper.unmount();
  });

  it('uses the same sandboxed frame when Full screen opens and restores focus after the native dialog closes', async() => {
    // risk: renderer isolation — expanding a preview must not weaken iframe policy or strand keyboard focus.
    const wrapper = mount(InlineFileCard, { props: { file: htmlFile }, attachTo: document.body });
    const fullScreenButton = wrapper.get('[title="Full screen"]');
    expect(document.body.contains(fullScreenButton.element)).toBe(true);
    await fullScreenButton.trigger('click');
    await nextTick();

    const dialog = wrapper.get('dialog');
    expect((dialog.element as HTMLDialogElement).open).toBe(true);
    expect(wrapper.findAll('iframe')).toHaveLength(2);
    for (const frame of wrapper.findAll('iframe')) {
      expect(frame.attributes('sandbox')).toBe('');
      expect(frame.attributes('srcdoc')).toContain("default-src 'none'");
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

  it('limits oversized HTML to the preview cap and exposes the full-file action', () => {
    // risk: resource limits — a large authorized HTML file must not be sanitized or rendered unbounded in the chat renderer.
    const oversizedFile: InlineFileCardViewModel = {
      ...htmlFile,
      preview: { kind: 'html', source: 'x'.repeat(MAX_INLINE_HTML_SOURCE_CHARACTERS) + 'tail-marker' },
    };
    const wrapper = mount(InlineFileCard, { props: { file: oversizedFile } });
    const srcdoc = wrapper.get('iframe').attributes('srcdoc') ?? '';

    expect(wrapper.find('.file-cap').exists()).toBe(true);
    expect(wrapper.get('.file-cap button').exists()).toBe(true);
    expect(srcdoc.length).toBeLessThan(MAX_INLINE_HTML_SOURCE_CHARACTERS + 1024);
    expect(srcdoc).not.toContain('tail-marker');
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
