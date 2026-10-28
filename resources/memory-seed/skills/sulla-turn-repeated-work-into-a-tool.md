---
slug: sulla-turn-repeated-work-into-a-tool
label: Turn repeated agent work into a token-saving runtime tool
trigger_when: When an agent has repeated the same multi-step tool sequence, reshaping, polling, validation, or API glue and should stop spending tokens on it.
trigger_actions: [automate repeated work, save tokens, promote task to function, build runtime tool]
trigger_phrases: [same steps again, repeated tool calls, save tokens, turn this into a tool, automate this sequence, API glue, polling]
scope: [sulla-functions, sulla-workflows]
---

**When:** Promote deterministic work after the same sequence happens twice. A workflow coordinates steps; a function performs bounded computation or glue without model reasoning.

**Do:**
1. Search for existing capability first: `sulla meta/browse_tools '{"query":"<capability>"}'`.
2. Ask the zero-model repetition detector for evidence: `sulla workflow/find_repeated_tasks '{"threshold":2,"limit":20}'`.
3. Separate judgment from mechanics. Keep ambiguous choices in an agent, router, condition, or user approval. Move parsing, filtering, data shaping, bounded polling, validation, and stable API glue into a function.
4. Design the function contract before code: small typed inputs, small structured outputs, explicit error output or failure, timeout, retry ceiling, and no secrets.
5. Build and publish it with the function skill. Test it through `sulla function/run` using representative real-shaped but non-secret input.
6. Replace repeated agent instructions with a direct call: `sulla function/run '{"slug":"<slug>","inputs":{}}'`.
7. For recurring orchestration, add the same slug as a workflow `function` node. Template the prior output into `config.inputs`; branch on the returned result.
8. Compare before and after: count removed model turns and tool calls, confirm equal output shape, and inspect `sulla function/runs '{"slug":"<slug>","only_failures":true}'`.
9. Keep one source of truth. Update the function instead of teaching every agent the mechanical sequence again.

**Choose:**
- Function: deterministic transform, validation, polling, or API glue.
- Workflow: recurring coordination, schedule, branching, approval, checkpoints, or mixed agents and functions.
- Agent: judgment, language, research, or an ambiguous decision.
- Reminder: notify the human and do no work.

**Don't:** Encode policy judgment in brittle string rules, create a new tool before catalog search, or hide an irreversible send, post, payment, or delete inside code.
