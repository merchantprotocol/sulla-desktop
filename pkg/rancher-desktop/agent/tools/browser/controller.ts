import { isGraphBrowserControllerEnabled, normalizeGraphBrowserArgs, type GraphBrowserTool } from '../../utils/graphBrowserController';
import { BaseTool, type ToolResponse } from '../base';
import { toolRegistry } from '../registry';

/** Provider-neutral scheduled-graph delegation to Sulla's in-app Browser. */
export class GraphBrowserControllerWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: Record<string, unknown>): Promise<ToolResponse> {
    if (!isGraphBrowserControllerEnabled(this.state)) {
      return {
        successBoolean: false,
        responseString: 'Browser controller is disabled for this graph.',
      };
    }

    const tool = input.tool as GraphBrowserTool;
    const args = (input.args && typeof input.args === 'object' && !Array.isArray(input.args))
      ? input.args as Record<string, unknown>
      : {};
    const threadId = String(this.state.metadata.threadId ?? this.state.metadata.conversationId ?? 'graph');
    const lastAssetId = typeof this.state.metadata.__browserControllerLastAssetId === 'string'
      ? this.state.metadata.__browserControllerLastAssetId
      : null;
    const normalized = normalizeGraphBrowserArgs(tool, args, threadId, lastAssetId);
    const worker = await toolRegistry.createTool(tool);
    const result = await worker.invoke(normalized, this.state);

    const assetId = typeof normalized.assetId === 'string' ? normalized.assetId : null;
    if (result.success && assetId) {
      if (tool === 'tab' && normalized.action === 'remove') {
        if (lastAssetId === assetId) delete this.state.metadata.__browserControllerLastAssetId;
      } else {
        this.state.metadata.__browserControllerLastAssetId = assetId;
      }
    }

    return {
      successBoolean: result.success,
      responseString: JSON.stringify(result, null, 2),
    };
  }
}
