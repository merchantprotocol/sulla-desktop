import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';
import { postgresClient } from '../../database/PostgresClient';

interface WebhookNode {
  nodeId:       string;
  nodeName:     string;
  method:       string;
  customPath:   string;
  expectedPath: string;
  fullUrl:      string;
  namingIssue?: {
    severity:            'high' | 'medium';
    problem:             string;
    recommendation:      string;
    expectedUrlAfterFix: string;
  };
}

interface RegisteredWebhookRow {
  webhookPath: string;
  method:      string;
  node:        string;
}

/**
 * Activate Workflow Tool - Worker class for execution
 */
export class ActivateWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  private normalizeMethod(raw: unknown): string {
    const normalized = String(raw || '').trim().toUpperCase();
    if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(normalized)) {
      return normalized;
    }
    return 'POST';
  }

  private normalizePath(pathValue: unknown): string {
    return String(pathValue || '').trim().replace(/^\/+/, '').replace(/\/+$/g, '');
  }

  private toKebabCase(value: string): string {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
      return 'webhook-trigger';
    }

    const normalized = trimmed
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();

    return normalized || 'webhook-trigger';
  }

  private hasNamingIssue(nodeName: string): boolean {
    const trimmed = nodeName.trim();
    if (!trimmed) {
      return false;
    }

    const hasSpaces = /\s/.test(trimmed);
    const hasUppercase = /[A-Z]/.test(trimmed);
    const hasSpecialChars = /[^a-zA-Z0-9\s-]/.test(trimmed);
    return hasSpaces || hasUppercase || hasSpecialChars;
  }

  private getWebhookBaseUrl(): string {
    const configured = String(process.env.N8N_WEBHOOK_URL || '').trim();
    const fallback = 'http://127.0.0.1:30119';
    return (configured || fallback).replace(/\/+$/, '');
  }

  private extractWebhookNodes(workflow: any, workflowId: string): WebhookNode[] {
    const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
    const baseUrl = this.getWebhookBaseUrl();
    const webhookNodes: WebhookNode[] = [];

    for (const node of nodes) {
      const nodeType = String(node?.type || '').trim();
      if (nodeType !== 'n8n-nodes-base.webhook') {
        continue;
      }

      const parameters = node?.parameters && typeof node.parameters === 'object'
        ? node.parameters
        : {};
      const nodeName = String(node?.name || '').trim();
      const customPath = this.normalizePath((parameters).path || (parameters).webhookPath || '');
      const kebabNodeName = this.toKebabCase(nodeName);
      const expectedPath = `${ workflowId }/${ kebabNodeName }${ customPath ? `/${ customPath }` : '' }`;
      const fullUrl = `${ baseUrl }/webhook/${ expectedPath }`;

      const namingIssue = this.hasNamingIssue(nodeName)
        ? {
          severity:            /\s|[^a-zA-Z0-9\s-]/.test(nodeName) ? 'high' as const : 'medium' as const,
          problem:             `Node name '${ nodeName }' contains characters that may lead to URL encoding or unexpected webhook path normalization.`,
          recommendation:      `Rename node to kebab-case '${ kebabNodeName }'.`,
          expectedUrlAfterFix: `${ baseUrl }/webhook/${ workflowId }/${ kebabNodeName }${ customPath ? `/${ customPath }` : '' }`,
        }
        : undefined;

      webhookNodes.push({
        nodeId: String(node?.id || '').trim(),
        nodeName,
        method: this.normalizeMethod((parameters).httpMethod),
        customPath,
        expectedPath,
        fullUrl,
        ...(namingIssue ? { namingIssue } : {}),
      });
    }

    return webhookNodes;
  }

  private async getWorkflowWebhookRows(workflowId: string): Promise<RegisteredWebhookRow[]> {
    await postgresClient.initialize();

    const rows = await postgresClient.query<RegisteredWebhookRow>(
      `SELECT "webhookPath", "method", "node"
       FROM webhook_entity
       WHERE "workflowId" = $1
       ORDER BY "pathLength" DESC NULLS LAST, "webhookPath" ASC`,
      [workflowId],
    );

    return rows.map((row) => ({
      webhookPath: String(row.webhookPath || '').trim(),
      method:      String(row.method || 'POST').trim().toUpperCase() || 'POST',
      node:        String(row.node || '').trim(),
    })).filter((row) => row.webhookPath.length > 0);
  }

  private normalizeActivationOptions(input: any): { versionId?: string } | undefined {
    const rawVersionId = input?.versionId;
    if (rawVersionId === undefined || rawVersionId === null) {
      return undefined;
    }

    const versionId = String(rawVersionId).trim();
    return versionId ? { versionId } : undefined;
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const workflowId = String(input?.id || '').trim();
      if (!workflowId) {
        return {
          successBoolean: false,
          responseString: 'Error activating workflow: Workflow ID is required',
        };
      }

      const result = await service.activateWorkflow(workflowId, this.normalizeActivationOptions(input));
      const workflow = await service.getWorkflow(workflowId, true);
      const webhookNodes = this.extractWebhookNodes(workflow, workflowId);
      const registeredRows = webhookNodes.length > 0
        ? await this.getWorkflowWebhookRows(workflowId)
        : [];

      const webhooks = webhookNodes.map((node) => {
        const dbRow = registeredRows.find((row) => {
          const byPathAndMethod = this.normalizePath(row.webhookPath) === this.normalizePath(node.expectedPath) &&
            this.normalizeMethod(row.method) === node.method;
          const byNodeAndMethod = row.node &&
            node.nodeName &&
            row.node === node.nodeName &&
            this.normalizeMethod(row.method) === node.method;
          return byPathAndMethod || byNodeAndMethod;
        });

        const testCommand = node.method === 'GET'
          ? `curl -X GET ${ node.fullUrl }`
          : `curl -X ${ node.method } ${ node.fullUrl } -H 'Content-Type: application/json' -d '{"test": true}'`;

        return {
          nodeId:               node.nodeId,
          nodeName:             node.nodeName,
          method:               node.method,
          customPath:           node.customPath,
          expectedPath:         node.expectedPath,
          fullUrl:              node.fullUrl,
          registeredInDatabase: Boolean(dbRow),
          testCommand,
          ...(node.namingIssue ? { namingIssue: node.namingIssue } : {}),
        };
      });

      const expectedCount = webhooks.length;
      const registeredCount = webhooks.filter((w) => w.registeredInDatabase).length;
      const hasUnregisteredWebhook = webhooks.some((w) => w.registeredInDatabase === false);
      const webhookWarning = hasUnregisteredWebhook
        ? {
          critical: true,
          message:  registeredCount === 0
            ? '⚠️ Webhooks activated via API do NOT register until n8n container restart'
            : '⚠️ Some webhook triggers are not registered yet and may return 404 until n8n restart',
          registeredCount,
          expectedCount,
          action:        'docker restart sulla_n8n',
          verifyCommand: `docker exec sulla_postgres psql -U sulla -d sulla -c "SELECT \"webhookPath\", \"method\" FROM webhook_entity WHERE \"workflowId\" = '${ workflowId }';"`,
        }
        : null;

      const payload = {
        workflowId,
        workflowName: String(workflow?.name || result?.name || ''),
        activated:    true,
        versionId:    String(result?.versionId || input?.versionId || ''),
        webhooks,
        webhookWarning,
      };

      return {
        successBoolean: true,
        responseString: JSON.stringify(payload, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error activating workflow: ${ (error as Error).message }`,
      };
    }
  }
}
