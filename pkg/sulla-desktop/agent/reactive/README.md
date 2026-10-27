# Reactive agent runtime (prototype)

Not wired into `Graph` or any production path. A self-contained TypeScript port of the pattern from
AWS / UC Berkeley's [Infinity](https://github.com/hydro-project/infinity) (Apache 2.0; read for design only, no code copied).

## The pattern

1. **Everything is an `InputMessage`** with a `threadId` and a stable `id`: user text, tool results, events,
   child reports, timer wake-ups.
2. **A slice never blocks.** `runSlice` loads history + processed ids from the stores, applies the batch,
   runs completions until the model stops or calls an *async* tool, persists, and returns. No state is kept
   in memory between slices.
3. **A tool call is the yield point.** Async tools return `{ mode: 'async' }`; the result re-enters later via
   `ctx.complete()`. Sync tools (`spawn_thread`, `report_to_parent`, `close_thread`) loop back in the same slice.
4. **FIFO per thread, parallel across threads.** One mailbox and at most one driver per thread; drivers exist only
   while there is work.
5. **At-least-once safe.** Processed ids per thread make redelivery a no-op; the assistant turn is persisted before
   its tool is dispatched.
6. **Interrupts.** Real user text aborts the in-flight completion (nothing from it is persisted), answers any
   pending tool call as interrupted, and the late real result is dropped.
7. **Events don't pollute the parent.** A non-associative event spawns a throwaway child that inherits history and
   either `report_to_parent`s or closes silently. Synthetic inputs wait behind a pending tool call.
8. **Compaction is a child thread** that summarizes and reports; the summary is stored with the history index it
   covers, so older children can still rebuild what they inherited.

## Where it would plug into Sulla

| Here | Sulla today |
|---|---|
| `ModelProvider` | `BaseNode` LLM call (`languagemodels/`) |
| `ReactiveTool` (async) | `ToolExecutor` awaits `tool.invoke` inline; long CLI tools, `spawn_agent` |
| `ConversationStore` / `StateStore` | `ThreadStateStore` (Redis 1h TTL + disk JSONL) / `conversation_history` (Postgres) |
| `spawn_thread` + `report_to_parent` | `spawn_agent` + `jobRegistry` + `wakeParentGraph` WebSocket hop |
| mailbox + `send()` | `BackendGraphWebSocketService.dispatchToAgent`, `<channel:...>` dispatch, Heartbeat wake |
| compaction thread | `contextBudget.ts` (drops oldest units, never summarizes) |

## Known prototype gaps

- A slice that throws loses its in-memory batch (processed ids make redelivery safe, but nothing redelivers yet).
- Completions are not streamed; no token accounting for compaction (character count stands in).
- No persistence adapters, no real model, no integration with `Graph.execute`.
- Tool cancellation and thread-closure notifications to tools are not implemented.
