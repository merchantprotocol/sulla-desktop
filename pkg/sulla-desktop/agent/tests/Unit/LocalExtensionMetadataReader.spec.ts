// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalExtensionMetadataReader } from '../../extensions/LocalExtensionMetadataReader';

describe('LocalExtensionMetadataReader', () => {
  let root: string;

  beforeEach(async() => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-local-metadata-'));
  });

  afterEach(async() => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeManifest(dir: string, slug: string, file: string, body: string): Promise<void> {
    await fs.mkdir(path.join(dir, slug), { recursive: true });
    await fs.writeFile(path.join(dir, slug, file), body);
  }

  function reader(options: { functionsDirs?: string[]; integrationsDirs?: string[]; listUi?: (id: string) => any[]; logger?: { warn(message: string): void } } = {}) {
    return new LocalExtensionMetadataReader({
      functionsDirs:    options.functionsDirs ?? [],
      integrationsDirs: options.integrationsDirs ?? [],
      listUi:           options.listUi ?? (() => []),
      logger:           options.logger,
    });
  }

  // risk: permissions — only known hooks are offered for a grant; unknown names must not become grantable.
  it('lists a function from disk with its known hooks and drops unknown hook names', async() => {
    const functions = path.join(root, 'functions');
    await writeManifest(functions, 'sounding', 'function.yaml', [
      'name: Sounding', 'version: 1.2.0', 'description: Profiles rows', 'hooks:',
      '  - before_tool_call', '  - name: on_user_message', '  - not_a_hook',
    ].join('\n'));

    const rows = await reader({ functionsDirs: [functions] }).list();

    expect(rows).toEqual([expect.objectContaining({
      extensionId: 'function:sounding',
      name:        'Sounding',
      version:     '1.2.0',
      hooks:       ['before_tool_call', 'on_user_message'],
      grants:      {},
      hiddenFromRail: false,
    })]);
  });

  // risk: permissions — a function that requests nothing and shows no UI is not a permission row.
  it('skips a function with neither hooks nor UI contributions', async() => {
    const functions = path.join(root, 'functions');
    await writeManifest(functions, 'plain', 'function.yaml', 'name: Plain\nhooks: []\n');

    expect(await reader({ functionsDirs: [functions] }).list()).toEqual([]);
  });

  it('keeps a function that has only UI contributions', async() => {
    const functions = path.join(root, 'functions');
    await writeManifest(functions, 'panel', 'function.yaml', 'name: Panel\n');
    const listUi = vi.fn(() => [{ extensionId: 'function:panel', slot: 'sidebar_entry', id: 'p', label: 'Panel', component: 'x' }]);

    const rows = await reader({ functionsDirs: [functions], listUi }).list();

    expect(listUi).toHaveBeenCalledWith('function:panel');
    expect(rows.map(row => row.extensionId)).toEqual(['function:panel']);
  });

  // risk: permissions — an integration must show as not granted until the DB-backed grant list says otherwise.
  it('lists an integration with permissions as not granted', async() => {
    const integrations = path.join(root, 'integrations');
    await writeManifest(integrations, 'robinhood', 'integration.yaml', [
      'id: robinhood', 'name: Robinhood', 'version: 1.0.0', 'permissions:', '  - trade:read', '  - trade:write',
    ].join('\n'));

    const rows = await reader({ integrationsDirs: [integrations] }).list();

    expect(rows).toEqual([expect.objectContaining({
      extensionId: 'integration:robinhood',
      integration: { id: 'robinhood', version: '1.0.0', permissions: ['trade:read', 'trade:write'], granted: false },
    })]);
  });

  it('skips an integration that declares no permissions', async() => {
    const integrations = path.join(root, 'integrations');
    await writeManifest(integrations, 'docs', 'integration.yaml', 'name: Docs\nversion: 1.0.0\n');

    expect(await reader({ integrationsDirs: [integrations] }).list()).toEqual([]);
  });

  // risk: availability — one broken manifest must not hide every other installed extension.
  it('skips a malformed manifest, logs it, and still lists the others', async() => {
    const functions = path.join(root, 'functions');
    await writeManifest(functions, 'broken', 'function.yaml', 'name: [unclosed\n  hooks: {');
    await writeManifest(functions, 'good', 'function.yaml', 'name: Good\nhooks:\n  - on_user_message\n');
    const warn = vi.fn();

    const rows = await reader({ functionsDirs: [functions], logger: { warn } }).list();

    expect(rows.map(row => row.slug)).toEqual(['good']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'));
  });

  // risk: availability — a fresh install with no extensions directory must return an empty list, not throw.
  it('returns an empty list when the directories do not exist', async() => {
    const missing = path.join(root, 'does-not-exist');

    await expect(reader({ functionsDirs: [missing], integrationsDirs: [missing] }).list()).resolves.toEqual([]);
  });

  // risk: correctness — the bundled resources copy wins over a user copy with the same slug, as resolveAll* orders them.
  it('uses the first directory that has a slug when two directories both define it', async() => {
    const bundled = path.join(root, 'resources');
    const user = path.join(root, 'user');
    await writeManifest(bundled, 'shared', 'function.yaml', 'name: Bundled\nhooks:\n  - on_user_message\n');
    await writeManifest(user, 'shared', 'function.yaml', 'name: User copy\nhooks:\n  - on_user_message\n');

    const rows = await reader({ functionsDirs: [bundled, user] }).list();

    expect(rows.map(row => row.name)).toEqual(['Bundled']);
  });
});
