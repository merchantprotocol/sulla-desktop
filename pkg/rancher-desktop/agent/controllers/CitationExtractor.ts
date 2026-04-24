/**
 * CitationExtractor — extracts <citations>…<source …/></citations> blocks
 * from LLM output and surfaces them as a CitationRow beneath the reply.
 *
 * Two-way extractor:
 *   IN:  enrichPrompt() instructs the model to emit a citations block when
 *        it draws on sources (files read, URLs fetched, docs referenced).
 *   OUT: processChunk() is a no-op — partial blocks are masked at the
 *        BaseNode stream-flush layer via stripProtocolTagsStreaming, so the
 *        user never sees raw `<citations` in the bubble.
 *        processComplete() parses the block, dispatches a `citation` chat
 *        message with a structured `citations` payload, and strips the
 *        block from the reply content.
 *
 * Always enabled — citations are useful in every mode.
 *
 * XML shape (the model is instructed to produce this exact shape):
 *   <citations>
 *     <source num="1" title="BaseNode.ts" origin="pkg/..." url="file:///..." />
 *     <source num="2" title="Docs" origin="docs.anthropic.com" url="https://..." />
 *   </citations>
 *
 * Inline markers in the prose remain as plain `[1]`, `[2]` — the card grid
 * is rendered from the trailing block. No JSON anywhere — pure XML.
 */

import type { Extractor, StreamContext, ChatMessageFn } from './Extractor';
import type { NormalizedResponse } from '../languagemodels/BaseLanguageModel';

// ─── Source shape ───────────────────────────────────────────────

export interface CitationSource {
  num:    number;
  title:  string;
  origin: string;
  url?:   string;
}

// ─── Regex ──────────────────────────────────────────────────────

const CITATIONS_BLOCK_RE = /<citations>([\s\S]*?)<\/citations>/gi;
// Parses one <source /> element and captures its attribute string.
// Self-closing or open-tag form (rarely written with a body; we ignore the body).
const SOURCE_EL_RE = /<source\b([^>]*?)\/?>/gi;
// Matches `name="value"` pairs inside the attribute string.
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

// ─── Prompt directive ───────────────────────────────────────────

export const CITATION_PROMPT = `

─── Source citations ──────────────────────────────────────────────
When your answer draws on concrete sources (files you read, URLs you
fetched, documentation passages, specific memories, or prior artifacts),
include a single \`<citations>\` block at the END of your response with
one self-closing \`<source />\` element per distinct source. Reference
them inline in the prose as [1], [2], etc.

Required attributes: num, title, origin.  Optional: url.

Format (use this exact shape — attributes in double quotes, no JSON):

<citations>
  <source num="1" title="BaseNode.ts" origin="pkg/rancher-desktop/agent/nodes" url="file:///…" />
  <source num="2" title="Anthropic Citations" origin="docs.anthropic.com" url="https://…" />
</citations>

Only cite sources you actually used. If you used none, omit the block.
Never invent URLs or file paths. The block is stripped before the user
sees the text and rendered as a card grid beneath your reply.
`;

// ─── Extractor ──────────────────────────────────────────────────

export class CitationExtractor implements Extractor {
  readonly name = 'citation';

  private readonly sendChatMessage: ChatMessageFn;

  constructor(sendChatMessage: ChatMessageFn) {
    this.sendChatMessage = sendChatMessage;
  }

  enrichPrompt(systemPrompt: string, _ctx: StreamContext): string {
    return systemPrompt + CITATION_PROMPT;
  }

  processChunk(chunk: string, _ctx: StreamContext): string {
    // Partial `<citations` blocks are masked at the stream-flush layer
    // (stripProtocolTagsStreaming) so the user never sees raw XML while
    // the reply is still coming in. Nothing to do per-token.
    return chunk;
  }

  processComplete(reply: NormalizedResponse, ctx: StreamContext): string {
    const matches = [...reply.content.matchAll(CITATIONS_BLOCK_RE)];
    if (matches.length === 0) return reply.content;

    // Fold all blocks into a single citation list. The model should emit
    // one, but if it emits multiple we concat rather than drop.
    const sources: CitationSource[] = [];
    for (const match of matches) {
      sources.push(...parseSources(match[1]));
    }

    // Strip the block(s) from the visible reply no matter what — even if
    // parsing yielded nothing, raw XML must never reach the user.
    reply.content = reply.content.replace(CITATIONS_BLOCK_RE, '').trim();

    if (sources.length === 0) return reply.content;

    // Renumber so the emitted list is 1..N and free of gaps/dupes. The
    // inline markers [1][2][…] the model wrote rely on the ORIGINAL nums
    // it chose, so we keep those as the display `num` and only dedupe on
    // url+title identity.
    const deduped = dedupeBy(sources, s => `${ s.num }|${ s.title }|${ s.url ?? '' }`);

    // Dispatch a citation chat message. Empty content is intentional —
    // the renderer ignores text and draws cards from `citations`.
    this.sendChatMessage(ctx.state, '', 'assistant', 'citation', { citations: deduped });

    return reply.content;
  }

  reset(): void {
    // Nothing to reset — this extractor is stateless per turn.
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function parseSources(inner: string): CitationSource[] {
  const out: CitationSource[] = [];
  const elements = [...inner.matchAll(SOURCE_EL_RE)];
  for (const el of elements) {
    const attrs = parseAttrs(el[1]);
    const numRaw = attrs.num;
    const title = attrs.title?.trim();
    const origin = attrs.origin?.trim();
    const url = attrs.url?.trim();

    if (!title || !origin) continue;

    const num = Number.parseInt(numRaw ?? '', 10);
    out.push({
      num:    Number.isFinite(num) ? num : out.length + 1,
      title,
      origin,
      url:    url && url.length > 0 ? url : undefined,
    });
  }
  return out;
}

function parseAttrs(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((match = ATTR_RE.exec(attrStr)) !== null) {
    out[match[1].toLowerCase()] = decodeAttr(match[2]);
  }
  return out;
}

/** Unescape the handful of entities a well-behaved XML attribute may carry. */
function decodeAttr(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
