import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { agentDefinitionService } from '../AgentDefinitionService';
import { buildAgentTeamBlock, listAgentDirectory, suggestAgentsForText } from '../AgentDirectoryService';

import type { AgentDefinition } from '../../database/models/AgentDefinitionModel';

// The directory only needs the service's reads; keep Electron-backed path
// helpers out of this unit test.
jest.mock('../AgentDefinitionService', () => ({
  agentDefinitionService: { list: jest.fn(), findBySlug: jest.fn() },
}));

function agent(slug: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id:                      `agent-${ slug }`,
    slug,
    name:                    slug,
    description:             `${ slug } description`,
    system_prompt:           '',
    soul_content:            '',
    allowed_tools:           [],
    skill_refs:              [],
    routine_refs:            [],
    model_priority:          [],
    version:                 null,
    status:                  'production',
    enabled:                 true,
    source_template_slug:    null,
    content_hash:            null,
    config:                  {},
    prompt_content:          '',
    goals_content:           '',
    prompt_files:            {},
    provider:                null,
    model:                   null,
    source_kind:             'local',
    marketplace_template_id: null,
    marketplace_slug:        null,
    marketplace_version:     null,
    marketplace_author:      null,
    when_to_call:            '',
    when_not_to_call:        '',
    send:                    '',
    returns:                 '',
    cost_tier:               null,
    can_call:                [],
    is_builtin:              false,
    builtin_hash:            null,
    created_at:              '',
    updated_at:              '',
    ...overrides,
  };
}

const rows = [
  agent('analytics-worker', { when_to_call: 'Metrics, KPIs and dashboards from real data.', cost_tier: 'high', send: 'question + data source', returns: 'dashboard html' }),
  agent('haiku-worker', { when_to_call: 'Light lookups and small edits.', when_not_to_call: 'Dashboards or design work.', cost_tier: 'low' }),
  agent('lead', { when_to_call: 'Runs the team.', can_call: ['haiku-worker'] }),
  agent('legacy', { enabled: false, status: 'archive' }),
  agent('hand-made'),
];

afterEach(() => { jest.resetAllMocks() });

function mockTable() {
  jest.mocked(agentDefinitionService.list).mockResolvedValue(rows);
  jest.mocked(agentDefinitionService.findBySlug).mockImplementation(slug => Promise.resolve(rows.find(r => r.slug === slug) ?? null));
}

describe('AgentDirectoryService', () => {
  it('lists every active agent from the table, falling back to description', async() => {
    mockTable();
    const cards = await listAgentDirectory();
    expect(cards.map(c => c.slug)).toEqual(['analytics-worker', 'haiku-worker', 'lead', 'hand-made']);
    expect(cards.find(c => c.slug === 'hand-made')!.whenToCall).toBe('hand-made description');
    expect((await listAgentDirectory({ includeInactive: true })).map(c => c.slug)).toContain('legacy');
  });

  it('ranks agents for free text and drops non-matches', async() => {
    mockTable();
    const cards = await suggestAgentsForText('build me a dashboard of sales KPIs');
    expect(cards[0].slug).toBe('analytics-worker');
    expect(cards.map(c => c.slug)).not.toContain('haiku-worker');
  });

  it('builds a team block scoped by can_call and excluding the caller', async() => {
    mockTable();
    const block = await buildAgentTeamBlock({ forAgentSlug: 'lead' });
    expect(block).toContain('<agent_team>');
    expect(block).toContain('**haiku-worker**');
    expect(block).toContain('Not for: Dashboards or design work.');
    expect(block).not.toContain('**lead**');
    expect(block).not.toContain('**analytics-worker**');

    const all = await buildAgentTeamBlock({ forAgentSlug: 'hand-made' });
    expect(all).toContain('**analytics-worker**');
    expect(all).not.toContain('**hand-made**');
    expect(all).not.toContain('**legacy**');
  });

  it('stays within maxChars', async() => {
    mockTable();
    const block = await buildAgentTeamBlock({ maxChars: 600 });
    expect(block.length).toBeLessThanOrEqual(700);
    expect(block).toContain('more: sulla agents/directory');
  });
});
