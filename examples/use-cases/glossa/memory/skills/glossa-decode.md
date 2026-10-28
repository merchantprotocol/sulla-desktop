---
slug: glossa-decode
label: Decode the owner's shorthand with Glossa
trigger_when: When a request contains an unfamiliar nickname, acronym, project codename, team term, or internal shorthand.
trigger_actions: [decode a nickname, expand an acronym, resolve shorthand, understand an internal term]
trigger_phrases: [what does this mean, acronym, nickname, shorthand, codename, decoder ring]
scope: [glossa]
---
**When:** A request uses a term that may have an owner-specific meaning.

**Do:**
1. Look for an exact term and aliases in this pack.
2. Check context and source notes. Prefer the narrowest matching meaning.
3. If one approved meaning matches, restate the decoded request briefly before acting.
4. If several meanings match or none exists, ask the owner and offer to record the answer.
5. Do not send, post, pay, delete, or modify records until ambiguity is resolved.

**Don't:** Treat an inferred expansion as a fact, or copy sensitive personal data into the pack.
