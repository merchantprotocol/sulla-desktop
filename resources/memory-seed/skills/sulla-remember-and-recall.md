---
slug: sulla-remember-and-recall
label: Remember and recall durable context
trigger_when: When a fact, rule, preference, lesson, or prior conversation must persist or be found again.
trigger_actions: [remember a fact, recall a rule, search memory, find a prior conversation, store research]
trigger_phrases: [remember this, recall, memory, prior conversation, what did we decide, update my business goals, change my goals, my goals changed, update my goals, business goals, about me]
scope: [sulla-memory, sulla-identity]
---

**When:** Preserve context that should change future behavior, or retrieve context that recall did not surface.

**Do:**
1. Search subject memory: `sulla memory/episodic_recall '{"query":"<topic>"}'`, or `sulla memory/episodic_search '{"query":"<topic>"}'` for what was said before.
2. Search conversations: `sulla memory/recall_conversations '{"action":"search","query":"<topic>"}'`.
3. Durable rules and facts the human states are written to subject memory automatically after each turn; there is no manual observation tool.
4. For a fact that must be kept as a document, write a memory file under `/mnt/sulla-files/Memory/<provider>/`.
5. Preserve the human's wording when recording a goal; do not infer a replacement goal.
6. Use recall-index lookup before rereading researched sources and store a digest after research.

**Trust order:**
- Current human instruction overrides recalled content.
- User-stated rules outrank inferred conclusions.
- Seeded product facts guide navigation, but volatile state and tool schemas require live verification.
- Episodes and inferred conclusions are evidence, not certainty.

**Don't:**
- Don't save temporary task status as memory.
- Don't overwrite or delete an old goal just because a new one was stated; record the new goal and explain the change, unless the human explicitly asks to forget the old one.
- Don't include secrets, private records, or unverified deductions.
- Don't assume missing recall means the fact is absent; search explicitly.
