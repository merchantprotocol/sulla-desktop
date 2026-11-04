// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class GitToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  git_status() { return { label: 'Git', summary: 'Checking status' } },
  git_commit(args) {
    return { label: 'Git', summary: `Committing: ${ text.truncate(text.string(args.message), 60) }` };
  },
  git_push(args) {
    const remote = text.string(args.remote) || 'origin';
    const branch = text.string(args.branch);
    return { label: 'Git', summary: `Pushing to ${ remote }${ branch ? `/${ branch }` : '' }` };
  },
  git_pull(args) {
    const remote = text.string(args.remote) || 'origin';
    const branch = text.string(args.branch);
    return { label: 'Git', summary: `Pulling from ${ remote }${ branch ? `/${ branch }` : '' }` };
  },
  git_diff(args) {
    const file = text.string(args.filePath);
    if (file) return { label: 'Git', summary: `Diffing ${ text.truncate(file, 50) }` };
    if (args.staged) return { label: 'Git', summary: 'Diffing staged changes' };
    return { label: 'Git', summary: 'Comparing changes' };
  },
  git_log(args) {
    const limit = args.limit ?? 10;
    return { label: 'Git', summary: `Showing last ${ limit } commits` };
  },
  git_add(args) {
    const files = Array.isArray(args.files) ? args.files : [];
    return { label: 'Git', summary: `Staging ${ files.length || 'all' } file${ files.length === 1 ? '' : 's' }` };
  },
  git_branch(args) {
    const action = text.string(args.action) || 'Managing';
    const name = text.string(args.branchName);
    return { label: 'Git', summary: `${ action } branch${ name ? ` ${ name }` : '' }` };
  },
  git_checkout(args) {
    const ref = text.string(args.ref);
    return { label: 'Git', summary: `Checking out ${ text.truncate(ref || 'files', 40) }` };
  },
  git_stash(args) {
    const action = text.string(args.action) || 'stash';
    return { label: 'Git', summary: `Stash: ${ action }` };
  },
  git_blame(args) {
    return { label: 'Git', summary: `Blaming lines ${ args.startLine ?? '?' }–${ args.endLine ?? '?' }` };
  },
  git_conflicts() { return { label: 'Git', summary: 'Listing merge conflicts' } },
    });
  }
}
