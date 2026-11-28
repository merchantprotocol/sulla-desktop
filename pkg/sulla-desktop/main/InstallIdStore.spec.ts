// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

import { InstallIdStore, type InstallIdFileSystem } from './installId';

function memoryFs(initial: Record<string, string>, readError?: Error) {
  const files = { ...initial };
  const fs: InstallIdFileSystem = {
    readFileSync: (file) => {
      if (readError) throw readError;
      if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });

      return files[file];
    },
    mkdirSync:     vi.fn(),
    writeFileSync: vi.fn((file: string, data: string) => { files[file] = data }),
  };

  return { files, fs };
}

describe('InstallIdStore', () => {
  // risk: data accuracy — an existing install id is reused, never regenerated
  it('returns the trimmed existing id without writing', () => {
    const { fs } = memoryFs({ '/ud/install-id': 'abc\n' });

    expect(new InstallIdStore('/ud', fs, () => 'new').get()).toBe('abc');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('creates the id once on first use with owner-only permissions', () => {
    const { files, fs } = memoryFs({});
    const store = new InstallIdStore('/ud', fs, () => 'new');

    expect(store.get()).toBe('new');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/ud', { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith('/ud/install-id', 'new', { encoding: 'utf8', mode: 0o600 });
    expect(files['/ud/install-id']).toBe('new');
    expect(store.get()).toBe('new');
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('regenerates when the stored id is blank', () => {
    expect(new InstallIdStore('/ud', memoryFs({ '/ud/install-id': '  ' }).fs, () => 'new').get()).toBe('new');
  });

  // risk: data accuracy — a permission error must surface instead of silently replacing the id
  it('rethrows read errors other than ENOENT', () => {
    const { fs } = memoryFs({}, Object.assign(new Error('denied'), { code: 'EACCES' }));

    expect(() => new InstallIdStore('/ud', fs, () => 'new').get()).toThrow('denied');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
