/** @jest-environment node */
import { TextDecoder, TextEncoder } from 'node:util';
import { beforeAll, afterAll, describe, expect, it } from '@jest/globals';

const SLACK_ID = 'slack';

interface IntegrationValueShape {
  value_id:       number;
  integration_id: string;
  property:       string;
  value:          string;
  created_at:     Date;
  updated_at:     Date;
}

let service: any;
let SullaIntegrations: any;
let registry: any;

beforeAll(async() => {
  (globalThis as any).TextEncoder = TextEncoder;
  (globalThis as any).TextDecoder = TextDecoder;

  const integrationServiceMod = await import('../../services/IntegrationService');
  service = integrationServiceMod.getIntegrationService();

  const integrationsMod = await import('../index');
  SullaIntegrations = integrationsMod.SullaIntegrations;
  registry = integrationsMod.registry;

  await service.initialize();

  const connectionStatus = await service.getConnectionStatus(SLACK_ID);
  if (!connectionStatus?.connected) {
    throw new Error('Slack production initialization test requires slack connection_status=true');
  }

  const botTokenValue: IntegrationValueShape | null = await service.getIntegrationValue(SLACK_ID, 'bot_token');
  const scopesTokenValue: IntegrationValueShape | null = await service.getIntegrationValue(SLACK_ID, 'scopes_token');
  const appTokenValue: IntegrationValueShape | null = await service.getIntegrationValue(SLACK_ID, 'app_token');
  const appLevelTokenValue: IntegrationValueShape | null = await service.getIntegrationValue(SLACK_ID, 'app_level_token');

  const existingBotToken = botTokenValue?.value || process.env.SLACK_BOT_TOKEN;
  const existingAppToken =
    scopesTokenValue?.value ||
    appTokenValue?.value ||
    appLevelTokenValue?.value ||
    process.env.SLACK_APP_TOKEN;

  if (!existingBotToken || !existingAppToken) {
    throw new Error('Slack production initialization test requires configured bot/app tokens in integration_values or env');
  }

  await registry.invalidate(SLACK_ID);
}, 30000);

afterAll(async() => {
  await registry.invalidate(SLACK_ID);
}, 30000);

describe('Slack integration initialization (production path)', () => {
  it('initializes Slack integration through SullaIntegrations and registry', async() => {
    await SullaIntegrations();
    const slack = await registry.get(SLACK_ID);

    expect(slack).toBeTruthy();
    expect(typeof slack.getThreadReplies).toBe('function');
    expect(typeof slack.sendMessage).toBe('function');

    // Validate that initialization is a real authenticated Slack connection.
    expect(typeof slack.isConnected).toBe('function');
    expect(slack.isConnected()).toBe(true);

    const authTest = await slack.apiCall('auth.test', {});
    expect(authTest?.ok).toBe(true);
    expect(typeof authTest?.team).toBe('string');

    const teamInfo = await slack.apiCall('team.info', {});
    expect(teamInfo?.ok).toBe(true);

    const usersList = await slack.apiCall('users.list', { limit: 5 });
    expect(usersList?.ok).toBe(true);
    const users = Array.isArray(usersList?.members) ? usersList.members : [];

    const channelsList = await slack.apiCall('conversations.list', {
      types: 'public_channel',
      limit: 5,
    });
    expect(channelsList?.ok).toBe(true);
    const channels = Array.isArray(channelsList?.channels) ? channelsList.channels : [];

    console.log('[slack_initialization.production] auth.test', {
      team:   authTest?.team,
      user:   authTest?.user,
      teamId: authTest?.team_id,
      userId: authTest?.user_id,
    });
    console.log('[slack_initialization.production] team.info', {
      teamName:   teamInfo?.team?.name,
      teamDomain: teamInfo?.team?.domain,
      teamId:     teamInfo?.team?.id,
    });
    console.log('[slack_initialization.production] users.list', {
      fetchedUsers:  users.length,
      sampleUserIds: users.slice(0, 3).map((u: any) => u?.id),
    });
    console.log('[slack_initialization.production] conversations.list', {
      fetchedChannels:  channels.length,
      sampleChannelIds: channels.slice(0, 3).map((c: any) => c?.id),
    });
  }, 120000);
});
