import { WorkFileClaimModel } from '../../database/models/WorkFileClaimModel';
import { BaseTool, ToolResponse } from '../base';
import { resolveRepository } from './fileClaims';

export class GitHubListClaimsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const repoRoot = input.absolutePath ? (await resolveRepository(input.absolutePath)).repoRoot : undefined;
      const claims = await WorkFileClaimModel.listActive(repoRoot);
      if (!claims.length) {
        return { successBoolean: true, responseString: repoRoot ? `No active file claims for ${ repoRoot }.` : 'No active file claims.' };
      }
      return {
        successBoolean: true,
        responseString: `${ claims.length } active file claim(s):\n${ claims.map(claim =>
          `  ${ claim.id }  ${ claim.repo_root } :: ${ claim.path_glob } — ${ claim.owner_label }` +
          `${ claim.owner_job_id ? ` (job ${ claim.owner_job_id })` : '' } [${ claim.worktree_path }]`).join('\n') }`,
      };
    } catch (error) {
      return { successBoolean: false, responseString: `List claims failed: ${ (error as Error).message }` };
    }
  }
}
