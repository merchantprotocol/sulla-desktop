import { createGitHubOctokit } from './octokit';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Read File Tool - Worker class for execution
 */
export class GitHubReadFileWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo, path, ref } = input;

    const octokit = await createGitHubOctokit(this.executionContext);

    try {
      const response = await octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      const data = response.data;
      if (Array.isArray(data)) {
        return {
          successBoolean: false,
          responseString: `Path '${ path }' is a directory, not a file.`,
        };
      }

      if (data.type !== 'file') {
        return {
          successBoolean: false,
          responseString: `Path '${ path }' is not a file.`,
        };
      }

      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      const responseString = `File: ${ data.path }
Size: ${ data.size } bytes
SHA: ${ data.sha }
Encoding: ${ data.encoding }
Ref: ${ ref || 'default' }

Content:
${ content }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error reading file: ${ (error as Error).message }`,
      };
    }
  }
}
