import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { AgentDefinition } from '../../database/models/AgentDefinitionModel';

const findBySlug = jest.fn<(slug: string) => Promise<AgentDefinition | null>>();

jest.unstable_mockModule('../AgentDefinitionService', () => ({ agentDefinitionService: { findBySlug, list: jest.fn() } }));

const { resolveDefaultRouteAgent, resolveFrontDoorAgent, resolveRoutableAgent } = await import('../ChatAgentRouting');

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

function table(...rows: AgentDefinition[]) {
  findBySlug.mockImplementation(slug => Promise.resolve(rows.find(row => row.slug === slug) ?? null));
}

afterEach(() => { findBySlug.mockReset() });

const sulla = { agentId: 'sulla', graphAgentId: 'sulla-desktop', name: 'Sulla' };

describe('default front door', () => {
  it('opens new chats on account-manager when it exists and is enabled', async() => {
    table(agent('account-manager', { name: 'Account Manager', front_door: true }));
    await expect(resolveDefaultRouteAgent()).resolves.toEqual({ agentId: 'account-manager', graphAgentId: 'account-manager', name: 'Account Manager' });
  });

  it('falls back to Sulla when account-manager is missing, disabled, archived or taken off the front door', async() => {
    table();
    await expect(resolveDefaultRouteAgent()).resolves.toEqual(sulla);
    table(agent('account-manager', { enabled: false }));
    await expect(resolveDefaultRouteAgent()).resolves.toEqual(sulla);
    table(agent('account-manager', { status: 'archive' }));
    await expect(resolveDefaultRouteAgent()).resolves.toEqual(sulla);
    table(agent('account-manager', { front_door: false }));
    await expect(resolveDefaultRouteAgent()).resolves.toEqual(sulla);
  });

  it('falls back to Sulla when the lookup throws', async() => {
    findBySlug.mockRejectedValue(new Error('db down'));
    await expect(resolveDefaultRouteAgent()).resolves.toEqual(sulla);
  });
});

describe('front-door routing targets', () => {
  it('accepts front_door agents and config opt-ins, and refuses everything else', async() => {
    table(
      agent('coding-manager', { front_door: true }),
      agent('imported', { config: { frontDoor: true } }),
      agent('opus-worker', { front_door: false, config: { frontDoor: true } }),
      agent('unset'),
      agent('off', { front_door: true, enabled: false }),
    );
    await expect(resolveFrontDoorAgent('coding-manager')).resolves.toEqual(expect.objectContaining({ agentId: 'coding-manager' }));
    await expect(resolveFrontDoorAgent('imported')).resolves.toEqual(expect.objectContaining({ agentId: 'imported' }));
    await expect(resolveFrontDoorAgent('opus-worker')).resolves.toBeNull();
    await expect(resolveFrontDoorAgent('unset')).resolves.toBeNull();
    await expect(resolveFrontDoorAgent('off')).resolves.toBeNull();
    await expect(resolveFrontDoorAgent('sulla')).resolves.toEqual(sulla);
  });

  it('keeps explicit routing (route_agent, agent tabs) open to any enabled agent', async() => {
    table(agent('opus-worker', { front_door: false }));
    await expect(resolveRoutableAgent('opus-worker')).resolves.toEqual(expect.objectContaining({ agentId: 'opus-worker' }));
  });
});
