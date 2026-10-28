---
slug: sulla-create-skill
label: Create a Sulla skill
trigger_when: When reusable agent instructions, voice, or a procedure should be packaged as a Markdown skill.
trigger_actions: [create skill, package skill, write agent instructions]
trigger_phrases: [skill, SKILL.md, reusable instructions]
scope: [sulla-use-cases]
---

**Do:**
1. Scaffold or create a bundle containing `SKILL.md`.
2. Add frontmatter with `sullaApi: ^1.0.0` and `hooks: []` unless a reviewed hook is required.
3. Write a human-described `trigger_when`, exact imperative steps, and safe boundaries.
4. Validate with `sulla marketplace/validate '{"kind":"skill","slug":"<slug>"}'`; request Files publication rather than treating the draft as active.
