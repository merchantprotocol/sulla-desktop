import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Mark PR Ready Tool — flips a draft pull request to "ready for review".
 *
 * GitHub only exposes this via GraphQL (markPullRequestReadyForReview); the REST
 * pulls.update endpoint cannot un-draft a PR. A draft PR also cannot be merged,
 * so this is the missing step between opening a draft and merging it. The PAT is
 * injected from the vault by IntegrationService — the AI never sees it.
 */
export class GitHubReadyPrWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo } = input;
    const pullNumber = typeof input.pull_number === 'number'
      ? input.pull_number
      : parseInt(String(input.pull_number || ''), 10);
    if (!owner || !repo || !Number.isFinite(pullNumber)) {
      return { successBoolean: false, responseString: 'Error: owner, repo, and pull_number are required.' };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'Error: GitHub token not configured.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      // Resolve the PR's GraphQL node id (REST → node_id), then mark it ready.
      const pr = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
      if (!pr.data.draft) {
        return { successBoolean: true, responseString: `PR #${ pullNumber } is already ready for review (not a draft).` };
      }
      await octokit.graphql(
        `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }`,
        { id: (pr.data as any).node_id },
      );
      return {
        successBoolean: true,
        responseString: `PR #${ pullNumber } "${ pr.data.title }" marked ready for review (no longer a draft).`,
      };
    } catch (error) {
      return { successBoolean: false, responseString: `Error marking PR ready: ${ (error as Error).message }` };
    }
  }
}
