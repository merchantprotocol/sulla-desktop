import { registry } from '../../integrations';
import { slackClient } from '../../integrations/slack/SlackClient';
import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

import type { SlackClient } from '../../integrations/slack/SlackClient';

const SLACK_ID = 'slack';
const DEFAULT_RECOVERY_ATTEMPTS = 3;
const DEFAULT_RECOVERY_DELAY_MS = 1500;
const DEFAULT_VALIDATE_DATA_PULL = true;

function runtimeContext() {
  return {
    pid:         typeof process !== 'undefined' ? process.pid : null,
    nodeEnv:     typeof process !== 'undefined' ? process.env.NODE_ENV || null : null,
    processType: typeof process !== 'undefined' ? ((process as any).type || 'node') : 'unknown',
    platform:    typeof process !== 'undefined' ? process.platform : 'unknown',
    hasWindow:   typeof window !== 'undefined',
  };
}

export class SlackConnectionHealthWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const invocationId = `health-${ Date.now() }-${ Math.random().toString(36).slice(2, 8) }`;
    const startedAt = Date.now();
    const reinitializeIfNeeded = input?.reinitializeIfNeeded !== false;
    const validateAuth = input?.validateAuth !== false;
    const validateDataPull = input?.validateDataPull !== false;
    const recoveryAttempts = Math.max(1, Number(input?.recoveryAttempts ?? DEFAULT_RECOVERY_ATTEMPTS));
    const recoveryDelayMs = Math.max(0, Number(input?.recoveryDelayMs ?? DEFAULT_RECOVERY_DELAY_MS));

    console.log('[slack_connection_health] Invocation start', {
      invocationId,
      input,
      runtime: runtimeContext(),
    });

    try {
      const service = getIntegrationService();
      console.log('[slack_connection_health] Initializing IntegrationService...', { invocationId });
      await service.initialize();
      console.log('[slack_connection_health] IntegrationService initialized', { invocationId });

      const connectionStatus = await service.getConnectionStatus(SLACK_ID);
      const botToken = (await service.getIntegrationValue(SLACK_ID, 'bot_token'))?.value;
      const appToken = (
        (await service.getIntegrationValue(SLACK_ID, 'scopes_token'))?.value ||
        (await service.getIntegrationValue(SLACK_ID, 'app_token'))?.value ||
        (await service.getIntegrationValue(SLACK_ID, 'app_level_token'))?.value
      );

      console.log('[slack_connection_health] Integration values fetched', {
        invocationId,
        connectedInDb: !!connectionStatus?.connected,
        hasBotToken:   !!botToken,
        hasAppToken:   !!appToken,
      });

      console.log('[slack_connection_health] Pre-check state:', {
        invocationId,
        singletonIsConnected: slackClient.isConnected(),
        registryType:         typeof registry,
        registryHasGet:       typeof registry?.get,
        runtime:              runtimeContext(),
      });

      console.log('[slack_connection_health] Requesting registry.get(slack)...', { invocationId });
      let slack = await registry.get<SlackClient>(SLACK_ID);
      console.log('[slack_connection_health] registry.get result:', {
        invocationId,
        gotClient:     !!slack,
        clientType:    slack ? typeof slack : 'null',
        isSlackClient: slack === (slackClient as unknown),
      });

      let reinitialized = false;
      let authOk: boolean | null = null;
      let authError: string | null = null;
      let dataPullOk: boolean | null = null;
      let dataPullError: string | null = null;
      let dataPullCount: number | null = null;
      let recoveryAttemptCount = 0;
      let singletonConnected = slackClient.isConnected();
      let lastInitializeError = slackClient.getLastInitializeError?.() || null;

      const runAuthTest = async(client: SlackClient | null) => {
        if (!client || !validateAuth) {
          console.log('[slack_connection_health] Skipping auth.test', {
            invocationId,
            hasClient: !!client,
            validateAuth,
          });
          return;
        }
        try {
          console.log('[slack_connection_health] Running auth.test', { invocationId });
          const auth = await client.apiCall('auth.test', {});
          authOk = auth?.ok !== false;
          authError = authOk ? null : (auth?.error || 'auth_test_failed');
          console.log('[slack_connection_health] auth.test result', {
            invocationId,
            authOk,
            authError,
            team: auth?.team,
            user: auth?.user,
          });
        } catch (err) {
          authOk = false;
          authError = (err as Error).message;
          console.error('[slack_connection_health] auth.test threw', {
            invocationId,
            authError,
            error: err,
          });
        }
      };

      const runDataPullTest = async(client: SlackClient | null) => {
        if (!client || !validateDataPull) {
          console.log('[slack_connection_health] Skipping users.list pull', {
            invocationId,
            hasClient: !!client,
            validateDataPull,
          });
          return;
        }

        try {
          console.log('[slack_connection_health] Running users.list data pull', { invocationId });
          const response = await client.apiCall('users.list', { limit: 1 });
          const members = Array.isArray((response)?.members) ? (response).members : [];

          dataPullCount = members.length;
          dataPullOk = response?.ok !== false;
          dataPullError = dataPullOk ? null : (response?.error || 'users_list_failed');
          console.log('[slack_connection_health] users.list result', {
            invocationId,
            dataPullOk,
            dataPullError,
            dataPullCount,
          });
        } catch (err) {
          dataPullOk = false;
          dataPullError = (err as Error).message;
          dataPullCount = null;
          console.error('[slack_connection_health] users.list threw', {
            invocationId,
            dataPullError,
            error: err,
          });
        }
      };

      await runAuthTest(slack);
      await runDataPullTest(slack);

      const unhealthy = !slack || (validateAuth && authOk === false) || (validateDataPull && dataPullOk === false);
      if (unhealthy && reinitializeIfNeeded) {
        console.warn('[slack_connection_health] Entering recovery loop', {
          invocationId,
          unhealthy,
          reinitializeIfNeeded,
          recoveryAttempts,
          recoveryDelayMs,
        });
        for (let attempt = 1; attempt <= recoveryAttempts; attempt++) {
          recoveryAttemptCount = attempt;
          console.warn('[slack_connection_health] Recovery attempt start', {
            invocationId,
            attempt,
          });

          // Invalidate registry cache so factory runs fresh
          await registry.invalidate(SLACK_ID);
          console.log('[slack_connection_health] Registry invalidated', {
            invocationId,
            attempt,
          });

          // Try registry path first (runs factory with token injection)
          slack = await registry.get<SlackClient>(SLACK_ID);
          console.log('[slack_connection_health] Registry get after invalidate', {
            invocationId,
            attempt,
            gotClient:     !!slack,
            isSlackClient: slack === (slackClient as unknown),
          });

          // If registry still null, try direct singleton init as last resort
          if (!slack && slackClient) {
            console.warn(`[slack_connection_health] Registry returned null, attempting direct slackClient.initialize() (attempt ${ attempt })`);
            await slackClient.initialize();
            slack = slackClient as unknown as SlackClient;
            console.log('[slack_connection_health] Direct singleton init complete', {
              invocationId,
              attempt,
              singletonConnected:  slackClient.isConnected(),
              lastInitializeError: slackClient.getLastInitializeError?.() || null,
            });
          }

          authOk = null;
          authError = null;
          dataPullOk = null;
          dataPullError = null;
          dataPullCount = null;
          singletonConnected = slackClient.isConnected();
          lastInitializeError = slackClient.getLastInitializeError?.() || null;
          await runAuthTest(slack);
          await runDataPullTest(slack);

          if (slack && (!validateAuth || authOk !== false) && (!validateDataPull || dataPullOk !== false)) {
            console.log('[slack_connection_health] Recovery succeeded', {
              invocationId,
              attempt,
              singletonConnected,
              authOk,
              dataPullOk,
            });
            break;
          }

          if (attempt < recoveryAttempts && recoveryDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, recoveryDelayMs));
          }
        }

        reinitialized = true;
      }

      const healthy = !!slack && (!validateAuth || authOk !== false) && (!validateDataPull || dataPullOk !== false);
      const details = {
        invocationId,
        runtime:               runtimeContext(),
        durationMs:            Date.now() - startedAt,
        healthy,
        connectedInDb:         !!connectionStatus?.connected,
        singletonConnected,
        hasBotToken:           !!botToken,
        hasAppToken:           !!appToken,
        registryClientPresent: !!slack,
        validateAuth,
        authOk,
        authError,
        lastInitializeError,
        validateDataPull,
        dataPullOk,
        dataPullError,
        dataPullCount,
        reinitialized,
        reinitializeIfNeeded,
        recoveryAttemptCount,
        recoveryAttempts,
        recoveryDelayMs,
      };

      return {
        successBoolean: healthy,
        responseString: `Slack connection health check:\n${ JSON.stringify(details, null, 2) }`,
      };
    } catch (error) {
      console.error('[slack_connection_health] Invocation failed', {
        invocationId,
        runtime:    runtimeContext(),
        durationMs: Date.now() - startedAt,
        error,
      });
      return {
        successBoolean: false,
        responseString: `Slack connection health check failed: ${ (error as Error).message }`,
      };
    }
  }
}
