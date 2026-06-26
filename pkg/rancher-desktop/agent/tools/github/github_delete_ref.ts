import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Delete Ref Tool — delete a remote branch (or tag) on GitHub.
 *
 * Fills the remote-branch-lifecycle gap: git_push only pushes, git_branch is
 * local-only, and the generic proxy 401s on write verbs. This uses the same
 * authenticated Octokit path as the other github_* tools (PAT injected from the
 * vault by IntegrationService — the AI never sees it).
 *
 * Destructive + outward-facing, so it refuses without {"confirm":true}. Before
 * deleting it resolves and reports the ref's current SHA, so the commit can be
 * recovered (the objects survive briefly and a new ref can point back at the SHA
 * via github_create_ref).
 */
export class GitHubDeleteRefWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner, repo } = input;
    const rawName: string = String(input.branch || input.ref || '').trim();
    const refType: 'heads' | 'tags' = input.ref_type === 'tags' ? 'tags' : 'heads';
    const confirm = input.confirm === true;

    if (!owner || !repo || !rawName) {
      return { successBoolean: false, responseString: 'Error: owner, repo, and branch are required.' };
    }

    // Normalize: accept "x", "heads/x", or "refs/heads/x" → the short name "x".
    const name = rawName
      .replace(/^refs\//, '')
      .replace(/^heads\//, '')
      .replace(/^tags\//, '');
    const apiRef = `${ refType }/${ name }`; // git.getRef/deleteRef want no leading "refs/"

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'Error: GitHub token not configured.' };
    }
    const octokit = new Octokit({ auth: tokenValue.value });

    // Resolve the current SHA first (also proves it exists) so we can report it.
    let sha = '';
    try {
      const ref = await octokit.git.getRef({ owner, repo, ref: apiRef });
      sha = ref.data.object.sha;
    } catch (error) {
      const status = (error as any)?.status;
      if (status === 404) {
        return { successBoolean: false, responseString: `Ref ${ refType }/${ name } not found on ${ owner }/${ repo } (already deleted or never existed).` };
      }
      return { successBoolean: false, responseString: `Error resolving ${ refType }/${ name }: ${ (error as Error).message }` };
    }

    if (!confirm) {
      return {
        successBoolean: false,
        responseString:
          `Refusing to delete remote ${ refType }/${ name } (${ sha.slice(0, 7) }) on ${ owner }/${ repo } without explicit confirmation. ` +
          `Re-call with {"confirm":true}. Recover later with github_create_ref using SHA ${ sha }.`,
      };
    }

    try {
      await octokit.git.deleteRef({ owner, repo, ref: apiRef });
      return {
        successBoolean: true,
        responseString: `Deleted remote ${ refType }/${ name } on ${ owner }/${ repo } (was ${ sha }). Recover with github_create_ref({ branch: "${ name }", sha: "${ sha }" }) if needed.`,
      };
    } catch (error) {
      return { successBoolean: false, responseString: `Error deleting ${ refType }/${ name }: ${ (error as Error).message }` };
    }
  }
}
