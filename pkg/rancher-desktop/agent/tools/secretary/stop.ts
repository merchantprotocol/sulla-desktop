import { BaseTool, ToolResponse } from '../base';

import { getSecretaryModeState } from '@pkg/main/secretaryModeState';
import { getWindow } from '@pkg/window';

/*
  sulla secretary/stop — end the active Secretary Mode session.

  Flow: dispatch `agent-command` with `{ command: 'stop-secretary' }`.
  AgentRouter.vue broadcasts a `sulla:secretary-stop` window event that
  the mounted SecretaryMode.vue picks up and runs its endSession().

  No-op if Secretary Mode isn't currently listening.
*/
export class SecretaryStopWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const current = getSecretaryModeState();

    if (!current.listening) {
      return {
        successBoolean: true,
        responseString: 'Secretary Mode is not listening — nothing to stop.',
      };
    }

    const sent = sendToAgentWindow({ command: 'stop-secretary' });

    if (!sent) {
      return {
        successBoolean: false,
        responseString: 'Main agent window not available — Sulla Desktop UI may not be ready yet.',
      };
    }

    return {
      successBoolean: true,
      responseString: 'Stopping Secretary Mode — session is ending.',
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

  return true;
}
