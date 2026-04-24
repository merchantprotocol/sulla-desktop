import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Manually trigger a GitHub Actions workflow via `workflow_dispatch`. The
 * target workflow must already declare a `workflow_dispatch` trigger.
 */
export class GitHubTriggerWorkflowRunWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo  = typeof input.repo === 'string' ? input.repo.trim() : '';
    const workflowId = typeof input.workflow_id === 'string' || typeof input.workflow_id === 'number'
      ? input.workflow_id
      : '';
    const ref = typeof input.ref === 'string' && input.ref.trim().length > 0 ? input.ref.trim() : 'main';
    const inputs = (input.inputs && typeof input.inputs === 'object') ? input.inputs : {};

    if (!owner || !repo) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo.' };
    }
    if (!workflowId) {
      return {
        successBoolean: false,
        responseString: 'Missing "workflow_id" — pass the workflow filename (e.g. "ci.yml") or numeric id.',
      };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      await octokit.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: workflowId as any,
        ref,
        inputs:      inputs as Record<string, string>,
      });

      return {
        successBoolean: true,
        responseString:
          `Triggered ${ owner }/${ repo } workflow "${ workflowId }" on ref "${ ref }". ` +
          `GitHub does not return a run id from dispatch — list recent runs or check_runs to find it.`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      if (/workflow_dispatch/i.test(msg)) {
        return {
          successBoolean: false,
          responseString: `Dispatch failed: ${ msg } — the target workflow likely doesn't declare a "workflow_dispatch" trigger in its "on:" block.`,
        };
      }
      return { successBoolean: false, responseString: `Dispatch failed: ${ msg }` };
    }
  }
}
