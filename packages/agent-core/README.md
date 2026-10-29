# @sulla/agent-core

The portable Sulla agent loop. One turn runner, provider adapters and a tool-call normalizer that run unchanged on Sulla Desktop (Node), Sulla Cloud (Cloudflare Workers) and Sulla Mobile (Hermes). Plan: Sulla Files `Projects/sulla-anywhere/PLAN.md` §3 and task T1.

**Status:** skeleton. Nothing in Desktop, Mobile or Cloud uses it yet.

## Rules

- No Node, React Native, Workers or DOM APIs. `tsconfig.json` builds with `lib: ["ES2022"]` and no `@types`, so `fetch`, `TextEncoder`, timers and Node globals don't compile. ESLint also blocks platform imports, globals and `class` syntax. The rules live in `eslint-rules.mjs`, which the root `eslint.config.mts` imports, and CI runs them with `node test/lint.mjs`.
- The core never holds a credential. Adapters build requests without auth headers; the host's `KeyBroker.fetch(providerId, request)` (or `stream(…)`) adds the key (Desktop vault, phone native module, Cloud vault broker).
- Every `tool_use` gets exactly one tool result, even when a guard stops the turn, so the transcript can be replayed to any provider. Tool call ids are made unique and provider-safe (`call_<iteration>_<index>` when a provider omits or repeats one).
- Approvals fail closed. A call needs `ToolHost.approve` unless its `sideEffect` is `read` or `write` and the host didn't set `requiresApproval`. Hosts set `requiresApproval` with `requiresApprovalFor({ sideEffect, relayed })`, so relayed writes wait for a tap too (PLAN.md §4.4). A pending approval stops waiting when the run aborts.
- A reply cut off at the output limit (`finishReason: 'length'` or `content_filter`) never runs its tool calls; each one is answered "Not run: output was cut off…".
- `runTurn` doesn't throw once a turn starts. Listener errors are ignored. A failed checkpoint runs no more tools and ends the turn as `checkpoint_failed`. Provider, tool and adapter error text is redacted before it reaches the model or the result.

## Shared types

`src/types.ts` is the canonical home of the placement types (`ToolPlacement`, `ToolSideEffect`, `ToolCredential`, `ToolPlacementMetadata`) that Desktop's tool manifests and `tool-placements.json` use. Tool ids are `<category>/<manifest name>` (`toolId()`, `parseToolId()`), e.g. `web/web_search`.

## Usage

`Usage` means the same thing for every provider. `inputTokens` is the whole prompt, including cache reads and writes. `cachedTokens` (reads) and `cacheWriteTokens` are parts of it, for pricing.

## Streaming

If the host's `KeyBroker` has `stream(providerId, request, onChunk, signal)`, turns stream and emit `text_delta` events. The host passes decoded body text to `onChunk`; the core parses SSE itself. It's a callback rather than a `ReadableStream` because React Native's fetch has no streaming body. Pass `stream: false` to `runTurn` to turn it off.

## Pieces

| File | What |
| --- | --- |
| `src/types.ts` | `ChatMessage`, `ContentBlock`, `ToolSpec`, `ToolResult`, `NormalizedResponse`, `StreamEvent`. Shapes match Desktop `BaseLanguageModel.ts` and `@sulla/runtime-protocol` |
| `src/host.ts` | Host interfaces: `KeyBroker`, `ToolHost` (with optional human `approve`), `Clock`, `Checkpoint` |
| `src/providers/` | `anthropic-messages` and `openai-chat` (also xAI, OpenRouter, Groq, Together, DeepSeek, Mistral, Ollama via `baseUrl`; `maxTokensField: 'max_completion_tokens'` for OpenAI reasoning models), plus the SSE parser |
| `src/toolCalls.ts` | Normalizer merged from Cloud `services/mcp/tool-calls.ts`: name cleanup, `exec` meta calls, argument coercion, result truncation, provider-safe wire names |
| `src/runTurn.ts` | The loop: iteration cap (default 40, like Desktop), token budget, abort, approvals, cut-off guard, checkpoint after every step, provider errors reported once and never retried |

## Tests

Golden transcripts in `test/golden/fixtures.js` replay recorded provider replies (plain and streamed) and pin the exact requests, tool calls, results and events. The same runner (`test/golden/runGolden.js`, no imports) runs on:

- **Node:** `node --test test/*.test.mjs` (after building)
- **Workers:** `node test/workers/run.mjs` (miniflare/workerd)
- **Hermes:** `HERMES_BIN=… node test/hermes/run.mjs` (esbuild lowers the bundle to ES2016 syntax; React Native apps are transpiled by Metro/Babel too. No runtime polyfills are added)

The Workers and Hermes runners load `esbuild` and `miniflare` from `AGENT_CORE_TOOLS_DIR`, so they stay out of the repo lockfile. CI: `.github/workflows/agent-core.yml`.
