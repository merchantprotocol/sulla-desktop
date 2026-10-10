import { WorkFileClaimModel } from '../../database/models/WorkFileClaimModel';
import { BaseTool, ToolResponse } from '../base';
import { normalizeClaimGlob, resolveRepository } from './fileClaims';

export class GitHubClaimFilesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const absolutePath = typeof input.absolutePath === 'string' ? input.absolutePath.trim() : '';
    const ownerLabel = typeof input.ownerLabel === 'string' ? input.ownerLabel.trim() : '';
    const jobIdValue = typeof input.jobId === 'string' ? input.jobId.trim() : '';
    if (!absolutePath || !ownerLabel || !Array.isArray(input.paths) || input.paths.length === 0 ||
      input.paths.some((item: unknown) => typeof item !== 'string')) {
      return { successBoolean: false, responseString: 'absolutePath, non-empty paths[], and ownerLabel are required.' };
    }

    try {
      const resolved = await resolveRepository(absolutePath);
      const paths = [...new Set(input.paths.map((item: string) => normalizeClaimGlob(item)))];
      const existing = await WorkFileClaimModel.listActive(resolved.repoRoot);
      const conflicts = existing.filter(claim =>
        claim.worktree_path !== resolved.worktreePath && paths.includes(claim.path_glob));
      const claims = await Promise.all(paths.map(pathGlob => WorkFileClaimModel.create({
        repoRoot: resolved.repoRoot,
        pathGlob,
        ownerJobId: jobIdValue || undefined,
        ownerLabel,
        worktreePath: resolved.worktreePath,
      })));
      const warning = conflicts.length
        ? `\nWARNING: ${ conflicts.length } identical active claim(s) already exist for another worktree:\n` +
          conflicts.map(claim => `  ${ claim.path_glob } — ${ claim.owner_label } in ${ claim.worktree_path }`).join('\n')
        : '';
      return {
        successBoolean: true,
        responseString: `Claimed ${ claims.length } path glob(s) for ${ ownerLabel } in ${ resolved.repoRoot }:\n` +
          claims.map(claim => `  ${ claim.id }  ${ claim.path_glob }`).join('\n') + warning,
      };
    } catch (error) {
      return { successBoolean: false, responseString: `Claim files failed: ${ (error as Error).message }` };
    }
  }
}
