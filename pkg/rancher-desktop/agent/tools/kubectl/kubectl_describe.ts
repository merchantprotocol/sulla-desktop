import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Kubectl Describe Tool - Worker class for execution
 */
export class KubectlDescribeWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { resource, name, namespace } = input;

    const args = ['describe', resource, name];

    if (namespace) {
      args.push('-n', namespace);
    }

    try {
      const res = await runCommand('kubectl', args, { timeoutMs: 60_000, maxOutputChars: 160_000 });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error describing resource: ${ res.stderr || res.stdout }`,
        };
      }

      const responseString = `Description of ${ resource } ${ name }${ namespace ? ` in namespace ${ namespace }` : '' }:\n${ res.stdout }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing kubectl describe: ${ (error as Error).message }`,
      };
    }
  }
}
