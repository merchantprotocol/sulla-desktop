// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Turns a GitHub merge refusal into an actionable reason. A draft PR gets the
 * exact command that un-drafts it, so agents stop closing and reopening PRs
 * or inventing merge-commit workarounds.
 */
export class MergeRefusalExplainer {
  explain(githubMessage: string, owner: string, repo: string, pullNumber: number): string {
    const message = githubMessage || 'GitHub refused the merge.';
    if (!this.isDraftRefusal(message)) return message;
    return `${ this.draftHint(owner, repo, pullNumber) } GitHub said: ${ message }`;
  }

  isDraftRefusal(message: string): boolean {
    return /draft/i.test(message);
  }

  draftHint(owner: string, repo: string, pullNumber: number): string {
    const args = JSON.stringify({ owner, repo, pull_number: pullNumber });
    return `PR is a draft — run \`sulla github/ready_pr '${ args }'\` first.`;
  }
}
