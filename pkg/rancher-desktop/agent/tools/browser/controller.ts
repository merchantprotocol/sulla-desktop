import {
  graphBrowserOwnerSessionId,
  isGraphBrowserControllerEnabled,
  normalizeGraphBrowserArgs,
  type GraphBrowserTool,
} from '../../utils/graphBrowserController';
import { BaseTool, type ToolResponse } from '../base';
import { toolRegistry } from '../registry';

import { tabRegistry, type TabOwner } from '@pkg/main/browserTabs/TabRegistry';

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
    const assetId = typeof normalized.assetId === 'string' ? normalized.assetId : null;
    if (!assetId) throw new Error('Browser controller could not resolve its graph-owned tab.');

    const owner: TabOwner = { kind: 'graph', sessionId: graphBrowserOwnerSessionId(threadId) };
    const isOpening = tool === 'tab' && normalized.action !== 'remove';
    if (isOpening) {
      tabRegistry.claimOwner(assetId, owner);
    } else {
      tabRegistry.assertOwner(assetId, owner);
    }

    const result = await (async() => {
      try {
        const worker = await toolRegistry.createTool(tool);
        if (tool === 'tab') {
          if (typeof worker.setTabOwner !== 'function') {
            throw new Error('Browser tab worker does not support graph ownership binding.');
          }
          worker.setTabOwner(owner);
        }
        return await worker.invoke(normalized, this.state);
      } catch (error) {
        if (isOpening) tabRegistry.releaseOwnerReservation(assetId, owner);
        throw error;
      }
    })();
    if (isOpening && !result.success) {
      tabRegistry.releaseOwnerReservation(assetId, owner);
    }

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
