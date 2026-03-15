import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';
import { postgresClient } from '../../database/PostgresClient';

interface RegisteredWebhookRow {
  webhookPath: string;
  method:      string;
  workflowId:  string;
}

interface WorkflowWebhookInfo {
  nodeId:               string;
  nodeName:             string;
  method:               'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  customPath:           string;
  expectedPath:         string;
  fullUrl:              string;
  registeredInDatabase: boolean;
  testCommand:          string;
  namingIssue?: {
    severity:            'high' | 'medium';
    problem:             string;
    recommendation:      string;
    expectedUrlAfterFix: string;
  };
}

export class GetWorkflowWebhookUrlWorker extends BaseTool {
  name = '';
  description = '';

  private normalizeMethod(raw: unknown): 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' {
    const normalized = String(raw || '').trim().toUpperCase();
    if (normalized === 'GET') return 'GET';
    if (normalized === 'PUT') return 'PUT';
    if (normalized === 'DELETE') return 'DELETE';
    if (normalized === 'PATCH') return 'PATCH';
    return 'POST';
  }

  private normalizePath(pathValue: unknown): string {
    return String(pathValue || '').trim().replace(/^\/+/, '').replace(/\/+$/g, '');
  }

  private toKebabCase(nodeName: string): string {
    return String(nodeName || '')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private hasNamingIssue(nodeName: string): boolean {
    const trimmed = String(nodeName || '').trim();
    if (!trimmed) {
      return false;
    }

    return /\s/.test(trimmed) || /[A-Z]/.test(trimmed) || /[^a-zA-Z0-9\s-]/.test(trimmed);
  }

  private getWebhookBaseUrl(): string {
    const configured = String(process.env.N8N_WEBHOOK_URL || process.env.WEBHOOK_URL || '').trim();
    const fallback = 'http://127.0.0.1:30119';
    return (configured || fallback).replace(/\/+$/, '');
  }

  private async getWorkflowWebhookRows(workflowId: string): Promise<RegisteredWebhookRow[]> {
    await postgresClient.initialize();

    const rows = await postgresClient.query<RegisteredWebhookRow>(
      `SELECT "webhookPath", "method", "workflowId"
       FROM webhook_entity
       WHERE "workflowId" = $1`,
      [workflowId],
    );

    return rows.map((row) => ({
      webhookPath: this.normalizePath(row.webhookPath),
      method:      this.normalizeMethod(row.method),
      workflowId:  String(row.workflowId || '').trim(),
    })).filter((row) => row.webhookPath.length > 0);
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const workflowId = String(input?.workflowId || input?.id || '').trim();
      if (!workflowId) {
        return {
          successBoolean: false,
          responseString: JSON.stringify({ error: 'workflowId is required' }, null, 2),
        };
      }

      const service = await createN8nService();
      const workflow = await service.getWorkflow(workflowId, true);
      const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
      const baseUrl = this.getWebhookBaseUrl();
      const dbRows = await this.getWorkflowWebhookRows(workflowId);

      const webhooks: WorkflowWebhookInfo[] = nodes
        .filter((node: any) => String(node?.type || '').trim() === 'n8n-nodes-base.webhook')
        .map((node: any) => {
          const nodeId = String(node?.id || '').trim();
          const nodeName = String(node?.name || '').trim();
          const parameters = node?.parameters && typeof node.parameters === 'object' ? node.parameters : {};
          const method = this.normalizeMethod((parameters).httpMethod);
          const customPath = this.normalizePath((parameters).path || (parameters).webhookPath || '');
          const kebabNodeName = this.toKebabCase(nodeName) || 'webhook';
          const expectedPath = `${ workflowId }/${ kebabNodeName }${ customPath ? `/${ customPath }` : '' }`;
          const fullUrl = `${ baseUrl }/webhook/${ expectedPath }`;

          const registeredInDatabase = dbRows.some((row) => row.webhookPath === expectedPath && row.method === method);

          const testCommand = method === 'GET'
            ? `curl -X GET ${ fullUrl }`
            : `curl -X ${ method } ${ fullUrl } -H 'Content-Type: application/json' -d '{"test": true}'`;

          const namingIssue = this.hasNamingIssue(nodeName)
            ? {
              severity:            /\s|[^a-zA-Z0-9\s-]/.test(nodeName) ? 'high' as const : 'medium' as const,
              problem:             `Node name '${ nodeName }' contains spaces, mixed case, or special characters that can cause unexpected webhook path behavior.`,
              recommendation:      `Rename node to kebab-case '${ kebabNodeName }'.`,
              expectedUrlAfterFix: `${ baseUrl }/webhook/${ workflowId }/${ kebabNodeName }${ customPath ? `/${ customPath }` : '' }`,
            }
            : undefined;

          return {
            nodeId,
            nodeName,
            method,
            customPath,
            expectedPath,
            fullUrl,
            registeredInDatabase,
            testCommand,
            ...(namingIssue ? { namingIssue } : {}),
          };
        });

      const expectedCount = webhooks.length;
      const registeredCount = webhooks.filter((w: WorkflowWebhookInfo) => w.registeredInDatabase).length;
      const hasUnregisteredWebhook = webhooks.some((w: WorkflowWebhookInfo) => w.registeredInDatabase === false);

      const payload = {
        workflowId,
        workflowName:   String(workflow?.name || ''),
        webhooks,
        webhookWarning: hasUnregisteredWebhook
          ? {
            critical: true,
            message:  registeredCount === 0
              ? '⚠️ Webhooks activated via API do NOT register until n8n container restart'
              : '⚠️ Some webhook triggers are not registered yet and may return 404 until n8n restart',
            registeredCount,
            expectedCount,
            action:        'docker restart sulla_n8n',
            verifyCommand: `docker exec sulla_postgres psql -U sulla -d sulla -c "SELECT \"webhookPath\", \"method\", \"workflowId\" FROM webhook_entity WHERE \"workflowId\" = '${ workflowId }';"`,
          }
          : null,
      };

      return {
        successBoolean: true,
        responseString: JSON.stringify(payload, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting workflow webhook URLs: ${ (error as Error).message }`,
      };
    }
  }
}
