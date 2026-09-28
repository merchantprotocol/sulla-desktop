// BrowserBookmarkModel.ts
// Browser bookmarks and folders, persisted in PostgreSQL (migration 0099).
// Rows form a tree through parent_id; `position` orders siblings.

import { randomBytes } from 'node:crypto';

import { postgresClient } from '../PostgresClient';

export type BookmarkKind = 'bookmark' | 'folder';

export interface BookmarkRecord {
  id:         string;
  parent_id:  string | null;
  kind:       BookmarkKind;
  title:      string;
  url:        string | null;
  favicon:    string | null;
  position:   number;
  created_at: string;
  updated_at: string;
}

export interface CreateBookmarkInput {
  kind:      BookmarkKind;
  title?:    string;
  url?:      string;
  favicon?:  string | null;
  parentId?: string | null;
}

export interface UpdateBookmarkInput {
  title?:   string;
  url?:     string;
  favicon?: string | null;
}

const MAX_TITLE = 500;
const MAX_URL = 4096;
// Favicons are stored inline as data: URLs — cap them so a hostile page
// can't bloat the table.
export const MAX_FAVICON_BYTES = 64 * 1024;

/**
 * Only navigable web/file URLs may be bookmarked. Rejects javascript:, data:
 * and anything else that could execute when the bookmark is opened.
 */
export function normalizeBookmarkUrl(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Bookmark URL is required');
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_URL) throw new Error('Bookmark URL is invalid');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Bookmark URL is invalid');
  }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    throw new Error(`Bookmark URL scheme ${ parsed.protocol } is not allowed`);
  }

  return parsed.toString();
}

function cleanTitle(input: unknown, fallback: string): string {
  const title = typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';

  return (title || fallback).slice(0, MAX_TITLE);
}

function cleanFavicon(input: unknown): string | null {
  if (typeof input !== 'string' || !input) return null;
  if (!/^data:image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp|svg\+xml);base64,/i.test(input)) return null;

  return input.length > MAX_FAVICON_BYTES * 1.4 ? null : input;
}

function newId(): string {
  return `bm_${ Date.now().toString(36) }_${ randomBytes(4).toString('hex') }`;
}

export class BrowserBookmarkModel {
  static async list(): Promise<BookmarkRecord[]> {
    return postgresClient.query<BookmarkRecord>(
      `SELECT id, parent_id, kind, title, url, favicon, position, created_at, updated_at
         FROM browser_bookmarks
        ORDER BY parent_id NULLS FIRST, position, created_at`,
    );
  }

  static async get(id: string): Promise<BookmarkRecord | null> {
    return postgresClient.queryOne<BookmarkRecord>('SELECT * FROM browser_bookmarks WHERE id = $1', [id]);
  }

  static async findByUrl(url: string): Promise<BookmarkRecord[]> {
    return postgresClient.query<BookmarkRecord>(
      `SELECT * FROM browser_bookmarks WHERE kind = 'bookmark' AND url = $1 ORDER BY created_at`,
      [normalizeBookmarkUrl(url)],
    );
  }

  static async create(input: CreateBookmarkInput): Promise<BookmarkRecord> {
    const kind: BookmarkKind = input.kind === 'folder' ? 'folder' : 'bookmark';
    const url = kind === 'bookmark' ? normalizeBookmarkUrl(input.url) : null;
    const title = cleanTitle(input.title, kind === 'folder' ? 'New folder' : (url ? new URL(url).hostname || url : ''));
    const parentId = input.parentId || null;

    if (parentId) await this.assertFolder(parentId);

    const rows = await postgresClient.query<BookmarkRecord>(
      `INSERT INTO browser_bookmarks (id, parent_id, kind, title, url, favicon, position)
       VALUES ($1, $2, $3, $4, $5, $6,
               (SELECT COALESCE(MAX(position), 0) + 1 FROM browser_bookmarks WHERE parent_id IS NOT DISTINCT FROM $2))
       RETURNING *`,
      [newId(), parentId, kind, title, url, kind === 'bookmark' ? cleanFavicon(input.favicon) : null],
    );

    return rows[0];
  }

  static async update(id: string, input: UpdateBookmarkInput): Promise<BookmarkRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const title = input.title === undefined ? existing.title : cleanTitle(input.title, existing.title);
    const url = existing.kind === 'bookmark' && input.url !== undefined ? normalizeBookmarkUrl(input.url) : existing.url;
    const favicon = input.favicon === undefined ? existing.favicon : cleanFavicon(input.favicon);

    return postgresClient.queryOne<BookmarkRecord>(
      `UPDATE browser_bookmarks SET title = $2, url = $3, favicon = $4, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, title, url, favicon],
    );
  }

  /** Deletes a bookmark, or a folder together with everything inside it. */
  static async remove(id: string): Promise<boolean> {
    const rows = await postgresClient.query<{ id: string }>('DELETE FROM browser_bookmarks WHERE id = $1 RETURNING id', [id]);

    return rows.length > 0;
  }

  /**
   * Move `id` into `parentId` (null = top level) at sibling `index`, then
   * renumber that sibling list so positions stay dense.
   */
  static async move(id: string, parentId: string | null, index: number): Promise<void> {
    const item = await this.get(id);
    if (!item) throw new Error('Bookmark not found');
    const target = parentId || null;

    if (target) {
      await this.assertFolder(target);
      // A folder may not be dropped into itself or one of its descendants.
      const cycle = await postgresClient.queryOne<{ hit: boolean }>(
        `WITH RECURSIVE ancestors AS (
           SELECT id, parent_id FROM browser_bookmarks WHERE id = $1
           UNION ALL
           SELECT b.id, b.parent_id FROM browser_bookmarks b JOIN ancestors a ON b.id = a.parent_id
         )
         SELECT TRUE AS hit FROM ancestors WHERE id = $2 LIMIT 1`,
        [target, id],
      );
      if (cycle?.hit) throw new Error('Cannot move a folder into itself');
    }

    const siblings = (await postgresClient.query<{ id: string }>(
      `SELECT id FROM browser_bookmarks
        WHERE parent_id IS NOT DISTINCT FROM $1 AND id <> $2
        ORDER BY position, created_at`,
      [target, id],
    )).map(r => r.id);
    const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.floor(index) : siblings.length, siblings.length));
    siblings.splice(at, 0, id);

    await postgresClient.query(
      `UPDATE browser_bookmarks b
          SET parent_id = $1,
              position = v.pos,
              updated_at = CASE WHEN b.id = $2 THEN NOW() ELSE b.updated_at END
         FROM unnest($3::text[]) WITH ORDINALITY AS v(id, pos)
        WHERE b.id = v.id`,
      [target, id, siblings],
    );
  }

  private static async assertFolder(id: string): Promise<void> {
    const parent = await this.get(id);
    if (parent?.kind !== 'folder') throw new Error('Parent folder not found');
  }
}
