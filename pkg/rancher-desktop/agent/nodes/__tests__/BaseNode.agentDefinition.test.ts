import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';

import { redisClient } from '../../database/RedisClient';
import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { agentDefinitionService } from '../../services/AgentDefinitionService';
import { loadAgentPromptData } from '../BaseNode';

afterEach(() => { jest.restoreAllMocks() });
afterAll(async() => { await redisClient.close() });

describe('runtime agent prompt resolution', () => {
  it('resolves prompt, model config, sections, and observation policy data from the DB definition', async() => {
    jest.spyOn(SullaSettingsModel, 'get').mockResolvedValue('');
    jest.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({
      id:                      'agent-db',
      slug:                    'db-agent',
      name:                    'DB Agent',
      description:             'database only',
      system_prompt:           'primary',
      soul_content:            'soul',
      allowed_tools:           ['meta'],
      skill_refs:              ['review'],
      routine_refs:            [],
      model_priority:          [],
      version:                 null,
      status:                  'production',
      enabled:                 true,
      source_template_slug:    null,
      content_hash:            null,
      config:                  { injectObservations: false, exclude_sections: ['environment'] },
      prompt_content:          'primary',
      goals_content:           '',
      prompt_files:            { 'soul.md': 'soul from db', 'prompt.md': 'prompt from db' },
      provider:                'codex',
      model:                   'gpt-6.1-sol',
      source_kind:             'local',
      marketplace_template_id: null,
      marketplace_slug:        null,
      marketplace_version:     null,
      marketplace_author:      null,
      created_at:              new Date(0).toISOString(),
      updated_at:              new Date(0).toISOString(),
    });
    const result = await loadAgentPromptData('db-agent');
    expect(agentDefinitionService.findBySlug).toHaveBeenCalledWith('db-agent');
    expect(result).toMatchObject({
      agentName:       'DB Agent',
      genericPrompt:   expect.stringContaining('prompt from db'),
      excludeSections: ['environment'],
      config:          { provider: 'codex', model: 'gpt-6.1-sol', injectObservations: false },
    });
  });
});
