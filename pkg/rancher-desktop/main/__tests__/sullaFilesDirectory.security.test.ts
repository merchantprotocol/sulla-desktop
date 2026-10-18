/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDirectoryWithinRoot } from '@pkg/main/sullaFilesDirectory';

describe('createDirectoryWithinRoot', () => {
  test('rejects lexical and existing-symlink escapes', async() => {
    const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sulla-files-folder-boundary-'));
    const root = path.join(fixture, 'root');
    const outside = path.join(fixture, 'outside');

    try {
      await Promise.all([fs.promises.mkdir(root), fs.promises.mkdir(outside)]);

      await expect(createDirectoryWithinRoot(root, '../escaped')).rejects.toThrow('escapes');
      await expect(fs.promises.lstat(path.join(fixture, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' });

      await fs.promises.symlink(outside, path.join(root, 'outside-link'), 'dir');

      await expect(createDirectoryWithinRoot(root, 'outside-link/escaped')).rejects.toThrow('escapes');
      await expect(fs.promises.lstat(path.join(outside, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' });

      await fs.promises.mkdir(path.join(root, 'inside'));
      await fs.promises.symlink(path.join(root, 'inside'), path.join(root, 'inside-link'), 'dir');
      await createDirectoryWithinRoot(root, 'inside-link/allowed');
      await expect(fs.promises.lstat(path.join(root, 'inside', 'allowed'))).resolves.toMatchObject({ mode: expect.any(Number) });
    } finally {
      await fs.promises.rm(fixture, { recursive: true, force: true });
    }
  });
});
