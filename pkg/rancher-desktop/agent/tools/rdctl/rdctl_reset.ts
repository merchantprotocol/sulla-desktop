import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Rdctl Reset Tool - Worker class for execution
 */
export class RdctlResetWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const res = await runCommand('rdctl', ['reset'], { timeoutMs: 300_000, maxOutputChars: 160_000 }); // Longer timeout for reset

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error resetting Sulla Desktop: ${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Sulla Desktop reset successfully.\nOutput:\n${ res.stdout }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing rdctl reset: ${ (error as Error).message }`,
      };
    }
  }
}
