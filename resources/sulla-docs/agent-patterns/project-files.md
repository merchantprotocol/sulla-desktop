# Project files in chat

Plans, specs, notes, and reports for a Projects project are durable Sulla Files documents. They are not host paths and are never read through a home-directory mount.

Create one with `chat/artifact_create` and supply `project_id`, `project_name`, `document_kind`, `owner_agent`, `delete_when`, plus related task and PR ids. Sulla writes YAML frontmatter (title, project id/name, epic, kind, owner, created/updated, status, deletion condition, tasks, and PRs), stores the document at `projects/<project-slug>/<file>.md`, and opens it in the artifact sidebar.

Always read before editing and pass `expectedVersion`. Sidebar and agent edits create new Files versions; if the Files version changed first, saving fails with a conflict instead of overwriting it. Use `chat/artifact_open` with `file_id` to open an existing project file. The Projects detail view lists linked files and their `delete_when` condition.

To embed the file in chat, include the `inlineReference` returned by the artifact tool in the message. Chat renders it as a file card with Open, History, and Edit inline controls. Inline and sidebar saves use the same artifact/Files write path.
