import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Create Ref Tool — create a remote branch (or tag) on GitHub.
 *
 * Completes remote-branch lifecycle alongside github_delete_ref and
 * github_list_branches: push code with git_push, then branch/restore refs here.
 * Point the new ref at an explicit `sha`, or at the current tip of `from_branch`
 * (resolved server-side). Authenticated via IntegrationService — the AI never
 * sees the PAT. Non-destructive; fails if the ref already exists (422).
 */
export class GitHubCreateRefWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo } = input;
    const rawName: string = String(input.branch || input.ref || '').trim();
    const refType: 'heads' | 'tags' = input.ref_type === 'tags' ? 'tags' : 'heads';
    let sha: string = String(input.sha || '').trim();
    const fromBranch: string = String(input.from_branch || '').trim();

    if (!owner || !repo || !rawName) {
      return { successBoolean: false, responseString: 'Error: owner, repo, and branch are required.' };
    }
    if (!sha && !fromBranch) {
      return { successBoolean: false, responseString: 'Error: provide either "sha" or "from_branch" to point the new ref at.' };
    }

    const name = rawName
      .replace(/^refs\//, '')
      .replace(/^heads\//, '')
      .replace(/^tags\//, '');

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'Error: GitHub token not configured.' };
    }
    const octokit = new Octokit({ auth: tokenValue.value });

    // Resolve from_branch → its current tip SHA when no explicit sha given.
    if (!sha) {
      try {
        const src = await octokit.git.getRef({ owner, repo, ref: `heads/${ fromBranch.replace(/^(refs\/)?heads\//, '') }` });
        sha = src.data.object.sha;
      } catch (error) {
        const status = (error as any)?.status;
        if (status === 404) {
          return { successBoolean: false, responseString: `Source branch "${ fromBranch }" not found on ${ owner }/${ repo }.` };
        }
        return { successBoolean: false, responseString: `Error resolving from_branch "${ fromBranch }": ${ (error as Error).message }` };
      }
    }

    try {
      await octokit.git.createRef({ owner, repo, ref: `refs/${ refType }/${ name }`, sha });
      return {
        successBoolean: true,
        responseString: `Created remote ${ refType }/${ name } on ${ owner }/${ repo } → ${ sha }.`,
      };
    } catch (error) {
      const status = (error as any)?.status;
      if (status === 422) {
        return { successBoolean: false, responseString: `Ref ${ refType }/${ name } already exists on ${ owner }/${ repo } (or the SHA is invalid).` };
      }
      return { successBoolean: false, responseString: `Error creating ${ refType }/${ name }: ${ (error as Error).message }` };
    }
  }
}
