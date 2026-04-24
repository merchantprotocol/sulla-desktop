import { BaseTool, ToolResponse } from '../base';

import { getWindow } from '@pkg/window';

/**
 * UI Open Tab — bridge between the agent and the renderer's `agent-command`
 * IPC handler. Lets the agent open / focus a built-in app view (marketplace,
 * vault, integrations, routines, history, secretary, chat, etc.) from chat.
 *
 * The renderer's `onAgentCommand` handler in pages/AgentRouter.vue already
 * accepts `{ command: 'open-tab', mode }` and `{ command: 'open-url', url }`
 * shapes — this tool just dispatches them to the main-agent window.
 *
 * For extension web UIs (Twenty CRM, etc.), prefer `browser/tab` with the
 * extension's URL — those aren't built-in modes.
 */

const VALID_MODES = new Set([
  'chat',
  'marketplace',
  'integrations',
  'vault',
  'routines',
  'history',
  'secretary',
  'document',
  'browser',
  'welcome',
]);

export class UiOpenTabWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    let mode = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : '';

    // If only a URL is given, route as open-url (raw browser tab on that URL).
    if (url && !mode) {
      const sent = sendToAgentWindow({ command: 'open-url', url });
      if (!sent) {
        return {
          successBoolean: false,
          responseString: 'Main agent window not available — Sulla Desktop UI may not be ready yet.',
        };
      }
      return {
        successBoolean: true,
        responseString: `Opened browser tab on ${ url }.`,
      };
    }

    if (!mode) {
      return {
        successBoolean: false,
        responseString: `Missing required field: mode. Valid modes: ${ Array.from(VALID_MODES).join(', ') }. (Or pass a "url" to open a raw browser tab.)`,
      };
    }

    if (!VALID_MODES.has(mode)) {
      return {
        successBoolean: false,
        responseString: `Unknown tab mode "${ mode }". Valid modes: ${ Array.from(VALID_MODES).join(', ') }.`,
      };
    }

    const sent = sendToAgentWindow({ command: 'open-tab', mode });
    if (!sent) {
      return {
        successBoolean: false,
        responseString: 'Main agent window not available — Sulla Desktop UI may not be ready yet.',
      };
    }

    return {
      successBoolean: true,
      responseString: `Opened "${ mode }" tab in Sulla Desktop.`,
    };
  }
}

function sendToAgentWindow(payload: Record<string, unknown>): boolean {
  const agentWindow = getWindow('main-agent');
  if (!agentWindow) return false;

  const dispatch = () => agentWindow.webContents.send('agent-command', payload);

  if (agentWindow.webContents.isLoading()) {
    agentWindow.webContents.once('did-finish-load', dispatch);
  } else {
    dispatch();
  }

  agentWindow.focus();
  return true;
}
