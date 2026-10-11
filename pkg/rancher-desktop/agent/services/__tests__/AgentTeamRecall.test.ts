import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { AgentDefinition } from '../../database/models/AgentDefinitionModel';

const list = jest.fn<() => Promise<AgentDefinition[]>>();
const findBySlug = jest.fn<(slug: string) => Promise<AgentDefinition | null>>();

// Only the service's reads are needed; keep Electron-backed path helpers out.
jest.unstable_mockModule('../AgentDefinitionService', () => ({ agentDefinitionService: { list, findBySlug } }));

const { buildTeamRecallContext } = await import('../AgentTeamRecall');

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
    front_door:              null,
    builtin_hash:            null,
    created_at:              '',
    updated_at:              '',
    ...overrides,
  };
}

const rows = [
  agent('account-manager', { name: 'Account Manager', can_call: ['ui-test-manager', 'analytics-worker', 'haiku-worker'] }),
  agent('ui-test-manager', {
    name:         'UI Test Manager',
    cost_tier:    'high',
    when_to_call: 'Test the app in the browser like a real user; QA the checkout flow and report what is broken.',
    send:         'App URL and the flows to test',
    returns:      'Issues report',
  }),
  agent('analytics-worker', { name: 'Analytics Worker', when_to_call: 'Metrics, KPIs and dashboards from real data.' }),
  agent('haiku-worker', { name: 'Haiku Worker', when_to_call: 'Light lookups and small edits.', cost_tier: 'low' }),
  agent('retired', { enabled: false, status: 'archive' }),
];

afterEach(() => { jest.resetAllMocks() });

function mockTable(table = rows) {
  list.mockResolvedValue(table);
  findBySlug.mockImplementation(slug => Promise.resolve(table.find(r => r.slug === slug) ?? null));
}

describe('buildTeamRecallContext', () => {
  it('returns nothing for an agent that calls no one', async() => {
    mockTable();
    await expect(buildTeamRecallContext({ agentSlug: 'haiku-worker', text: 'test the checkout' })).resolves.toBe('');
    await expect(buildTeamRecallContext({ agentSlug: 'unknown', text: 'x' })).resolves.toBe('');
  });

  it('includes the shared section and ranks the team, marking a strong fit', async() => {
    mockTable();
    const block = await buildTeamRecallContext({ agentSlug: 'account-manager', text: 'please test the checkout flow in the browser and report what is broken' });
    expect(block).toContain('## Calling your team');
    expect(block).toContain('## Team directory');
    const lines = block.slice(block.indexOf('## Team directory')).split('\n').filter(line => line.startsWith('- '));
    expect(lines[0]).toContain('**fits right now** · **ui-test-manager**');
    expect(block).toContain('Send: App URL and the flows to test');
    expect(lines.filter(line => line.includes('fits right now'))).toHaveLength(1);
    // Everyone else is a single compact line.
    expect(block).toContain('- **analytics-worker** (Analytics Worker): Metrics, KPIs and dashboards from real data.');
  });

  it('skips the shared section when the agent prompt already carries it', async() => {
    mockTable([{ ...rows[0], prompt_files: { 'prompt.md': '# Account Manager\n\n## Calling your team\n\nYou have a team.' } }, ...rows.slice(1)]);
    const block = await buildTeamRecallContext({ agentSlug: 'account-manager', text: 'thanks' });
    expect(block.startsWith('## Team directory')).toBe(true);
    expect(block).not.toContain('## Calling your team');
  });

  it('marks nothing when the situation matches weakly, keeping can_call order', async() => {
    mockTable();
    const block = await buildTeamRecallContext({ agentSlug: 'account-manager', text: 'thanks' });
    expect(block).not.toContain('fits right now');
    expect(block).toContain('Nothing in the current situation clearly points');
    const slugs = block.slice(block.indexOf('## Team directory')).split('\n').filter(line => line.startsWith('- **')).map(line => /\*\*([a-z-]+)\*\*/.exec(line)?.[1]);
    expect(slugs).toEqual(['ui-test-manager', 'analytics-worker', 'haiku-worker']);
  });

  it('stays within the size cap', async() => {
    const many = Array.from({ length: 40 }, (_, i) => agent(`worker-${ i }`, { when_to_call: 'x'.repeat(200) }));
    const lead = agent('lead', { can_call: many.map(row => row.slug) });
    mockTable([lead, ...many]);
    const block = await buildTeamRecallContext({ agentSlug: 'lead', text: 'anything', maxChars: 1500 });
    const directory = block.slice(block.indexOf('## Team directory'));
    expect(directory.length).toBeLessThanOrEqual(1500 + 60);
    expect(directory).toContain('more: `sulla agents/directory`');
  });
});
