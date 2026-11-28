// SPDX-License-Identifier: GPL-2.0-or-later
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SullaFilesDirectoryService } from './sullaFilesDirectory.ts';

describe('Files directory service', () => {
it('creates a nested folder beneath the Files root', async () => {
  // risk: file access control — an allowed relative path must create the intended directory.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-files-directory-'));
  try {
    await fs.mkdir(path.join(temporary, 'root'));
    await new SullaFilesDirectoryService().createDirectoryWithinRoot(path.join(temporary, 'root'), 'folder');
    expect((await fs.stat(path.join(temporary, 'root', 'folder'))).isDirectory()).toBe(true);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

it('refuses a relative path that escapes the Files root', async () => {
  // risk: file access control — traversal must not create directories outside the authorized root.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-files-directory-'));
  try {
    const root = path.join(temporary, 'root');
    await fs.mkdir(root);
    await expect(new SullaFilesDirectoryService().createDirectoryWithinRoot(root, '../outside')).rejects.toThrow(/escap/);
    await expect(fs.stat(path.join(temporary, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
});
