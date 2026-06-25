import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Get Issue Comments Tool - reads the comment thread on an issue or PR.
 *
 * GitHub models pull requests as issues, so this works for both: pass the PR
 * number as `issue_number` to read the PR's conversation (e.g. the note left
 * when a PR was closed). The PAT is injected from the vault by
 * IntegrationService — the AI never sees it.
 */
export class GitHubGetIssueCommentsWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo, issue_number, limit = 30 } = input;

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return {
        successBoolean: false,
        responseString: 'Error: GitHub token not configured.',
      };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      // Paginate so a long thread isn't truncated at GitHub's 30-item default,
      // then cap to `limit` for the response.
      const all = await octokit.paginate(octokit.issues.listComments, {
        owner,
        repo,
        issue_number,
        per_page: 100,
      });

      if (!all.length) {
        return { successBoolean: true, responseString: `Issue/PR #${ issue_number } has no comments.` };
      }

      const shown = all.slice(0, limit);
      const blocks = shown.map((cmt: any) => {
        const author = cmt.user?.login || 'Unknown';
        const when = new Date(cmt.created_at).toLocaleString();
        const assoc = cmt.author_association && cmt.author_association !== 'NONE'
          ? ` (${ cmt.author_association })` : '';
        return `─── @${ author }${ assoc } — ${ when } ───\n${ cmt.body || '(empty)' }`;
      });

      const header = `Issue/PR #${ issue_number } — ${ all.length } comment(s)`
        + (all.length > shown.length ? ` (showing first ${ shown.length })` : '') + ':\n';

      return {
        successBoolean: true,
        responseString: header + '\n' + blocks.join('\n\n'),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting issue comments: ${ (error as Error).message }`,
      };
    }
  }
}
