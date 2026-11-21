// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'node:path';

import { FilesListingPager } from '../agent/files/FilesListingPager';

import type { ChatFilesSourceGuard, PreparedChatFilesSource } from './ChatFilesSourceGuard';
import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue } from 'electron';

export interface ChatFilesReference {
  fileId:          string;
  versionId:       string;
  path:            string;
  name:            string;
  mime:            string;
  size:            number;
  updatedAt:       string;
  createdByType?:  string;
  createdById?:    string;
  collectionId?:   string;
  collectionKind?: string;
  agentRunId?:     string;
}

export interface PartialChatFilesImport {
  references: ChatFilesReference[];
  error:      string;
}

/** A non-success response from the streamed Files import endpoint. */
export class ChatFilesImportHttpError extends Error {
  constructor(message:string, readonly status:number) { super(message) }
}

/** The slice of SullaFilesClient the importer talks to. */
export interface ChatFilesClientPort {
  request(endpoint:string, init?:RequestInit):Promise<Response>;
  json<T>(endpoint:string, init?:RequestInit):Promise<T>;
  stream(endpoint:string, init?:RequestInit, signal?:AbortSignal):Promise<Response>;
}

/** The slice of Electron's dialog module used to pick host files. */
export interface ChatFilesDialogPort {
  showOpenDialog(options:OpenDialogOptions):Promise<OpenDialogReturnValue>;
  showOpenDialog(owner:BrowserWindow, options:OpenDialogOptions):Promise<OpenDialogReturnValue>;
}

interface FilesCollection {
  id:                   string;
  name?:                string;
  kind?:                string;
  compatibility_state?: string;
}

interface FilesRecord {
  id?:                 unknown;
  current_version_id?: unknown;
  path?:               unknown;
  mime?:               unknown;
  size?:               unknown;
  updated_at?:         unknown;
  created_by_type?:    unknown;
  created_by_id?:      unknown;
}

const MIME_BY_EXTENSION:Readonly<Record<string, string>> = Object.freeze({
  '.avif':  'image/avif',
  '.csv':   'text/csv',
  '.gif':   'image/gif',
  '.html':  'text/html',
  '.jpeg':  'image/jpeg',
  '.jpg':   'image/jpeg',
  '.json':  'application/json',
  '.md':    'text/markdown',
  '.sulla': 'text/markdown',
  '.mov':   'video/quicktime',
  '.mp3':   'audio/mpeg',
  '.mp4':   'video/mp4',
  '.pdf':   'application/pdf',
  '.png':   'image/png',
  '.svg':   'image/svg+xml',
  '.txt':   'text/plain',
  '.wav':   'audio/wav',
  '.webm':  'video/webm',
  '.webp':  'image/webp',
  '.yaml':  'application/yaml',
  '.yml':   'application/yaml',
  '.zip':   'application/zip',
});

/**
 * Imports host files chosen in chat into the authenticated Files collection and
 * returns durable version references. Every source is validated before the first
 * upload; a failure after some uploads reports the committed ones as partial.
 */
export class ChatFilesImporter {
  static readonly maxFiles = 100;
  static readonly uploadTimeoutMs = 30 * 60_000;

  constructor(
    private readonly client:ChatFilesClientPort,
    private readonly sources:ChatFilesSourceGuard,
    private readonly dialog:ChatFilesDialogPort,
  ) {}

  static mimeFor(name:string):string {
    return MIME_BY_EXTENSION[path.extname(name).toLocaleLowerCase()] ?? 'application/octet-stream';
  }

  async import(filePaths:string[], destination = ''):Promise<ChatFilesReference[] | PartialChatFilesImport> {
    if (!Array.isArray(filePaths) || filePaths.some(source => typeof source !== 'string' || !source)) throw new Error('Files import requires selected file paths.');
    if (!filePaths.length) return [];
    if (filePaths.length > ChatFilesImporter.maxFiles) throw new Error('Choose 100 files or fewer at a time.');

    // Validate every source before committing the first item. This
    // keeps protected, changed, oversized, or non-file selections out of Files
    // and never modifies the source files.
    const prepared:PreparedChatFilesSource[] = [];
    try {
      for (const source of filePaths) prepared.push(await this.sources.prepare(source));

      const collection = await this.collection();
      const normalizedDestination = destination.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
      if (normalizedDestination.split('/').some(part => part === '.' || part === '..')) throw new Error('The Files destination is invalid.');
      const destinationReserved = await this.reservedNames(collection, normalizedDestination);
      const references:ChatFilesReference[] = [];
      for (const source of prepared) {
        try {
          const outcome = await this.uploadOne(source, collection, normalizedDestination, destinationReserved);
          references.push(outcome.reference);
          if (outcome.sourceChanged) {
            return { references, error: 'The source changed during import. The committed Files version is attached; review it before sending.' };
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Files import failed.';
          if (references.length) return { references, error: `${ message } The files already listed were imported and are ready to attach.` };
          throw error;
        }
      }
      return references;
    } finally {
      await Promise.all(prepared.map(source => source.handle.close().catch(() => undefined)));
    }
  }

  async pickAndImport(owner?:BrowserWindow):Promise<ChatFilesReference[] | PartialChatFilesImport> {
    const options = { title: 'Upload to Sulla Files', properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] };
    const picked = owner ? await this.dialog.showOpenDialog(owner, options) : await this.dialog.showOpenDialog(options);
    if (picked.canceled) return [];
    return this.import(picked.filePaths);
  }

  private async collection():Promise<FilesCollection> {
    const collections = await this.client.json<FilesCollection[]>('/v1/collections');
    const collection = collections.find(item => item.name === 'Files' && item.compatibility_state !== 'legacy') ??
      collections.find(item => item.kind === 'knowledge' && item.compatibility_state !== 'legacy');
    if (!collection?.id) throw new Error('The authenticated Files collection is unavailable.');
    return collection;
  }

  /**
   * Only names directly inside the destination are kept (active and trash), read page by page
   * under the destination prefix, so memory follows that folder, not the whole collection.
   */
  private async reservedNames(collection:FilesCollection, normalizedDestination:string):Promise<Set<string>> {
    const destinationPrefix = normalizedDestination ? `${ normalizedDestination }/` : '';
    const reserved = new Set<string>();
    for (const trash of ['false', 'true']) {
      for await (const page of FilesListingPager.pages<FilesRecord>(url => this.client.request(url), '/v1/files', { collectionId: collection.id, path: normalizedDestination, trash })) {
        for (const file of page) {
          if (typeof file.path !== 'string' || (destinationPrefix && !file.path.startsWith(destinationPrefix))) continue;
          const relative = destinationPrefix ? file.path.slice(destinationPrefix.length) : file.path;
          if (!relative.includes('/')) reserved.add(relative);
        }
      }
    }
    return reserved;
  }

  private async uploadOne(source:PreparedChatFilesSource, collection:FilesCollection, normalizedDestination:string, reserved:Set<string>):Promise<{ reference: ChatFilesReference; sourceChanged: boolean }> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const targetPath = [normalizedDestination, this.availablePath(source.name, reserved)].filter(Boolean).join('/');
      const mime = ChatFilesImporter.mimeFor(targetPath);
      const { response, sourceChanged } = await this.upload(source, `/v1/files/import?collectionId=${ encodeURIComponent(collection.id) }&path=${ encodeURIComponent(targetPath) }`, mime);
      if (response.status === 409) {
        await response.arrayBuffer();
        if (sourceChanged) throw new Error('The source changed while Files was importing it. Try again.');
        continue;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new ChatFilesImportHttpError(body?.error || `Files import failed (${ response.status })`, response.status);
      }
      const file = await response.json() as FilesRecord;
      return { reference: this.durableReference(file, collection, targetPath, source.size), sourceChanged };
    }
    throw new Error('Files could not reserve a unique destination name.');
  }

  private async upload(source:PreparedChatFilesSource, endpoint:string, mime:string):Promise<{ response: Response; sourceChanged: boolean }> {
    if (!this.sources.matches(source, await source.handle.stat())) throw new Error('The source changed while Files was importing it. Try again.');
    // requestFilesStream can retry once after unlocking. A fresh positional stream per
    // iterator makes the same body safe to send again without buffering the file.
    const body = {
      async * [Symbol.asyncIterator]() {
        const stream = source.handle.createReadStream({ autoClose: false, start: 0, end: source.size ? source.size - 1 : undefined });
        for await (const chunk of stream) yield chunk;
      },
    } as unknown as BodyInit;
    const init = {
      method:  'PUT',
      // Chromium's fetch rejects a caller-set content-length (net::ERR_INVALID_ARGUMENT)
      // and sends streamed bodies chunked, so the size travels in its own header.
      headers: { 'content-type': mime, 'x-sulla-expected-bytes': String(source.size) },
      body,
      duplex:  'half',
    } as RequestInit & { duplex: 'half' };
    // Large native imports need a transfer deadline, not the metadata request timeout.
    const response = await this.client.stream(endpoint, init, AbortSignal.timeout(ChatFilesImporter.uploadTimeoutMs));
    const sourceChanged = !this.sources.matches(source, await source.handle.stat());
    return { response, sourceChanged };
  }

  private availablePath(name:string, reserved:Set<string>):string {
    const safeName = path.basename(name).replaceAll('/', '_').replaceAll('\\', '_');
    if (!safeName || safeName === '.' || safeName === '..') throw new Error('The selected file has an invalid name.');
    const extension = path.extname(safeName);
    const stem = extension ? safeName.slice(0, -extension.length) : safeName;
    for (let index = 0; ; index++) {
      const candidate = index ? `${ stem } (${ index })${ extension }` : safeName;
      if (!reserved.has(candidate)) { reserved.add(candidate); return candidate }
    }
  }

  private durableReference(file:FilesRecord, collection:FilesCollection, expectedPath:string, expectedBytes:number):ChatFilesReference {
    const fileId = typeof file.id === 'string' ? file.id : '';
    const versionId = typeof file.current_version_id === 'string' ? file.current_version_id : '';
    const committedPath = typeof file.path === 'string' ? file.path : '';
    const size = Number(file.size);
    if (!fileId || !versionId || committedPath !== expectedPath || size !== expectedBytes) throw new Error('Files did not confirm the imported file version.');
    return {
      fileId,
      versionId,
      path:           committedPath,
      name:           path.basename(committedPath),
      mime:           typeof file.mime === 'string' && file.mime ? file.mime : ChatFilesImporter.mimeFor(committedPath),
      size,
      updatedAt:      typeof file.updated_at === 'string' ? file.updated_at : new Date().toISOString(),
      createdByType:  typeof file.created_by_type === 'string' ? file.created_by_type : undefined,
      createdById:    typeof file.created_by_id === 'string' ? file.created_by_id : undefined,
      collectionId:   collection.id,
      collectionKind: collection.kind,
    };
  }
}
