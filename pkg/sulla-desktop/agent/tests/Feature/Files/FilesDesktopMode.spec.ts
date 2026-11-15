import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../../../../../services/sulla-files/src/config.js';

describe('Desktop Files runtime config', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ignores the retired service server-mode env and preserves remote server roots', () => {
    // risk: data access — Desktop must remain the local Files service even when
    // old server deployment variables are present, without losing client sync.
    vi.stubEnv('SULLA_FILES_DATABASE_URL', 'postgres://localhost/files');
    vi.stubEnv('SULLA_FILES_CAPABILITY_SIGNING_KEY', 'x'.repeat(32));
    vi.stubEnv('SULLA_FILES_MODE', 'server');
    vi.stubEnv('SULLA_FILES_MASTER_KEY', 'legacy-server-master-key');
    vi.stubEnv('SULLA_FILES_SERVER_URL', 'https://files.example.test');
    vi.stubEnv('SULLA_FILES_FOLDER', '/tmp/sulla-files-test-root');

    const config = loadConfig();

    expect(config.mode).toBe('desktop');
    expect(config.serverUrl).toBe('https://files.example.test');
    expect(config.fileRoots?.[0]).toMatchObject({ syncMode: 'server', path: '/tmp/sulla-files-test-root' });
    expect('serverMasterKey' in config).toBe(false);
  });

  const baseEnv = () => {
    vi.stubEnv('SULLA_FILES_DATABASE_URL', 'postgres://localhost/files');
    vi.stubEnv('SULLA_FILES_CAPABILITY_SIGNING_KEY', 'x'.repeat(32));
    vi.stubEnv('SULLA_FILES_FOLDER', '/tmp/sulla-files-test-root');
  };

  it('stays desktop with no mode variable at all and has no hosted-only config', () => {
    // risk: data access — mode must never be derived from env
    baseEnv();
    vi.stubEnv('SULLA_FILES_MODE', '');
    const config = loadConfig() as unknown as Record<string, unknown>;

    expect(config.mode).toBe('desktop');
    expect(config.serverMasterKey).toBeUndefined();
    expect(config.serverUiEnabled).toBeUndefined();
  });

  it('keeps a local root and a syncMode=server client root side by side from SULLA_FILES_ROOTS_JSON', () => {
    // risk: data access — Desktop-as-client roots must survive the server-mode removal
    baseEnv();
    vi.stubEnv('SULLA_FILES_MODE', 'server');
    vi.stubEnv('SULLA_FILES_ROOTS_JSON', JSON.stringify([
      { id: 'org', name: 'Org', path: '/tmp/sulla-org-root', syncMode: 'server' },
      { id: 'scratch', name: 'Scratch', path: '/tmp/sulla-scratch-root', syncMode: 'local', paused: true },
    ]));
    const config = loadConfig();

    expect(config.mode).toBe('desktop');
    const roots = config.fileRoots!;
    expect(roots.map(r => r.id)).toEqual(['default', 'org', 'scratch']);
    expect(roots.find(r => r.id === 'org')).toMatchObject({ syncMode: 'server', primary: false });
    expect(roots.find(r => r.id === 'scratch')).toMatchObject({ syncMode: 'local', paused: true });
    expect(roots.find(r => r.id === 'default')?.primary).toBe(true);
  });

  it('rejects overlapping root paths', () => {
    // risk: data integrity — two roots must never share a directory tree
    baseEnv();
    vi.stubEnv('SULLA_FILES_ROOTS_JSON', JSON.stringify([
      { id: 'a', name: 'A', path: '/tmp/sulla-files-test-root/inner', syncMode: 'local' },
    ]));

    expect(() => loadConfig()).toThrow(/overlap/);
  });
});
