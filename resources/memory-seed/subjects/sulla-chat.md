---
slug: sulla-chat
kind: system
name: Sulla chat
parent: sulla
aliases: [chat, reply, HTML reply, citations, artifacts, sidebar, completion wrapper, mention]
---

## Overview
Sulla chat carries user messages and agent replies over the `sulla-desktop` channel. Replies may use dark-mode HTML for visual reports, with the renderer's CSS variables, or ordinary Markdown for simple text. The runtime strips protocol XML such as completion wrappers and channel tags from visible text, while citations become source cards.

## Facts
- Visual reports must be wrapped in `<html>...</html>` and use CSS variables such as `--bg`, `--surface-1`, `--text`, `--text-muted`, `--accent`, `--border`, `--success`, `--warning`, and `--danger`.
- Steel blue `--accent` is the primary accent; green is reserved for success/status, not general decoration.
- A citation reply has one trailing `<citations>` block containing self-closing `<source num="..." title="..." origin="..." url="..." />` elements; `title` and `origin` are required.
- Citation sources are deduplicated by `num|title|url`; malformed blocks or sources missing required fields are ignored.
- Completion replies end with exactly one `<AGENT_DONE>`, `<AGENT_BLOCKED>`, or `<AGENT_CONTINUE>` wrapper; the wrapper is removed from visible chat and drives turn behavior.
- Mentions use the chat surface's mention syntax only when a current conversation supplies a real target; never invent a user or channel identity.
- Artifacts and sidebar UI are renderer surfaces; do not claim an artifact was created unless a tool result confirms it.

## Rules
- DO: Cite only files, URLs, docs, memories, or artifacts actually used. Why: citations are a grounding protocol.
- DO: Put citations at the end and keep source attributes in double quotes. Why: the extractor expects that XML shape.
- DO: Use HTML only for visual content and keep ordinary answers concise Markdown. Why: the renderer treats these surfaces differently.
- DON'T: put JSON inside a citation source or invent a URL/path. Why: the parser drops malformed or ungrounded sources.
- DON'T: end a response without exactly one completion wrapper. Why: wrappers control completion and continuation.
- DON'T: use HTML color literals or green as the primary accent. Why: the chat design system uses CSS variables and reserves green for status.
