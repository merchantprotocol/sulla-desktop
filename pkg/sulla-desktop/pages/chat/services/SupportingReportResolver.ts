// SPDX-License-Identifier: GPL-2.0-or-later
import { DURABLE_FILE_ID_PATTERN } from '@pkg/shared/filesReferences';

import type { CitationMessage } from '../models/Message';

type Source = CitationMessage['sources'][number];
export interface SupportingReportFile { fileId: string; path: string; collectionId: string; }
interface FilesIpc { invoke(channel: string, input?: unknown): Promise<any>; }
const AMBIGUOUS = 'More than one saved file matches this reference. Choose the report in Files.';

/** Resolves a cited Files link, path, or folder + file name to one exact saved document, never a host path or guessed link. */
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
    const linked = await this.linkedFile(source.url);
    if (linked) return linked;
    const origin = SupportingReportResolver.safePath(source.origin);
    if (!origin) throw new Error('This reference has no saved Files document to open.');
    const title = String(source.title ?? '');
    const candidate = SupportingReportResolver.isPlainName(title) ? SupportingReportResolver.safePath(`${ origin }/${ title }`) : undefined;
    // With a plain file name, the exact origin and origin + title are equal candidates: one distinct file in total, or refuse.
    const exact = await this.matches(origin);
    // A path that is a file in one collection and a folder in any collection is ambiguous, whatever the title says.
    if (exact.length && await this.isFolder(origin)) throw new Error(AMBIGUOUS);
    const found = [...exact, ...(candidate ? await this.matches(candidate) : [])];
    return SupportingReportResolver.one([...new Map(found.map(file => [`${ file.collectionId }\u0000${ file.fileId }`, file])).values()]);
  }

  /** A `sulla-file://<id>` link resolves to that file only when Files still has it; otherwise the path rules apply. */
  private async linkedFile(url: string | undefined): Promise<SupportingReportFile | undefined> {
    const match = /^sulla-file:\/\/([^?#/]*)(?:\?[^#]*)?$/.exec(String(url ?? '').trim());
    if (!match || !DURABLE_FILE_ID_PATTERN.test(match[1])) return undefined;
    let record: any;
    try {
      record = await this.ipc.invoke('sulla-files:metadata', { fileId: match[1] });
    } catch (error) {
      // Only a confirmed missing file falls back; a timeout must not let the path rules open a different file.
      if (/file not found/i.test(error instanceof Error ? error.message : String(error))) return undefined;
      throw new Error('Files could not load this report. Please retry.');
    }
    if (record?.id !== match[1] || record.deleted_at || typeof record.collection_id !== 'string' || !record.collection_id) return undefined;
    const path = SupportingReportResolver.safePath(record.path);
    return path && path === record.path ? { fileId: record.id, path, collectionId: record.collection_id } : undefined;
  }

  private async matches(path: string): Promise<SupportingReportFile[]> {
    const matches: SupportingReportFile[] = [];
    await this.eachChild(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', (file, collectionId) => {
      if (file.path === path) matches.push({ fileId: file.id, path, collectionId });
      return false;
    });
    return matches;
  }

  /** True when any collection holds a non-deleted direct child under `path`. */
  private async isFolder(path: string): Promise<boolean> {
    let found = false;
    await this.eachChild(path, file => (found = String(file.path ?? '').startsWith(`${ path }/`)));
    return found;
  }

  /** Visits each non-deleted direct child of `folder` in every collection; stops early when `visit` returns true. */
  private async eachChild(folder: string, visit: (file: any, collectionId: string) => boolean): Promise<void> {
    const collections = await this.ipc.invoke('sulla-files:collections') as { id: string }[];
    if (!Array.isArray(collections)) throw new Error('Files could not load this report. Please retry.');
    for (const collection of collections) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const listing = await this.ipc.invoke('sulla-files:list-page', { collectionId: collection.id, path: folder, children: true, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(listing.files)) throw new Error('Files could not load this report. Please retry.');
        for (const file of listing.files) {
          if (!file.deleted_at && visit(file, collection.id)) return;
        }
        if (!listing.hasMore) break;
        if (!listing.nextCursor || cursors.has(listing.nextCursor) || page === 99) throw new Error('Files could not finish checking this report. Please retry.');
        cursors.add(listing.nextCursor); cursor = listing.nextCursor;
      }
    }
  }

  private static one(matches: SupportingReportFile[]): SupportingReportFile {
    if (!matches.length) throw new Error('This report is not available in Files. Ask Sulla to save it again.');
    if (matches.length !== 1) throw new Error(AMBIGUOUS);
    return matches[0];
  }

  /** A relative Files path with no empty, `.` or `..` segment and no scheme; anything else is refused. */
  private static safePath(value: unknown): string | undefined {
    const path = String(value ?? '').replaceAll('\\', '/');
    if (!path || path.startsWith('/') || /^[a-z]+:/i.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
    return path;
  }

  private static isPlainName(title: string): boolean {
    return Boolean(title) && title !== '.' && title !== '..' && !/[\\/]/.test(title) && !/^[a-z]+:/i.test(title);
  }

  async verify(file: SupportingReportFile): Promise<void> {
    const current = await this.ipc.invoke('sulla-files:metadata', { fileId: file.fileId });
    if (current.id !== file.fileId || current.path !== file.path || current.deleted_at) throw new Error('This report moved or is no longer available. Refresh Files before opening it.');
  }
}
