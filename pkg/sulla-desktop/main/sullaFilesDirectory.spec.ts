import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SullaFilesDirectoryService } from './sullaFilesDirectory.ts';

test('directory service creates a nested folder beneath the Files root', async () => {
  // risk: file access control — an allowed relative path must create the intended directory.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-files-directory-'));
  try {
    await fs.mkdir(path.join(temporary, 'root'));
    await new SullaFilesDirectoryService().createDirectoryWithinRoot(path.join(temporary, 'root'), 'folder');
    assert.equal((await fs.stat(path.join(temporary, 'root', 'folder'))).isDirectory(), true);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('directory service refuses a relative path that escapes the Files root', async () => {
  // risk: file access control — traversal must not create directories outside the authorized root.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-files-directory-'));
  try {
    const root = path.join(temporary, 'root');
    await fs.mkdir(root);
    await assert.rejects(new SullaFilesDirectoryService().createDirectoryWithinRoot(root, '../outside'), /escap/);
    await assert.rejects(fs.stat(path.join(temporary, 'outside')), { code: 'ENOENT' });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
