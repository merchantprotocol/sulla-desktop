/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { executionTargetFor } from '../executionTargets';
import { defaultToolPlacementMetadata } from '../toolPlacement';

describe('tool placement metadata', () => {
  test('keeps unclassified tools on Desktop and does not make them relayable', () => {
    expect(defaultToolPlacementMetadata('unknown_tool', 'unknown', ['read'])).toEqual({
      placements: ['desktop'], relayable: false, sideEffect: 'read', credential: 'none',
    });
  });

  test('maps the portable tool families from the Sulla Anywhere contract', () => {
    expect(defaultToolPlacementMetadata('github_get_issue', 'github', ['read'])).toEqual({
      placements: ['desktop', 'cloud', 'mobile'],
      relayable: true,
      sideEffect: 'read',
      credential: { integration: 'github' },
    });
    expect(defaultToolPlacementMetadata('files_list', 'files', ['read']).placements).toEqual(['desktop', 'mobile']);
    expect(defaultToolPlacementMetadata('vault_list', 'vault', ['read']).relayable).toBe(false);
    expect(defaultToolPlacementMetadata('spawn_agent', 'agents', ['execute']).placements).toEqual(['desktop', 'cloud', 'mobile']);
  });

  test.each([
    ['slack_send_message', 'slack'],
    ['github_comment_on_issue', 'github'],
    ['github_create_release', 'github'],
    ['pack_uninstall', 'memory'],
    ['vault_delete_credential', 'vault'],
  ])('marks %s as irreversible', (name, category) => {
    expect(defaultToolPlacementMetadata(name, category, ['execute']).sideEffect).toBe('irreversible');
  });

  test('does not alter the existing execution-target resolver', () => {
    expect(executionTargetFor('browser', 'browser_tab')).toBe('desktop-local');
    expect(executionTargetFor('agents', 'spawn_agent')).toBe('controller');
    expect(executionTargetFor('files', 'files_list')).toBe('catalog');
    expect(executionTargetFor('github', 'github_git_push')).toBe('agent-local');
  });
});
