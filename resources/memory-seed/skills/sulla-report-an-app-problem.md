---
slug: sulla-report-an-app-problem
label: Diagnose and report a Sulla Desktop app problem
trigger_when: When the Desktop app shows an error, especially while attaching files, and the human wants evidence or a clean issue draft.
trigger_actions: [capture app error, diagnose attachment failure, prepare bug report]
trigger_phrases: [the app shows an error, attach a file fails, file upload is broken, report this Desktop bug, capture the error]
scope: [sulla-desktop, tool-capture, tool-docker, tool-github]
---

**When:** Collect reproducible evidence before filing anything.

**Do:**
1. Ask for the exact user-visible error and the smallest reproduction steps; do not put secrets or private file contents in the report.
2. Capture the relevant screen with `sulla capture/screenshot '{}'`.
3. Check app/service logs using the named container only: `sulla docker/ps '{"all":true}'`; then `sulla docker/logs '{"container":"<container>","tail":200}'`.
4. Check for an available update with the user-facing **Check for Updates…** flow; do not invent an update tool.
5. Prepare an issue body containing expected behavior, actual error, steps, Desktop version, timestamp, sanitized logs, and screenshot path.
6. Before creating an outward-facing issue, ask once with `ask_user_question`; after approval use `sulla github/create_issue '{"owner":"<owner>","repo":"<repo>","title":"<short title>","body":"<prepared body>"}'`.

**Check:** Confirm the screenshot and sanitized evidence exist, and verify the returned issue URL/number after approval.

**Cleanup:** Keep only the requested evidence. Remove temporary copies only after the human approves deletion; never attach secrets.

**Traps:** A screenshot may contain private data. Logs can contain tokens or paths. Filing an issue sends data publicly or to collaborators and always waits for approval.
