---
sullaApi: ^1.0.0
hooks: []
slug: glossa
name: Glossa
title: Teach Sulla your people, acronyms and shorthand
line: Build an editable decoder ring so shorthand is understood without guessing.
description: Capture owner-approved people, terms, projects, and preferences as a scoped Sulla memory pack.
category: productivity
tags: [memory, glossary, people, acronyms, shorthand]
license: Apache-2.0
memory_pack: true
---
# Glossa

Glossa turns owner-approved shorthand into a small, editable memory pack. It distinguishes facts from guesses and asks when a term is genuinely unknown.

## When to use
Use when Sulla misreads a nickname, acronym, project codename, team term, or recurring preference.

## Steps
1. Search existing Files and memory before adding a duplicate: `sulla files/search '{"query":"glossary shorthand people acronyms"}'` and `sulla observation/search_observations '{"query":"acronym nickname project term"}'`.
2. Capture the exact term, approved meaning, context, aliases, and source. Never infer a person's identity, role, or sensitive trait from a message.
3. Keep a compact hot set in the pack subject and put richer context in separate subjects. Use plain language and aliases a human would type. Separate “stated”, “derived”, and “unknown”; unknown terms remain questions.
4. Put durable decoding guidance in `memory/skills/glossa-decode.md`, and update `memory/manifest.json` whenever pack content changes. The pack is scoped and editable; it does not override core safety rules.
5. Before acting on shorthand, decode it from the pack. If multiple meanings match, show the ambiguity and ask the human. Do not send, post, pay, delete, or change records based on an unresolved term.
6. Save a human-facing glossary in the existing Files location only when requested. Memory pack content is not a substitute for the owner's source documents.

## Privacy
Store only what helps the requested work. Keep personal data in Files and avoid secrets, credentials, financial account numbers, and private identifiers. The human can edit, sync, or uninstall this pack.

## Attribution
Adapted from `productivity/skills/memory-management` in anthropics/knowledge-work-plugins, Copyright Anthropic, PBC. Licensed under the Apache License 2.0. Modified for Sulla Desktop.
