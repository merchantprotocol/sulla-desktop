// SPDX-License-Identifier: GPL-2.0-or-later
import type { CitationMessage } from '../models/Message';

type Source = CitationMessage['sources'][number];
export interface SupportingReportFile { fileId: string; path: string; collectionId: string; }
interface FilesIpc { invoke(channel: string, input?: unknown): Promise<any>; }

/** Resolves a cited Files path to one exact saved document, never a host path or guessed link. */
export class SupportingReportResolver {
  constructor(private readonly ipc: FilesIpc) {}

  webUrl(source: Source): string | undefined { return SupportingReportResolver.webUrl(source); }

  /** A cited http(s) page, or undefined for a Files report. Pure, so trace projections can share it. */
  static webUrl(source: Source): string | undefined {
    try {
      const url = new URL(source.url || source.origin);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
    } catch { return undefined }
  }

  async file(source: Source): Promise<SupportingReportFile> {
    const path = source.origin.replaceAll('\\', '/');
    if (!path || path.startsWith('/') || /^[a-z]+:/i.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('This reference has no saved Files document to open.');
    }
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const collections = await this.ipc.invoke('sulla-files:collections') as { id: string }[];
    if (!Array.isArray(collections)) throw new Error('Files could not load this report. Please retry.');
    const matches: SupportingReportFile[] = [];
    for (const collection of collections) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const listing = await this.ipc.invoke('sulla-files:list-page', { collectionId: collection.id, path: folder, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(listing.files)) throw new Error('Files could not load this report. Please retry.');
        for (const file of listing.files) {
          if (file.path === path && !file.deleted_at) matches.push({ fileId: file.id, path, collectionId: collection.id });
        }
        if (!listing.hasMore) break;
        if (!listing.nextCursor || cursors.has(listing.nextCursor) || page === 99) throw new Error('Files could not finish checking this report. Please retry.');
        cursors.add(listing.nextCursor); cursor = listing.nextCursor;
      }
    }
    if (!matches.length) throw new Error('This report is not available in Files. Ask Sulla to save it again.');
    if (matches.length !== 1) throw new Error('More than one saved file matches this reference. Choose the report in Files.');
    return matches[0];
  }

  async verify(file: SupportingReportFile): Promise<void> {
    const current = await this.ipc.invoke('sulla-files:metadata', { fileId: file.fileId });
    if (current.id !== file.fileId || current.path !== file.path || current.deleted_at) throw new Error('This report moved or is no longer available. Refresh Files before opening it.');
  }
}
