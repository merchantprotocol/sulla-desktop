import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * List CI check runs for a ref (branch / SHA / tag). Answers "is CI green?"
 * at the most recent state for the ref.
 */
export class GitHubCheckRunsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo  = typeof input.repo === 'string' ? input.repo.trim() : '';
    const ref   = typeof input.ref === 'string' ? input.ref.trim() : '';

    if (!owner || !repo || !ref) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo, ref (branch name, SHA, or tag).' };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      const response = await octokit.checks.listForRef({
        owner,
        repo,
        ref,
        per_page: 50,
      });

      const runs = response.data.check_runs;
      if (runs.length === 0) {
        return { successBoolean: true, responseString: `No check runs found for ${ owner }/${ repo }@${ ref }.` };
      }

      const lines = runs.map((run: any) => {
        const statusTag = run.conclusion
          ? `[${ run.conclusion }]`
          : run.status === 'in_progress' ? '[running]' : `[${ run.status }]`;
        const dur = run.completed_at && run.started_at
          ? ` (${ Math.round((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000) }s)`
          : '';
        return `  ${ statusTag } ${ run.name }${ dur } — ${ run.html_url }`;
      });

      const totals: Record<string, number> = {};
      for (const r of runs) {
        const key = r.conclusion || r.status;
        totals[key] = (totals[key] ?? 0) + 1;
      }
      const summary = Object.entries(totals).map(([k, v]) => `${ v } ${ k }`).join(', ');

      return {
        successBoolean: true,
        responseString:
          `${ runs.length } check run(s) for ${ owner }/${ repo }@${ ref } — ${ summary }:\n${ lines.join('\n') }`,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `List check runs failed: ${ msg }` };
    }
  }
}
