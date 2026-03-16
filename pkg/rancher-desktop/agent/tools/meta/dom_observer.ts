import { BaseTool, ToolResponse } from '../base';

/**
 * Passive DOM observation tool.
 *
 * The agent never needs to call this directly — the system automatically
 * injects dom_observer tool results when open browser tabs emit DOM changes.
 * If the agent wants to stop receiving these events, it should close the
 * browser tab via browser_tab(action='remove', assetId='...').
 */
export class DomObserverWorker extends BaseTool {
  name = 'dom_observer';
  description = '';

  protected async _validatedCall(_input: Record<string, unknown>): Promise<ToolResponse> {
    return {
      successBoolean: true,
      responseString:
        'dom_observer is passive — you do not need to call it. ' +
        'DOM events are delivered automatically while browser tabs are open. ' +
        'To stop receiving events for a tab, close it with browser_tab(action=\'remove\', assetId=\'...\').',
    };
  }
}
