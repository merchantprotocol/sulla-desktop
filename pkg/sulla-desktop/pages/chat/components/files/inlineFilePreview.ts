/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */

export type InlineFileStatus = 'ready' | 'loading' | 'error' | 'access-denied';

export interface InlineArchiveEntryPreview {
  name: string;
  sizeLabel?: string;
}

export type InlineFilePreview =
  | { kind: 'html'; source: string; assetBaseUrl?: string }
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

export const MAX_INLINE_HTML_SOURCE_CHARACTERS = 256 * 1024;

/** Keeps an HTML page intact for an isolated Electron guest and gives relative
 * resources the same Files preview URL base as the HTML editor. */
export class InlineHtmlPreviewDocument {
  constructor(private readonly maxCharacters = MAX_INLINE_HTML_SOURCE_CHARACTERS) {}

  toHtml(source: string, assetBaseUrl?: string): string {
    const documentSource = source.slice(0, this.maxCharacters);
    if (!assetBaseUrl) return documentSource;

    // Match the Files HTML builder: insert its capability URL after an existing
    // head start. If no head exists, keep the doctype and html start tag in
    // front so adding the base element cannot switch a standards document to
    // quirks mode.
    const baseTag = '<base href="' + this.escapeAttribute(assetBaseUrl) + '">';
    const head = /<head(?:\s[^>]*)?>/i.exec(documentSource);
    if (head) {
      return documentSource.slice(0, head.index + head[0].length) + baseTag + documentSource.slice(head.index + head[0].length);
    }

    const doctype = /<!doctype\b[^>]*>/i.exec(documentSource);
    const html = /<html(?:\s[^>]*)?>/i.exec(documentSource);
    const insertionIndex = Math.max(
      doctype ? doctype.index + doctype[0].length : 0,
      html ? html.index + html[0].length : 0,
    );
    return documentSource.slice(0, insertionIndex) + baseTag + documentSource.slice(insertionIndex);
  }

  toDataUrl(source: string, assetBaseUrl?: string): string {
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(this.toHtml(source, assetBaseUrl));
  }

  private escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
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
