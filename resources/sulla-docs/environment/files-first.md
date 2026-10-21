# Files-first Sulla

Everything Sulla knows and produces lives in the File Manager, so there is one place to look.
Agents should read these docs from `/mnt/sulla-files/Sulla/Docs/` (the Files FUSE mount), not from the repository path; that keeps the same documentation available in containers and workflows.
The File Manager tree is mounted at `/mnt/sulla-files` inside the VM, workflow runners and agent containers. Use normal file tools (ls, cat, edit, write, mv, cp) on the mount — every change is versioned and audited automatically.
For how to save, publish, and handle locks, read [files-harness.md](files-harness.md).

Agent Git worktrees live at `/mnt/worktrees` (backed by the persistent ext4 path `/mnt/data/worktrees`). That path is not a Files collection. Files watches only its configured roots, so worktrees are not indexed unless you track them.

## Layout

```
/mnt/sulla-files/
  <Jonathon's own folders>
  Sulla/
    Docs/          environment + tool docs (this file lives here)
    Use Cases/     skills/ workflows/ agents/ functions/ recipes/ — one folder per item, versioned by Files
    Projects/      plan files and project working docs
    Identity/
  Logs/            system area, hidden in the UI behind Trash → More
    audit/files/<file-id>.jsonl
    audit/vault/<secret-id>.jsonl
    app/
  Training Data/   system area, hidden behind Trash → More; points at Sulla's conversation JSONL folder
```

## Rules

- No permission gating yet. Every agent can read and write every non-system file. Agent writes are drafts until a human publishes them. Per-agent permissions are planned (per-agent identity on every write is already tracked).
- Every write carries the agent's identity (`X-Sulla-Actor` header through FUSE). This enables audit attribution and future per-agent permissions.
- Temporary work goes in `/tmp/<job id>/`. Move anything worth keeping into `/mnt/sulla-files`.
- Every folder has a `_folder-metadata.yaml` file. Read it to understand the folder's purpose and file metadata. When you create a folder, fill in the description.
- Kept on purpose: the Files service token (`x-sulla-files-token`), the wallet/vault path exclusions, and no host-path mounts.
- Audit logs are append-only JSONL, one file per subject, named by stable id (renames never break the trail).
  Each line: `ts, actor, action, subjectKind, subjectId, path, result, requestId, prevHash, hash`. Never secret values.
  Only services write them; agents can read them.
- Existing Postgres audit tables stay. File logs are added alongside them.
- Use Cases: the files are the source of truth; Postgres is the runtime index. The index is rebuilt from published versions about every 2 seconds, so a publish takes effect within seconds. Only published versions are active. Drafts never are. See [files-harness.md](files-harness.md#5-use-cases-lifecycle).
- The one-time Use Case migration copies old Postgres definitions into Files. It never deletes Postgres rows. It only disables runtime rows whose Files definition is gone.
