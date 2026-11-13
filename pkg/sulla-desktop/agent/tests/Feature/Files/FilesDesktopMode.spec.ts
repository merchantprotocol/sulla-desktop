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
});
