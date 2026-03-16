import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Lima Start Tool - Worker class for execution
 */
export class LimaStartWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { instance } = input;

    const args = ['start', instance];

    try {
      const res = await runCommand('limactl', args, { timeoutMs: 300_000, maxOutputChars: 160_000 }); // Longer timeout for starting

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error starting Lima VM: ${ res.stderr || res.stdout }`,
        };
      }

      const responseString = `Lima VM ${ instance } started\nOutput:\n${ res.stdout }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing limactl start: ${ (error as Error).message }`,
      };
    }
  }
}
