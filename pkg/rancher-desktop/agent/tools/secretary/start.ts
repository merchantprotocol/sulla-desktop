import { BaseTool, ToolResponse } from '../base';

import { getSecretaryModeState } from '@pkg/main/secretaryModeState';
import { getWindow } from '@pkg/window';

/*
  sulla secretary/start — open (or focus) a Secretary Mode tab and auto-
  start the listening session. This closes the gap where the keyboard
  shortcut / tray menu only opened the tab but left the user to click
  START manually.

  Flow: dispatch `agent-command` with `{ command: 'start-secretary' }`
  to the main agent window. AgentRouter.vue creates a secretary tab (or
  focuses an existing one) and broadcasts a `sulla:secretary-start`
  window event. SecretaryMode.vue listens for that event and calls its
  own startSession() — the same code path the START button runs.

  Idempotent: if a session is already listening, reports that and does
  nothing. Does NOT create a second listening tab.
*/
export class SecretaryStartWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const current = getSecretaryModeState();

    if (current.listening) {
      return {
        successBoolean: true,
        responseString: 'Secretary Mode is already listening.',
      };
    }

    const sent = sendToAgentWindow({ command: 'start-secretary' });

    if (!sent) {
      return {
        successBoolean: false,
        responseString: 'Main agent window not available — Sulla Desktop UI may not be ready yet.',
      };
    }

    return {
      successBoolean: true,
      responseString: 'Starting Secretary Mode — listening session is opening. If the microphone permission prompt appears, approve it to begin transcription.',
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
