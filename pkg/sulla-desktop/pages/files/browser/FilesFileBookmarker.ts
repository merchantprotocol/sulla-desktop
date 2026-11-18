// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaFileBookmarkLink } from '../../../shared/sullaFileBookmark';

export interface FilesBookmarkCreator {
  create(input: { kind: 'bookmark'; title: string; url: string }): Promise<unknown>;
}

export interface FilesBookmarkableFile {
  id:   string;
  path: string;
  name: string;
}

/** Saves a Files document to the Bookmarks root as `sulla-file://<id>?path=&name=` (no version: it always opens the latest). */
export class FilesFileBookmarker {
  constructor(private readonly bookmarks: FilesBookmarkCreator) {}

  async addFile(file: FilesBookmarkableFile): Promise<void> {
    const name = String(file.name || SullaFileBookmarkLink.nameOf(file.path));
    await this.bookmarks.create({
      kind:  'bookmark',
      title: name,
      url:   SullaFileBookmarkLink.build({ id: file.id, path: file.path, name }),
    });
  }
}
