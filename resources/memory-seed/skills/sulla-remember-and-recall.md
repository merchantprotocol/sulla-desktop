---
slug: sulla-remember-and-recall
label: Remember and recall durable context
trigger_when: When a fact, rule, preference, lesson, or prior conversation must persist or be found again.
trigger_actions: [remember a fact, recall a rule, search memory, find a prior conversation, store research]
trigger_phrases: [remember this, recall, memory, observation, prior conversation, what did we decide]
scope: [sulla-memory, sulla-identity]
---

**When:** Preserve context that should change future behavior, or retrieve context that recall did not surface.

**Do:**
1. Search operational memory: `sulla observation/search_observations '{"query":"<topic>"}'`.
2. Search identity memory: `sulla observation/search_identity_observations '{"domain":"<domain>","query":"<topic>"}'`.
3. Search conversations: `sulla memory/recall_conversations '{"query":"<topic>"}'`.
4. Add a durable operational fact: `sulla observation/add_observational_memory '{"priority":"high","content":"<verified fact and why it matters>"}'`.
5. Add a domain fact: `sulla observation/add_identity_observation '{"domain":"<domain>","level":3,"category":"<category>","content":"<fact>","basis":"Stated directly by the human."}'`.
6. For memory files, use `/mnt/sulla-files/Memory/<provider>/` and also record the fact with an observation tool.
7. Use recall-index lookup before rereading researched sources and store a digest after research.

**Trust order:**
- Current human instruction overrides recalled content.
- User-stated rules outrank inferred conclusions.
- Seeded product facts guide navigation, but volatile state and tool schemas require live verification.
- Episodes and inferred conclusions are evidence, not certainty.

**Don't:**
- Don't save temporary task status as memory.
- Don't include secrets, private records, or unverified deductions.
- Don't assume missing recall means the fact is absent; search explicitly.
