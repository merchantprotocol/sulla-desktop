---
sullaApi: ^1.0.0
hooks: []
slug: muscle-memory
name: Muscle Memory
title: Turn tribal knowledge into a runbook anyone can follow
line: Capture a repeatable procedure with exact steps, checks, rollback, and escalation.
summary: Creates or updates source-linked operational runbooks from walkthroughs, notes, or existing Files documents.
version: 1.0.0
category: operations
tags: [operations, runbook, documentation, incident-readiness]
license: Apache-2.0
---
# Muscle Memory

Turn a recurring task into a runbook that a person unfamiliar with it can execute safely.

## Use
1. Gather the process name, owner, frequency, prerequisites, inputs, exact actions, expected results, failure modes, rollback, and escalation path. Accept pasted notes, an uploaded document, or a walkthrough transcript from Secretary Mode.
2. Run `sulla files/search '{"query":"<process name> runbook"}'` before creating anything. Update a matching document instead of making a duplicate. Use `sulla files/where '{"what":"operational runbook for <process>","kind":"runbook"}'` to choose a destination.
3. Separate facts from assumptions. Mark unknown commands, permissions, thresholds, and contacts for confirmation; never invent production access or claim a command was tested.
4. Write Purpose, Prerequisites, Procedure, Verification, Troubleshooting, Rollback, Escalation, and History. Each procedure step has an exact action, expected result, and failure response. Prefer dry-runs and least privilege.
5. Save the draft in Files when the human asks. If a command needs checking, use `sulla docker/logs` only in an isolated dry-run container and state what was actually verified. Do not run destructive production commands.
6. Have a stranger follow the draft, record gaps, and revise. Keep revisions source-linked.

## Output
Return the runbook, assumptions and unverified items, verification evidence, and a suggested next review date. Never publish to an external wiki without explicit approval.

Adapted from `operations/skills/runbook` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
