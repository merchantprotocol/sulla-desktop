import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Rdctl Extension Tool - Worker class for execution
 */
export class RdctlExtensionWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { subcommand, args = [] } = input;

    const cmdArgs = ['extension', subcommand, ...args];

    try {
      const res = await runCommand('rdctl', cmdArgs, { timeoutMs: 120_000, maxOutputChars: 160_000 });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error executing extension command: ${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Extension command executed: ${ subcommand }${ args.length ? ` ${ args.join(' ') }` : '' }\nOutput:\n${ res.stdout }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing rdctl extension: ${ (error as Error).message }`,
      };
    }
  }
}
