import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Rdctl Info Tool - Worker class for execution
 */
export class RdctlInfoWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const res = await runCommand('rdctl', ['info'], { timeoutMs: 60_000, maxOutputChars: 160_000 });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error getting rdctl info: ${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Sulla Desktop Information:\n${ res.stdout }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing rdctl info: ${ (error as Error).message }`,
      };
    }
  }
}
