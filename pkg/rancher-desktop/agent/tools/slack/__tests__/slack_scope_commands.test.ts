import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockGet: any = jest.fn();

jest.unstable_mockModule('../../../integrations', () => ({
  registry: {
    get: mockGet,
  },
}));

async function loadScopeTools() {
  return import('../slack_scope_commands');
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('slack_scope_commands', () => {
  afterEach(() => {
    mockGet.mockReset();
  });

  it('registers scope tools for the provided Slack OAuth scopes', async() => {
    const { slackScopeToolRegistrations, slackApiMethodToolRegistrations } = await loadScopeTools();
    const toolNames = slackScopeToolRegistrations.map((r: any) => r.name);
    const commandToolNames = slackApiMethodToolRegistrations.map((r: any) => r.name);

    expect(toolNames).toContain('slack_app_mentions_read');
    expect(toolNames).toContain('slack_chat_write');
    expect(toolNames).toContain('slack_channels_write_invites');
    expect(toolNames).toContain('slack_users_read_email');
    expect(toolNames).toContain('slack_incoming_webhook');

    expect(commandToolNames).toContain('slack_cmd_channels_history');
    expect(commandToolNames).toContain('slack_cmd_chat_post_message');
    expect(commandToolNames).toContain('slack_cmd_files_upload');
    expect(commandToolNames).toContain('slack_cmd_usergroups_update');
  });

  it('executes scope command through Slack apiCall', async() => {
    const { SlackScopeCommandWorker, slackScopeToolRegistrations } = await loadScopeTools();
    const registration = slackScopeToolRegistrations.find((r: any) => r.name === 'slack_users_read');

    mockGet.mockResolvedValueOnce({
      apiCall: jest.fn(async() => ({ ok: true, members: [] })),
    });

    const worker = configureWorker(new SlackScopeCommandWorker(), registration);
    const result = await worker.invoke({ apiMethod: 'users.list', params: { limit: 1 } });

    expect(result.success).toBe(true);
    expect(result.result).toContain('users:read');
    expect(result.result).toContain('users.list');
  });

  it('executes concrete slack_cmd tool through mapped API method', async() => {
    const { SlackApiCommandWorker, slackApiMethodToolRegistrations } = await loadScopeTools();
    const registration = slackApiMethodToolRegistrations.find((r: any) => r.name === 'slack_cmd_team_info');

    mockGet.mockResolvedValueOnce({
      apiCall: jest.fn(async() => ({ ok: true, team: { id: 'T1' } })),
    });

    const worker = configureWorker(new SlackApiCommandWorker(), registration);
    const result = await worker.invoke({ params: {} });

    expect(result.success).toBe(true);
    expect(result.result).toContain('slack_cmd_team_info');
    expect(result.result).toContain('team.info');
  });
});
