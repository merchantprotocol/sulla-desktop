---
schemaversion: 1
slug: git-operations
title: "Git & GitHub Operations"
section: "Standard Operating Procedures"
category: "Developer Tools"
tags:
  - skill
  - git
  - github
  - version-control
  - branches
  - issues
  - pull-request
  - commit
  - push
  - pull
order: 5
locked: true
author: seed
---

# Git & GitHub Operations — Tool Reference

**Triggers**: Human says "git operations", "github", "version control", "commit code", "push to github", "create branch", "pull request", "git status", "manage issues".

## Overview
You have a full suite of built-in git tools. **Always use these instead of exec for any git/GitHub operation.** The tools are split into two categories:

1. **Local Git Tools** — run git commands on the local filesystem via `absolutePath`
2. **GitHub API Tools** — interact with GitHub's API via `owner`/`repo` (requires GitHub token)

All local tools accept an `absolutePath` parameter — this can be any path inside the repo (the tool automatically resolves the repo root).

---

## Local Git Tools

### git_status
Show current branch and working tree status (staged, unstaged, untracked files).
```
git_status({ absolutePath: "/path/to/repo" })
```
**Use first** to understand the current state before making changes.

### git_log
Show commit history.
```
git_log({ absolutePath: "/path/to/repo", limit: 10, oneline: true })
```
- `limit` — number of commits (default 20)
- `oneline` — compact format (default true)

### git_diff
Show changes between working tree, staging area, or commits.
```
// Unstaged changes
git_diff({ absolutePath: "/path/to/repo" })

// Staged changes only
git_diff({ absolutePath: "/path/to/repo", staged: true })

// Between two commits
git_diff({ absolutePath: "/path/to/repo", commitA: "abc123", commitB: "def456" })

// Single file
git_diff({ absolutePath: "/path/to/repo", filePath: "/path/to/file.ts" })
```

### git_blame
Show who last modified each line of a file.
```
git_blame({ absolutePath: "/path/to/file.ts" })
git_blame({ absolutePath: "/path/to/file.ts", startLine: 50, endLine: 100 })
```
Returns: LINE / AUTHOR / DATE / CONTENT table (capped at 300 lines).

### git_branch
Create, switch, delete, or list branches.
```
git_branch({ absolutePath: "/path/to/repo", action: "list" })
git_branch({ absolutePath: "/path/to/repo", action: "create", branchName: "feature/new-thing" })
git_branch({ absolutePath: "/path/to/repo", action: "switch", branchName: "main" })
git_branch({ absolutePath: "/path/to/repo", action: "delete", branchName: "old-branch" })
```

### git_add
Stage files for commit.
```
// Stage specific files
git_add({ absolutePath: "/path/to/repo", files: ["/path/to/file1.ts", "/path/to/file2.ts"] })

// Stage all changes
git_add({ absolutePath: "/path/to/repo" })
```

### git_commit
Stage files and commit (combines add + commit).
```
// Commit specific files
git_commit({ absolutePath: "/path/to/repo", message: "feat: add new feature", files: ["/path/to/file.ts"] })

// Stage all and commit
git_commit({ absolutePath: "/path/to/repo", message: "fix: resolve bug" })
```

### git_push
Push commits to remote.
```
git_push({ absolutePath: "/path/to/repo" })
git_push({ absolutePath: "/path/to/repo", remote: "origin", branch: "feature/branch" })
```

### git_pull
Pull from remote. Automatically reports merge conflicts.
```
git_pull({ absolutePath: "/path/to/repo" })
git_pull({ absolutePath: "/path/to/repo", remote: "origin", branch: "main" })
```

### git_conflicts
List files with merge conflicts and show the conflict diffs.
```
git_conflicts({ absolutePath: "/path/to/repo" })
```
Use after a failed pull/merge to see exactly what needs resolving.

### git_stash
Save, list, apply, pop, or drop stashed changes.
```
git_stash({ absolutePath: "/path/to/repo", action: "save", message: "WIP: feature work" })
git_stash({ absolutePath: "/path/to/repo", action: "list" })
git_stash({ absolutePath: "/path/to/repo", action: "apply" })
git_stash({ absolutePath: "/path/to/repo", action: "pop" })
git_stash({ absolutePath: "/path/to/repo", action: "drop", stashRef: "stash@{1}" })
```

### git_checkout
Restore files from a commit or branch, or discard working tree changes.
```
// Discard local changes to specific files
git_checkout({ absolutePath: "/path/to/repo", files: ["/path/to/file.ts"] })

// Restore from a specific commit
git_checkout({ absolutePath: "/path/to/repo", files: ["/path/to/file.ts"], ref: "abc123" })
```

---

## GitHub API Tools

These use the GitHub API via Octokit. Require `owner` and `repo` parameters.

### github_init
Initialize a new git repository.
```
github_init({ absolutePath: "/path/to/new/repo" })
```

### github_add_remote
Add a remote to an existing repo.
```
github_add_remote({ absolutePath: "/path/to/repo", remoteName: "origin", remoteUrl: "https://github.com/owner/repo.git" })
```

### github_create_file / github_read_file
Create or read files directly via the GitHub API.
```
github_create_file({ owner: "org", repo: "repo", path: "src/new.ts", content: "...", message: "Add file" })
github_read_file({ owner: "org", repo: "repo", path: "src/existing.ts", ref: "main" })
```

### github_list_branches
List branches via the API.
```
github_list_branches({ owner: "org", repo: "repo" })
```

---

## Issue Management

### github_get_issue / github_get_issues
Read issues.
```
github_get_issue({ owner: "org", repo: "repo", issue_number: 42 })
github_get_issues({ owner: "org", repo: "repo", state: "open", labels: ["bug"], limit: 20 })
```

### github_create_issue
Create a new issue.
```
github_create_issue({
  owner: "org", repo: "repo",
  title: "Bug: something is broken",
  body: "## Description\nDetailed bug report...",
  labels: ["bug", "priority:high"],
  assignees: ["username"]
})
```

### github_update_issue
Edit an existing issue (title, body, labels, assignees, state).
```
github_update_issue({
  owner: "org", repo: "repo", issue_number: 42,
  title: "Updated title",
  labels: ["bug", "in-progress"],
  assignees: ["new-assignee"]
})
```

### github_close_issue
Close an issue with a reason.
```
github_close_issue({ owner: "org", repo: "repo", issue_number: 42, reason: "completed" })
github_close_issue({ owner: "org", repo: "repo", issue_number: 43, reason: "not_planned" })
```

### github_comment_on_issue
Add a comment to an issue.
```
github_comment_on_issue({ owner: "org", repo: "repo", issue_number: 42, body: "Fixed in PR #50" })
```

---

## Pull Requests

### github_create_pr
Create a pull request.
```
github_create_pr({
  owner: "org", repo: "repo",
  title: "feat: add new feature",
  head: "feature/new-thing",
  base: "main",
  body: "## Changes\n- Added X\n- Fixed Y",
  draft: false
})
```

---

## Common Workflows

### Feature Branch Workflow
```
1. git_status       → check clean working tree
2. git_branch       → action: "create", branchName: "feature/xyz"
3. (make changes)
4. git_add          → stage changes
5. git_commit       → commit with descriptive message
6. git_push         → push branch to remote
7. github_create_pr → open PR against main
```

### Bug Fix Workflow
```
1. github_get_issue   → read the bug report
2. git_branch         → create fix branch from main
3. (fix the bug)
4. git_commit         → commit the fix
5. git_push           → push fix branch
6. github_create_pr   → open PR referencing the issue
7. github_close_issue → close the issue (or let the PR close it)
```

### Code Review Workflow
```
1. git_log    → review recent commits
2. git_diff   → compare branches or commits
3. git_blame  → identify who changed specific lines
```

### Conflict Resolution
```
1. git_pull       → pull and see if conflicts arise
2. git_conflicts  → inspect conflict markers
3. (resolve manually)
4. git_add        → stage resolved files
5. git_commit     → commit the merge resolution
```

## Best Practices
1. **Always git_status first** — know your state before acting
2. **Use descriptive commit messages** — prefix with feat:, fix:, docs:, chore:, etc.
3. **Create feature branches** — never commit directly to main
4. **Pull before push** — avoid conflicts by staying up to date
5. **Use git_stash** — save work-in-progress before switching branches
6. **Link issues to PRs** — reference issue numbers in PR descriptions
7. **Never use exec for git operations** — always use these built-in tools
