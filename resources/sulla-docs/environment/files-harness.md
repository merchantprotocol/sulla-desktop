# Use-case files harness

Use-case definitions live in Sulla Files under `Sulla/Use Cases/<type>/<slug>/`, where type is `agents`, `skills`, `workflows`, `functions`, or `recipes`. This path is the single source of truth for user and built-in definitions.

- **Edit = draft.** Agent writes create a new draft file version. Drafts are invisible to the runtime index.
- **Request publication.** After reviewing the draft, call `files_request_publish` with its `file_id` and `version_id`.
- **Human approval.** The request appears in Decide. A human approval publishes the version; rejection leaves the draft intact.
- **Only published is active.** The runtime loader rebuilds its Postgres index from published Files versions. Do not treat a draft or a direct database row as active.
- **Locks and retention apply.** Use the Files API so permissions, locks, retention, audit, and provenance are enforced. Never bypass the Files service with direct Postgres writes.

Built-in app-shipped definitions use the same namespace and are read-only to agents; app releases may update them.

## Use Case publishing

Files under `Sulla/Use Cases/<type>/<slug>/` are versioned drafts whether the
writer is an agent or a human (File Manager, upload, or FUSE). A draft never
activates a skill, workflow, agent, function, or recipe. The human activates a
version with **Publish** in File Manager; publishing an older version is the
rollback operation. Files outside this path retain the normal human-write
publishes-immediately behavior.
