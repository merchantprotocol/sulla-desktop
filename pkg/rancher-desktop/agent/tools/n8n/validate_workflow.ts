import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';
import { postgresClient } from '../../database/PostgresClient';

type JsonRecord = Record<string, any>;

interface ConnectionEdge {
  sourceNode:        string;
  sourceOutputIndex: number;
  sourceType:        string;
  targetNode:        string;
  targetInputIndex:  number;
  targetType:        string;
}

interface WebhookIssue {
  nodeId:               string;
  nodeName:             string;
  issue:                'webhook_path_naming' | 'webhook_not_registered' | 'webhook_path_collision';
  severity:             'critical' | 'high' | 'medium';
  expectedPath:         string;
  actualRegisteredPath: string | null;
  problem:              string;
  recommendation:       string;
}

interface WebhookEntityRow {
  webhookPath: string;
  method:      string;
  node:        string | null;
  workflowId:  string;
}

function toKebabCase(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  return trimmed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function normalizeWebhookPath(pathValue: unknown): string {
  return String(pathValue || '').trim().replace(/^\/+/, '').replace(/\/+$/g, '');
}

function normalizeMethod(methodValue: unknown): string {
  return String(methodValue || 'POST').trim().toUpperCase() || 'POST';
}

function hasWebhookNamingRisk(nodeName: string): boolean {
  const trimmed = nodeName.trim();
  if (!trimmed) {
    return false;
  }

  const hasSpaces = /\s/.test(trimmed);
  const hasUppercase = /[A-Z]/.test(trimmed);
  const hasSpecialChars = /[^a-zA-Z0-9\s-]/.test(trimmed);
  return hasSpaces || hasUppercase || hasSpecialChars;
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as JsonRecord;
}

function asEdgeArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) as JsonRecord[];
}

function collectEdges(connectionsRaw: unknown): {
  edges:             ConnectionEdge[];
  brokenConnections: { sourceNode: string; issue: string; detail?: string }[];
} {
  const edges: ConnectionEdge[] = [];
  const brokenConnections: { sourceNode: string; issue: string; detail?: string }[] = [];
  const connections = asRecord(connectionsRaw);

  for (const [sourceNode, byTypeRaw] of Object.entries(connections)) {
    const byType = asRecord(byTypeRaw);

    for (const [sourceType, outputBucketsRaw] of Object.entries(byType)) {
      const outputBuckets = Array.isArray(outputBucketsRaw)
        ? outputBucketsRaw
        : Object.values(asRecord(outputBucketsRaw));

      outputBuckets.forEach((targetsRaw, sourceOutputIndex) => {
        if (!Array.isArray(targetsRaw)) {
          brokenConnections.push({
            sourceNode,
            issue:  'malformed_output_bucket',
            detail: `Expected array at ${ sourceType }[${ sourceOutputIndex }]`,
          });
          return;
        }

        const targets = asEdgeArray(targetsRaw);
        for (const target of targets) {
          const targetNode = String(target.node || '').trim();
          if (!targetNode) {
            brokenConnections.push({
              sourceNode,
              issue:  'missing_target_node',
              detail: `Missing target node at ${ sourceType }[${ sourceOutputIndex }]`,
            });
            continue;
          }

          edges.push({
            sourceNode,
            sourceOutputIndex,
            sourceType:       String(sourceType || 'main'),
            targetNode,
            targetInputIndex: Number(target.index ?? 0),
            targetType:       String(target.type || 'main'),
          });
        }
      });
    }
  }

  return { edges, brokenConnections };
}

export class ValidateWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const workflowId = String(input.workflowId || '').trim();
      if (!workflowId) {
        throw new Error('workflowId is required');
      }

      const service = await createN8nService();
      const workflow = await service.getWorkflowWithCredentials(workflowId, true);

      const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
      const connections = workflow?.connections;
      const credentials = Array.isArray(workflow?.credentials) ? workflow.credentials : [];

      const nodeNames = new Set(
        nodes.map((node: any) => String(node?.name || '').trim()).filter(Boolean),
      );

      const credentialIds = new Set(
        credentials.map((cred: any) => String(cred?.id || '').trim()).filter(Boolean),
      );
      const credentialNames = new Set(
        credentials.map((cred: any) => String(cred?.name || '').trim()).filter(Boolean),
      );

      const { edges, brokenConnections } = collectEdges(connections);

      for (const edge of edges) {
        if (!nodeNames.has(edge.sourceNode)) {
          brokenConnections.push({
            sourceNode: edge.sourceNode,
            issue:      'source_node_missing',
            detail:     `Source node ${ edge.sourceNode } not found in workflow nodes`,
          });
        }
        if (!nodeNames.has(edge.targetNode)) {
          brokenConnections.push({
            sourceNode: edge.sourceNode,
            issue:      'target_node_missing',
            detail:     `Target node ${ edge.targetNode } not found`,
          });
        }
      }

      const inboundCount = new Map<string, number>();
      const outboundCount = new Map<string, number>();
      for (const edge of edges) {
        outboundCount.set(edge.sourceNode, (outboundCount.get(edge.sourceNode) || 0) + 1);
        inboundCount.set(edge.targetNode, (inboundCount.get(edge.targetNode) || 0) + 1);
      }

      const floatingNodes = nodes
        .filter((node: any) => {
          const name = String(node?.name || '').trim();
          if (!name) {
            return false;
          }
          return (inboundCount.get(name) || 0) === 0 && (outboundCount.get(name) || 0) === 0;
        })
        .map((node: any) => ({
          id:   String(node?.id || '').trim(),
          name: String(node?.name || '').trim(),
          type: String(node?.type || '').trim(),
        }));

      const nodesWithNoTypeConfigured = nodes
        .filter((node: any) => !String(node?.type || '').trim())
        .map((node: any) => ({
          id:   String(node?.id || '').trim(),
          name: String(node?.name || '').trim(),
        }));

      const missingCredentials = nodes
        .map((node: any) => {
          const required = asRecord(node?.credentials);
          const missing: string[] = [];

          for (const [credentialType, credentialRefRaw] of Object.entries(required)) {
            const credentialRef = asRecord(credentialRefRaw);
            const id = String(credentialRef.id || '').trim();
            const name = String(credentialRef.name || '').trim();

            if (!id && !name) {
              missing.push(`${ credentialType }:missing_reference`);
              continue;
            }

            const idExists = id ? credentialIds.has(id) : false;
            const nameExists = name ? credentialNames.has(name) : false;

            if (!idExists && !nameExists) {
              missing.push(`${ credentialType }:${ id || name }`);
            }
          }

          if (!missing.length) {
            return null;
          }

          return {
            nodeId:   String(node?.id || '').trim(),
            nodeName: String(node?.name || '').trim(),
            nodeType: String(node?.type || '').trim(),
            missing,
          };
        })
        .filter(Boolean);

      const webhookIssues: WebhookIssue[] = [];
      const webhookNodes = nodes.filter((node: any) => String(node?.type || '').trim() === 'n8n-nodes-base.webhook');
      const workflowActive = Boolean((workflow)?.active);

      let webhookRowsByWorkflow: WebhookEntityRow[] = [];
      if (webhookNodes.length > 0) {
        await postgresClient.initialize();
        webhookRowsByWorkflow = await postgresClient.query<WebhookEntityRow>(
          `SELECT "webhookPath", "method", "node", "workflowId"
           FROM webhook_entity
           WHERE "workflowId" = $1`,
          [workflowId],
        );
      }

      for (const webhookNode of webhookNodes) {
        const nodeId = String(webhookNode?.id || '').trim();
        const nodeName = String(webhookNode?.name || '').trim();
        const kebabNodeName = toKebabCase(nodeName);
        const customPath = normalizeWebhookPath(webhookNode?.parameters?.path);
        const expectedPath = `${ workflowId }/${ kebabNodeName }/${ customPath }`;
        const method = normalizeMethod(webhookNode?.parameters?.httpMethod);

        const matchingRegistration = webhookRowsByWorkflow.find((row) => {
          const rowNode = String(row.node || '').trim();
          if (rowNode && nodeName && rowNode === nodeName) {
            return true;
          }

          return normalizeMethod(row.method) === method && normalizeWebhookPath(row.webhookPath) === expectedPath;
        }) || null;

        const actualRegisteredPath = matchingRegistration ? normalizeWebhookPath(matchingRegistration.webhookPath) : null;

        if (hasWebhookNamingRisk(nodeName) || kebabNodeName !== nodeName) {
          webhookIssues.push({
            nodeId,
            nodeName,
            issue:          'webhook_path_naming',
            severity:       'high',
            expectedPath,
            actualRegisteredPath,
            problem:        `Node name '${ nodeName }' may produce unexpected webhook registration path segments after normalization.`,
            recommendation: `Rename node to kebab-case '${ kebabNodeName || 'webhook-trigger' }' to avoid casing/special character path mismatches.`,
          });
        }

        if (workflowActive && !matchingRegistration) {
          webhookIssues.push({
            nodeId,
            nodeName,
            issue:          'webhook_not_registered',
            severity:       'critical',
            expectedPath,
            actualRegisteredPath,
            problem:        'Workflow is active but no webhook_entity registration was found for this webhook node/path.',
            recommendation: 'Restart n8n container; webhook registrations are applied at startup and may not refresh on API activation alone.',
          });
        }

        const collisions = await postgresClient.query<{ workflowId: string; webhookPath: string; method: string }>(
          `SELECT "workflowId", "webhookPath", "method"
           FROM webhook_entity
           WHERE "webhookPath" = $1
             AND UPPER(COALESCE("method", 'POST')) = $2`,
          [expectedPath, method],
        );

        const uniqueWorkflowIds = Array.from(new Set(collisions.map((row) => String(row.workflowId || '').trim()).filter(Boolean)));
        if (uniqueWorkflowIds.length > 1) {
          webhookIssues.push({
            nodeId,
            nodeName,
            issue:          'webhook_path_collision',
            severity:       'critical',
            expectedPath,
            actualRegisteredPath,
            problem:        `Multiple workflows share webhookPath + method (${ expectedPath } ${ method }), which prevents reliable webhook registration/routing.`,
            recommendation: 'Use a unique webhook path per workflow/node (for example include workflow purpose or node slug in path).',
          });
        }
      }

      const report = {
        workflowId:   String(workflow?.id || workflowId),
        workflowName: String(workflow?.name || ''),
        summary:      {
          nodeCount:                  nodes.length,
          edgeCount:                  edges.length,
          floatingNodeCount:          floatingNodes.length,
          missingCredentialNodeCount: missingCredentials.length,
          brokenConnectionCount:      brokenConnections.length,
          nodesWithNoTypeCount:       nodesWithNoTypeConfigured.length,
          webhookIssueCount:          webhookIssues.length,
        },
        floatingNodes,
        missingCredentials,
        brokenConnections,
        nodesWithNoTypeConfigured,
        webhookIssues,
        valid:
          floatingNodes.length === 0 &&
          missingCredentials.length === 0 &&
          brokenConnections.length === 0 &&
          nodesWithNoTypeConfigured.length === 0 &&
          webhookIssues.length === 0,
      };

      return {
        successBoolean: true,
        responseString: JSON.stringify(report, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error validating workflow: ${ (error as Error).message }`,
      };
    }
  }
}
