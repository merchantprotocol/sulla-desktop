// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { hostname } from 'os';

import { ipcMain } from 'electron';

import { filesContainerRequest } from '@pkg/agent/files/containerClient';
import { SHELF_FOLDER, type ShelfEntry, type ShelfMeta, ShelfNotes } from '@pkg/pages/chat/messages/shelfNote';

/** One Files request: service-relative path in, parsed JSON (or undefined for 204) out. */
export type ShelfFilesRequest = (path: string, init?: RequestInit) => Promise<any>;

const CONTEXT = { agent_id: 'sulla-shelf', device_id: hostname() } as any;

export function defaultShelfRequest(): ShelfFilesRequest {
  return async(path, init = {}) => {
    const response = await filesContainerRequest(path, CONTEXT, init);
    return response.status === 204 ? undefined : response.json();
  };
}

/** Shelved-thread notes in Sulla Files under Projects/Shelf. */
export class ThreadShelfStore {
  constructor(private readonly request: ShelfFilesRequest) {}

  private async collectionId(): Promise<string> {
    const collections = await this.request('/v1/collections') as any[];
    const home = collections.find(c => !c.systemArea && !c.system_area && (c.is_default || c.explorer_path === ''));
    if (!home) throw new Error('The Sulla Files home collection is unavailable');
    return home.id;
  }

  private async read(fileId: string): Promise<{ text: string; versionId: string; path: string }> {
    const result = await this.request(`/v1/agent-files/${ encodeURIComponent(fileId) }`);
    return { text: Buffer.from(String(result.content_base64 ?? ''), 'base64').toString('utf8'), versionId: result.version?.id, path: result.file?.path };
  }

  async list(): Promise<ShelfEntry[]> {
    const collectionId = await this.collectionId();
    const files = await this.request(`/v1/files?collectionId=${ encodeURIComponent(collectionId) }&path=${ encodeURIComponent(SHELF_FOLDER) }`) as any[];
    const notes = files.filter(file => typeof file.path === 'string' && file.path.startsWith(`${ SHELF_FOLDER }/`) && file.path.endsWith('.md') && !file.path.slice(SHELF_FOLDER.length + 1).includes('/'));
    const entries = await Promise.all(notes.map(async(file): Promise<ShelfEntry | null> => {
      try {
        const parsed = ShelfNotes.parseNote((await this.read(file.id)).text);
        if (!parsed) return null;
        const slug = file.path.slice(SHELF_FOLDER.length + 1, -3);
        return { fileId: file.id, slug, path: file.path, meta: parsed.meta, goal: ShelfNotes.goalLine(parsed.body) };
      } catch { return null }
    }));
    return entries.filter((entry): entry is ShelfEntry => entry !== null);
  }

  /** Writes a new note; never overwrites an existing one (the slug gets a -2, -3 ... suffix). */
  async save(meta: ShelfMeta, body: string): Promise<{ fileId: string; slug: string; path: string }> {
    const collectionId = await this.collectionId();
    const existing = await this.request(`/v1/files?collectionId=${ encodeURIComponent(collectionId) }&path=${ encodeURIComponent(SHELF_FOLDER) }`) as any[];
    const taken = existing.map(file => String(file.path ?? '')).filter(path => path.endsWith('.md')).map(path => path.slice(SHELF_FOLDER.length + 1, -3));
    const slug = ShelfNotes.uniqueSlug(meta.name, taken);
    const path = `${ SHELF_FOLDER }/${ slug }.md`;
    const written = await this.request('/v1/agent-files', {
      method: 'POST',
      body:   JSON.stringify({ collectionId, path, content: ShelfNotes.buildNote(meta, body), mime: 'text/markdown', message: `Shelve ${ meta.name }` }),
    });
    return { fileId: written.fileId, slug, path };
  }

  async markResumed(fileId: string, resumedThreadId: string): Promise<void> {
    const collectionId = await this.collectionId();
    const { text, versionId, path } = await this.read(fileId);
    await this.request('/v1/agent-files', {
      method: 'POST',
      body:   JSON.stringify({ collectionId, path, fileId, expectedVersionId: versionId, content: ShelfNotes.markResumed(text, resumedThreadId, new Date()), mime: 'text/markdown', message: 'Resume shelved thread' }),
    });
  }

  /** Moves the note to the Files trash (restorable until the trash is emptied). */
  async trash(fileId: string): Promise<void> {
    await this.request(`/v1/files/${ encodeURIComponent(fileId) }`, { method: 'DELETE' });
  }
}

export function initThreadShelfIpc(store = new ThreadShelfStore(defaultShelfRequest())): void {
  const wrap = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async(_event: unknown, ...args: A) => {
    try { return { ok: true, value: await fn(...args) } } catch (error) {
      console.warn('[ThreadShelf]', error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  ipcMain.handle('thread-shelf:list', wrap(() => store.list()));
  ipcMain.handle('thread-shelf:save', wrap((meta: ShelfMeta, body: string) => store.save(meta, body)));
  ipcMain.handle('thread-shelf:mark-resumed', wrap((fileId: string, resumedThreadId: string) => store.markResumed(fileId, resumedThreadId)));
  ipcMain.handle('thread-shelf:trash', wrap((fileId: string) => store.trash(fileId)));
  // History keeps one row per tab that showed the chat (keyed by tab id, with the chat thread id),
  // plus one keyed by the backend thread id. Act on all of them.
  const historyRows = async(chatThreadId: string, backendThreadId?: string) => {
    const { ConversationHistoryModel } = await import('@pkg/agent/database/models/ConversationHistoryModel');
    const rows = await ConversationHistoryModel.listByThread(chatThreadId);
    const backend = backendThreadId ? await ConversationHistoryModel.getById(backendThreadId) : null;
    const ids = [...new Set([...rows.map(row => row.id), ...(backend ? [backend.id] : [])])];
    return { model: ConversationHistoryModel, ids };
  };
  ipcMain.handle('thread-shelf:archive-conversation', wrap(async(chatThreadId: string, backendThreadId?: string) => {
    const { model, ids } = await historyRows(chatThreadId, backendThreadId);
    for (const id of ids) await model.archiveConversation(id);
    return ids.length;
  }));
  ipcMain.handle('thread-shelf:delete-conversation', wrap(async(chatThreadId: string, backendThreadId?: string) => {
    const { model, ids } = await historyRows(chatThreadId, backendThreadId);
    for (const id of ids) await model.deleteConversation(id);
    return ids.length;
  }));
}
