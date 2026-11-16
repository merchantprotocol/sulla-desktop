// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface FilesPathCollection {
  id: string;
  name: string;
  explorer_path?: string | null;
  is_default?: boolean;
}

export interface FilesPathCandidate {
  collectionId: string;
  path: string;
}

/** Resolve both collection-rooted paths and the mounted Files tree's paths. */
export class FilesPathResolver {
  candidates(collections:FilesPathCollection[], relativePath:string):FilesPathCandidate[] {
    const parts = relativePath.split('/');
    const root = parts[0];
    const inner = parts.slice(1).join('/');
    const candidates:FilesPathCandidate[] = [];
    for (const collection of collections) {
      if (collection.name === root || collection.explorer_path === root) {
        candidates.push({ collectionId: collection.id, path: inner });
      }
    }
    for (const collection of [...collections].sort((left, right) => Number(right.is_default === true) - Number(left.is_default === true))) {
      if (!candidates.some(candidate => candidate.collectionId === collection.id && candidate.path === relativePath)) {
        candidates.push({ collectionId: collection.id, path: relativePath });
      }
    }
    return candidates;
  }
}
