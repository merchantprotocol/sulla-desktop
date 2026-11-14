// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createGitHubOctokit } from './octokit';
import { BaseTool, ToolResponse } from '../base';

/** Updates mutable GitHub repository metadata without changing visibility. */
export class GitHubUpdateRepoWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
    if (!owner || !repo) {
      return { successBoolean: false, responseString: 'Missing required fields: owner, repo.' };
    }

    const updateParams: Record<string, unknown> = { owner, repo };
    const changedFields: string[] = [];
    for (const field of ['name', 'description', 'homepage']) {
      if (input[field] !== undefined) {
        if (typeof input[field] !== 'string') {
          return { successBoolean: false, responseString: `Invalid field: ${ field } must be a string.` };
        }
        updateParams[field] = input[field];
        changedFields.push(field);
      }
    }
    if (input.topics !== undefined) {
      if (!Array.isArray(input.topics) || input.topics.some((topic: unknown) => typeof topic !== 'string')) {
        return { successBoolean: false, responseString: 'Invalid field: topics must be an array of strings.' };
      }
      changedFields.push('topics');
    }
    if (!changedFields.length) {
      return { successBoolean: false, responseString: 'Nothing to change. Provide name, description, homepage, or topics.' };
    }

    try {
      const octokit = await createGitHubOctokit(this.executionContext);
      let fullName = `${ owner }/${ repo }`;
      if (changedFields.some(field => field !== 'topics')) {
        const response = await octokit.repos.update(updateParams as any);
        fullName = response.data.full_name || fullName;
      }
      if (input.topics !== undefined) {
        const currentRepo = fullName.split('/').pop() || repo;
        await octokit.repos.replaceAllTopics({ owner, repo: currentRepo, names: input.topics });
      }
      return {
        successBoolean: true,
        responseString: `Repository updated: ${ fullName }\nChanged: ${ changedFields.join(', ') }`,
      };
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const detail = err?.response?.data?.message || err?.message || String(err);
      return { successBoolean: false, responseString: `Update repo failed${ status ? ` (${ status })` : ''}: ${ detail }` };
    }
  }
}
