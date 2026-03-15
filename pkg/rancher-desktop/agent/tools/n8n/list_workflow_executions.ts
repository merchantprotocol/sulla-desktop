import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as JsonRecord;
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIso(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  const n = asNumber(value);
  if (n === null) {
    return null;
  }

  try {
    return new Date(n).toISOString();
  } catch {
    return null;
  }
}

function computeDurationMs(execution: JsonRecord): number | null {
  const explicit = asNumber(execution.duration);
  if (explicit !== null) {
    return explicit;
  }

  const startedAt = Date.parse(String(execution.startedAt || execution.startTime || ''));
  const stoppedAt = Date.parse(String(execution.stoppedAt || execution.finishedAt || execution.endTime || ''));

  if (!Number.isNaN(startedAt) && !Number.isNaN(stoppedAt) && stoppedAt >= startedAt) {
    return stoppedAt - startedAt;
  }

  return null;
}

function extractErrorMessage(execution: JsonRecord): string | null {
  const direct = String(execution.error || execution.errorMessage || '').trim();
  if (direct) {
    return direct;
  }

  const data = asRecord(execution.data);
  const resultData = asRecord(data.resultData);
  const runData = asRecord(resultData.runData);

  for (const nodeRuns of Object.values(runData)) {
    if (!Array.isArray(nodeRuns)) {
      continue;
    }
    for (const run of nodeRuns) {
      const runRecord = asRecord(run);
      const runError = asRecord(runRecord.error);
      const runMessage = String(runError.message || runRecord.error || '').trim();
      if (runMessage) {
        return runMessage;
      }
    }
  }

  const executionError = asRecord(resultData.error);
  const nestedMessage = String(executionError.message || '').trim();
  if (nestedMessage) {
    return nestedMessage;
  }

  return null;
}

export class ListWorkflowExecutionsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const workflowId = String(input.workflowId || '').trim();
      if (!workflowId) {
        return { successBoolean: false, responseString: 'workflowId is required' };
      }

      const limit = typeof input.limit === 'number'
        ? Math.max(1, Math.min(250, Math.floor(input.limit)))
        : 20;

      const service = await createN8nService();
      const executionsRaw = await service.getExecutions({
        workflowId,
        limit,
      });

      const executions = Array.isArray(executionsRaw)
        ? executionsRaw
        : (Array.isArray((executionsRaw as any)?.data) ? (executionsRaw as any).data : []);

      const summary = executions.map((item: any) => {
        const execution = asRecord(item);
        return {
          id:           String(execution.id || '').trim(),
          status:       String(execution.status || '').trim() || 'unknown',
          startedAt:    toIso(execution.startedAt || execution.startTime),
          durationMs:   computeDurationMs(execution),
          errorMessage: extractErrorMessage(execution),
        };
      });

      return {
        successBoolean: true,
        responseString: JSON.stringify({
          workflowId,
          limit,
          count:      summary.length,
          executions: summary,
        }, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error listing workflow executions: ${ (error as Error).message }`,
      };
    }
  }
}
