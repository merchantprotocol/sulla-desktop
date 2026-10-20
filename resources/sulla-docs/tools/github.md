# Sulla Tools — GitHub / Git

**58 tools** — local git on the shared Mac filesystem, plus the GitHub REST/GraphQL API. All authenticated by the vault PAT.

## Authentication

Git and API calls authenticate via a Personal Access Token (PAT) stored in the vault, injected automatically at call time. SSH remotes are auto-converted to HTTPS with the PAT as `x-access-token`. **No SSH key setup, no raw `gh`, never extract the PAT yourself** — it's autofill-protected and a raw `git push` fails with no credential helper. Always go through these tools.

Local git tools take `absolutePath` — the repo path (or **any path inside it**) on the Mac. Home is shared into Lima, so `/Users/<you>/Sites/...` paths work from the agent.

---

## Local git (14)
| Tool | Purpose |
|------|---------|
| `git_status` | Working-tree status: branch, staged/unstaged/untracked. |
| `git_add` | Stage files. |
| `git_commit` | Stage + commit (`message`; optional `files[]`, else stages all). |
| `git_push` | Push to remote (PAT injected). `remote` default `origin`, `branch` default current. |
| `git_pull` | Pull from remote. |
| `git_fetch` | Authenticated fetch without touching the working tree; optional `branch` and `prune`. Returns changed remote-tracking refs. |
| `git_branch` | Create / switch / delete / list branches. |
| `git_checkout` | Restore files from a commit/branch, or discard changes. |
| `git_log` | Commit history (`limit`). |
| `git_diff` | Diff working tree / staged / commits. |
| `git_blame` | Per-line last-modifier attribution. |
| `git_conflicts` | List conflicted files + their conflict diffs. |
| `git_stash` | Save / list / apply / pop / drop. |
| `git_worktree` | Add / list / remove / prune worktrees — check out several branches at once (great for reviewing/building parallel PRs). |

```bash
sulla github/git_push '{"absolutePath":"/Users/jonathonbyrdziak/Sites/sulla/sulla-desktop","branch":"my-branch"}'
sulla github/git_commit '{"absolutePath":"/path/to/repo","message":"feat: X","files":["docs/README.md"]}'
sulla github/git_fetch '{"absolutePath":"/path/to/repo","remote":"origin","branch":"main","prune":true}'
```

## Per-worker file claims (3)

`github/claim_files`, `github/release_files`, and `github/list_claims` coordinate workers editing linked worktrees. Repository identity comes from Git's common directory, so claims created in one worktree are visible from every worktree of that repository.

```bash
sulla github/claim_files '{"absolutePath":"/path/to/worktree","paths":["pkg/example/**","docs/readme.md"],"ownerLabel":"worker-2","jobId":"agent-job-123"}'
sulla github/list_claims '{"absolutePath":"/path/to/another-worktree"}'
sulla github/release_files '{"absolutePath":"/path/to/worktree","ownerLabel":"worker-2"}'
```

Claims are advisory: `git_status`, `git_add`, and `git_commit` append a clear warning when changed files match a claim from another worktree, but never block the operation. Release claims manually when the worker finishes. Automatic job-completion release is not currently wired.

## Repositories & refs (10)
`github/init`, `github/add_remote`, `github/create_repo`, `github/get_repo`, `github/list_repos`, `github/delete_repo` (destructive), `github/fork_repo`, `github/list_branches`, `github/create_ref` (create a remote branch/tag at a SHA or another branch's tip), `github/delete_ref` (delete a remote branch/tag).

## Files via API (3)
`github/read_file`, `github/create_file`, `github/update_file` — read/write a file directly in a remote repo without cloning. This is the **API-replication fallback** when local push is unavailable: `create_ref` a branch → `create_file`/`update_file` per changed file → `create_pr`.

## Issues (7)
`github/create_issue`, `github/get_issue`, `github/get_issues`, `github/get_issue_comments` (PRs are issues — pass the PR number), `github/update_issue`, `github/close_issue` (reason `completed`/`not_planned`), `github/comment_on_issue`.

## Pull requests (12)
`github/create_pr` (`draft:true` for draft), `github/get_pr`, `github/list_prs`, `github/update_pr`, `github/ready_pr` (draft → ready; drafts can't be merged), `github/draft_pr` (ready → draft; **requires `comment`** saying what to fix, posted before the conversion — the reversible way to hand work back instead of leaving it in limbo), `github/close_pr`, `github/merge_pr` (`merge`/`squash`/`rebase`, requires `confirm:true`), `github/add_pr_review` (APPROVE / REQUEST_CHANGES / COMMENT), `github/list_pr_reviews`, `github/request_pr_reviewers`, `github/get_pr_files`.

```bash
sulla github/create_pr '{"owner":"merchantprotocol","repo":"sulla-desktop","title":"feat: X","head":"feature/x","base":"main","draft":true}'
```

## Releases & CI (4)
`github/create_release` (cuts the release + git tag), `github/check_runs` (CI status for a ref — is it green?), `github/ci_logs` (failure annotations plus bounded Actions job-log excerpts for a `runId`, `jobId`, or `ref`), `github/trigger_workflow_run` (manual `workflow_dispatch`).

```bash
sulla github/ci_logs '{"owner":"merchantprotocol","repo":"sulla-desktop","ref":"main","failedOnly":true,"maxLines":300}'
```

## Projects V2 boards (3, GraphQL)
`github/list_projects` (board node ids + fields + single-select options), `github/add_issue_to_project`, `github/set_project_field` (most often the Status single-select).

## Heartbeat issue-discovery (2)
`github/heartbeat_new_issues` (open issues Heartbeat hasn't handled — anti-joined against the seen-set), `github/heartbeat_claim_issue` (atomic claim + collision guard). Internal to the Heartbeat operator loop.

---

## Notes
- All local git operates on the **Mac filesystem** — the home dir is shared into Lima.
- Commit author is the repo's configured git identity.
- Merges and destructive ops require a confirm flag: `github/merge_pr` and `github/close_pr` need `confirm:true`; `github/delete_repo` needs `confirm:true` plus `confirm_name` matching the repo name; `github/delete_ref` and a non-draft `github/create_release` need `confirm:true`.
- Pushed changes to a running app still need a **rebuild/restart** to take effect in the binary.

### Tested PR heads and complete inventories

`github/merge_pr` accepts optional `sha`, the full 40-character tested head SHA.
GitHub rejects the request if the PR head changed before the merge. A response
with `merged: false` is reported as a failure. This does not pin the base branch;
recheck main and required CI before merging and verify main afterward.

`github/list_prs` accepts `page` (positive integer, default 1), with `limit` up to
100 per page. Follow the returned next-page indication using the same filters
until no next page remains to inventory every open PR, including drafts.
