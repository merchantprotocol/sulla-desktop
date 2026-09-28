/* eslint-disable @typescript-eslint/require-await -- async mocks stand in for Postgres/fetch */
import { jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { BrowserBookmarkModel, normalizeBookmarkUrl } from '../BrowserBookmarkModel';

describe('BrowserBookmarkModel', () => {
  const originalQuery = postgresClient.query;
  const originalQueryOne = postgresClient.queryOne;

  afterEach(() => {
    postgresClient.query = originalQuery;
    postgresClient.queryOne = originalQueryOne;
  });

  describe('normalizeBookmarkUrl', () => {
    it('accepts web and file URLs', () => {
      expect(normalizeBookmarkUrl(' https://example.com ')).toBe('https://example.com/');
      expect(normalizeBookmarkUrl('file:///Users/me/notes.html')).toBe('file:///Users/me/notes.html');
    });

    it('rejects executable and malformed URLs', () => {
      expect(() => normalizeBookmarkUrl('javascript:alert(1)')).toThrow(/not allowed/);
      expect(() => normalizeBookmarkUrl('data:text/html,<script>')).toThrow(/not allowed/);
      expect(() => normalizeBookmarkUrl('not a url')).toThrow(/invalid/);
      expect(() => normalizeBookmarkUrl(undefined)).toThrow(/required/);
    });
  });

  it('creates a bookmark at the end of its sibling list with a hostname fallback title', async() => {
    postgresClient.query = jest.fn(async(_sql: string, params: any[]) => [{ id: params[0], title: params[3] }]) as any;

    await BrowserBookmarkModel.create({ kind: 'bookmark', url: 'https://www.example.com/a', title: '   ' });

    const [sql, params] = (postgresClient.query as any).mock.calls[0];
    expect(sql).toContain('COALESCE(MAX(position), 0) + 1');
    expect(sql).toContain('parent_id IS NOT DISTINCT FROM $2');
    expect(params[0]).toMatch(/^bm_/);
    expect(params.slice(1)).toEqual([null, 'bookmark', 'www.example.com', 'https://www.example.com/a', null]);
  });

  it('drops favicons that are not bounded image data URLs', async() => {
    postgresClient.query = jest.fn(async() => [{}]) as any;

    await BrowserBookmarkModel.create({ kind: 'bookmark', url: 'https://a.test', favicon: 'https://a.test/favicon.ico' });
    await BrowserBookmarkModel.create({ kind: 'bookmark', url: 'https://a.test', favicon: 'data:image/png;base64,AAAA' });

    const calls = (postgresClient.query as any).mock.calls;
    expect(calls[0][1][5]).toBeNull();
    expect(calls[1][1][5]).toBe('data:image/png;base64,AAAA');
  });

  it('refuses to nest under a bookmark instead of a folder', async() => {
    postgresClient.queryOne = jest.fn(async() => ({ id: 'bm_1', kind: 'bookmark' })) as any;
    postgresClient.query = jest.fn(async() => []) as any;

    await expect(BrowserBookmarkModel.create({ kind: 'bookmark', url: 'https://a.test', parentId: 'bm_1' })).rejects.toThrow(/Parent folder/);
    expect(postgresClient.query).not.toHaveBeenCalled();
  });

  it('refuses to move a folder into its own descendant', async() => {
    postgresClient.queryOne = jest.fn(async(sql: string) => {
      if (sql.includes('WITH RECURSIVE')) return { hit: true };

      return { id: 'x', kind: 'folder', parent_id: null };
    }) as any;
    postgresClient.query = jest.fn(async() => []) as any;

    await expect(BrowserBookmarkModel.move('folder_a', 'folder_child', 0)).rejects.toThrow(/into itself/);
    expect(postgresClient.query).not.toHaveBeenCalled();
  });

  it('renumbers the destination siblings with the moved row at the requested index', async() => {
    postgresClient.queryOne = jest.fn(async(sql: string) => (sql.includes('WITH RECURSIVE') ? null : { id: 'x', kind: 'folder', parent_id: null })) as any;
    postgresClient.query = jest.fn(async(sql: string) => (sql.startsWith('SELECT id FROM') ? [{ id: 'a' }, { id: 'b' }, { id: 'c' }] : [])) as any;

    await BrowserBookmarkModel.move('m', 'folder_1', 1);

    const calls = (postgresClient.query as any).mock.calls;
    expect(calls[0][1]).toEqual(['folder_1', 'm']);
    const [updateSql, updateParams] = calls[1];
    expect(updateSql).toContain('WITH ORDINALITY');
    expect(updateParams).toEqual(['folder_1', 'm', ['a', 'm', 'b', 'c']]);
  });

  it('clamps an out-of-range move index to the end', async() => {
    postgresClient.queryOne = jest.fn(async() => ({ id: 'm', kind: 'bookmark', parent_id: null })) as any;
    postgresClient.query = jest.fn(async(sql: string) => (sql.startsWith('SELECT id FROM') ? [{ id: 'a' }] : [])) as any;

    await BrowserBookmarkModel.move('m', null, 99);

    expect((postgresClient.query as any).mock.calls[1][1]).toEqual([null, 'm', ['a', 'm']]);
  });
});
