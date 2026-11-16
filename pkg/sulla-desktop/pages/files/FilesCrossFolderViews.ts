// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FolderAggregate, FolderAggregation } from './fileAggregation';
import type { FilesDataSource, FilesFolderSummary, FilesItem } from './types';

export type CrossFolderSection = 'recent' | 'starred' | 'agent';

/**
 * The File Manager only holds the open folder's rows, so every view that spans folders reads its own bounded
 * server source: Recent and Agent files from the newest-first server list, Starred from the star ids.
 */
export class FilesSectionSource {
  static readonly recentLimit = 50;
  static readonly agentLimit = 200;

  constructor(private readonly source:Pick<FilesDataSource, 'recentFiles' | 'filesByIds'>) {}

  /** True when this data source can serve `section` without the whole-collection file list. */
  supports(section:string):section is CrossFolderSection {
    if (section === 'recent' || section === 'agent') return typeof this.source.recentFiles === 'function';
    if (section === 'starred') return typeof this.source.filesByIds === 'function';
    return false;
  }

  async load(section:CrossFolderSection, starredKeys:Iterable<string>):Promise<FilesItem[]> {
    if (section === 'recent') return this.source.recentFiles!({ limit: FilesSectionSource.recentLimit });
    if (section === 'agent') return this.source.recentFiles!({ limit: FilesSectionSource.agentLimit, createdByType: 'agent-run' });
    const ids = [...starredKeys].filter(key => !key.startsWith('folder:'));
    return ids.length ? this.source.filesByIds!(ids) : [];
  }
}

/** Server-computed recursive totals per child folder, keyed by the parent folder they were loaded for. */
export class FolderSummaryIndex {
  private readonly byParent = new Map<string, Map<string, FilesFolderSummary>>();

  constructor(readonly serverBacked:boolean) {}

  set(parent:string, summaries:FilesFolderSummary[]):FolderSummaryIndex {
    const next = new FolderSummaryIndex(this.serverBacked);
    for (const [key, value] of this.byParent) next.byParent.set(key, value);
    next.byParent.set(parent, new Map(summaries.map(summary => [summary.name, summary])));
    return next;
  }

  loaded(parent:string):boolean { return this.byParent.has(parent) }

  /**
   * Overlay the server totals on the folder aggregates built from loaded rows: counts and sizes come from the
   * server, folders that only exist implicitly (files but no folder record) are added, and when the server
   * figure is not loaded yet the count is reported unknown (-1) rather than a false 0.
   */
  apply(aggregation:FolderAggregation, prefix:string):FolderAggregation {
    if (!this.serverBacked) return aggregation;
    const parent = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const summaries = this.byParent.get(parent);
    const folders = new Map<string, FolderAggregate>();
    for (const [name, aggregate] of aggregation.folders) folders.set(name, FolderSummaryIndex.overlay(aggregate, summaries?.get(name), Boolean(summaries)));
    for (const [name, summary] of summaries ?? []) {
      if (!folders.has(name)) folders.set(name, FolderSummaryIndex.overlay({ name, path: `${ prefix }${ name }`, count: 0, size: 0, newestTimestamp: Date.parse('0'), allAgent: false, hasConflict: false, hasSyncing: false, allOnlineOnly: false }, summary, true));
    }
    return { ...aggregation, folders };
  }

  private static overlay(aggregate:FolderAggregate, summary:FilesFolderSummary|undefined, loaded:boolean):FolderAggregate {
    // Loaded but absent means the folder holds no active files; not loaded yet means unknown, never a false 0.
    if (!summary) return loaded ? { ...aggregate, count: 0, size: 0 } : { ...aggregate, count: -1 };
    const timestamp = summary.updatedAt ? Date.parse(summary.updatedAt) : aggregate.newestTimestamp;
    // Per-file flags (agent-made, online-only) are only known from loaded rows; never infer them from a bare total.
    const sampled = aggregate.count > 0;
    return { ...aggregate, count: summary.fileCount, size: summary.totalBytes, newestTimestamp: timestamp, allAgent: sampled && aggregate.allAgent, allOnlineOnly: sampled && aggregate.allOnlineOnly, newest: aggregate.newest ?? (summary.updatedAt ? { updatedAt: summary.updatedAt } as FilesItem : undefined) };
  }
}
