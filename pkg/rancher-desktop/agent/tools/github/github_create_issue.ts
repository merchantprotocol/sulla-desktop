import { createGitHubOctokit } from './octokit';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Create Issue Tool
 */
export class GitHubCreateIssueWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo, title, body } = input;
    const labels: string[] = Array.isArray(input.labels) ? input.labels : [];
    const assignees: string[] = Array.isArray(input.assignees) ? input.assignees : [];

    const octokit = await createGitHubOctokit(this.executionContext);

    try {
      const response = await octokit.issues.create({
        owner,
        repo,
        title,
        body:      body || '',
        labels:    labels.length > 0 ? labels : undefined,
        assignees: assignees.length > 0 ? assignees : undefined,
      });

      const issue = response.data;
      return {
        successBoolean: true,
        responseString: `Issue created: #${ issue.number } "${ issue.title }"\nURL: ${ issue.html_url }\nState: ${ issue.state }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error creating issue: ${ (error as Error).message }`,
      };
    }
  }
}
