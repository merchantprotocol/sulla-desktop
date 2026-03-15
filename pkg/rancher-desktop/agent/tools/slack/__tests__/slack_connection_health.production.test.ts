/** @jest-environment node */
import { TextDecoder, TextEncoder } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getIntegrationService } from '../../../services/IntegrationService';
import { SullaIntegrations, registry } from '../../../integrations';
import { SlackConnectionHealthWorker, slackConnectionHealthRegistration } from '../slack_connection_health';

const SLACK_ID = 'slack';
const service = getIntegrationService();
interface HealthTestSlackClient { isConnected: () => boolean }

function makeHealthWorker() {
  const worker = new SlackConnectionHealthWorker();
  worker.name = slackConnectionHealthRegistration.name;
  worker.description = slackConnectionHealthRegistration.description;
  worker.schemaDef = slackConnectionHealthRegistration.schemaDef;
  return worker;
}

describe('slack_connection_health (production path)', () => {
  beforeAll(async() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;

    await service.initialize();

    const connectionStatus = await service.getConnectionStatus(SLACK_ID);
    if (!connectionStatus?.connected) {
      throw new Error('Slack production health test requires slack connection_status=true');
    }

    const botToken = (await service.getIntegrationValue(SLACK_ID, 'bot_token'))?.value || process.env.SLACK_BOT_TOKEN;
    const appToken =
      (await service.getIntegrationValue(SLACK_ID, 'scopes_token'))?.value ||
      (await service.getIntegrationValue(SLACK_ID, 'app_token'))?.value ||
      (await service.getIntegrationValue(SLACK_ID, 'app_level_token'))?.value ||
      process.env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error('Slack production health test requires configured bot/app tokens in integration_values or env');
    }

    await registry.invalidate(SLACK_ID);
  }, 120000);

  afterAll(async() => {
    await registry.invalidate(SLACK_ID);
  }, 30000);

  it('preserves backend-initialized Slack client and reports healthy', async() => {
    await registry.invalidate(SLACK_ID);
    await SullaIntegrations();

    const initialClient = (await registry.get(SLACK_ID));
    expect(initialClient).toBeTruthy();
    if (!initialClient) {
      throw new Error('Expected backend-initialized Slack client to exist');
    }
    expect(typeof initialClient.isConnected).toBe('function');
    expect(initialClient.isConnected()).toBe(true);

    const worker = makeHealthWorker();
    const result = await worker.invoke({
      reinitializeIfNeeded: true,
      validateAuth:         true,
      validateDataPull:     true,
      recoveryAttempts:     1,
      recoveryDelayMs:      0,
    });

    const clientAfterHealth = (await registry.get(SLACK_ID));
    expect(clientAfterHealth).toBeTruthy();
    if (!clientAfterHealth) {
      throw new Error('Expected Slack client to still exist after health check');
    }

    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('"healthy": true');
    expect(String(result.result)).toContain('"registryClientPresent": true');
    expect(String(result.result)).toContain('"singletonConnected": true');
    expect(String(result.result)).toContain('"authOk": true');
    expect(String(result.result)).toContain('"dataPullOk": true');
    expect(String(result.result)).toContain('"reinitialized": false');
    expect(clientAfterHealth).toBe(initialClient);
    expect(clientAfterHealth.isConnected()).toBe(true);
  }, 120000);

  it('reports healthy from a cold context with real auth/data pull validation', async() => {
    // Simulate a separate execution context with no pre-warmed registry entry.
    await registry.invalidate(SLACK_ID);

    const worker = makeHealthWorker();
    const result = await worker.invoke({
      reinitializeIfNeeded: true,
      validateAuth:         true,
      validateDataPull:     true,
      recoveryAttempts:     1,
      recoveryDelayMs:      0,
    });

    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('"healthy": true');
    expect(String(result.result)).toContain('"registryClientPresent": true');
    expect(String(result.result)).toContain('"singletonConnected": true');
    expect(String(result.result)).toContain('"authOk": true');
    expect(String(result.result)).toContain('"validateDataPull": true');
    expect(String(result.result)).toContain('"dataPullOk": true');
  }, 120000);
});
