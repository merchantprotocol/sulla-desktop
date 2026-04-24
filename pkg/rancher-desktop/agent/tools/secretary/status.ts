import { BaseTool, ToolResponse } from '../base';

import { getSecretaryModeState } from '@pkg/main/secretaryModeState';

/*
  sulla secretary/status — report whether Secretary Mode is currently
  listening. Backed by the main-process cache in secretaryModeState.ts,
  which the Secretary Mode renderer updates whenever isListening flips.
*/
export class SecretaryStatusWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const state = getSecretaryModeState();

    return {
      successBoolean: true,
      responseString: JSON.stringify(state),
    };
  }
}
