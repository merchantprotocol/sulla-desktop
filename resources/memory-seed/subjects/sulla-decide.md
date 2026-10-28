---
slug: sulla-decide
kind: system
name: Decide
parent: sulla
aliases: [Decide, approvals, approval policy, human decision]
---

## Overview
Decide is the left-rail view for durable conversation requests and tool approval policies. A request is bound to its original conversation and process session and settles only the waiting call. Approve, deny, answer, or defer do not create a new conversation. Offline snapshots and stale requests are not authorization to execute.

## Facts
- Decisions are stored in `human_decisions`; tool policies are stored in `tool_approval_policies`.
- Requests contain no tool arguments, credentials, or executable closures.
- Duplicate, wrong-conversation, expired, and orphaned requests fail closed; restart expires old requests.
- Native graph calls and provider CLI calls carry session context; a gated call without conversation context fails closed.
- Remote decision clients must use existing authenticated paired transport and wait for `settled: true` before showing acceptance.

## Rules
- DO: Review the original tool call before approving it. Why: approval settles the waiting call and does not replay a new action.
- DO: Treat `defer` as leaving the existing caller waiting until expiry. Why: it is not approval.
- DON'T: use an offline snapshot as execution authority. Why: only the live authenticated device can authorize the action.
