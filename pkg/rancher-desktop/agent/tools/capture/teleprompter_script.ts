import {
  isTeleprompterOpen,
  openTeleprompterWindow,
  sendPosition,
  sendScript,
  whenTeleprompterReady,
} from '@pkg/main/teleprompterWindow';

import { BaseTool, ToolResponse } from '../base';

/**
 * Push script text (and optional starting index) to the floating
 * teleprompter. Opens the teleprompter if it's not already visible so
 * the agent doesn't have to chain two tool calls.
 */
export class TeleprompterScriptWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const text  = typeof input.text === 'string' ? input.text : '';
    const index = Number.isFinite(input.currentIndex) ? Math.max(0, Math.floor(input.currentIndex)) : 0;

    if (!text.trim()) {
      return { successBoolean: false, responseString: 'text is required.' };
    }

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return { successBoolean: false, responseString: 'text contained no words.' };
    }

    const wasOpen = isTeleprompterOpen();
    if (!wasOpen) openTeleprompterWindow();
    // Wait for did-finish-load before sending the script — otherwise the
    // renderer hasn't registered its IPC handlers yet and webContents.send
    // is silently dropped.
    if (!wasOpen) await whenTeleprompterReady();
    sendScript(words, Math.min(index, words.length - 1));
    if (index > 0) sendPosition(Math.min(index, words.length - 1));

    return {
      successBoolean: true,
      responseString: `Teleprompter script loaded — ${ words.length } words, cursor at index ${ Math.min(index, words.length - 1) }.`,
    };
  }
}
