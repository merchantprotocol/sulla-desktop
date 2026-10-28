---
slug: sulla-keep-a-playbook
label: Keep a live Playbook for a multi-step goal
trigger_when: When work has multiple chunks, background jobs, decisions, blockers, or milestones and the human needs one live sidebar plan to follow.
trigger_actions: [create a playbook, update the plan, track multi-step work, show progress in sidebar]
trigger_phrases: [make a plan, keep me updated, track the work, playbook, multi-step goal, sidebar plan]
scope: [sulla-chat, sulla-heartbeat]
---

**When:** Every multi-step goal gets one living Playbook artifact before execution starts. A quick answer or single reversible action stays in chat.

**Do:**
1. Outline every chunk from start to finish before writing details. Give each chunk an honest status color: `var(--success)` done, `var(--info)` moving, `var(--warning)` blocked or needs the human, `var(--danger)` failed, and `var(--text-dim)` not started.
2. Check for the dashboard skill: `sulla skills/skill_list '{"query":"chat-dashboard-components"}'`. If installed, load and materialize it with `sulla skills/skill_get '{"slug":"chat-dashboard-components","materialize":true}'`, then use its `publish-playbook.mjs` as its SKILL.md directs. Otherwise use the artifact tools below.
3. Read existing artifacts: `sulla chat/artifact_list '{"includeClosed":true}'`. Reuse the same stable name, `Playbook — <goal>`. Never create a second Playbook for the same goal.
4. Read the real clock before each log timestamp: `date '+%Y-%m-%d %H:%M %Z'`. Never estimate a time.
5. Create an `html` artifact and focus it:
   `sulla chat/artifact_create '{"name":"Playbook — Launch the report","kind":"html","status":"working","focus":true,"content":"<main style=\"font-family:var(--font-body);color:var(--text);background:var(--bg);padding:20px\"><h1 style=\"font-family:var(--font-display)\">Launch the report</h1><p style=\"color:var(--text-muted)\">Updated 2026-01-01 09:00 UTC</p><section style=\"border:1px solid var(--border);background:var(--surface-1);padding:14px\"><h2>A · Gather evidence <span style=\"color:var(--info)\">MOVING</span></h2><p>Collect and verify source facts.</p></section><section><h2>Decisions</h2><p>Use source A because it is current. Undo: revert artifact version 1.</p><h2>Needs the human</h2><p>Nothing.</p><h2>Log</h2><p>2026-01-01 09:00 UTC — Playbook opened; evidence gathering started.</p></section></main>"}'`
6. Use the app variables only: `--bg`, `--surface-1` through `--surface-3`, `--text`, `--text-muted`, `--text-dim`, `--accent`, `--accent-hover`, `--accent-dim`, `--accent-border`, `--border`, `--border-muted`, `--info`, `--success`, `--warning`, `--danger`; and `--font-display`, `--font-mono`, `--font-body`. Steel blue `--accent` is primary. Green is status only.
7. After every move, read first: `sulla chat/artifact_read '{"idOrName":"Playbook — Launch the report"}'`. Preserve human edits. Replace the complete HTML with `artifact_update`, passing the returned version: `sulla chat/artifact_update '{"idOrName":"Playbook — Launch the report","expectedVersion":1,"content":"<main>...complete current HTML...</main>"}'`.
8. Record each decision as “decision, because reason, undo path.” Keep a clear “Needs the human” section. Add clock-stamped log entries for starts, results, failures, recoveries, decisions, and completion.
9. Focus it when the human should look: `sulla chat/artifact_focus '{"idOrName":"Playbook — Launch the report"}'`.
10. When every chunk is final, update the same artifact with `status:"done"`, add the final clock-stamped log entry, focus it, and turn off the chat heartbeat.

**Use the right write:** `artifact_update` replaces the complete document or status. `artifact_edit` makes exact atomic replacements when each `find` occurs once. `artifact_append` adds a log tail. All writes should use the version returned by a fresh read.

**Don't:**
- Don't paste a Markdown plan into an HTML artifact.
- Don't hardcode colors or use green as the primary accent.
- Don't report progress in chat that the Playbook does not yet show.
- Don't overwrite a human edit after a version conflict. Read, merge, and retry.
