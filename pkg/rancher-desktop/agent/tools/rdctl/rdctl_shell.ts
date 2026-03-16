import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Rdctl Shell Tool - Worker class for execution
 */
export class RdctlShellWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { command } = input;

    const args = ['shell'];

    if (command) {
      args.push('--', command);
    }

    try {
      const res = await runCommand('rdctl', args, { timeoutMs: command ? 60_000 : 300_000, maxOutputChars: 160_000 });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error executing shell command in VM: ${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Shell command executed in Sulla Desktop VM${ command ? `: ${ command }` : ' (interactive)' }\nOutput:\n${ res.stdout }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing rdctl shell: ${ (error as Error).message }`,
      };
    }
  }
}
