# github tools

GitHub repository management tools.

## add_issue_to_project

Add an issue (or PR) as a card on a Projects V2 board via addProjectV2ItemById (GraphQL-only). Address the board by project_id (PVT_… from github_list_projects) and the issue by content_node_id, or supply owner + repo + issue_number to resolve it.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `project_id` | string | Required |
| `content_node_id` | string | Optional |
| `owner` | string | Optional |
| `repo` | string | Optional |
| `issue_number` | number | Optional |

**Example**

```bash
sulla github/add_issue_to_project '{"project_id":"<project_id>"}'
```

## add_pr_review

Submit a pull request review — APPROVE, REQUEST_CHANGES, or COMMENT. Body is required for REQUEST_CHANGES and COMMENT.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `pull_number` | number | Required |
| `event` | enum: APPROVE\|REQUEST_CHANGES\|COMMENT | Required |
| `body` | string | Optional |

**Example**

```bash
sulla github/add_pr_review '{"owner":"<owner>","repo":"<repo>","pull_number":"<pull_number>","event":"<event>"}'
```

## add_remote

Add a remote repository to an existing git repository.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `remoteName` | string | Required |
| `remoteUrl` | string | Required |

**Example**

```bash
sulla github/add_remote '{"absolutePath":"<absolutePath>","remoteName":"<remoteName>","remoteUrl":"<remoteUrl>"}'
```

## check_runs

List CI check runs for a ref (branch name, SHA, or tag). Use this to answer "is CI green?" — shows status / conclusion / timing for each check.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `ref` | string | Required |

**Example**

```bash
sulla github/check_runs '{"owner":"<owner>","repo":"<repo>","ref":"<ref>"}'
```

## ci_logs

Inspect CI failures by workflow run, Actions job, or ref. Returns check annotations and a bounded job-log excerpt around each failure.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `runId` | number | Optional |
| `jobId` | number | Optional |
| `ref` | string | Optional |
| `failedOnly` | boolean | Optional |
| `maxLines` | number | Optional |

**Example**

```bash
sulla github/ci_logs '{"owner":"<owner>","repo":"<repo>"}'
```

## claim_files

Claim repository-relative file globs for a worker. Claims are shared across every worktree of the same repository and warn rather than block.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `paths` | array | Required |
| `ownerLabel` | string | Required |
| `jobId` | string | Optional |

**Example**

```bash
sulla github/claim_files '{"absolutePath":"<absolutePath>","paths":"<paths>","ownerLabel":"<ownerLabel>"}'
```

## close_issue

Close a GitHub issue with an optional reason (completed or not_planned).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `issue_number` | number | Required |
| `reason` | enum: completed\|not_planned | Optional |

**Example**

```bash
sulla github/close_issue '{"owner":"<owner>","repo":"<repo>","issue_number":"<issue_number>"}'
```

## close_pr

Close a pull request without merging it. Requires confirm:true.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `pull_number` | number | Required |
| `confirm` | boolean | Required |
| `comment` | string | Optional |

**Example**

```bash
sulla github/close_pr '{"owner":"<owner>","repo":"<repo>","pull_number":"<pull_number>","confirm":"<confirm>"}'
```

## comment_on_issue

Add a comment to a GitHub issue.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `issue_number` | number | Required |
| `body` | string | Required |

**Example**

```bash
sulla github/comment_on_issue '{"owner":"<owner>","repo":"<repo>","issue_number":"<issue_number>","body":"<body>"}'
```

## create_file

Create a new file in a GitHub repository.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `path` | string | Required |
| `content` | string | Required |
| `message` | string | Required |
| `branch` | string | Optional |

**Example**

```bash
sulla github/create_file '{"owner":"<owner>","repo":"<repo>","path":"<path>","content":"<content>","message":"<message>"}'
```

## create_issue

Create a new issue in a GitHub repository.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `title` | string | Required |
| `body` | string | Optional |
| `labels` | array | Optional |
| `assignees` | array | Optional |

**Example**

```bash
sulla github/create_issue '{"owner":"<owner>","repo":"<repo>","title":"<title>"}'
```

## create_pr

Create a pull request in a GitHub repository.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `title` | string | Required |
| `head` | string | Required |
| `base` | string | Optional |
| `body` | string | Optional |
| `draft` | boolean | Optional |

**Example**

```bash
sulla github/create_pr '{"owner":"<owner>","repo":"<repo>","title":"<title>","head":"<head>"}'
```

## create_ref

Create a remote branch (or tag) on GitHub, pointed at an explicit SHA or the current tip of another branch (from_branch). Completes remote-branch lifecycle with github_list_branches / github_delete_ref.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `branch` | string | Required |
| `sha` | string | Optional |
| `from_branch` | string | Optional |
| `ref_type` | enum: heads\|tags | Optional |

**Example**

```bash
sulla github/create_ref '{"owner":"<owner>","repo":"<repo>","branch":"<branch>"}'
```

## create_release

Cut a GitHub release (and its git tag). Publishing a non-draft release is outward-facing — refuses without {"confirm":true}; use {"draft":true} for a safe draft.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `tag_name` | string | Required |
| `target_commitish` | string | Optional |
| `name` | string | Optional |
| `body` | string | Optional |
| `draft` | boolean | Optional |
| `prerelease` | boolean | Optional |
| `generate_release_notes` | boolean | Optional |
| `confirm` | boolean | Optional |

**Example**

```bash
sulla github/create_release '{"owner":"<owner>","repo":"<repo>","tag_name":"<tag_name>"}'
```

## create_repo

Create a new GitHub repository for the authenticated user or an organization.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `name` | string | Required |
| `owner` | string | Optional |
| `description` | string | Optional |
| `private` | boolean | Optional |
| `auto_init` | boolean | Optional |
| `org` | boolean | Optional |

**Example**

```bash
sulla github/create_repo '{"name":"<name>"}'
```

## delete_ref

Delete a remote branch (or tag) on GitHub. Destructive + outward-facing — refuses without {"confirm":true}; reports the deleted SHA so it can be restored via github_create_ref.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `branch` | string | Required |
| `ref_type` | enum: heads\|tags | Optional |
| `confirm` | boolean | Optional |

**Example**

```bash
sulla github/delete_ref '{"owner":"<owner>","repo":"<repo>","branch":"<branch>"}'
```

## delete_repo

Permanently delete a GitHub repository. Irreversible — requires confirm:true AND confirm_name matching the repo name.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `confirm` | boolean | Required |
| `confirm_name` | string | Required |

**Example**

```bash
sulla github/delete_repo '{"owner":"<owner>","repo":"<repo>","confirm":"<confirm>","confirm_name":"<confirm_name>"}'
```

## draft_pr

Return a ready pull request to draft via the GraphQL convertPullRequestToDraft mutation (the inverse of github_ready_pr; REST cannot do this). Requires a "comment" saying what needs to be fixed — the comment is posted before the conversion so a PR never leaves the ready queue unexplained.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `pull_number` | number | Required |
| `comment` | string | Required |

**Example**

```bash
sulla github/draft_pr '{"owner":"<owner>","repo":"<repo>","pull_number":"<pull_number>","comment":"<comment>"}'
```

## fork_repo

Fork a GitHub repository into the authenticated user's account or a specified organization.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `organization` | string | Optional |
| `name` | string | Optional |

**Example**

```bash
sulla github/fork_repo '{"owner":"<owner>","repo":"<repo>"}'
```

## get_issue

Get details of a specific GitHub issue.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `issue_number` | number | Required |

**Example**

```bash
sulla github/get_issue '{"owner":"<owner>","repo":"<repo>","issue_number":"<issue_number>"}'
```

## get_issue_comments

Read the comment thread on a GitHub issue or pull request (PRs are issues in the API — pass the PR number). Returns each comment with author, association, timestamp, and body.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `issue_number` | number | Required |
| `limit` | number | Optional |

**Example**

```bash
sulla github/get_issue_comments '{"owner":"<owner>","repo":"<repo>","issue_number":"<issue_number>"}'
```

## get_issues

Get issues from a GitHub repository.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `state` | enum: open\|closed\|all | Required |
| `labels` | array | Optional |
| `since` | string | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla github/get_issues '{"owner":"<owner>","repo":"<repo>","state":"<state>"}'
```

## get_pr

Get full details of a specific pull request — head/base, diff stats, reviewer list, labels, mergeable state.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `pull_number` | number | Required |

**Example**

```bash
sulla github/get_pr '{"owner":"<owner>","repo":"<repo>","pull_number":"<pull_number>"}'
```

## get_pr_files

List all files changed in a pull request with their status (added/modified/removed/renamed) and line diff counts.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `pull_number` | number | Required |

**Example**

```bash
sulla github/get_pr_files '{"owner":"<owner>","repo":"<repo>","pull_number":"<pull_number>"}'
```

## get_repo

Get metadata and stats for a GitHub repository — stars, forks, language, topics, default branch, license, push times.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |

**Example**

```bash
sulla github/get_repo '{"owner":"<owner>","repo":"<repo>"}'
```

## git_add

Stage files for commit. If no files are specified, stages all changes.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `files` | array | Optional |

**Example**

```bash
sulla github/git_add '{"absolutePath":"<absolutePath>"}'
```

## git_blame

Show who last modified each line of a file. Optionally limit to a line range.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `startLine` | number | Optional |
| `endLine` | number | Optional |

**Example**

```bash
sulla github/git_blame '{"absolutePath":"<absolutePath>"}'
```

## git_branch

Create, switch, delete, or list git branches.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `action` | enum: list\|create\|switch\|delete | Required |
| `branchName` | string | Optional |

**Example**

```bash
sulla github/git_branch '{"absolutePath":"<absolutePath>","action":"<action>"}'
```

## git_checkout

Restore files from a commit or branch, or discard working tree changes.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `files` | array | Required |
| `ref` | string | Optional |

**Example**

```bash
sulla github/git_checkout '{"absolutePath":"<absolutePath>","files":"<files>"}'
```

## git_commit

Stage files and create a git commit. If no files are specified, stages all changes.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `message` | string | Required |
| `files` | array | Optional |

**Example**

```bash
sulla github/git_commit '{"absolutePath":"<absolutePath>","message":"<message>"}'
```

## git_conflicts

List files with merge conflicts and show the conflict diffs for each file.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |

**Example**

```bash
sulla github/git_conflicts '{"absolutePath":"<absolutePath>"}'
```

## git_diff

Show changes between working tree, staging area, or commits.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `staged` | boolean | Optional |
| `commitA` | string | Optional |
| `commitB` | string | Optional |
| `filePath` | string | Optional |

**Example**

```bash
sulla github/git_diff '{"absolutePath":"<absolutePath>"}'
```

## git_fetch

Fetch authenticated remote refs without changing the working tree. Reports remote-tracking refs that were added, updated, or pruned.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `remote` | string | Optional |
| `branch` | string | Optional |
| `prune` | boolean | Optional |

**Example**

```bash
sulla github/git_fetch '{"absolutePath":"<absolutePath>"}'
```

## git_log

Show commit history for a repository.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `limit` | number | Optional |
| `oneline` | boolean | Optional |

**Example**

```bash
sulla github/git_log '{"absolutePath":"<absolutePath>"}'
```

## git_pull

Pull commits from a remote repository. Automatically reports any merge conflicts after pull.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `remote` | string | Optional |
| `branch` | string | Optional |

**Example**

```bash
sulla github/git_pull '{"absolutePath":"<absolutePath>"}'
```

## git_push

Push commits to a remote repository.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `remote` | string | Optional |
| `branch` | string | Optional |
| `tags` | boolean | Optional |
| `force` | boolean | Optional |

**Example**

```bash
sulla github/git_push '{"absolutePath":"<absolutePath>"}'
```

## git_stash

Save, list, apply, pop, or drop stashed changes.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `action` | enum: save\|list\|apply\|pop\|drop | Required |
| `message` | string | Optional |
| `stashRef` | string | Optional |

**Example**

```bash
sulla github/git_stash '{"absolutePath":"<absolutePath>","action":"<action>"}'
```

## git_status

Show the working tree status — current branch, staged/unstaged/untracked files.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |

**Example**

```bash
sulla github/git_status '{"absolutePath":"<absolutePath>"}'
```

## git_worktree

Add, list, remove, or prune git worktrees — check out multiple branches of one repo into separate directories at once (ideal for reviewing/building several PRs in parallel).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `action` | enum: add\|list\|remove\|prune | Required |
| `worktreePath` | string | Optional |
| `branch` | string | Optional |
| `createBranch` | boolean | Optional |
| `commitish` | string | Optional |
| `force` | boolean | Optional |

**Example**

```bash
sulla github/git_worktree '{"absolutePath":"<absolutePath>","action":"<action>"}'
```

## heartbeat_claim_issue

Heartbeat issue-discovery (#500) atomic claim + collision guard: records an issue in the heartbeat_seen_issues seen-set via INSERT ... ON CONFLICT DO NOTHING.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `issue_number` | number | Required |
| `node_id` | string | Optional |
| `title` | string | Optional |
| `claim_method` | string | Optional |

**Example**

```bash
sulla github/heartbeat_claim_issue '{"owner":"<owner>","repo":"<repo>","issue_number":"<issue_number>"}'
```

## heartbeat_new_issues

Heartbeat issue-discovery (#500) "touched-before" filter: given the open-issue union from scan_active_issues, returns only issues Heartbeat has NOT handled before — anti-joined against the heartbeat_seen_issues seen-set and excluding issues already assigned to Heartbeat or bearing the claim label. Deterministic, zero-LLM, read-only.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `issues` | array | Required |
| `heartbeat_login` | string | Optional |
| `claim_label` | string | Optional |

**Example**

```bash
sulla github/heartbeat_new_issues '{"issues":"<issues>"}'
```

## init

Initialize a git repository at the specified absolute path.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |

**Example**

```bash
sulla github/init '{"absolutePath":"<absolutePath>"}'
```

## list_branches

List branches in a GitHub repository.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `protected` | boolean | Optional |

**Example**

```bash
sulla github/list_branches '{"owner":"<owner>","repo":"<repo>"}'
```

## list_claims

List active worker file claims, optionally scoped to the repository containing absolutePath.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Optional |

**Example**

```bash
sulla github/list_claims '{}'
```

## list_pr_reviews

List all reviews on a pull request with their state (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED) and authors.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `pull_number` | number | Required |

**Example**

```bash
sulla github/list_pr_reviews '{"owner":"<owner>","repo":"<repo>","pull_number":"<pull_number>"}'
```

## list_projects

List Projects V2 boards for an org or user, with each board's node id (projectId, PVT_…), fields, and — for single-select fields like Status — every option id/name. Projects V2 is GraphQL-only (no REST).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `owner_type` | string | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla github/list_projects '{"owner":"<owner>"}'
```

## list_prs

List one page of pull requests with optional filters. Follow the returned next-page instruction to inventory every PR, including drafts.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `state` | enum: open\|closed\|all | Optional |
| `base` | string | Optional |
| `head` | string | Optional |
| `sort` | enum: created\|updated\|popularity\|long-running | Optional |
| `limit` | number | Optional |
| `page` | number | Optional |

**Example**

```bash
sulla github/list_prs '{"owner":"<owner>","repo":"<repo>"}'
```

## list_repos

List repositories for the authenticated user, a specific user, or an organization.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Optional |
| `org` | boolean | Optional |
| `type` | enum: all\|owner\|member\|public\|private\|forks\|sources | Optional |
| `sort` | enum: created\|updated\|pushed\|full_name | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla github/list_repos '{}'
```

## merge_pr

Merge a GitHub pull request. Destructive — refuses without {"confirm":true}.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `pull_number` | number | Required |
| `sha` | string | Optional |
| `merge_method` | string | Optional |
| `commit_title` | string | Optional |
| `commit_message` | string | Optional |
| `confirm` | boolean | Required |

**Example**

```bash
sulla github/merge_pr '{"owner":"<owner>","repo":"<repo>","pull_number":"<pull_number>","confirm":"<confirm>"}'
```

## read_file

Read the contents of a file from a GitHub repository.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `path` | string | Required |
| `ref` | string | Optional |

**Example**

```bash
sulla github/read_file '{"owner":"<owner>","repo":"<repo>","path":"<path>"}'
```

## ready_pr

Flip a draft pull request to "ready for review" (draft PRs cannot be merged). Uses the GraphQL markPullRequestReadyForReview mutation.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `pull_number` | number | Required |

**Example**

```bash
sulla github/ready_pr '{"owner":"<owner>","repo":"<repo>","pull_number":"<pull_number>"}'
```

## release_files

Release active file claims in one repository by owner label or explicit claim ids.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `absolutePath` | string | Required |
| `ownerLabel` | string | Optional |
| `claimIds` | array | Optional |

**Example**

```bash
sulla github/release_files '{"absolutePath":"<absolutePath>"}'
```

## request_pr_reviewers

Request specific users or teams to review a pull request.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `pull_number` | number | Required |
| `reviewers` | array | Optional |
| `team_reviewers` | array | Optional |

**Example**

```bash
sulla github/request_pr_reviewers '{"owner":"<owner>","repo":"<repo>","pull_number":"<pull_number>"}'
```

## set_project_field

Set one field on one Projects V2 card via updateProjectV2ItemFieldValue (GraphQL-only) — most often the Status single-select, i.e. moving a card between columns. All ids come from the prior steps: project_id + field_id (+ option_id) from github_list_projects, item_id from github_add_issue_to_project.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `project_id` | string | Required |
| `item_id` | string | Required |
| `field_id` | string | Required |
| `option_id` | string | Optional |
| `text` | string | Optional |
| `number` | number | Optional |
| `date` | string | Optional |

**Example**

```bash
sulla github/set_project_field '{"project_id":"<project_id>","item_id":"<item_id>","field_id":"<field_id>"}'
```

## trigger_workflow_run

Manually trigger a GitHub Actions workflow via workflow_dispatch. The target workflow must declare a workflow_dispatch trigger in its "on:" block.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `workflow_id` | string | Required |
| `ref` | string | Optional |
| `inputs` | object | Optional |

**Example**

```bash
sulla github/trigger_workflow_run '{"owner":"<owner>","repo":"<repo>","workflow_id":"<workflow_id>"}'
```

## update_file

Update an existing file in a GitHub repository. Automatically fetches the current file SHA required for updates.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `path` | string | Required |
| `content` | string | Required |
| `message` | string | Required |
| `branch` | string | Optional |

**Example**

```bash
sulla github/update_file '{"owner":"<owner>","repo":"<repo>","path":"<path>","content":"<content>","message":"<message>"}'
```

## update_issue

Update an existing GitHub issue — edit title, body, labels, assignees, or state.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `issue_number` | number | Required |
| `title` | string | Optional |
| `body` | string | Optional |
| `state` | enum: open\|closed | Optional |
| `labels` | array | Optional |
| `assignees` | array | Optional |

**Example**

```bash
sulla github/update_issue '{"owner":"<owner>","repo":"<repo>","issue_number":"<issue_number>"}'
```

## update_pr

Edit a pull request — update its title, body, base branch, or open/closed state.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `owner` | string | Required |
| `repo` | string | Required |
| `pull_number` | number | Required |
| `title` | string | Optional |
| `body` | string | Optional |
| `base` | string | Optional |
| `state` | enum: open\|closed | Optional |

**Example**

```bash
sulla github/update_pr '{"owner":"<owner>","repo":"<repo>","pull_number":"<pull_number>"}'
```
