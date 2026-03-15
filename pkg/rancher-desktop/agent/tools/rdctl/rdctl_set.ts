import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Rdctl Set Tool - Worker class for execution
 */
export class RdctlSetWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { field, value } = input;

    const args = ['set', field, value.toString()];

    try {
      const res = await runCommand('rdctl', args, { timeoutMs: 300_000, maxOutputChars: 160_000 }); // Longer timeout for restart

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error setting Sulla Desktop setting: ${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Sulla Desktop setting updated successfully: ${ field } = ${ value }\nOutput:\n${ res.stdout }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing rdctl set: ${ (error as Error).message }`,
      };
    }
  }
}
