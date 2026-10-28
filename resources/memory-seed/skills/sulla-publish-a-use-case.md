---
slug: sulla-publish-a-use-case
label: Create or update a Sulla Use Case safely
trigger_when: When creating or editing an agent, skill, workflow, function, or recipe that the runtime should activate.
trigger_actions: [create an agent, edit a skill, build a workflow, publish a function, update a recipe]
trigger_phrases: [Use Case, publish draft, activate skill, activate workflow, agent definition, recipe]
scope: [sulla-use-cases, sulla-files]
---

**When:** Change a runtime definition whose Files version must be reviewed and published.

**Do:**
1. Search `/mnt/sulla-files/Use Cases/<type>/` and update the existing slug.
2. Read the current files and folder metadata.
3. Edit the definition in place. The write creates a draft.
4. Find the current validator with `sulla meta/browse_tools '{"query":"validate <type>"}'` and validate the artifact.
5. List versions: `sulla files/versions '{"path":"Use Cases/<type>/<slug>/<file>"}'`.
6. Request publication: `sulla files/request_publish '{"file_id":"<file-id>","version_id":"<draft-version-id>","reason":"Validated update"}'`.
7. Report that activation remains pending until the human approves the Decide card.

**Don't:**
- Don't write runtime index tables directly.
- Don't claim a draft is active.
- Don't bypass locks or retention.
