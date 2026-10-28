---
slug: sulla-publish-use-case
label: Publish a Sulla use case
trigger_when: When a completed skill, function, workflow, recipe, integration, or package should move from draft to an approved installable artifact.
trigger_actions: [publish use case, request publication, submit marketplace artifact]
trigger_phrases: [publish use case, request publish, marketplace publish]
scope: [sulla-use-cases, sulla-marketplace, sulla-decide]
---

**Do:**
1. Validate the local artifact and remove secrets, `.env`, keys, `.git`, caches, and build output.
2. Request publication through the Files publication flow; the draft stays invisible until a human approves it in Decide.
3. For a catalog submission, run `sulla marketplace/publish '{"kind":"<kind>","slug":"<slug>","version":"<version>"}'` only after owner approval.
4. Treat `pending` as not live; verify approval and installation separately.

**Don't:** send or publish outward-facing artifacts without the required human approval.
