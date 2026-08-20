# Sulla Tools — GitHub / Git

**52 tools** — local git on the shared Mac filesystem, plus the GitHub REST/GraphQL API. All authenticated by the vault PAT.

## Authentication

Git and API calls authenticate via a Personal Access Token (PAT) stored in the vault, injected automatically at call time. SSH remotes are auto-converted to HTTPS with the PAT as `x-access-token`. **No SSH key setup, no raw `gh`, never extract the PAT yourself** — it's autofill-protected and a raw `git push` fails with no credential helper. Always go through these tools.

Local git tools take `absolutePath` — the repo path (or **any path inside it**) on the Mac. Home is shared into Lima, so `/Users/<you>/Sites/...` paths work from the agent.

---

## Local git (13)
| Tool | Purpose |
|------|---------|
| `git_status` | Working-tree status: branch, staged/unstaged/untracked. |
| `git_add` | Stage files. |
| `git_commit` | Stage + commit (`message`; optional `files[]`, else stages all). |
| `git_push` | Push to remote (PAT injected). `remote` default `origin`, `branch` default current. |
| `git_pull` | Pull from remote. |
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
```

## Repositories & refs (10)
`github_init`, `github_add_remote`, `github_create_repo`, `github_get_repo`, `github_list_repos`, `github_delete_repo` (destructive), `github_fork_repo`, `github_list_branches`, `github_create_ref` (create a remote branch/tag at a SHA or another branch's tip), `github_delete_ref` (delete a remote branch/tag).

## Files via API (3)
`github_read_file`, `github_create_file`, `github_update_file` — read/write a file directly in a remote repo without cloning. This is the **API-replication fallback** when local push is unavailable: `create_ref` a branch → `create_file`/`update_file` per changed file → `create_pr`.

## Issues (7)
`github_create_issue`, `github_get_issue`, `github_get_issues`, `github_get_issue_comments` (PRs are issues — pass the PR number), `github_update_issue`, `github_close_issue` (reason `completed`/`not_planned`), `github_comment_on_issue`.

## Pull requests (11)
`github_create_pr` (`draft:true` for draft), `github_get_pr`, `github_list_prs`, `github_update_pr`, `github_ready_pr` (draft → ready; drafts can't be merged), `github_close_pr`, `github_merge_pr` (`merge`/`squash`/`rebase`, requires `confirm:true`), `github_add_pr_review` (APPROVE / REQUEST_CHANGES / COMMENT), `github_list_pr_reviews`, `github_request_pr_reviewers`, `github_get_pr_files`.

```bash
sulla github/github_create_pr '{"owner":"merchantprotocol","repo":"sulla-desktop","title":"feat: X","head":"feature/x","base":"main","draft":true}'
```

## Releases & CI (3)
`github_create_release` (cuts the release + git tag), `github_check_runs` (CI status for a ref — is it green?), `github_trigger_workflow_run` (manual `workflow_dispatch`).

## Projects V2 boards (3, GraphQL)
`github_list_projects` (board node ids + fields + single-select options), `github_add_issue_to_project`, `github_set_project_field` (most often the Status single-select).

## Heartbeat issue-discovery (2)
`heartbeat_new_issues` (open issues Heartbeat hasn't handled — anti-joined against the seen-set), `heartbeat_claim_issue` (atomic claim + collision guard). Internal to the Heartbeat operator loop.

---

## Notes
- All local git operates on the **Mac filesystem** — the home dir is shared into Lima.
- Commit author is the repo's configured git identity.
- Merges and destructive ops (`github_merge_pr`, `github_delete_repo`) require `confirm:true`.
- Pushed changes to a running app still need a **rebuild/restart** to take effect in the binary.
