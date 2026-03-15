// registry.ts (or wherever you centralize registrations)
import { IntegrationRegistry } from './IntegrationRegistry';
import { isConnectionStatusSuppressed } from './integrationFlags';
import { getIntegrationService } from '../services/IntegrationService';
import { SlackClient, slackClient } from './slack/SlackClient';

export const registry = new IntegrationRegistry();
// Token properties that should trigger a full hot-reload (invalidate + re-init)
const CREDENTIAL_PROPERTIES = new Set([
  'bot_token',
  'scopes_token',
  'app_token',
  'app_level_token',
]);
let integrationListenerSubscribed = false;

/**
 * Hot-reload: tear down existing client and re-initialize with new tokens
 */
async function reloadIntegration(integrationId: string, reason: string): Promise<void> {
  try {
    await registry.invalidate(integrationId);
    const client = await registry.get(integrationId);
    if (client) {
      console.log(`[Integrations] ${ integrationId } hot-reloaded (${ reason })`);
    } else {
      console.warn(`[Integrations] ${ integrationId } hot-reload returned null (${ reason })`);
    }
  } catch (error) {
    console.error(`[Integrations] ${ integrationId } hot-reload failed (${ reason }):`, error);
  }
}

/**
 * Initialize: user clicked Connect — init if not already connected
 */
async function initializeIntegration(integrationId: string): Promise<void> {
  try {
    // Invalidate first so the factory re-reads fresh credentials from DB
    await registry.invalidate(integrationId);
    const client = await registry.get(integrationId);
    if (client) {
      console.log(`[Integrations] ${ integrationId } initialized via Connect`);
    } else {
      console.warn(`[Integrations] ${ integrationId } initialization returned null after Connect`);
    }
  } catch (error) {
    console.error(`[Integrations] ${ integrationId } initialization failed:`, error);
  }
}

/**
 * Disconnect: user clicked Disconnect — tear down the client
 */
async function disconnectIntegration(integrationId: string): Promise<void> {
  try {
    await registry.invalidate(integrationId);
    console.log(`[Integrations] ${ integrationId } disconnected`);
  } catch (error) {
    console.error(`[Integrations] ${ integrationId } disconnect failed:`, error);
  }
}

/**
 * Slack
 *
 *
 */
registry.register('slack', async() => {
  const svc = getIntegrationService();
  await svc.initialize(); // ensure DB tables

  // Check if tokens exist — if no tokens at all, Slack is not configured
  const botToken = (await svc.getIntegrationValue('slack', 'bot_token'))?.value || process.env.SLACK_BOT_TOKEN;
  const appToken = (
    (await svc.getIntegrationValue('slack', 'scopes_token'))?.value ||
    (await svc.getIntegrationValue('slack', 'app_token'))?.value ||
    (await svc.getIntegrationValue('slack', 'app_level_token'))?.value ||
    process.env.SLACK_APP_TOKEN
  );

  if (!botToken || !appToken) {
    console.warn('[Integrations] Slack tokens not configured — skipping initialization');
    return null;
  }

  // Inject tokens so SlackClient doesn't need to re-query DB
  slackClient.setTokens(botToken, appToken);

  await slackClient.initialize();

  return slackClient;
});

/**
 * Initialize all Sulla integrations
 * This function is called during application startup to set up all integration factories
 */
export async function SullaIntegrations(): Promise<void> {
  // Integration factories are already registered above
  // This function serves as the explicit initialization hook
  console.log('[Integrations] Sulla integrations initialized');

  try {
    const svc = getIntegrationService();
    await svc.initialize();

    if (!integrationListenerSubscribed) {
      svc.onValueChange((value, action) => {
        const id = value.integration_id;

        // connection_status changed → user clicked Connect/Disconnect in UI
        if (value.property === 'connection_status') {
          if (isConnectionStatusSuppressed()) {
            console.log(`[Integrations] Suppressed connection_status reload for ${ id } (backend-initiated)`);
            return;
          }
          const isConnect = value.value === 'true';
          if (isConnect) {
            console.log(`[Integrations] Connect event for ${ id }`);
            void initializeIntegration(id);
          } else {
            console.log(`[Integrations] Disconnect event for ${ id }`);
            void disconnectIntegration(id);
          }
          return;
        }

        // Credential/token changed → hot-reload if it's a known credential property
        if (CREDENTIAL_PROPERTIES.has(value.property)) {
          void reloadIntegration(id, `${ action }:${ value.property }`);
        }
      });
      integrationListenerSubscribed = true;
    }

    // Initialize Slack after a short delay to let TLS/network settle
    setTimeout(() => {
      console.log('[Integrations] Attempting deferred Slack initialization...');
      registry.get<SlackClient>('slack').then((client) => {
        if (client) {
          console.log('[Integrations] Slack connected at boot');
        } else {
          console.warn('[Integrations] Slack deferred init returned null (tokens missing or connect failed)');
        }
      }).catch((err) => {
        console.error('[Integrations] Slack deferred init error:', err);
      });
    }, 5000);
  } catch (ex: any) {
    console.error('[Background] Failed to initialize cron services:', ex);
  }
}
