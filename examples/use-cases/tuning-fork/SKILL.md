---
sullaApi: ^1.0.0
hooks: []
slug: tuning-fork
name: Tuning Fork
title: Capture your brand voice once, use it in every draft
line: Build a reusable voice profile from real examples and check every new draft against it.
summary: Discovers a brand voice from owned examples, stores an editable voice memory pack, and applies evidence-based voice checks to drafts.
version: 1.0.0
category: marketing
tags: [brand, voice, writing, memory-pack, content]
license: MIT
memory_pack: true
---
# Tuning Fork

Learn the owner's voice from real material, turn the evidence into usable guidelines, and enforce those guidelines without flattening the writing.

## Use
1. Gather 5–10 representative examples from owner-provided Files, a public site opened with the browser, pasted text, or an optional connected Drive. Do not use confidential material unless the owner selects it.
2. Separate observation from inference. Capture repeated vocabulary, sentence rhythm, structure, tone, point of view, claims, calls to action, and explicit avoidances. Quote short evidence for each rule.
3. Ask only about meaningful contradictions: for example, warm newsletter copy versus terse support replies. Keep channel-specific variants rather than averaging them away.
4. Save the approved profile in the pack's `memory/subjects/tuning-fork.md`. Put operational drafting guidance in `memory/skills/tuning-fork-write-in-voice.md`. Bump `memory/manifest.json` whenever the pack changes.
5. For a draft, preserve its facts and purpose first. Compare it against the profile, identify the few highest-impact mismatches, revise, then show a short voice-check note. Never invent claims, testimonials, or personal stories to sound authentic.
6. Use `sulla files/search '{"query":"brand voice examples"}'` before creating new guidance and `sulla files/where '{"what":"brand voice guide","kind":"writing guide"}'` for a separate human-facing guide.
7. If examples live on a public site, discover the current browser read tool with `sulla meta/browse_tools '{"query":"read a public website"}'`. If a Drive integration is wanted, check the vault and discover its exact operations rather than guessing.
8. Sending or posting a revised draft waits for the human's explicit Approve through `sulla meta/ask_user_question`.

## Output
Produce: voice in one sentence; five evidence-backed traits; vocabulary to use/avoid; rhythm and structure; channel variants; before/after examples; confidence and gaps; and a short checklist other drafting skills can apply.

---
Adapted from brand-voice by Tribe AI. MIT License, Copyright (c) 2025 Tribe AI.
