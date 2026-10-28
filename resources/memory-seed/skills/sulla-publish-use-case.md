---
slug: sulla-publish-use-case
label: Publish a Sulla use case through Files approval
trigger_when: When a use case draft in Sulla Files is complete and should become an active agent, skill, workflow, function, or recipe.
trigger_actions: [publish use case draft, activate use case, request Files publication, approve use case]
trigger_phrases: [publish use case, activate draft, publish draft, request publication]
scope: [sulla-use-cases, sulla-files, sulla-decide]
---

**When:** Use this for the local Files-to-active transition. Marketplace submission is a separate outward-facing step.

**Do:**
1. Validate the artifact first with `sulla marketplace/validate '{"kind":"<kind>","slug":"<slug>"}'`; validate workflows fully with `sulla meta/validate_sulla_workflow`.
2. Inspect the draft contents and remove secrets, `.env`, keys, `.git`, caches, private account data, and build output. Keep only the files the use case needs.
3. Request publication with the exact draft identifiers: `sulla files/request_publish '{"file_id":"<file_id>","version_id":"<version_id>","reason":"Activate reviewed use case"}'`.
4. Tell the human the request is pending in Decide. Only the human-side Files approval activates the version; the agent cannot publish it itself.
5. After approval, verify the active artifact and run a safe smoke check. Never call it active merely because the request was created.
6. If marketplace distribution is wanted after local activation, use `sulla marketplace/publish '{"kind":"<kind>","slug":"<slug>","version":"<semver>"}'` only after the human has approved the local artifact and outward submission is authorized. A Cloud session is required, and the marketplace status remains `pending` until review.

**Don't:**
- Don't confuse a Files draft or pending marketplace submission with an active or live artifact.
- Don't upload secrets or private data.
- Don't use marketplace unpublish casually; it is an outward-facing removal and needs explicit confirmation.
