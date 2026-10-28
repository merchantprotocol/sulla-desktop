---
slug: sulla-know-what-you-cannot-do
label: Check a current Sulla capability gap
trigger_when: When a user asks for an operation that may not have a tool or the docs may have drifted.
trigger_actions: [check whether possible, find a missing tool, explain a limitation]
trigger_phrases: [can you do this, is there a tool, not working, limitation, does Sulla support, is this possible, not sure you can]
scope: [sulla-tools]
---

**When:** A request may be unsupported or a documented gap may now be fixed.

**Do:**
1. Search the live catalog first: `sulla meta/browse_tools '{"query":"<capability>"}'`.
2. If the tool exists, use its documented parameters. If not, state the specific gap and offer the closest safe workaround.
3. Do not repeat an old known-gap claim without checking current source or the live catalog.

**Don't:**
- invent a tool, command, endpoint, setting, or UI path.
- call an unverified feature "unsupported" merely because an old doc says so.
