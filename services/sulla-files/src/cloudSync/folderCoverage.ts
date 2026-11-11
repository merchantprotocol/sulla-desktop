// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Counts only; never names or paths, so the preview is safe to log. */
export interface FolderCoverageCounts {
  collections:number;
  liveFolders:number;
  foldersMissingFromCloud:number;
  childrenOfUncommittedParents:number;
}

export interface CloudFolderCoverageStore {
  enabledCollectionIds():Promise<string[]>;
  counts(collectionIds:string[]):Promise<Omit<FolderCoverageCounts, 'collections'>>;
  /** Journals every live folder Cloud has never received, parents first. Returns rows added. */
  journalMissingFolders(collectionId:string):Promise<number>;
}

/**
 * Owner-visible, read-only preview of Cloud folder coverage plus the additive backfill.
 * The preview logs counts only (no names or paths). The backfill only queues folders
 * that were never uploaded; it never rewrites local ids, paths or version history.
 */
export class CloudFolderCoverage {
  constructor(
    private readonly store:CloudFolderCoverageStore,
    private readonly log:(line:string) => void,
  ) {}

  async preview(collectionIds?:string[]):Promise<FolderCoverageCounts> {
    const ids = collectionIds ?? await this.store.enabledCollectionIds();
    const counts = { collections: ids.length, ...await this.store.counts(ids) };
    this.log(`[SullaFiles] cloud folder coverage preview: collections=${ counts.collections } liveFolders=${ counts.liveFolders } `
      + `foldersMissingFromCloud=${ counts.foldersMissingFromCloud } childrenOfUncommittedParents=${ counts.childrenOfUncommittedParents }`);
    return counts;
  }

  async backfill(collectionIds?:string[]):Promise<number> {
    const ids = collectionIds ?? await this.store.enabledCollectionIds();
    let journaled = 0;
    for (const id of ids) journaled += await this.store.journalMissingFolders(id);
    if (journaled) this.log(`[SullaFiles] cloud folder backfill queued ${ journaled } folder(s) Cloud never received`);
    return journaled;
  }

  /** Startup: report what is missing, then queue only what was never uploaded. */
  async previewAndBackfill(collectionIds?:string[]):Promise<{ preview:FolderCoverageCounts; journaled:number }> {
    const ids = collectionIds ?? await this.store.enabledCollectionIds();
    const preview = await this.preview(ids);
    const journaled = preview.foldersMissingFromCloud ? await this.backfill(ids) : 0;
    return { preview, journaled };
  }
}
