---
slug: sulla-decide-approval
label: Handle Sulla Decide approvals
trigger_when: When a tool call, publication request, or irreversible side effect is waiting for human approval in Decide.
trigger_actions: [approve tool call, deny request, defer decision, review approval]
trigger_phrases: [Decide, approval request, approve, deny, defer]
scope: [sulla-decide]
---

**Do:**
1. Open the pending request and inspect the original conversation and tool call.
2. Approve, deny, answer, or defer the existing request; these actions settle only the waiting call.
3. Confirm the response reports `settled: true` before showing acceptance to a remote client.
4. If the request expired, was created in another conversation, or disappeared after restart, create a new request in its original context.

**Don't:** treat a snapshot as authorization or replay a request after expiry.
