import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

export class GitHubGetPRFilesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner      = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo       = typeof input.repo === 'string' ? input.repo.trim() : '';
    const pullNumber = typeof input.pull_number === 'number' ? input.pull_number : parseInt(String(input.pull_number || ''), 10);

    if (!owner || !repo) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo.' };
    }
    if (!pullNumber || Number.isNaN(pullNumber)) {
      return { successBoolean: false, responseString: 'Missing or invalid "pull_number".' };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'GitHub token not configured in vault.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: pullNumber, per_page: 100 });

      if (files.length === 0) {
        return { successBoolean: true, responseString: `No files changed in ${ owner }/${ repo }#${ pullNumber }.` };
      }

      const totalAdded   = files.reduce((s, f) => s + f.additions, 0);
      const totalDeleted = files.reduce((s, f) => s + f.deletions, 0);

      const lines = files.map(f => {
        const status = { added: '+', removed: '-', modified: '~', renamed: 'R', copied: 'C', changed: '~', unchanged: '=' }[f.status] || '?';
        return `${ status } ${ f.filename }  (+${ f.additions }/-${ f.deletions })`;
      });

      return {
        successBoolean: true,
        responseString:
          `${ files.length } files changed in ${ owner }/${ repo }#${ pullNumber }  (+${ totalAdded }/-${ totalDeleted })\n\n` +
          lines.join('\n'),
      };
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Get PR files failed: ${ msg }` };
    }
  }
}
