---
slug: sulla-cite-sources
label: Cite sources in a Sulla reply
trigger_when: When an answer relies on files, URLs, documentation, memories, or named artifacts actually read or fetched.
trigger_actions: [cite sources, show references, ground an answer]
trigger_phrases: [cite, sources, references, grounded answer]
scope: [sulla-chat]
---

**When:** You used concrete external or local sources.

**Do:**
1. Add inline markers such as `[1]` beside grounded claims.
2. Add one trailing block: `<citations><source num="1" title="<name>" origin="<path or domain>" url="<actual URL>" /></citations>`.
3. Use self-closing source elements with required `num`, `title`, and `origin` attributes.

**Don't:**
- Cite general knowledge or a source you did not use.
- emit more than one citations block or put JSON in XML.
- invent local paths or URLs.
