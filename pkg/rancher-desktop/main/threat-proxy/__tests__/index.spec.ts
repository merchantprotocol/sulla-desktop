/** @jest-environment node */

import { jest } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

// Mock all modules with side-effects before importing the module under test.
mockModules({
  electron: undefined,
  '@pkg/utils/logging': undefined,
  '@pkg/utils/paths': {
    altAppHome: '/tmp/test-app-home',
    logs: '/tmp/test-logs',
  },
  '@pkg/agent/database/models/SullaSettingsModel': {
    SullaSettingsModel: {
      get: jest.fn<() => Promise<any>>().mockResolvedValue(null),
      set: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
  },
});

// Must be a dynamic import so mocks are installed first.
const { renderEnvFile, SETTINGS_KEYS, INTEGRATION_IDS } = await import('@pkg/main/threat-proxy');

describe('renderEnvFile', () => {
  const defaultSettings = {
    enabled:       true,
    allowlist:     '',
    blockMode:     'block' as const,
    injectionMode: 'warn' as const,
  };

  const emptyKeys = {
    safeBrowsingApiKey: '',
    virusTotalApiKey:   '',
  };

  it('produces the expected env-file lines in the right order', () => {
    const out = renderEnvFile(defaultSettings, emptyKeys);
    const lines = out.split('\n').filter(l => l.trim() && !l.startsWith('#'));

    expect(lines).toEqual([
      'GOOGLE_SAFE_BROWSING_API_KEY=""',
      'VT_API_KEY=""',
      'SULLA_PROXY_ALLOWLIST=""',
      'SULLA_PROXY_BLOCK_MODE=\'block\'',
      'SULLA_INJECTION_MODE=\'warn\'',
      expect.stringContaining('SULLA_INJECTION_SCAN_CONTENT_TYPES='),
    ]);
  });

  it('shell-quotes a simple string with single quotes', () => {
    const out = renderEnvFile({ ...defaultSettings, allowlist: 'example.com,foo.bar' }, emptyKeys);
    expect(out).toContain("SULLA_PROXY_ALLOWLIST='example.com,foo.bar'");
  });

  it('renders empty string values as ""', () => {
    const out = renderEnvFile(defaultSettings, emptyKeys);
    expect(out).toContain('GOOGLE_SAFE_BROWSING_API_KEY=""');
    expect(out).toContain('VT_API_KEY=""');
    expect(out).toContain('SULLA_PROXY_ALLOWLIST=""');
  });

  it("escapes embedded single quotes with '\\''", () => {
    const out = renderEnvFile(
      defaultSettings,
      { safeBrowsingApiKey: "it's'weird", virusTotalApiKey: '' },
    );
    // Shell quoting: 'it'\''s'\''weird'
    expect(out).toContain("GOOGLE_SAFE_BROWSING_API_KEY='it'\\''s'\\''weird'");
  });

  it('includes a managed-by comment header', () => {
    const out = renderEnvFile(defaultSettings, emptyKeys);
    expect(out).toContain('# /etc/sulla-proxy.env — managed by Sulla Desktop');
  });

  it('includes all expected keys', () => {
    const out = renderEnvFile(
      { ...defaultSettings, blockMode: 'warn', injectionMode: 'redact', allowlist: 'trusted.com' },
      { safeBrowsingApiKey: 'sb-key', virusTotalApiKey: 'vt-key' },
    );
    expect(out).toContain("GOOGLE_SAFE_BROWSING_API_KEY='sb-key'");
    expect(out).toContain("VT_API_KEY='vt-key'");
    expect(out).toContain("SULLA_PROXY_ALLOWLIST='trusted.com'");
    expect(out).toContain("SULLA_PROXY_BLOCK_MODE='warn'");
    expect(out).toContain("SULLA_INJECTION_MODE='redact'");
  });

  it('trailing newline — file ends with \\n so the shell sources it cleanly', () => {
    const out = renderEnvFile(defaultSettings, emptyKeys);
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('SETTINGS_KEYS', () => {
  it('all keys are namespaced under threatProxy.*', () => {
    for (const val of Object.values(SETTINGS_KEYS)) {
      expect(val).toMatch(/^threatProxy\./);
    }
  });
});

describe('INTEGRATION_IDS', () => {
  it('exports the expected integration slugs', () => {
    expect(INTEGRATION_IDS.safeBrowsing).toBe('google-safe-browsing');
    expect(INTEGRATION_IDS.virusTotal).toBe('virustotal');
  });
});
