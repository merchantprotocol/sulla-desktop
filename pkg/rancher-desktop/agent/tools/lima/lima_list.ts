import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Lima List Tool - Worker class for execution
 */
export class LimaListWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { json } = input;

    const args = ['list'];

    if (json) {
      args.push('--json');
    }

    try {
      const res = await runCommand('limactl', args, { timeoutMs: 60_000, maxOutputChars: 160_000 });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error listing Lima VMs: ${ res.stderr || res.stdout }`,
        };
      }

      const responseString = `Lima VM instances${ json ? ' (JSON format)' : '' }:\n${ res.stdout }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing limactl list: ${ (error as Error).message }`,
      };
    }
  }
}
