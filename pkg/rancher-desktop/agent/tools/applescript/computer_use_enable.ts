import { BaseTool, ToolResponse } from '../base';

/** Retained only to fail closed for legacy callers; not cataloged. */
export class ComputerUseEnableWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: unknown): Promise<ToolResponse> {
    return { successBoolean: false, responseString: 'Only the human can enable applications in Computer Use Settings.' };
  }
}
