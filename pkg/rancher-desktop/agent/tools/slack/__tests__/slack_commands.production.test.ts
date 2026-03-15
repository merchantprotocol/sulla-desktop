/** @jest-environment node */
import { TextDecoder, TextEncoder } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getIntegrationService } from '../../../services/IntegrationService';
import { SullaIntegrations, registry } from '../../../integrations';
import { SlackApiCommandWorker, slackApiMethodToolRegistrations } from '../slack_scope_commands';

const SLACK_ID = 'slack';
const service = getIntegrationService();

async function invokeTool(name: string, input: Record<string, any>) {
  const registration = slackApiMethodToolRegistrations.find(r => r.name === name);
  if (!registration) {
    throw new Error(`Missing registration for ${ name }`);
  }

  const tool = new SlackApiCommandWorker();
  tool.name = registration.name;
  tool.description = registration.description;
  tool.schemaDef = registration.schemaDef;
  return tool.invoke(input);
}

describe('Slack command tools (production path)', () => {
  beforeAll(async() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;

    await service.initialize();

    const connectionStatus = await service.getConnectionStatus(SLACK_ID);
    if (!connectionStatus?.connected) {
      throw new Error('Slack production command tests require slack connection_status=true');
    }

    const botToken = (await service.getIntegrationValue(SLACK_ID, 'bot_token'))?.value || process.env.SLACK_BOT_TOKEN;
    const appToken =
      (await service.getIntegrationValue(SLACK_ID, 'scopes_token'))?.value ||
      (await service.getIntegrationValue(SLACK_ID, 'app_token'))?.value ||
      (await service.getIntegrationValue(SLACK_ID, 'app_level_token'))?.value ||
      process.env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error('Slack production command tests require configured bot/app tokens in integration_values or env');
    }

    await registry.invalidate(SLACK_ID);
    await SullaIntegrations();
  }, 60000);

  afterAll(async() => {
    await registry.invalidate(SLACK_ID);
  }, 30000);

  it('slack_cmd_channels_read works against Slack API', async() => {
    const result = await invokeTool('slack_cmd_channels_read', {
      params: {
        types: 'public_channel',
        limit: 100,
      },
    });

    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('conversations.list');
    expect(String(result.result)).not.toContain('Slack integration is not initialized');
  }, 45000);

  it('slack_cmd_team_info works against Slack API', async() => {
    const result = await invokeTool('slack_cmd_team_info', { params: {} });

    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('team.info');
  }, 45000);

  it('slack_cmd_users_list works against Slack API', async() => {
    const result = await invokeTool('slack_cmd_users_list', {
      params: {
        limit: 25,
      },
    });

    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('users.list');
  }, 45000);
});
