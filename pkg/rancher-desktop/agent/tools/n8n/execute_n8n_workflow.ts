import { BaseTool, ToolResponse } from '../base';
import { getN8nRuntime } from '../../services/N8nRuntimeService';
import { createN8nService } from '../../services/N8nService';
import { WebhookEntityModel } from '../../database/models/WebhookEntityModel';

export class ExecuteN8nWorkflowBridgeWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const logPrefix = '[execute_n8n_workflow]';
    const gatewayWorkflowName = '🚀 Universal n8n Trigger Gateway (Minimal 2026)';
    const gatewayWebhookPath = 'universal-gateway';
    const safeStringify = (value: unknown): string => {
      try {
        return JSON.stringify(value, null, 2);
      } catch (error) {
        return `[unserializable: ${ error instanceof Error ? error.message : String(error) }]`;
      }
    };

    const truncate = (value: string, limit = 4000): string => {
      if (value.length <= limit) {
        return value;
      }
      return `${ value.slice(0, limit) }... [truncated ${ value.length - limit } chars]`;
    };

    const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

    try {
      console.log(`${ logPrefix } start`, truncate(safeStringify({ input })));

      const toRecord = (value: unknown): Record<string, unknown> => (
        value && typeof value === 'object' && !Array.isArray(value)
          ? value as Record<string, unknown>
          : {}
      );

      const getWorkflowId = (value: unknown): string => {
        const record = toRecord(value);
        const nestedData = toRecord(record.data);
        return String(record.id || nestedData.id || '').trim();
      };

      const toBoolean = (value: unknown): boolean => {
        if (typeof value === 'boolean') {
          return value;
        }

        if (typeof value === 'number') {
          return value !== 0;
        }

        if (typeof value === 'string') {
          const normalized = value.trim().toLowerCase();
          return normalized === 'true' || normalized === '1' || normalized === 'yes';
        }

        return false;
      };

      const isWorkflowActive = (value: unknown): boolean => {
        const record = toRecord(value);
        const nestedData = toRecord(record.data);
        return toBoolean(record.active ?? nestedData.active);
      };

      const isWorkflowArchived = (value: unknown): boolean => {
        const record = toRecord(value);
        const nestedData = toRecord(record.data);
        return toBoolean(record.archived ?? record.isArchived ?? nestedData.archived ?? nestedData.isArchived);
      };

      const getNodes = (value: unknown): Record<string, unknown>[] => {
        const record = toRecord(value);
        const nestedData = toRecord(record.data);
        const nodes = Array.isArray(record.nodes)
          ? record.nodes
          : Array.isArray(nestedData.nodes)
            ? nestedData.nodes
            : [];

        return nodes
          .filter((node): node is Record<string, unknown> => !!node && typeof node === 'object' && !Array.isArray(node));
      };

      const workflowNeedsGatewayRepair = (value: unknown): boolean => {
        const nodes = getNodes(value);
        const webhookNode = nodes.find((node) => String(node.type || '').trim() === 'n8n-nodes-base.webhook');
        const executeNode = nodes.find((node) => String(node.type || '').trim() === 'n8n-nodes-base.executeWorkflow');

        const webhookParams = toRecord(webhookNode?.parameters);
        const executeParams = toRecord(executeNode?.parameters);

        const webhookPath = String(webhookParams.path || '').trim();
        const executeMode = String(executeParams.mode || '').trim().toLowerCase();
        const executeWorkflowIdExpr = String(executeParams.workflowId || '').trim();

        return webhookPath !== gatewayWebhookPath ||
          executeMode !== 'id' ||
          !executeWorkflowIdExpr;
      };

      const service = await createN8nService();
      const { bridge } = await getN8nRuntime();
      console.log(`${ logPrefix } runtime acquired`);

      const workflowId = String(input.workflowId || '').trim();
      if (!workflowId) {
        console.warn(`${ logPrefix } missing workflowId`);
        return { successBoolean: false, responseString: 'workflowId is required' };
      }

      let resolvedWorkflowId = workflowId;
      let clonedFromWorkflowId: string | null = null;

      const sourceWorkflow = await service.getWorkflow(workflowId, true);
      if (isWorkflowArchived(sourceWorkflow)) {
        const sourceRecord = toRecord(sourceWorkflow);
        const sourceName = String(sourceRecord.name || workflowId).trim();
        const cloneName = `${ sourceName } (Auto copy ${ new Date().toISOString() })`;
        const clonePayload = {
          name:        cloneName,
          nodes:       Array.isArray(sourceRecord.nodes) ? deepClone(sourceRecord.nodes) : [],
          connections: sourceRecord.connections && typeof sourceRecord.connections === 'object' && !Array.isArray(sourceRecord.connections)
            ? deepClone(sourceRecord.connections)
            : {},
          settings: sourceRecord.settings && typeof sourceRecord.settings === 'object' && !Array.isArray(sourceRecord.settings)
            ? deepClone(sourceRecord.settings)
            : {},
          ...(sourceRecord.staticData !== undefined ? { staticData: deepClone(sourceRecord.staticData) } : {}),
        };

        console.log(`${ logPrefix } source workflow archived, cloning for execution`, {
          workflowId,
          cloneName,
        });

        const clonedWorkflow = await service.createWorkflow(clonePayload as any);
        const clonedWorkflowId = getWorkflowId(clonedWorkflow);
        if (!clonedWorkflowId) {
          throw new Error(`Failed to clone archived workflow ${ workflowId }: missing cloned id`);
        }

        resolvedWorkflowId = clonedWorkflowId;
        clonedFromWorkflowId = workflowId;
      }

      const mode = String(input.mode || 'async').trim().toLowerCase();
      const waitForCompletion = mode === 'sync';
      console.log(`${ logPrefix } mode resolved`, { mode, waitForCompletion, workflowId: resolvedWorkflowId });

      const data = input.data && typeof input.data === 'object' && !Array.isArray(input.data)
        ? input.data
        : {};
      console.log(`${ logPrefix } run payload`, truncate(safeStringify(data)));

      const gatewayPayload = {
        name:  gatewayWorkflowName,
        nodes: [
          {
            parameters: {
              httpMethod:   'POST',
              path:         gatewayWebhookPath,
              responseMode: 'lastNode',
              options:      {},
            },
            id:          '1',
            name:        'Webhook',
            type:        'n8n-nodes-base.webhook',
            typeVersion: 2,
            position:    [240, 300],
          },
          {
            parameters: {
              mode:         'id',
              workflowId:   '={{ $json.body.workflowId ?? $json.body.id ?? $query.workflowId ?? $query.id ?? $json.workflowId ?? $json.id }}',
              source:       'database',
              workflowData: '={{ $json.body.data ?? $query.data ?? $json.body ?? $json }}',
              options:      {
                waitForExecution: true,
              },
            },
            id:          '2',
            name:        'Execute Target Workflow',
            type:        'n8n-nodes-base.executeWorkflow',
            typeVersion: 1,
            position:    [460, 300],
          },
        ],
        connections: {
          Webhook: {
            main: [
              [
                {
                  node:  'Execute Target Workflow',
                  type:  'main',
                  index: 0,
                },
              ],
            ],
          },
        },
        settings: {
          executionOrder: 'v1',
        },
      };

      console.log(`${ logPrefix } finding gateway workflow`, { gatewayWorkflowName });
      const workflows = await service.getWorkflows({ limit: 250 });
      const sameNameWorkflows = workflows.filter(workflow => {
        const name = String(workflow.name || '').trim();
        return name === gatewayWorkflowName;
      });

      let gatewayWorkflow = sameNameWorkflows.find(workflow => !isWorkflowArchived(workflow)) || null;

      let gatewayCreated = false;
      if (!gatewayWorkflow) {
        console.log(`${ logPrefix } gateway workflow not found, creating`, truncate(safeStringify(gatewayPayload)));
        gatewayWorkflow = await service.createWorkflow(gatewayPayload);
        gatewayCreated = true;
      } else {
        const existingGatewayWorkflowId = getWorkflowId(gatewayWorkflow);
        if (existingGatewayWorkflowId) {
          const existingGatewayWorkflow = await service.getWorkflow(existingGatewayWorkflowId, true);
          if (workflowNeedsGatewayRepair(existingGatewayWorkflow)) {
            console.log(`${ logPrefix } gateway workflow found but invalid, applying repair`, { gatewayWorkflowId: existingGatewayWorkflowId });
            gatewayWorkflow = await service.updateWorkflow(existingGatewayWorkflowId, gatewayPayload as any);
          } else {
            console.log(`${ logPrefix } gateway workflow found and valid, keeping existing definition`, { gatewayWorkflowId: existingGatewayWorkflowId });
            gatewayWorkflow = existingGatewayWorkflow;
          }
        }
      }

      const gatewayWorkflowId = getWorkflowId(gatewayWorkflow);
      if (!gatewayWorkflowId) {
        throw new Error(`Gateway workflow resolved without id: ${ safeStringify(gatewayWorkflow) }`);
      }

      await WebhookEntityModel.findOrCreate({
        workflowId:  gatewayWorkflowId,
        webhookPath: gatewayWebhookPath,
      });

      if (!isWorkflowActive(gatewayWorkflow)) {
        console.log(`${ logPrefix } gateway workflow inactive, activating`, { gatewayWorkflowId });
        await service.activateWorkflow(gatewayWorkflowId);
      }

      const webhookBase = bridge.getAppRootUrl();
      if (!webhookBase) {
        throw new Error('Unable to resolve n8n app root URL for gateway webhook invocation');
      }

      const webhookUrl = new URL(`webhook/${ gatewayWebhookPath }`, webhookBase);
      const webhookPayload = {
        id:         resolvedWorkflowId,
        workflowId: resolvedWorkflowId,
        data,
      };

      const webhookUrlString = webhookUrl.toString();
      console.log(`${ logPrefix } invoking gateway webhook`, { webhookUrl, gatewayWorkflowId, waitForCompletion });
      console.log(`${ logPrefix } gateway webhook payload`, truncate(safeStringify(webhookPayload)));

      const webhookResponse = await fetch(webhookUrlString, {
        method:      'POST',
        credentials: 'include',
        headers:     {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(webhookPayload),
      });

      const responseText = await webhookResponse.text();
      let parsedWebhookResponse: unknown = responseText;
      try {
        parsedWebhookResponse = responseText ? JSON.parse(responseText) : {};
      } catch {
        parsedWebhookResponse = responseText;
      }

      if (!webhookResponse.ok) {
        let targetExecutionError: Record<string, unknown> | null = null;

        if (webhookResponse.status === 500) {
          try {
            const recentExecutions = await service.getExecutions({
              workflowId:  resolvedWorkflowId,
              includeData: true,
              limit:       5,
            });

            const failedExecution = recentExecutions.find((execution: any) => {
              const status = String(execution?.status || '').toLowerCase();
              return status === 'error' || status === 'failed' || status === 'canceled';
            }) || recentExecutions[0];

            if (failedExecution) {
              const resultData = failedExecution?.data?.resultData || {};
              const executionError = resultData?.error || failedExecution?.data?.error || failedExecution?.error || null;

              targetExecutionError = {
                executionId: String(failedExecution?.id || ''),
                status:      String(failedExecution?.status || ''),
                startedAt:   failedExecution?.startedAt,
                stoppedAt:   failedExecution?.stoppedAt,
                finishedAt:  failedExecution?.finishedAt,
                error:       executionError,
              };
            }
          } catch (executionLookupError) {
            targetExecutionError = {
              lookupFailed: true,
              message:      executionLookupError instanceof Error ? executionLookupError.message : String(executionLookupError),
            };
          }
        }

        console.error(`${ logPrefix } gateway webhook failed`, {
          status:     webhookResponse.status,
          statusText: webhookResponse.statusText,
          body:       truncate(responseText),
          targetExecutionError,
        });
        return {
          successBoolean: false,
          responseString: JSON.stringify(
            webhookResponse.status === 500 && targetExecutionError?.error
              ? {
                error:            'Target workflow execution failed',
                targetWorkflowId: resolvedWorkflowId,
                targetExecutionError,
              }
              : {
                error:            `Gateway webhook failed ${ webhookResponse.status } ${ webhookResponse.statusText }`,
                gatewayWorkflowId,
                targetWorkflowId: resolvedWorkflowId,
                webhookUrl:       webhookUrlString,
                responseBody:     parsedWebhookResponse,
                targetExecutionError,
              },
            null,
            2,
          ),
        };
      }

      console.log(`${ logPrefix } gateway webhook success`, {
        gatewayWorkflowId,
        gatewayCreated,
        webhookUrl: webhookUrlString,
      });

      return {
        successBoolean: true,
        responseString: JSON.stringify({
          inputWorkflowId:    workflowId,
          executedWorkflowId: resolvedWorkflowId,
          clonedFromWorkflowId,
          gatewayWorkflowId,
          gatewayCreated,
          webhookUrl:         webhookUrlString,
          mode,
          result:             parsedWebhookResponse,
        }, null, 2),
      };
    } catch (error) {
      const errorDetails = error instanceof Error
        ? {
          message: error.message,
          stack:   error.stack,
          cause:   error.cause,
        }
        : {
          message: String(error),
          stack:   undefined,
          cause:   undefined,
        };

      console.error(`${ logPrefix } unexpected failure`, {
        error: errorDetails,
      });

      return {
        successBoolean: false,
        responseString: JSON.stringify({
          error:   'Failed to execute workflow via gateway',
          details: errorDetails,
        }, null, 2),
      };
    }
  }
}
