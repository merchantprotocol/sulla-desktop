import { Octokit } from '@octokit/rest';

import { GitHubPullRequestMirrorModel } from '../../database/models/GitHubPullRequestMirrorModel';
import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { GitHubPullRequestMirrorService } from '../../services/GitHubPullRequestMirrorService';
import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

export class ReconcileGitHubPRMirrorWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const repositories = Array.isArray(input.repositories)
      ? input.repositories.map((value: any) => ({
        owner: typeof value?.owner === 'string' ? value.owner.trim() : '',
        repo:  typeof value?.repo === 'string' ? value.repo.trim() : '',
      })).filter((value: any) => value.owner && value.repo)
      : [];
    const epicId = typeof input.epic_id === 'string' ? input.epic_id.trim() : '';
    const parentId = typeof input.parent_id === 'string' && input.parent_id.trim() ? input.parent_id.trim() : null;
    if (!epicId || repositories.length === 0) {
      return { successBoolean: false, responseString: 'repositories and epic_id are required.' };
    }
    const token = await getIntegrationService().getIntegrationValue('github', 'token');
    if (!token) return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };

    try {
      const result = await new GitHubPullRequestMirrorService(
        new Octokit({ auth: token.value }), getProjectsApplicationService(), GitHubPullRequestMirrorModel,
      ).reconcile({
        repositories,
        epicId,
        parentId,
        openStatus:     typeof input.open_status === 'string' && input.open_status.trim() ? input.open_status.trim() : 'backlog',
        terminalStatus: typeof input.terminal_status === 'string' && input.terminal_status.trim() ? input.terminal_status.trim() : 'done',
        actor:          typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'github-pr-mirror',
        dryRun:         input.dry_run !== false,
        batchSize:      Number.isInteger(input.batch_size) && input.batch_size > 0 ? Math.min(input.batch_size, 500) : 100,
      });
      return { successBoolean: result.failures.length === 0, responseString: JSON.stringify(result) };
    } catch (error: any) {
      return { successBoolean: false, responseString: `GitHub PR mirror failed: ${ error?.message ?? String(error) }` };
    }
  }
}
