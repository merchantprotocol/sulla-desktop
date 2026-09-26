import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Convert PR To Draft Tool — the inverse of github_ready_pr.
 *
 * GitHub only exposes this via GraphQL (convertPullRequestToDraft); REST's
 * pulls.update cannot re-draft a PR. This is how an agent hands work back
 * instead of parking it in some side channel: a draft PR leaves the "ready"
 * queue, and marking it ready for review puts it back.
 *
 * `comment` is REQUIRED. A PR that silently drops out of the queue with no
 * written reason is the exact failure this tool exists to prevent, so the
 * explanation is posted BEFORE the conversion — if the comment is rejected,
 * the PR is deliberately left ready rather than quietly hidden.
 *
 * No `confirm` gate: this is reversible in seconds via github_ready_pr, and
 * friction here would push agents back toward leaving work in limbo.
 * The PAT is injected from the vault by IntegrationService — the AI never sees it.
 */
export class GitHubDraftPRWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
    const pullNumber = typeof input.pull_number === 'number'
      ? input.pull_number
      : parseInt(String(input.pull_number || ''), 10);
    const comment = typeof input.comment === 'string' ? input.comment.trim() : '';

    if (!owner || !repo) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo.' };
    }
    if (!pullNumber || Number.isNaN(pullNumber) || pullNumber < 1) {
      return { successBoolean: false, responseString: 'Missing or invalid "pull_number".' };
    }
    if (!comment) {
      return {
        successBoolean: false,
        responseString:
          `Refusing to draft ${ owner }/${ repo }#${ pullNumber } without a comment.\n` +
          `Re-call with "comment" describing what needs to be fixed — a PR must never ` +
          `leave the ready queue without a written reason.`,
      };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });

      // A landed or abandoned PR must never be rewritten into a hand-back.
      if (pr.merged) {
        return {
          successBoolean: false,
          responseString: `PR #${ pullNumber } is already merged — verify main instead of handing it back.`,
        };
      }
      if (pr.state !== 'open') {
        return {
          successBoolean: false,
          responseString: `PR #${ pullNumber } is ${ pr.state }, not open. Reopening is a separate decision.`,
        };
      }

      // Explanation first: the PR stays ready until the reason is on the record.
      await octokit.issues.createComment({ owner, repo, issue_number: pullNumber, body: comment });

      if (pr.draft) {
        return {
          successBoolean: true,
          responseString:
            `PR #${ pullNumber } "${ pr.title }" is already a draft. Comment posted with what needs fixing.\n` +
            `URL: ${ pr.html_url }`,
        };
      }

      const result: any = await octokit.graphql(
        `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }`,
        { id: (pr as any).node_id },
      );

      // Never report success off an ambiguous mutation response.
      if (result?.convertPullRequestToDraft?.pullRequest?.isDraft !== true) {
        return {
          successBoolean: false,
          responseString:
            `PR #${ pullNumber }: comment posted but draft conversion was not confirmed by GitHub. ` +
            `The PR may still be ready for review — re-check before relying on it.`,
        };
      }

      return {
        successBoolean: true,
        responseString:
          `PR #${ pullNumber } "${ pr.title }" returned to draft with a comment on what needs fixing.\n` +
          `URL: ${ pr.html_url }\n` +
          `It is out of the ready queue; github_ready_pr puts it back.`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Draft PR failed: ${ msg }` };
    }
  }
}
