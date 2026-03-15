import { BaseTool, ToolResponse } from '../base';
import { postgresClient } from '../../database/PostgresClient';
import { runCommand } from '../util/CommandRunner';

type DiagnoseWebhookInput = {
  workflowId: string;
  container?: string;
  endpointTimeoutMs?: number;
};

type WebhookRow = {
  webhookPath: string;
  method: string;
};

const DEFAULT_N8N_CONTAINER = 'sulla_n8n';
const DEFAULT_ENDPOINT_TIMEOUT_MS = 15_000;
const N8N_BASE_URL = 'http://127.0.0.1:30119';

function asPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferHttpMethod(value: string): 'GET' | 'POST' | 'PUT' | 'PATCH' {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'GET') return 'GET';
  if (normalized === 'PUT') return 'PUT';
  if (normalized === 'PATCH') return 'PATCH';
  return 'POST';
}

export class DiagnoseWebhookWorker extends BaseTool {
  name = '';
  description = '';

  private async getWorkflowActive(workflowId: string): Promise<boolean> {
    await postgresClient.initialize();

    const row = await postgresClient.queryOne<{ active: boolean | null }>(
      'SELECT active FROM workflow_entity WHERE id = $1 LIMIT 1',
      [workflowId],
    );

    return Boolean(row?.active);
  }

  private async getWebhook(workflowId: string): Promise<WebhookRow | null> {
    await postgresClient.initialize();

    const row = await postgresClient.queryOne<WebhookRow>(
      `SELECT "webhookPath", "method"
       FROM webhook_entity
       WHERE "workflowId" = $1
       ORDER BY "pathLength" DESC NULLS LAST, "webhookPath" ASC
       LIMIT 1`,
      [workflowId],
    );

    if (!row?.webhookPath) {
      return null;
    }

    return {
      webhookPath: String(row.webhookPath).trim(),
      method: String(row.method || 'POST').trim() || 'POST',
    };
  }

  private async testEndpoint(webhookPath: string, method: string, timeoutMs: number): Promise<{ status: number | null; error: string | null; testedUrl: string }> {
    const cleanPath = webhookPath.replace(/^\/+/, '');
    const testedUrl = `${N8N_BASE_URL}/webhook/${cleanPath}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const resolvedMethod = inferHttpMethod(method);

    try {
      const init: RequestInit = {
        method: resolvedMethod,
        signal: controller.signal,
      };

      if (resolvedMethod !== 'GET') {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify({ diagnostic: true, source: 'diagnose_webhook' });
      }

      const response = await fetch(testedUrl, init);
      return {
        status: response.status,
        error: null,
        testedUrl,
      };
    } catch (error) {
      return {
        status: null,
        error: error instanceof Error ? error.message : String(error),
        testedUrl,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async getRelevantLogs(container: string, workflowId: string, webhookPath: string | null): Promise<string[]> {
    const logs = await runCommand(
      'docker',
      ['logs', '--tail', '400', container],
      { timeoutMs: 20_000, maxOutputChars: 160_000 },
    );

    const raw = `${logs.stdout || ''}\n${logs.stderr || ''}`;
    if (!raw.trim()) {
      return [];
    }

    const workflowRegex = new RegExp(escapeRegex(workflowId), 'i');
    const webhookRegex = webhookPath ? new RegExp(escapeRegex(webhookPath), 'i') : null;
    const genericRegex = /(webhook|register|error|failed|cannot\s+find|not\s+found|timeout)/i;

    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => workflowRegex.test(line) || (webhookRegex ? webhookRegex.test(line) : false) || genericRegex.test(line))
      .slice(-5);
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const workflowId = String(input?.workflowId || '').trim();
    if (!workflowId) {
      return {
        successBoolean: false,
        responseString: JSON.stringify({ error: 'workflowId is required' }, null, 2),
      };
    }

    const container = String(input?.container || DEFAULT_N8N_CONTAINER).trim() || DEFAULT_N8N_CONTAINER;
    const endpointTimeoutMs = asPositiveInteger(input?.endpointTimeoutMs, DEFAULT_ENDPOINT_TIMEOUT_MS);

    try {
      const [workflowActive, webhook] = await Promise.all([
        this.getWorkflowActive(workflowId),
        this.getWebhook(workflowId),
      ]);

      const databaseRegistered = Boolean(webhook?.webhookPath);
      const endpointTest = databaseRegistered
        ? await this.testEndpoint(webhook!.webhookPath, webhook!.method, endpointTimeoutMs)
        : { status: null, error: 'No webhook_entity row found for workflow', testedUrl: '' };

      const n8nLogs = await this.getRelevantLogs(container, workflowId, webhook?.webhookPath ?? null);

      const result = {
        workflowId,
        workflowActive,
        databaseRegistered,
        webhookPath: webhook?.webhookPath ?? null,
        endpointTest: {
          status: endpointTest.status,
          error: endpointTest.error,
          testedUrl: endpointTest.testedUrl,
          method: webhook ? inferHttpMethod(webhook.method) : null,
        },
        n8nLogs,
      };

      return {
        successBoolean: databaseRegistered && endpointTest.error === null,
        responseString: JSON.stringify(result, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: JSON.stringify({
          workflowId,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2),
      };
    }
  }
}
