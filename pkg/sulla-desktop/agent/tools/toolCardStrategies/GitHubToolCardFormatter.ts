// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class GitHubToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  github_create_pr(args) {
    return { label: 'GitHub', summary: `Creating PR: ${ text.truncate(text.string(args.title), 55) }` };
  },
  github_create_issue(args) {
    return { label: 'GitHub', summary: `Creating issue: ${ text.truncate(text.string(args.title), 50) }` };
  },
  github_get_issue(args) {
    return { label: 'GitHub', summary: `Fetching issue #${ args.issue_number }` };
  },
  github_get_issues(args) {
    const state = text.string(args.state) || 'open';
    const repo = `${ text.string(args.owner) }/${ text.string(args.repo) }`;
    return { label: 'GitHub', summary: `Fetching ${ state } issues from ${ repo }` };
  },
  github_read_file(args) {
    return { label: 'GitHub', summary: `Reading ${ text.truncate(text.string(args.path), 50) }` };
  },
  github_create_file(args) {
    return { label: 'GitHub', summary: `Creating ${ text.truncate(text.string(args.path), 50) }` };
  },
  github_update_file(args) {
    return { label: 'GitHub', summary: `Updating ${ text.truncate(text.string(args.path), 50) }` };
  },
  github_comment_on_issue(args) {
    return { label: 'GitHub', summary: `Commenting on #${ args.issue_number }` };
  },
  github_close_issue(args) {
    return { label: 'GitHub', summary: `Closing issue #${ args.issue_number }` };
  },
  github_update_issue(args) {
    return { label: 'GitHub', summary: `Updating issue #${ args.issue_number }` };
  },
  github_list_branches(args) {
    return { label: 'GitHub', summary: `Listing branches on ${ text.string(args.owner) }/${ text.string(args.repo) }` };
  },
  github_add_remote(args) {
    return { label: 'Git', summary: `Adding remote ${ text.string(args.remoteName) }` };
  },
  github_init() { return { label: 'Git', summary: 'Initializing repository' } },
    });
  }
}
