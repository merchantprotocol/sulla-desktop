# Citations — the `<citations>` XML Protocol

Sulla's chat UI renders a grid of source cards beneath any reply that declares its sources. The agent triggers this by emitting a single trailing XML block. There is no API-level citations integration — it's a prompt-side contract that works on every backend (Claude Code, direct Anthropic SDK, Grok, local llama-server).

## When to emit a block

Emit `<citations>` whenever your answer is grounded in **concrete, nameable sources you actually used**:

- Files you read this turn (`Read`, `Grep` hits, etc.)
- URLs you fetched (`WebFetch`, browser tab navigation, search results)
- Docs you referenced (sulla-docs pages, third-party documentation passages)
- Specific memories or artifacts you pulled in

Do **not** emit a block when:
- You're speculating or reasoning from general knowledge
- You used zero external sources (a casual greeting, a code explanation from memory, etc.)
- The "source" is something internal you can't point at (tool registry, agent rules)

The block is optional. Omitting it is correct for most short replies. Inventing sources is not — never cite a URL or path you didn't actually touch.

## Exact shape

```xml
<citations>
  <source num="1" title="BaseNode.ts" origin="pkg/rancher-desktop/agent/nodes" url="file:///Users/…/BaseNode.ts" />
  <source num="2" title="Anthropic Citations" origin="docs.anthropic.com" url="https://docs.anthropic.com/…" />
</citations>
```

**Required attributes on every `<source />`:**
| Attribute | Meaning |
|-----------|---------|
| `num` | Integer matching the inline marker in the prose (`[1]`, `[2]`). |
| `title` | Short human label the card shows prominently. Filename, page title, doc name. |
| `origin` | Where it came from. Domain (`docs.anthropic.com`), path (`pkg/…/nodes`), or logical category (`sulla-memory`). |

**Optional:**
| Attribute | Meaning |
|-----------|---------|
| `url` | Click target. `file:///…` for local paths, `https://…` for web. Omit if there's nowhere clickable to go. |

Use double quotes for values. Encode `&` as `&amp;` and `"` as `&quot;` inside attribute values — the parser unescapes those back.

## Inline markers

In the prose, reference sources as `[1]`, `[2]`, `[3]` — plain brackets, not footnote syntax. These stay as literal text in the reply; the card grid appears beneath.

```
The streaming-complete sentinel is emitted at text→tool_use boundaries [1],
and Anthropic's native Citations API is a separate feature layered on
top of document content blocks [2].

<citations>
  <source num="1" title="BaseNode.ts" origin="pkg/…/nodes" url="file:///…" />
  <source num="2" title="Anthropic Docs" origin="docs.anthropic.com" url="https://…" />
</citations>
```

## What the runtime does for you

- **Streaming safety.** The stream-flush layer (`stripProtocolTagsStreaming`) truncates the visible buffer at the first `<citations` so partial blocks never leak to the user mid-stream.
- **Parse + strip + dispatch.** After the reply completes, `CitationExtractor.processComplete` parses the block, emits a `kind: 'citation'` chat message with a structured `citations[]` payload, and scrubs the block from the visible text.
- **Card rendering.** The frontend `CitationRow.vue` component draws the cards — numbered steel-blue badge, serif title, hover glow. You don't render HTML; the runtime does.
- **Deduplication.** Sources are deduped by `num|title|url` so accidentally repeating a source in the block doesn't produce duplicate cards.
- **Validation.** Sources without `title` or `origin` are dropped silently. Malformed XML (unclosed tag, bad quote) means the whole block is ignored rather than corrupting the reply.

## Hard rules

- **One block per reply, at the end.** Earlier-in-the-response blocks still parse (regex is global) but it's unidiomatic and harder to read.
- **Pure XML. No JSON anywhere.** Attributes in double quotes. No JSON payload inside a `<source>` body.
- **Never hallucinate URLs or file paths.** If you weren't sure you read it, don't cite it. The whole point of the protocol is grounding.
- **Self-closing `<source …/>` elements only.** Don't give sources a body.
- **Numbers are yours.** Pick `num` values that match your inline markers. `[3][1]` is fine — the grid renders in array order, not numeric order.

## Reference

- Extractor: `pkg/rancher-desktop/agent/controllers/CitationExtractor.ts`
- Prompt section: `pkg/rancher-desktop/agent/prompts/sections/citations.ts`
- Streaming strip: `pkg/rancher-desktop/agent/utils/stripProtocolTags.ts` (`stripProtocolTagsStreaming`)
- WS dispatch: `BaseNode.wsChatMessage` (`kind = 'citation'` + `extras.citations`)
- Renderer: `pkg/rancher-desktop/pages/chat/components/citation/CitationRow.vue`
- Frontend mapping: `PersonaAdapter.mapBackendMessage` (citation branch)
