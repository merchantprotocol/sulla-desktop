// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// sullaFileBookmark.ts — `sulla-file://<fileId>?path=&name=` bookmarks that point at a Sulla Files document.
// Pure: no Electron, no database, so the main process, the agent runtime and the renderer share one rule.

import { DURABLE_FILE_ID_PATTERN } from './filesReferences';

export interface SullaFileBookmarkTarget {
  fileId: string;
  path:   string;
  name:   string;
}

export interface SullaFileBookmarkInput {
  id:    string;
  path:  string;
  name?: string;
}

const SULLA_FILE_URL = /^sulla-file:\/\/([^?#]*)(?:\?([^#]*))?$/;

export class SullaFileBookmarkLink {
  static readonly SCHEME = 'sulla-file:';

  static isSullaFileUrl(url: string | null | undefined): boolean {
    return typeof url === 'string' && url.startsWith(`${ SullaFileBookmarkLink.SCHEME }//`);
  }

  /** Builds the bookmark form. It never pins a version: the bookmark always opens the latest one. */
  static build(input: SullaFileBookmarkInput): string {
    const path = String(input.path ?? '').trim();
    if (!DURABLE_FILE_ID_PATTERN.test(input.id) || !path) throw new Error('File bookmark needs a valid file id and path');
    const name = String(input.name ?? '').trim() || SullaFileBookmarkLink.nameOf(path);

    return `${ SullaFileBookmarkLink.SCHEME }//${ input.id }?${ new URLSearchParams({ path, name }) }`;
  }

  /** Strict parse. Returns null unless the id matches the Files id pattern and a path is present. */
  static parse(url: string): SullaFileBookmarkTarget | null {
    const match = SULLA_FILE_URL.exec(String(url ?? '').trim());
    if (!match) return null;

    const fileId = match[1];
    if (!DURABLE_FILE_ID_PATTERN.test(fileId)) return null;

    const params = new URLSearchParams(match[2] ?? '');
    const path = (params.get('path') ?? '').trim();
    if (!path) return null;

    const name = (params.get('name') ?? '').trim() || SullaFileBookmarkLink.nameOf(path);

    return { fileId, path, name };
  }

  static isValid(url: string): boolean {
    return SullaFileBookmarkLink.parse(url) !== null;
  }

  static nameOf(path: string): string {
    return path.split('/').filter(Boolean).at(-1) ?? path;
  }
}
