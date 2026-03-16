import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Kubectl Apply Tool - Worker class for execution
 */
export class KubectlApplyWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { file, namespace, dryRun } = input;

    const args = ['apply', '-f', file];

    if (namespace) {
      args.push('-n', namespace);
    }

    if (dryRun && dryRun !== 'none') {
      args.push('--dry-run', dryRun);
    }

    try {
      const res = await runCommand('kubectl', args, { timeoutMs: 60_000, maxOutputChars: 160_000 });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error applying manifest: ${ res.stderr || res.stdout }`,
        };
      }

      const responseString = `Applied manifest from ${ file }${ namespace ? ` in namespace ${ namespace }` : '' }${ dryRun && dryRun !== 'none' ? ` (dry-run: ${ dryRun })` : '' }\nOutput:\n${ res.stdout }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing kubectl apply: ${ (error as Error).message }`,
      };
    }
  }
}
