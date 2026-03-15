import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as JsonRecord;
}

export class GetExecutionLogWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const executionId = String(input.executionId || '').trim();
      if (!executionId) {
        return { successBoolean: false, responseString: 'executionId is required' };
      }

      const service = await createN8nService();
      const execution = await service.getExecution(executionId);
      const executionRecord = asRecord(execution);
      const data = asRecord(executionRecord.data);
      const resultData = asRecord(data.resultData);
      const runData = asRecord(resultData.runData);

      const nodes = Object.entries(runData).map(([nodeName, runsRaw]) => {
        const runs = Array.isArray(runsRaw)
          ? runsRaw.map((run: any, index: number) => {
            const runRecord = asRecord(run);
            const runError = asRecord(runRecord.error);
            return {
              runIndex:      index,
              startTime:     runRecord.startTime || null,
              executionTime: runRecord.executionTime ?? null,
              error:         runRecord.error || (Object.keys(runError).length ? runError : null),
              data:          runRecord.data ?? null,
              source:        runRecord.source ?? null,
            };
          })
          : [];

        return {
          nodeName,
          runCount: runs.length,
          runs,
        };
      });

      const response = {
        executionId: String(executionRecord.id || executionId),
        workflowId:  String(executionRecord.workflowId || '').trim() || null,
        status:      String(executionRecord.status || '').trim() || 'unknown',
        startedAt:   executionRecord.startedAt || null,
        stoppedAt:   executionRecord.stoppedAt || null,
        mode:        executionRecord.mode || null,
        finished:    executionRecord.finished ?? null,
        retryOf:     executionRecord.retryOf ?? null,
        waitTill:    executionRecord.waitTill || null,
        globalError: resultData.error || null,
        nodeCount:   nodes.length,
        nodes,
      };

      return {
        successBoolean: true,
        responseString: JSON.stringify(response, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting execution log: ${ (error as Error).message }`,
      };
    }
  }
}
