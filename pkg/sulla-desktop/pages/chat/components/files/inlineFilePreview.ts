/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */

import DOMPurify from 'dompurify';

export type InlineFileStatus = 'ready' | 'loading' | 'error' | 'access-denied';

export interface InlineArchiveEntryPreview {
  name: string;
  sizeLabel?: string;
}

export type InlineFilePreview =
  | { kind: 'html'; source: string }
  | { kind: 'image'; bytes: Uint8Array; mimeType: string; altText?: string }
  | { kind: 'archive'; entries: readonly InlineArchiveEntryPreview[]; totalEntries: number }
  | { kind: 'custom' };

export interface InlineFilePreviewCap {
  label: string;
  canOpenInTab?: boolean;
}

/**
 * Parent-supplied, already-authorized data for the inline card.
 *
 * The preview shell deliberately owns no Files lookup, transport, persistence,
 * or authorization logic. The chat parent supplies bytes and metadata only
 * after its existing permission checks succeed.
 */
export interface InlineFileCardViewModel {
  fileId: string;
  name: string;
  path: string;
  sizeLabel?: string;
  mimeType?: string;
  status?: InlineFileStatus;
  message?: string;
  cap?: InlineFilePreviewCap;
  preview?: InlineFilePreview;
  canOpenInTab?: boolean;
}

export interface InlineFileActionReference {
  fileId: string;
  name: string;
  path: string;
}

const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "img-src data:",
  "media-src data:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "navigate-to 'none'",
].join('; ');

export const MAX_INLINE_HTML_SOURCE_CHARACTERS = 256 * 1024;

const SAFE_CSS_SOURCE = /(?:@import\b|url\s*\(|image-set\s*\(|expression\s*\(|-moz-binding\s*:)/i;

/**
 * Builds a passive document for an empty-sandbox srcdoc iframe.
 *
 * DOMPurify removes executable markup and URL-bearing attributes outside the
 * narrow local-fragment/data-raster allowlist. A restrictive CSP remains in
 * place as a second boundary for CSS, navigation and resource loads.
 */
export class InlineHtmlPreviewPolicy {
  constructor(private readonly purifier: Pick<typeof DOMPurify, 'sanitize'> = DOMPurify) {}

  toSrcdoc(source: string): string {
    const boundedSource = source.slice(0, MAX_INLINE_HTML_SOURCE_CHARACTERS);
    const cleanMarkup = this.purifier.sanitize(boundedSource, {
      USE_PROFILES:       { html: true },
      ADD_TAGS:           ['style'],
      FORBID_TAGS:        ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'base', 'meta', 'link', 'portal', 'fencedframe'],
      FORBID_ATTR:        ['srcdoc', 'srcset', 'ping', 'target', 'action', 'formaction', 'formtarget'],
      ALLOWED_URI_REGEXP: /^(?:#|data:image\/(?:png|jpeg|gif|webp|avif);base64,)/i,
    });
    const passiveMarkup = this.stripCssResourceReferences(cleanMarkup);
    const csp = '<meta http-equiv="Content-Security-Policy" content="' + HTML_PREVIEW_CSP + '">';

    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + csp + '</head><body>' + passiveMarkup + '</body></html>';
  }

  private stripCssResourceReferences(markup: string): string {
    return markup
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, block => SAFE_CSS_SOURCE.test(block) ? '' : block)
      .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, attribute => SAFE_CSS_SOURCE.test(attribute) ? '' : attribute);
  }
}

export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

const SAFE_INLINE_IMAGE_MIME_TYPES: readonly string[] = Object.freeze([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export interface ObjectUrlFactory {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export type BlobFactory = (parts: BlobPart[], options?: BlobPropertyBag) => Blob;

/**
 * Owns one ephemeral local image URL and releases it whenever replaced or
 * unmounted. It accepts only small raster bytes authorized by the parent;
 * SVG and remote URLs never enter this path.
 */
export class InlineImagePreviewSource {
  private currentUrl = '';

  constructor(
    private readonly objectUrls: ObjectUrlFactory = URL,
    private readonly blobFactory: BlobFactory = (parts, options) => new Blob(parts, options),
  ) {}

  replace(bytes: Uint8Array, mimeType: string): string {
    this.release();

    const normalizedMimeType = mimeType.trim().toLowerCase();
    if (!SAFE_INLINE_IMAGE_MIME_TYPES.includes(normalizedMimeType)) {
      throw new Error('This image type cannot be previewed safely.');
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
      throw new Error('This image is outside the inline preview size limit.');
    }

    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = this.blobFactory([copy.buffer as ArrayBuffer], { type: normalizedMimeType });
    this.currentUrl = this.objectUrls.createObjectURL(blob);
    return this.currentUrl;
  }

  release(): void {
    if (!this.currentUrl) return;
    this.objectUrls.revokeObjectURL(this.currentUrl);
    this.currentUrl = '';
  }
}
