/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.


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
const { renderConfigFile, SETTINGS_KEYS, INTEGRATION_IDS } = await import('@pkg/main/threat-proxy');

describe('renderConfigFile', () => {
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

  it('produces the keys the proxy addons read', () => {
    const config = JSON.parse(renderConfigFile(defaultSettings, emptyKeys));

    expect(config).toEqual({
      managedBy:                 'Sulla Desktop',
      safeBrowsingApiKey:        '',
      virusTotalApiKey:          '',
      allowlist:                 '',
      blockMode:                 'block',
      injectionMode:             'warn',
      injectionScanContentTypes: expect.arrayContaining(['text/html', 'application/json']),
    });
  });

  it('carries settings and vault keys verbatim', () => {
    const config = JSON.parse(renderConfigFile(
      { ...defaultSettings, blockMode: 'warn', injectionMode: 'redact', allowlist: 'trusted.com,foo.bar' },
      { safeBrowsingApiKey: 'sb-key', virusTotalApiKey: 'vt-key' },
    ));

    expect(config.safeBrowsingApiKey).toBe('sb-key');
    expect(config.virusTotalApiKey).toBe('vt-key');
    expect(config.allowlist).toBe('trusted.com,foo.bar');
    expect(config.blockMode).toBe('warn');
    expect(config.injectionMode).toBe('redact');
  });

  it('round-trips values that would need shell quoting', () => {
    const awkward = `it's"weird\\ $(rm -rf) \n`;
    const config = JSON.parse(renderConfigFile(defaultSettings, { safeBrowsingApiKey: awkward, virusTotalApiKey: '' }));

    expect(config.safeBrowsingApiKey).toBe(awkward);
  });

  it('ends with a newline', () => {
    expect(renderConfigFile(defaultSettings, emptyKeys).endsWith('\n')).toBe(true);
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
