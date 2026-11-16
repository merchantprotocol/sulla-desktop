// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// A folder's metadata listing (/v1/fuse/folder-metadata) matches its children by LIKE prefix. Without escaping,
// `_` and `%` in the folder name are wildcards, so "a_b" also listed "aXb"'s files and "50%" listed "500"'s.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LikePattern } from '../src/LikePattern.js';
import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe('LikePattern', () => {
  it('escapes %, _ and the escape character so a literal matches only itself', () => {
    // risk: data leak — an unescaped wildcard widens a folder prefix to its siblings.
    expect(LikePattern.prefix('a_b/')).toBe('a\\_b/%');
    expect(LikePattern.prefix('50%/')).toBe('50\\%/%');
    expect(LikePattern.prefix('c:\\x/')).toBe('c:\\\\x/%');
    expect(LikePattern.contains('a_b')).toBe('%a\\_b%');
    expect(LikePattern.prefix('plain/')).toBe('plain/%');
  });
});

describe.skipIf(!databaseUrl)('folder metadata listing with LIKE wildcards in folder names (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();

  const tag = async(path:string, owner:string) => {
    await fixture.createFile(path);
    const put = await fixture.request('/v1/fuse/metadata', 'PUT', { body: { collectionId: fixture.collectionId, path, set: { owner } } });
    if (put.status !== 200) throw new Error(`metadata ${ path }: ${ put.status } ${ JSON.stringify(put.body) }`);
  };
  const listing = (folder:string) => fixture.request(`/v1/fuse/folder-metadata?collectionId=${ fixture.collectionId }&path=${ encodeURIComponent(folder) }`);

  beforeAll(async() => {
    await fixture.start();
    await tag('a_b/mine.txt', 'a_b');
    await tag('aXb/secret.txt', 'aXb');
    await tag('50%/mine.txt', '50%');
    await tag('500/secret.txt', '500');
  }, 30_000);
  afterAll(() => fixture.stop());

  it('lists only the "a_b" folder\'s own files, never sibling "aXb"\'s', async() => {
    // risk: data leak — `_` matched any one character, exposing a sibling folder's file metadata.
    const listed = await listing('a_b');
    expect(listed.status).toBe(200);
    expect(listed.body.files).toEqual({ 'mine.txt': { owner: 'a_b' } });
    expect((await listing('aXb')).body.files).toEqual({ 'secret.txt': { owner: 'aXb' } });
  });

  it('lists only the "50%" folder\'s own files, never sibling "500"\'s', async() => {
    // risk: data leak — `%` matched any run of characters, exposing a sibling folder's file metadata.
    const listed = await listing('50%');
    expect(listed.status).toBe(200);
    expect(listed.body.files).toEqual({ 'mine.txt': { owner: '50%' } });
    expect((await listing('500')).body.files).toEqual({ 'secret.txt': { owner: '500' } });
  });
});
