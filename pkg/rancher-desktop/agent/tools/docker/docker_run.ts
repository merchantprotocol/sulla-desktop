import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Docker Run Tool - Worker class for execution
 */
export class DockerRunWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { image, name, command, options } = input;

    const args = ['run'];
    if (options) {
      args.push(...options.split(' '));
    }
    if (name) {
      args.push('--name', name);
    }
    args.push(image);
    if (command) {
      args.push(...command.split(' '));
    }

    try {
      const res = await runCommand('docker', args, { timeoutMs: 120000, maxOutputChars: 160_000 }); // Longer timeout for running containers

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error running docker run: ${ res.stderr || res.stdout }`,
        };
      }

      const containerId = res.stdout.trim();
      return {
        successBoolean: true,
        responseString: `Container started successfully. Image: ${ image }, Container ID: ${ containerId }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing docker run: ${ (error as Error).message }`,
      };
    }
  }
}
