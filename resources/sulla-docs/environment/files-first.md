# Files-first Sulla

Everything Sulla knows and produces lives in the File Manager, so there is one place to look.
Agents should read these docs from `/mnt/sulla-files/Sulla/Docs/` (the Files FUSE mount), not from the repository path; that keeps the same documentation available in containers and workflows.
The File Manager tree is mirrored exactly at `/mnt/sulla-files` inside the VM, workflow runners and agent containers.

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
    app/ services/ workflows/
  Training Data/   system area, hidden behind Trash → More; points at Sulla's conversation JSONL folder
```

## Rules

- No permission gating. Every agent can read and write every non-system file. A future permission design will replace this.
- Kept on purpose: the Files service token (`x-sulla-files-token`), the wallet/vault path exclusions, and no host-path mounts.
- Audit logs are append-only JSONL, one file per subject, named by stable id (renames never break the trail).
  Each line: `ts, actor, action, subjectKind, subjectId, path, result, requestId, prevHash, hash`. Never secret values.
  Only services write them; agents can read them. The format is ready to load into Apache AGE (actors/subjects = nodes, events = edges).
- Existing Postgres data is never migrated or dropped. File logs are added alongside existing audit tables.
- Use Cases: the files are the source of truth; Postgres is the runtime index, refreshed when a file is saved. Publishing packages a Use Case folder at a chosen version.
