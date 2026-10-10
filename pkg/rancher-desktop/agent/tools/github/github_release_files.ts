import { WorkFileClaimModel } from '../../database/models/WorkFileClaimModel';
import { BaseTool, ToolResponse } from '../base';
import { resolveRepository } from './fileClaims';

export class GitHubReleaseFilesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const absolutePath = typeof input.absolutePath === 'string' ? input.absolutePath.trim() : '';
    const ownerLabel = typeof input.ownerLabel === 'string' ? input.ownerLabel.trim() : '';
    const claimIds = Array.isArray(input.claimIds)
      ? input.claimIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : [];
    if (!absolutePath) {
      return { successBoolean: false, responseString: 'absolutePath is required.' };
    }
    if ((!ownerLabel && claimIds.length === 0) || (ownerLabel && claimIds.length > 0)) {
      return { successBoolean: false, responseString: 'Provide exactly one of ownerLabel or claimIds[].' };
    }

    try {
      const resolved = await resolveRepository(absolutePath);
      const released = await WorkFileClaimModel.release({
        repoRoot: resolved.repoRoot,
        ownerLabel: ownerLabel || undefined,
        claimIds: claimIds.length ? claimIds : undefined,
      });
      return {
        successBoolean: true,
        responseString: released.length
          ? `Released ${ released.length } file claim(s):\n${ released.map(claim => `  ${ claim.id }  ${ claim.path_glob }`).join('\n') }`
          : 'No matching active file claims found.',
      };
    } catch (error) {
      return { successBoolean: false, responseString: `Release files failed: ${ (error as Error).message }` };
    }
  }
}
