import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Rdctl Start Tool - Worker class for execution
 */
export class RdctlStartWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const res = await runCommand('rdctl', ['start'], { timeoutMs: 300_000, maxOutputChars: 160_000 }); // Longer timeout for starting

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error starting Sulla Desktop: ${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Sulla Desktop started successfully.\nOutput:\n${ res.stdout }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing rdctl start: ${ (error as Error).message }`,
      };
    }
  }
}
