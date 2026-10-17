import { createGitHubOctokit } from './octokit';
import { BaseTool, ToolResponse } from '../base';

export class GitHubGetRepoWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo  = typeof input.repo === 'string' ? input.repo.trim() : '';

    if (!owner || !repo) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo.' };
    }

    const octokit = await createGitHubOctokit(this.executionContext);

    try {
      const { data: r } = await octokit.repos.get({ owner, repo });

      const lines = [
        `${ r.full_name } — ${ r.description || '(no description)' }`,
        `URL: ${ r.html_url }`,
        `Clone: ${ r.clone_url }`,
        `Default branch: ${ r.default_branch }`,
        `Private: ${ r.private }  |  Fork: ${ r.fork }  |  Archived: ${ r.archived }`,
        `Stars: ${ r.stargazers_count }  |  Forks: ${ r.forks_count }  |  Open issues: ${ r.open_issues_count }`,
        `Language: ${ r.language || 'unknown' }`,
        `Created: ${ new Date(r.created_at!).toLocaleString() }`,
        `Updated: ${ new Date(r.updated_at!).toLocaleString() }`,
        `Pushed:  ${ new Date(r.pushed_at!).toLocaleString() }`,
        `Topics: ${ r.topics?.join(', ') || 'none' }`,
        `License: ${ r.license?.name || 'none' }`,
      ];

      return { successBoolean: true, responseString: lines.join('\n') };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Get repo failed: ${ msg }` };
    }
  }
}
