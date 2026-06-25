import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Create Release - cut a GitHub release (and its git tag) on a repo.
 *
 * Publishing a non-draft release is an outward-facing, prod-touching action, so
 * it refuses without {"confirm":true} (mirrors github_merge_pr). Draft releases
 * are safe and need no confirmation. `generate_release_notes` lets GitHub
 * auto-build notes from merged PRs since the previous tag.
 */
export class GitHubCreateReleaseWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo  = typeof input.repo === 'string' ? input.repo.trim() : '';
    const tagName = typeof input.tag_name === 'string' ? input.tag_name.trim() : '';
    const targetCommitish = typeof input.target_commitish === 'string' && input.target_commitish.trim()
      ? input.target_commitish.trim() : undefined;
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined;
    const body = typeof input.body === 'string' ? input.body : undefined;
    const draft = input.draft === true;
    const prerelease = input.prerelease === true;
    const generateReleaseNotes = input.generate_release_notes === true;
    const confirm = input.confirm === true;

    if (!owner || !repo) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo.' };
    }
    if (!tagName) {
      return { successBoolean: false, responseString: 'Missing required field: tag_name.' };
    }
    // Only a PUBLISHED (non-draft) release is outward-facing — gate it.
    if (!draft && !confirm) {
      return {
        successBoolean: false,
        responseString:
          `Refusing to publish release "${ tagName }" on ${ owner }/${ repo } without explicit confirmation. ` +
          `Re-call with {"confirm":true} to publish, or {"draft":true} to create a draft.`,
      };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      const response = await octokit.repos.createRelease({
        owner,
        repo,
        tag_name:               tagName,
        target_commitish:       targetCommitish,
        name,
        body,
        draft,
        prerelease,
        generate_release_notes: generateReleaseNotes,
      });

      return {
        successBoolean: true,
        responseString:
          `${ draft ? 'Drafted' : 'Published' } release ${ response.data.tag_name } on ${ owner }/${ repo }` +
          `${ prerelease ? ' (prerelease)' : '' }.\n` +
          `Name: ${ response.data.name || '(none)' }\n` +
          `URL: ${ response.data.html_url }`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Create release failed: ${ msg }` };
    }
  }
}
