import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }));
vi.mock('@pkg/utils/paths', () => ({ default: { sullaConfig: '/sulla-config' } }));

import { SupportDeviceIdentity, type SupportIdentityFileSystem } from './supportIdentity';

function memoryFs(initial: Record<string, string>) {
  const files = { ...initial };
  const fs: SupportIdentityFileSystem = {
    readFileSync: (file) => { if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[file] },
    mkdirSync:     vi.fn(),
    writeFileSync: vi.fn((file: string, data: string) => { files[file] = data }),
  };

  return { files, fs };
}

const identity = (fs: SupportIdentityFileSystem) => new SupportDeviceIdentity(() => '/enrolled', () => '/fallback/id', fs, () => 'new-id');

describe('SupportDeviceIdentity', () => {
  // risk: data accuracy — the enrolled Cloud id must win over the support fallback id
  it('prefers the enrolled id over the fallback id', () => {
    const { fs } = memoryFs({ '/enrolled': ' enrolled \n', '/fallback/id': 'fallback' });

    expect(identity(fs).read()).toBe('enrolled');
    expect(identity(fs).getOrCreate()).toBe('enrolled');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('returns null from readEnrolled when not enrolled or the file is blank', () => {
    expect(identity(memoryFs({}).fs).readEnrolled()).toBeNull();
    expect(identity(memoryFs({ '/enrolled': '  ' }).fs).readEnrolled()).toBeNull();
  });

  it('falls back to the support id when the enrolled file is missing', () => {
    expect(identity(memoryFs({ '/fallback/id': 'fallback' }).fs).read()).toBe('fallback');
  });

  // risk: irreversible side effect — a new id is written once, owner-only, and reused afterwards
  it('creates and persists a fallback id with mode 0600 when none exists', () => {
    const { files, fs } = memoryFs({});
    const subject = identity(fs);

    expect(subject.getOrCreate()).toBe('new-id');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/fallback', { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith('/fallback/id', 'new-id', { mode: 0o600 });
    expect(files['/fallback/id']).toBe('new-id');
    expect(subject.getOrCreate()).toBe('new-id');
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });
});
