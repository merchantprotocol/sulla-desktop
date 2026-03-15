import { BaseTool, ToolResponse } from '../base';
import { createN8nService } from '../../services/N8nService';

type JsonRecord = Record<string, unknown>;

interface FlatConnection {
  targetNode:     string;
  inputIndex:     number;
  outputIndex:    number;
  connectionType: string;
  targetType:     string;
}

function toRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as JsonRecord;
}

function toConnectionArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) as JsonRecord[];
}

function flattenWorkflowConnections(connections: unknown): Record<string, Record<string, FlatConnection[]>> {
  const sourceMap = toRecord(connections);
  const flattened: Record<string, Record<string, FlatConnection[]>> = {};

  for (const [sourceNodeName, outputsByTypeRaw] of Object.entries(sourceMap)) {
    const outputsByType = toRecord(outputsByTypeRaw);
    const byOutputIndex: Record<string, FlatConnection[]> = {};

    for (const [connectionType, outputBucketsRaw] of Object.entries(outputsByType)) {
      const outputBuckets = Array.isArray(outputBucketsRaw)
        ? outputBucketsRaw
        : Object.values(toRecord(outputBucketsRaw));

      outputBuckets.forEach((targetsRaw, outputIndex) => {
        const targets = toConnectionArray(targetsRaw);
        if (!targets.length) {
          return;
        }

        const key = String(outputIndex);
        if (!Array.isArray(byOutputIndex[key])) {
          byOutputIndex[key] = [];
        }

        for (const target of targets) {
          byOutputIndex[key].push({
            targetNode:     String(target.node || '').trim(),
            inputIndex:     Number(target.index ?? 0),
            outputIndex,
            connectionType: String(connectionType || 'main'),
            targetType:     String(target.type || 'main'),
          });
        }
      });
    }

    flattened[sourceNodeName] = byOutputIndex;
  }

  return flattened;
}

export class GetWorkflowConnectionsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const service = await createN8nService();
      const workflow = await service.getWorkflowWithCredentials(input.id, input.excludePinnedData);
      const workflowRecord = toRecord(workflow);

      const response = {
        workflowId:   String(workflowRecord.id || input.id || ''),
        workflowName: String(workflowRecord.name || ''),
        connections:  flattenWorkflowConnections(workflowRecord.connections),
      };

      return {
        successBoolean: true,
        responseString: JSON.stringify(response, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting workflow connections: ${ (error as Error).message }`,
      };
    }
  }
}
