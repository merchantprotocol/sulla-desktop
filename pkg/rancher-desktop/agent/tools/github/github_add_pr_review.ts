import { createGitHubOctokit } from './octokit';
import { BaseTool, ToolResponse } from '../base';

export class GitHubAddPRReviewWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner      = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo       = typeof input.repo === 'string' ? input.repo.trim() : '';
    const pullNumber = typeof input.pull_number === 'number' ? input.pull_number : parseInt(String(input.pull_number || ''), 10);
    const event      = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(input.event) ? input.event : 'COMMENT';
    const body       = typeof input.body === 'string' ? input.body : '';

    if (!owner || !repo) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo.' };
    }
    if (!pullNumber || Number.isNaN(pullNumber)) {
      return { successBoolean: false, responseString: 'Missing or invalid "pull_number".' };
    }
    if ((event === 'REQUEST_CHANGES' || event === 'COMMENT') && !body) {
      return { successBoolean: false, responseString: `"body" is required when event is ${ event }.` };
    }

    const octokit = await createGitHubOctokit(this.executionContext);

    try {
      const { data: review } = await octokit.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event:       event as any,
        body,
      });

      const label = event === 'APPROVE' ? 'Approved' : event === 'REQUEST_CHANGES' ? 'Changes requested' : 'Comment submitted';
      return {
        successBoolean: true,
        responseString:
          `Review submitted: ${ label } on ${ owner }/${ repo }#${ pullNumber }\n` +
          `Review ID: ${ review.id }\n` +
          `State: ${ review.state }\n` +
          `URL: ${ review.html_url }`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Add PR review failed: ${ msg }` };
    }
  }
}
