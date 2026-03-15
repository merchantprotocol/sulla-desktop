import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';
import { getN8nRuntime } from '../../services/N8nRuntimeService';

/**
 * Create Workflow Tool - Worker class for execution
 */
export class CreateWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  private readonly webhookNodeType = 'n8n-nodes-base.webhook';
  private readonly respondNodeType = 'n8n-nodes-base.respondToWebhook';
  private readonly riskyLastNodeTypes = new Set([
    'n8n-nodes-base.set',
    'n8n-nodes-base.code',
    'n8n-nodes-base.function',
    'n8n-nodes-base.functionItem',
  ]);

  private normalizeSaveDataSuccessExecution(value: unknown): 'none' | 'all' {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'none' ? 'none' : 'all';
  }

  private parseJsonIfString(value: any, field: string): any {
    if (typeof value !== 'string') {
      return value;
    }

    try {
      return JSON.parse(value);
    } catch (error) {
      throw new Error(`Invalid JSON for ${ field }: ${ (error as Error).message }`);
    }
  }

  private normalizeWorkflowPayload(input: any): any {
    const payload = { ...input };

    payload.nodes = this.parseJsonIfString(payload.nodes, 'nodes');
    payload.connections = this.parseJsonIfString(payload.connections, 'connections');
    payload.settings = this.parseJsonIfString(payload.settings, 'settings') || {};
    payload.shared = this.parseJsonIfString(payload.shared, 'shared');
    payload.staticData = this.parseJsonIfString(payload.staticData, 'staticData');

    if (!Array.isArray(payload.nodes)) {
      throw new Error('Invalid workflow payload: nodes must be an array.');
    }

    payload.nodes = payload.nodes.map((node: any, index: number) => {
      const parsedNode = this.parseJsonIfString(node, `nodes[${ index }]`);
      if (typeof parsedNode !== 'object' || parsedNode === null || Array.isArray(parsedNode)) {
        throw new Error(`Invalid workflow payload: nodes[${ index }] must be an object.`);
      }
      return parsedNode;
    });

    if (typeof payload.connections !== 'object' || payload.connections === null || Array.isArray(payload.connections)) {
      throw new Error('Invalid workflow payload: connections must be an object.');
    }

    if (typeof payload.settings !== 'object' || payload.settings === null || Array.isArray(payload.settings)) {
      throw new Error('Invalid workflow payload: settings must be an object.');
    }

    if (payload.settings.saveDataSuccessExecution !== undefined) {
      payload.settings.saveDataSuccessExecution = this.normalizeSaveDataSuccessExecution(payload.settings.saveDataSuccessExecution);
    }

    if (payload.shared !== undefined && !Array.isArray(payload.shared)) {
      throw new Error('Invalid workflow payload: shared must be an array when provided.');
    }

    return payload;
  }

  private extractWebhookNodes(nodes: any[]): any[] {
    return nodes.filter((node) => String(node?.type || '').trim() === this.webhookNodeType);
  }

  private hasRespondToWebhookNode(nodes: any[]): boolean {
    return nodes.some((node) => String(node?.type || '').trim() === this.respondNodeType);
  }

  private buildAdjacency(connections: Record<string, any>): Map<string, string[]> {
    const adjacency = new Map<string, string[]>();
    for (const [sourceNode, connectionValue] of Object.entries(connections || {})) {
      const mainBranches = Array.isArray(connectionValue?.main) ? connectionValue.main : [];
      const downstream: string[] = [];
      for (const branch of mainBranches) {
        const branchItems = Array.isArray(branch) ? branch : [];
        for (const edge of branchItems) {
          const target = String(edge?.node || '').trim();
          if (target) {
            downstream.push(target);
          }
        }
      }
      adjacency.set(sourceNode, downstream);
    }
    return adjacency;
  }

  private getDownstreamNodeNames(startNodeName: string, adjacency: Map<string, string[]>): Set<string> {
    const visited = new Set<string>();
    const queue = [...(adjacency.get(startNodeName) || [])];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      const next = adjacency.get(current) || [];
      for (const nodeName of next) {
        if (!visited.has(nodeName)) {
          queue.push(nodeName);
        }
      }
    }

    return visited;
  }

  private applyWebhookSafety(payload: any): { payload: any; warnings: string[]; hasWebhook: boolean } {
    const warnings: string[] = [];
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    const webhookNodes = this.extractWebhookNodes(nodes);
    if (webhookNodes.length === 0) {
      return { payload, warnings, hasWebhook: false };
    }

    const adjacency = this.buildAdjacency(payload.connections || {});
    const nodesByName = new Map<string, any>(nodes.map((node: any) => [String(node?.name || ''), node]));

    for (const webhookNode of webhookNodes) {
      const webhookName = String(webhookNode?.name || '').trim();
      const parameters = webhookNode.parameters && typeof webhookNode.parameters === 'object'
        ? webhookNode.parameters
        : (webhookNode.parameters = {});
      const currentMode = String(parameters.responseMode || 'lastNode').trim();
      const downstreamNames = this.getDownstreamNodeNames(webhookName, adjacency);
      const hasRiskyDownstream = Array.from(downstreamNames).some((nodeName) => {
        const downstreamNode = nodesByName.get(nodeName);
        const type = String(downstreamNode?.type || '').trim();
        return this.riskyLastNodeTypes.has(type);
      });

      if (currentMode === 'lastNode' && hasRiskyDownstream) {
        parameters.responseMode = 'responseNode';
        warnings.push(`Auto-fixed webhook responseMode from 'lastNode' to 'responseNode' for reliability (node: ${ webhookName || webhookNode?.id || 'unknown' }).`);
      }

      // Ensure webhookId is set to match path for clean URL registration
      const webhookPath = String(parameters.path || '').trim();
      if (webhookPath && !webhookNode.webhookId) {
        webhookNode.webhookId = webhookPath;
        warnings.push(`Auto-set webhookId to '${ webhookPath }' for clean URL registration (node: ${ webhookName || webhookNode?.id || 'unknown' }).`);
      }
    }

    const hasRespondNode = this.hasRespondToWebhookNode(nodes);
    const webhookInResponseNodeMode = webhookNodes.some((node) => String(node?.parameters?.responseMode || '').trim() === 'responseNode');
    if (webhookInResponseNodeMode && !hasRespondNode) {
      warnings.push('Webhook uses responseNode mode but no Respond to Webhook node found - responses may fail.');
    }

    return { payload, warnings, hasWebhook: true };
  }

  private hasResponseData(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0 && value.trim() !== '{}';
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
    return true;
  }

  private executionHasRunData(execution: any): boolean {
    const runData = execution?.data?.resultData?.runData;
    if (!runData || typeof runData !== 'object') {
      return false;
    }
    return Object.keys(runData).length > 0;
  }

  private async buildWebhookValidation(service: any, workflow: any): Promise<{ tested: boolean; endpoints: { url: string; testResult: string; executionId: string | null; issue: string | null }[] }> {
    const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
    const webhookNodes = this.extractWebhookNodes(nodes);
    const isActive = !!workflow?.active;
    if (!isActive || webhookNodes.length === 0) {
      return { tested: false, endpoints: [] };
    }

    const { bridge } = await getN8nRuntime();
    const appRootUrl = bridge.getAppRootUrl();
    if (!appRootUrl) {
      return { tested: false, endpoints: [] };
    }

    const endpoints: { url: string; testResult: string; executionId: string | null; issue: string | null }[] = [];
    const baselineExecutions = await service.getExecutions({ workflowId: String(workflow.id || ''), includeData: false, limit: 20 });
    const baselineExecutionIds = new Set((baselineExecutions || []).map((execution: any) => String(execution?.id || '')));

    for (const webhookNode of webhookNodes) {
      const path = String(webhookNode?.parameters?.path || webhookNode?.parameters?.webhookPath || '').trim();
      if (!path) {
        endpoints.push({
          url:         '',
          testResult:  'failed',
          executionId: null,
          issue:       `Webhook node ${ String(webhookNode?.name || webhookNode?.id || 'unknown') } is missing path/webhookPath`,
        });
        continue;
      }

      const url = new URL(`webhook/${ path }`, appRootUrl).toString();
      let parsedBody: unknown = null;

      try {
        const response = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ __sullaWebhookValidation: true, timestamp: new Date().toISOString() }),
        });

        const responseText = await response.text();
        try {
          parsedBody = responseText ? JSON.parse(responseText) : {};
        } catch {
          parsedBody = responseText;
        }

        const executions = await service.getExecutions({ workflowId: String(workflow.id || ''), includeData: true, limit: 20 });
        const newExecution = (executions || []).find((execution: any) => !baselineExecutionIds.has(String(execution?.id || '')));
        const executionId = newExecution?.id ? String(newExecution.id) : null;
        const executedNodes = this.executionHasRunData(newExecution);
        const responseHasData = this.hasResponseData(parsedBody);

        let issue: string | null = null;
        let testResult = response.ok ? 'passed' : 'failed';
        if (executedNodes && !responseHasData) {
          issue = 'Webhook returns empty response despite node execution - likely responseMode mismatch';
          testResult = 'warning';
        } else if (!response.ok) {
          issue = `HTTP ${ response.status } ${ response.statusText }`;
        }

        endpoints.push({ url, testResult, executionId, issue });
        if (executionId) {
          baselineExecutionIds.add(executionId);
        }
      } catch (error) {
        endpoints.push({
          url,
          testResult:  'failed',
          executionId: null,
          issue:       error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { tested: true, endpoints };
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const normalizedPayload = this.normalizeWorkflowPayload(input);
      const { payload, warnings, hasWebhook } = this.applyWebhookSafety(normalizedPayload);
      const workflow = await service.createWorkflow(payload);
      const webhookValidation = hasWebhook
        ? await this.buildWebhookValidation(service, workflow)
        : { tested: false, endpoints: [] };

      const responseString = JSON.stringify({
        message:  'Workflow created successfully',
        workflow: {
          id:              workflow.id,
          name:            workflow.name,
          active:          !!workflow.active,
          createdAt:       workflow.createdAt,
          updatedAt:       workflow.updatedAt,
          nodeCount:       workflow.nodes?.length || 0,
          connectionCount: Object.keys(workflow.connections || {}).length,
        },
        warnings,
        webhookValidation,
      }, null, 2);

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error creating workflow: ${ (error as Error).message }`,
      };
    }
  }
}
