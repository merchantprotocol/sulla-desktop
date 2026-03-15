import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';
import { createN8nService } from '../../services/N8nService';
import { postgresClient } from '../../database/PostgresClient';

interface RestartInput {
  container?:      string;
  timeoutMs?:      number;
  pollIntervalMs?: number;
  includeLogs?:    boolean;
}

const DEFAULT_CONTAINER = 'sulla_n8n';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_LOG_TAIL = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

export class RestartN8nContainerWorker extends BaseTool {
  name = '';
  description = '';

  private async getContainerRunning(container: string): Promise<boolean> {
    const inspect = await runCommand(
      'docker',
      ['inspect', '-f', '{{.State.Running}}', container],
      { timeoutMs: 20_000, maxOutputChars: 16_000 },
    );

    if (inspect.exitCode !== 0) {
      return false;
    }

    return String(inspect.stdout || '').trim().toLowerCase() === 'true';
  }

  private async getWebhookRegistrationStatus(): Promise<{
    totalRegistered:            number;
    activeWorkflowWebhookCount: number;
    gatewayWebhookRegistered:   boolean;
    sampleWebhookPaths:         string[];
  }> {
    await postgresClient.initialize();

    const totalRow = await postgresClient.queryOne<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM webhook_entity',
      [],
    );

    const activeWorkflowRow = await postgresClient.queryOne<{ count: number }>(
      `SELECT COUNT(DISTINCT we."workflowId")::int AS count
       FROM webhook_entity we
       JOIN workflow_entity wf ON wf.id = we."workflowId"
       WHERE wf.active = true`,
      [],
    );

    const gatewayRow = await postgresClient.queryOne<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM webhook_entity WHERE "webhookPath" = $1',
      ['universal-gateway'],
    );

    const sampleRows = await postgresClient.query<{ webhookPath: string }>(
      'SELECT "webhookPath" FROM webhook_entity ORDER BY "pathLength" DESC NULLS LAST, "webhookPath" ASC LIMIT 10',
      [],
    );

    return {
      totalRegistered:            Number(totalRow?.count || 0),
      activeWorkflowWebhookCount: Number(activeWorkflowRow?.count || 0),
      gatewayWebhookRegistered:   Number(gatewayRow?.count || 0) > 0,
      sampleWebhookPaths:         sampleRows.map((row) => String(row.webhookPath || '')).filter(Boolean),
    };
  }

  private async getRecentContainerLogs(container: string, sinceIso: string): Promise<string> {
    const logs = await runCommand(
      'docker',
      ['logs', '--since', sinceIso, '--tail', String(DEFAULT_LOG_TAIL), container],
      { timeoutMs: 20_000, maxOutputChars: 120_000 },
    );

    if (logs.exitCode !== 0) {
      return (logs.stderr || logs.stdout || '').trim();
    }

    return (logs.stdout || '').trim();
  }

  protected async _validatedCall(input: RestartInput): Promise<ToolResponse> {
    const container = String(input?.container || DEFAULT_CONTAINER).trim() || DEFAULT_CONTAINER;
    const timeoutMs = asPositiveInteger(input?.timeoutMs, DEFAULT_TIMEOUT_MS);
    const pollIntervalMs = asPositiveInteger(input?.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    const includeLogs = asBoolean(input?.includeLogs, true);

    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();

    try {
      const restartResult = await runCommand(
        'docker',
        ['restart', container],
        { timeoutMs: 60_000, maxOutputChars: 50_000 },
      );

      if (restartResult.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: JSON.stringify({
            error:    'Failed to restart n8n container',
            container,
            exitCode: restartResult.exitCode,
            details:  (restartResult.stderr || restartResult.stdout || '').trim(),
          }, null, 2),
        };
      }

      const service = await createN8nService();
      let ready = false;
      let running = false;
      let health = false;

      while (Date.now() - startedAt < timeoutMs) {
        running = await this.getContainerRunning(container);

        try {
          health = await service.healthCheck();
        } catch {
          health = false;
        }

        if (running && health) {
          ready = true;
          break;
        }

        await sleep(pollIntervalMs);
      }

      const elapsedMs = Date.now() - startedAt;
      const recentLogs = includeLogs ? await this.getRecentContainerLogs(container, startedAtIso) : '';

      let webhookRegistrationStatus: {
        totalRegistered:            number;
        activeWorkflowWebhookCount: number;
        gatewayWebhookRegistered:   boolean;
        sampleWebhookPaths:         string[];
      } | null = null;
      let webhookRegistrationError: string | null = null;

      try {
        webhookRegistrationStatus = await this.getWebhookRegistrationStatus();
      } catch (error) {
        webhookRegistrationError = error instanceof Error ? error.message : String(error);
      }

      const registrationLogMatches = recentLogs
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /webhook|register/i.test(line))
        .slice(0, 20);

      const payload = {
        container,
        ready,
        checks: {
          containerRunning:   running,
          healthCheckPassing: health,
          elapsedMs,
          timeoutMs,
        },
        webhookRegistration: {
          status: webhookRegistrationStatus
            ? (webhookRegistrationStatus.totalRegistered > 0 ? 'registered' : 'none_registered')
            : 'unknown',
          ...webhookRegistrationStatus,
          error: webhookRegistrationError,
        },
        registrationLogs: registrationLogMatches,
      };

      if (!ready) {
        return {
          successBoolean: false,
          responseString: JSON.stringify({
            ...payload,
            error: 'n8n container restart completed, but readiness checks did not pass before timeout',
          }, null, 2),
        };
      }

      return {
        successBoolean: true,
        responseString: JSON.stringify(payload, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: JSON.stringify({
          error:   'Unexpected failure while restarting n8n container',
          container,
          details: error instanceof Error ? error.message : String(error),
        }, null, 2),
      };
    }
  }
}
