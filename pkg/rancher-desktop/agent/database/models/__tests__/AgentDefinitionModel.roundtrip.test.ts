import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { AgentDefinitionModel } from '../AgentDefinitionModel';

afterEach(() => { jest.restoreAllMocks() });

describe('AgentDefinitionModel lossless CRUD', () => {
  it('writes and reads every runtime and marketplace field', async() => {
    const queryOne = jest.spyOn(postgresClient, 'queryOne').mockImplementation(async(sql: string, params: any[] = []) => {
      await Promise.resolve();
      if (!sql.includes('INSERT INTO')) return null;
      return {
        id:                      params[0],
        slug:                    params[1],
        name:                    params[2],
        description:             params[3],
        system_prompt:           params[4],
        soul_content:            params[5],
        allowed_tools:           params[6],
        skill_refs:              params[7],
        routine_refs:            params[8],
        model_priority:          JSON.parse(params[9]),
        version:                 params[10],
        status:                  params[11],
        enabled:                 params[12],
        source_template_slug:    params[13],
        content_hash:            params[14],
        config:                  JSON.parse(params[15]),
        prompt_content:          params[16],
        goals_content:           params[17],
        prompt_files:            JSON.parse(params[18]),
        provider:                params[19],
        model:                   params[20],
        source_kind:             params[21],
        marketplace_template_id: params[22],
        marketplace_slug:        params[23],
        marketplace_version:     params[24],
        marketplace_author:      params[25],
        created_at:              new Date(0),
        updated_at:              new Date(0),
      } as any;
    });
    const created = await AgentDefinitionModel.create({
      slug:                  'all-fields',
      name:                  'All Fields',
      description:           'desc',
      systemPrompt:          'prompt',
      soulContent:           'soul',
      goalsContent:          'goals',
      promptContent:         'prompt',
      promptFiles:           { 'prompt.md': 'prompt', 'custom.md': 'custom' },
      allowedTools:          ['meta'],
      skillRefs:             ['review'],
      routineRefs:           ['nightly'],
      modelPriority:         [{ provider: 'codex', model: 'gpt-6.1-sol' }],
      config:                { injectObservations: false, arbitrary: { preserved: 1 } },
      provider:              'codex',
      model:                 'gpt-6.1-sol',
      sourceKind:            'marketplace',
      marketplaceTemplateId: 'tpl',
      marketplaceSlug:       'all-fields',
      marketplaceVersion:    '2.0.0',
      marketplaceAuthor:     'Jonathon',
    });
    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(created).toMatchObject({
      slug:                    'all-fields',
      prompt_content:          'prompt',
      goals_content:           'goals',
      prompt_files:            { 'custom.md': 'custom' },
      config:                  { arbitrary: { preserved: 1 } },
      provider:                'codex',
      model:                   'gpt-6.1-sol',
      source_kind:             'marketplace',
      marketplace_template_id: 'tpl',
      marketplace_version:     '2.0.0',
    });
    queryOne.mockResolvedValueOnce({ ...created, name: 'Renamed', updated_at: new Date(1) } as any);
    const updated = await AgentDefinitionModel.update(created.id, { name: 'Renamed' });
    expect(updated).toMatchObject({
      name:         'Renamed',
      config:       { injectObservations: false, arbitrary: { preserved: 1 } },
      prompt_files: { 'prompt.md': 'prompt', 'custom.md': 'custom' },
      source_kind:  'marketplace',
    });
    queryOne.mockResolvedValueOnce({ ...updated } as any);
    expect(await AgentDefinitionModel.findBySlug('all-fields')).toEqual(updated);
    queryOne.mockResolvedValueOnce({ id: created.id } as any);
    expect(await AgentDefinitionModel.delete(created.id)).toBe(true);
  });
});
