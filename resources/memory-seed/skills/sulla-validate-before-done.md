---
slug: sulla-validate-before-done
label: Validate work before claiming completion
trigger_when: When implementation, configuration, a workflow, a function, or delegated work is ready to report complete.
trigger_actions: [verify completion, validate before done, check the result]
trigger_phrases: [done, complete, verify, validate, ready]
scope: [sulla]
---

**When:** You are about to use DONE or report success.

**Do:**
1. Compare the result against the user's requested outcome and acceptance checks.
2. Run the safest relevant verification or inspect the returned tool result; distinguish what you checked from what you did not run.
3. If incomplete, use `<AGENT_CONTINUE>`; if blocked by required user input, use `<AGENT_BLOCKED>`; otherwise use exactly one `<AGENT_DONE>` wrapper.

**Don't:**
- claim tests, builds, sends, deployments, or file changes that have no evidence.
- hide a remaining gap behind a summary.
