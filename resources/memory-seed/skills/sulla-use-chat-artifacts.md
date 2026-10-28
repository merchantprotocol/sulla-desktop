---
slug: sulla-use-chat-artifacts
label: Create and maintain chat sidebar artifacts
trigger_when: When a result, plan, working document, code sample, or long-lived reference should stay open in the chat sidebar instead of being buried in replies.
trigger_actions: [create artifact, update artifact, open file in sidebar, restore artifact, close artifact]
trigger_phrases: [artifact, sidebar document, open this file, keep this visible, revision history, revert document]
scope: [sulla-chat]
---

**When:** Create an artifact for a document the human will follow, edit, compare, or revisit. Reply in chat for a short answer, status line, or transient explanation.

**Do:**
1. List first: `sulla chat/artifact_list '{"includeClosed":true}'`. Use one descriptive stable name such as `Playbook — Vendor review`; do not add “v2,” “new,” or “final.”
2. Create and focus once: `sulla chat/artifact_create '{"name":"Vendor review","kind":"html","content":"<main style=\"color:var(--text);background:var(--bg)\"><h1>Vendor review</h1></main>","status":"working","focus":true}'`. Kinds are `markdown`, `html`, and `code`. Creation by an existing name updates that artifact instead of duplicating it; use `expectedVersion` when doing so.
3. Before any shared write, read content and version: `sulla chat/artifact_read '{"idOrName":"Vendor review"}'`.
4. Replace complete content, rename, change status, or optionally focus with `artifact_update`: `sulla chat/artifact_update '{"idOrName":"Vendor review","expectedVersion":1,"status":"done","content":"<main>...complete document...</main>","focus":true}'`.
5. For narrow changes, use atomic exact replacements: `sulla chat/artifact_edit '{"idOrName":"Vendor review","expectedVersion":1,"edits":[{"find":"MOVING","replace":"DONE"}]}'`. Every `find` must occur exactly once or nothing changes.
6. For a notes or log tail, append verbatim: `sulla chat/artifact_append '{"idOrName":"Vendor review","expectedVersion":2,"text":"\n&lt;time copied from `date` output&gt; — Review finished."}'`.
7. Open a managed Files document by id with `sulla chat/artifact_open '{"file_id":"<file-id>","focus":true}'`. Edits save back to the same versioned file with conflict protection.
8. Bring attention without writing: `sulla chat/artifact_focus '{"idOrName":"Vendor review"}'`.
9. Inspect revisions newest first with `sulla chat/artifact_history '{"idOrName":"Vendor review"}'`. Restore an old version as a new revision: `sulla chat/artifact_revert '{"idOrName":"Vendor review","version":1,"expectedVersion":3}'`.
10. Close a finished tab without losing content or history: `sulla chat/artifact_close '{"idOrName":"Vendor review","expectedVersion":4}'`. Restore it with `sulla chat/artifact_reopen '{"idOrName":"Vendor review","expectedVersion":4}'`.
11. Soft-delete only when the human has approved deletion: `sulla chat/artifact_delete '{"idOrName":"Vendor review","expectedVersion":4,"confirm":true}'`. Revision history remains, but deleted artifacts stay hidden.

**Choose the operation:** update = replace the whole current document or metadata; edit = exact atomic find/replace; append = add a tail; close = hide the tab but preserve it; delete = approved soft deletion.

**Don't:**
- Don't create an artifact for every reply.
- Don't write without a fresh version when the human may be editing.
- Don't close a live Playbook while its goal is unfinished.
- Don't claim creation, focus, or persistence unless the tool response confirms it.
