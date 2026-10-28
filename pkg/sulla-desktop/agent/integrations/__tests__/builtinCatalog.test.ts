// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { jest } from '@jest/globals';

import { nativeIntegrations } from '../native';

const PROVIDERS = ['claude-code', 'codex', 'grok', 'openai', 'anthropic', 'opencode', 'cursor'];
const ADDED = ['azure_devops', 'forgejo', 'gitea', 'meta-ads', 'n8n'];
const UPDATED = ['bitbucket', 'cloudflare', 'cohere', 'gitlab', 'google_drive', 'openai', 'r2'];

describe('built-in integration catalog (hard-coded, no folders, no DB)', () => {
  it('contains every model provider the app needs', async() => {
    const { integrations } = await import('../catalog');
    for (const id of PROVIDERS) {
      expect(integrations[id]).toBeDefined();
      expect(integrations[id].category).toBe('AI Infrastructure');
    }
  });

  it('contains the definitions that were missing from code', async() => {
    const { integrations } = await import('../catalog');
    for (const id of [...ADDED, ...UPDATED]) expect(integrations[id]).toBeDefined();
  });

  it('is the full catalog (300+ integrations) with consistent ids', async() => {
    const { integrations } = await import('../catalog');
    const entries = Object.entries(integrations);
    expect(entries.length).toBeGreaterThanOrEqual(310);
    for (const [key, integration] of entries) {
      expect(integration.id).toBe(key);
      expect(integration.name).toBeTruthy();
      expect(integration.category).toBeTruthy();
    }
  });

  it('prefers the newer definitions over the per-category ones', () => {
    // openai gained OAuth sign-in in the newer definition.
    expect((nativeIntegrations.openai as { oauth?: boolean }).oauth).toBe(true);
  });

  it('keeps the baseline when the database catalog is empty, and lets the database override by slug', async() => {
    jest.resetModules();
    const override = { ...nativeIntegrations['claude-code'], name: 'Claude Code (edited)' };
    jest.unstable_mockModule('../loader', () => ({
      loadCatalogWithDatabase: async() => ({ integrations: { 'claude-code': override }, manifests: {}, sources: {}, errors: [] }),
    }));
    const catalog = await import('../catalog');
    await catalog.refreshIntegrationCatalog();
    expect(catalog.integrations['claude-code'].name).toBe('Claude Code (edited)');
    expect(catalog.integrations.codex).toBeDefined();
    expect(Object.keys(catalog.integrations).length).toBeGreaterThanOrEqual(310);

    jest.resetModules();
    jest.unstable_mockModule('../loader', () => ({
      loadCatalogWithDatabase: async() => ({ integrations: {}, manifests: {}, sources: {}, errors: [] }),
    }));
    const empty = await import('../catalog');
    await empty.refreshIntegrationCatalog();
    for (const id of PROVIDERS) expect(empty.integrations[id]).toBeDefined();
  });
});
