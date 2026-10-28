---
slug: sulla-build-workflow
label: Build and validate a Sulla workflow graph
trigger_when: When you need to create or edit a workflow with agents, functions, routes, conditions, loops, approvals, responses, or recurring steps.
trigger_actions: [build a workflow, create a routine, edit workflow YAML, validate workflow, add approval]
trigger_phrases: [workflow, routine, workflow YAML, agent workflow, approval step, router, condition]
scope: [sulla-workflows]
---

**When:** Use a workflow for recurring or durable multi-step work. Keep a one-off task in the current conversation.

**Do:**
1. Write down the trigger, inputs, deterministic steps, model steps, branches, stop conditions, approval points, output, and failure limit.
2. Use `manual` or `schedule` for the trigger. A trigger config must include `triggerType` and `triggerDescription`.
3. Use an `agent` node only where judgment is needed. Its config requires `agentId`, `agentName`, `additionalPrompt`, `orchestratorInstructions`, `successCriteria`, and `completionContract`.
4. Use a `function` or `tool-call` node for deterministic work. Use a router for one model-selected route and a condition for true/false evaluation.
5. Put a `user-input` node before an approval-gated action. Set `promptText` to the exact decision needed. Follow with a condition when the answer selects approve or deny.
6. Pass data with `{{trigger}}`, `{{node-123.result}}`, or `{{node-123.threadId}}`. Unresolved values remain literal, so use stable node ids and inspect the live output.
7. Give loops a finite `maxIterations`. Connect entry to the loop with `targetHandle: loop-entry`, body with `sourceHandle: loop-start`, body return with `targetHandle: loop-back`, and exit with `sourceHandle: loop-exit`.
8. Validate: `sulla meta/validate_sulla_workflow '{"filePath":"/mnt/worktrees/<job>/routine.yaml"}'`.
9. Dry-run traversal: `sulla meta/dry_run_workflow '{"filePath":"/mnt/worktrees/<job>/routine.yaml"}'`.
10. Import the reviewed YAML as a draft: `sulla workflow/import_workflow '{"slug":"<slug>","yaml":"<complete-yaml>","status":"draft"}'`.
11. Review the returned Files ids. Request publication for each draft file: `sulla files/request_publish '{"file_id":"<file-id>","version_id":"<version-id>","reason":"Validated workflow ready to activate"}'`. Publication requires the human's approval.
12. After publication, run the exact id: `sulla meta/execute_workflow '{"workflowId":"<slug>","message":"<input>"}'`. Read health with `sulla workflow/routines_digest '{}'` and drill down only when flagged.

**Check:** Validation has no errors, dry-run reaches every intended terminal, the live execution completes, and its final output matches the contract.

**Don't:** Guess config fields, route handles, or slugs. Do not publish or trigger an externally consequential action without its required approval.
