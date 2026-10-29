# @sulla/agent-core

The portable Sulla agent loop. One turn runner, provider adapters and a tool-call normalizer that run unchanged on Sulla Desktop (Node), Sulla Cloud (Cloudflare Workers) and Sulla Mobile (Hermes). Plan: Sulla Files `Projects/sulla-anywhere/PLAN.md` §3 and task T1.

**Status:** skeleton. Nothing in Desktop, Mobile or Cloud uses it yet.

## Rules

- No Node, React Native, Workers or DOM APIs. `tsconfig.json` builds with `lib: ["ES2022"]` and no `@types`, so `fetch`, `TextEncoder`, timers and Node globals don't compile. ESLint (`agent-core-portable` in `eslint.config.mts`) also blocks platform imports and globals.
- The core never holds a credential. Adapters build requests without auth headers; the host's `KeyBroker.fetch(providerId, request)` adds the key (Desktop vault, phone native module, Cloud vault broker).
- Every `tool_use` gets exactly one tool result, even when a guard stops the turn, so the transcript can be replayed to any provider.

## Pieces

| File | What |
| --- | --- |
| `src/types.ts` | `ChatMessage`, `ContentBlock`, `ToolSpec`, `ToolResult`, `NormalizedResponse`, `StreamEvent`. Shapes match Desktop `BaseLanguageModel.ts` and `@sulla/runtime-protocol` |
| `src/host.ts` | Host interfaces: `KeyBroker`, `ToolHost` (with optional human `approve`), `Clock`, `Checkpoint` |
| `src/providers/` | `anthropic-messages` and `openai-chat` (also xAI, OpenRouter, Groq, Together, DeepSeek, Mistral, Ollama via `baseUrl`) |
| `src/toolCalls.ts` | Normalizer merged from Cloud `services/mcp/tool-calls.ts`: name cleanup, `exec` meta calls, argument coercion, result truncation, provider-safe wire names |
| `src/runTurn.ts` | The loop: iteration cap (default 40, like Desktop), token budget, abort, approvals for `irreversible` tools, checkpoint after every step, provider errors reported once and never retried |

## Tests

Golden transcripts in `test/golden/fixtures.js` replay recorded provider replies and pin the exact requests, tool calls and results. The same runner (`test/golden/runGolden.js`, no imports) runs on:

- **Node:** `node --test test/*.test.mjs` (after building)
- **Workers:** `node test/workers/run.mjs` (miniflare/workerd)
- **Hermes:** `HERMES_BIN=… node test/hermes/run.mjs` (esbuild lowers the bundle to ES2016 syntax; React Native apps are transpiled by Metro/Babel too. No runtime polyfills are added)

The Workers and Hermes runners load `esbuild` and `miniflare` from `AGENT_CORE_TOOLS_DIR`, so they stay out of the repo lockfile. CI: `.github/workflows/agent-core.yml`.
