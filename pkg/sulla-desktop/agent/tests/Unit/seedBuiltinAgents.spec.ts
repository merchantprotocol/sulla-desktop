// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { BuiltinAgentHasher, type BuiltinManagedContent } from '../../builtinAgents';
import { decideBuiltinSeedAction } from '../../builtinAgents/seedBuiltinAgents';
import type { AgentDefinition } from '../../database/models/AgentDefinitionModel';

describe('decideBuiltinSeedAction', () => {
  it('keeps Files-published content when its hash matches the last built-in seed', () => {
    // risk: a boot-time seed could overwrite an agent prompt published from Sulla Files
    const lastSeedContent: BuiltinManagedContent = {
      name:             'coding-manager',
      description:      'Coding manager',
      system_prompt:    'Prompt from the last built-in seed',
      prompt_content:   'Prompt from the last built-in seed',
      soul_content:     '',
      goals_content:    '',
      prompt_files:     {},
      allowed_tools:    [],
      skill_refs:       [],
      routine_refs:     [],
      model_priority:   [],
      provider:         null,
      model:            null,
      model_slot:       null,
      config:           {},
      when_to_call:     'Code changes',
      when_not_to_call: 'Non-code work',
      send:             'Task brief',
      returns:          'Result',
      cost_tier:        'low',
      can_call:         [],
      agent_awareness:  true,
    };
    const currentBundleContent = {
      ...lastSeedContent,
      system_prompt:  'Updated prompt from the current bundle',
      prompt_content: 'Updated prompt from the current bundle',
    };
    const lastSeedHash = BuiltinAgentHasher.hashManagedContent(lastSeedContent);
    const row: AgentDefinition = {
      ...lastSeedContent,
      id:                      'agent-row-1',
      slug:                    'coding-manager',
      version:                 null,
      status:                  'production',
      enabled:                 true,
      source_template_slug:    null,
      content_hash:            null,
      model_choice:            null,
      source_kind:             'local',
      marketplace_template_id: null,
      marketplace_slug:        null,
      marketplace_version:     null,
      marketplace_author:      null,
      front_door:              null,
      is_builtin:              true,
      builtin_hash:            lastSeedHash,
      run_location:            'container',
      use_case_file_id:        'files-agent-file-1',
      use_case_version_id:     'files-agent-version-1',
      created_at:              '2026-01-01T00:00:00.000Z',
      updated_at:              '2026-01-01T00:00:00.000Z',
    };

    expect(BuiltinAgentHasher.hashManagedContent(currentBundleContent)).not.toBe(lastSeedHash);
    expect(BuiltinAgentHasher.hashManagedContent(row)).toBe(lastSeedHash);
    expect(decideBuiltinSeedAction(currentBundleContent, row, false)).toEqual({ kind: 'kept' });
  });
});
