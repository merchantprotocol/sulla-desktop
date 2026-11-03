// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getBuiltinAgentSpecs, hashManagedContent, renderBuiltinAgent, type BuiltinManagedContent } from '../index';
import { decideBuiltinSeedAction } from '../seedBuiltinAgents';

import type { AgentDefinition } from '../../database/models/AgentDefinitionModel';

/** A full AgentDefinition row carrying the given managed content. */
function toRow(content: BuiltinManagedContent, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-account-manager', slug: 'account-manager', created_at: '', updated_at: '', version: null,
    source_template_slug: null, content_hash: null, marketplace_template_id: null, marketplace_slug: null,
    marketplace_version: null, marketplace_author: null, front_door: false, run_location: 'container',
    use_case_file_id: null, use_case_version_id: null, source_kind: 'local', status: 'production', enabled: true,
    is_builtin: true, builtin_hash: null,
    ...content,
    ...overrides,
  };
}

describe('account-manager can_call upgrade through seedBuiltinAgents', () => {
  const newSpec = getBuiltinAgentSpecs().find(agent => agent.slug === 'account-manager')!;
  const newContent = renderBuiltinAgent(newSpec);

  // The shipped bundle now carries the live-directory wildcard.
  it('ships the can_call wildcard for account-manager', () => {
    expect(newContent.can_call).toEqual(['*']);
  });

  it('refreshes an untouched row from the old fixed roster to the wildcard', () => {
    const oldContent: BuiltinManagedContent = {
      ...newContent,
      can_call: ['project-manager', 'director', 'ui-test-manager'],
      prompt_content: 'old account-manager prompt, pre-directory',
      system_prompt:  'old account-manager prompt, pre-directory',
    };
    const oldHash = hashManagedContent(oldContent);
    const row = toRow(oldContent, { builtin_hash: oldHash });

    const action = decideBuiltinSeedAction(newContent, row, true);

    expect(action.kind).toBe('refresh');
  });

  it('never clobbers a row whose can_call the human edited since the last seed', () => {
    const oldContent: BuiltinManagedContent = {
      ...newContent,
      can_call: ['project-manager', 'director', 'ui-test-manager'],
      prompt_content: 'old account-manager prompt, pre-directory',
      system_prompt:  'old account-manager prompt, pre-directory',
    };
    const oldHash = hashManagedContent(oldContent);
    // The human has since narrowed can_call by hand; builtin_hash still points
    // at the old bundle, so the row no longer hashes to it.
    const editedRow = toRow({ ...oldContent, can_call: ['director'] }, { builtin_hash: oldHash });

    const action = decideBuiltinSeedAction(newContent, editedRow, true);

    expect(action.kind).not.toBe('refresh');
    expect(action.kind).not.toBe('insert');
    if (action.kind === 'fill-cards' || action.kind === 'adopt') {
      expect(action.patch.canCall).toBeUndefined();
    }
  });
});
