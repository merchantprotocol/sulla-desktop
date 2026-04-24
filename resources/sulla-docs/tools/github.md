# Sulla Tools — GitHub / Git

## Authentication

Git push/pull authenticates via a Personal Access Token (PAT) stored in the vault. SSH remotes are auto-converted to HTTPS with the PAT injected as `x-access-token`.

**No SSH key setup needed.** The vault PAT handles all authentication.

---

## git_push / git_pull

```bash
exec({ command: "sulla github/git_push '{\"absolutePath\":\"/Users/jonathonbyrdziak/Sites/sulla/sulla-desktop\"}'" })
exec({ command: "sulla github/git_pull '{\"absolutePath\":\"/Users/jonathonbyrdziak/Sites/sulla/sulla-desktop\"}'" })
```

Parameters:
- `absolutePath` (required): Full path to the git repo on the Mac
- `remote` (optional): Remote name, defaults to `"origin"`
- `branch` (optional): Branch name, defaults to current branch

---

## git_commit

Stage and commit in one call.

```bash
exec({ command: "sulla github/git_commit '{\"absolutePath\":\"/path/to/repo\",\"message\":\"feat: add docs\",\"files\":[\"docs/README.md\"]}'" })
```

Parameters:
- `absolutePath` (required)
- `message` (required): Commit message
- `files` (optional): Array of specific files to stage; omit to stage all changes

---

## git_status / git_diff / git_log

```bash
exec({ command: "sulla github/git_status '{\"absolutePath\":\"/path/to/repo\"}'" })
exec({ command: "sulla github/git_diff '{\"absolutePath\":\"/path/to/repo\"}'" })
exec({ command: "sulla github/git_log '{\"absolutePath\":\"/path/to/repo\",\"limit\":10}'" })
```

---

## git_branch / git_checkout

```bash
exec({ command: "sulla github/git_branch '{\"absolutePath\":\"/path/to/repo\"}'" })
exec({ command: "sulla github/git_checkout '{\"absolutePath\":\"/path/to/repo\",\"branch\":\"feature/new-thing\",\"create\":true}'" })
```

---

## GitHub API Tools

### Create Issue
```bash
exec({ command: "sulla github/github_create_issue '{\"owner\":\"merchantprotocol\",\"repo\":\"sulla-desktop\",\"title\":\"Bug: X fails\",\"body\":\"Details...\",\"labels\":[\"bug\"]}'" })
```

### Create Pull Request
```bash
exec({ command: "sulla github/github_create_pr '{\"owner\":\"merchantprotocol\",\"repo\":\"sulla-desktop\",\"title\":\"feat: X\",\"body\":\"Summary...\",\"head\":\"feature/x\",\"base\":\"main\"}'" })
```

### Read/Write Files via GitHub API
```bash
exec({ command: "sulla github/github_read_file '{\"owner\":\"merchantprotocol\",\"repo\":\"sulla-resources\",\"path\":\"skills/README.md\"}'" })
exec({ command: "sulla github/github_create_file '{\"owner\":\"merchantprotocol\",\"repo\":\"sulla-resources\",\"path\":\"skills/new-skill.md\",\"content\":\"...\",\"message\":\"add skill\"}'" })
```

---

## Important Notes

- All git operations work on the **Mac filesystem** (paths like `/Users/jonathonbyrdziak/...`) even though the agent runs in Lima — the home dir is shared.
- Commits show author as configured in the repo's git config.
- PAT is fetched from vault at call time — never expires mid-session unexpectedly.
