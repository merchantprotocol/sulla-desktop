/**
 * SubconsciousMiddleware — pre-processing step before the main agent LLM call.
 *
 * Launches up to 3 parallel subconscious graphs:
 * 1. Conversational Summarizer — compresses/deletes old messages
 * 2. Memory Recall Agent — searches for relevant skills, tools, resources
 * 3. Observation Agent — creates/removes observational memories
 *
 * Results are merged back into the live state before the main agent call.
 *
 * All agents are fully logged via the conversation logger (SullaLogger).
 * Each gets its own conversationId linked to the parent via parentConversationId.
 * Logs are written to ~/sulla/logs/ and can be inspected for debugging.
 */

import type { BaseThreadState } from '../nodes/Graph';
import { GraphRegistry } from '../services/GraphRegistry';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { parseJson } from '../services/JsonParseService';

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Message count threshold before the summarizer runs */
const TRIGGER_WINDOW_SIZE = 45;

/**
 * Detect whether the latest user message is a simple greeting or trivial
 * message that doesn't need full memory recall (skills, workflows, tabs,
 * credentials, environment search).  This avoids ~2 minutes of recall
 * overhead for messages like "hi", "thanks", "good morning", etc.
 */
function isSimpleMessage(state: BaseThreadState): boolean {
  // Find the last user message
  let lastUserText = '';
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        lastUserText = msg.content;
      } else if (Array.isArray(msg.content)) {
        lastUserText = msg.content
          .filter((b: any) => b?.type === 'text')
          .map((b: any) => b.text || '')
          .join(' ');
      }
      break;
    }
  }

  const trimmed = lastUserText.trim().toLowerCase();
  if (!trimmed) return true;

  // Short messages (under 20 chars) that match common greetings/acknowledgements
  if (trimmed.length <= 20) {
    const greetings = [
      'hi', 'hey', 'hello', 'yo', 'sup', 'hola', 'howdy',
      'good morning', 'good afternoon', 'good evening', 'good night',
      'gm', 'morning', 'evening',
      'thanks', 'thank you', 'thx', 'ty', 'appreciate it',
      'ok', 'okay', 'k', 'cool', 'nice', 'great', 'awesome', 'perfect',
      'yes', 'no', 'yep', 'nope', 'yeah', 'nah', 'sure', 'yup',
      'bye', 'goodbye', 'see ya', 'later', 'cya',
      'lol', 'haha', 'heh', 'lmao',
      'what\'s up', 'whats up', 'wassup',
      'how are you', 'how\'s it going',
    ];
    // Exact match or match after stripping punctuation
    const stripped = trimmed.replace(/[!?.,\s]+$/g, '');
    if (greetings.includes(stripped) || greetings.includes(trimmed)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

export interface SubconsciousMiddlewareOptions {
  /** Whether observations should be managed (false for planning agents) */
  includeObservations: boolean;
}

/**
 * Run the subconscious middleware pipeline.
 * Launches applicable agents in parallel, then merges their results into state.
 */
export async function runSubconsciousMiddleware(
  state: BaseThreadState,
  options: SubconsciousMiddlewareOptions,
): Promise<void> {
  const startTime = Date.now();
  const launched: string[] = [];
  const awaitedTasks: Promise<void>[] = [];

  // 1. Summarizer — only when conversation is long (awaited: modifies messages)
  const shouldSummarize = state.messages.length > TRIGGER_WINDOW_SIZE;
  if (shouldSummarize) {
    launched.push('summarizer');
    awaitedTasks.push(runSummarizer(state));
  }

  // 2. Memory Recall — skip for simple greetings/acknowledgements
  const simple = isSimpleMessage(state);
  if (simple) {
    console.log('[SubconsciousMiddleware] Simple message detected — skipping memory recall');
    (state.metadata as any).recallContext = null;
  } else {
    launched.push('memory-recall');
    const recallPromise = runMemoryRecall(state);
    awaitedTasks.push(recallPromise.then(ctx => { (state.metadata as any).recallContext = ctx; }));
  }

  // 3. Observation Agent — fire-and-forget: it only does side-effect tool
  //    calls (add/remove observational memory, update identity files) and
  //    never touches state.messages directly. No need to wait for it.
  if (options.includeObservations) {
    launched.push('observation (fire-and-forget)');
    runObservationAgent(state).catch((error) => {
      console.error('[SubconsciousMiddleware] Observation Agent failed (fire-and-forget):', error instanceof Error ? error.message : error);
    });
  }

  console.log(`[SubconsciousMiddleware] Launched: ${ launched.join(', ') } | messages: ${ state.messages.length }`);

  // Await only the agents that modify state
  const settledResults = await Promise.allSettled(awaitedTasks);

  const failures = settledResults.filter(r => r.status === 'rejected');
  const elapsed = Date.now() - startTime;

  if (failures.length > 0) {
    for (const f of failures) {
      console.error('[SubconsciousMiddleware] Agent failed:', (f as PromiseRejectedResult).reason?.message || (f as PromiseRejectedResult).reason);
    }
  }

  const recallLen = ((state.metadata as any).recallContext || '').length;
  console.log(`[SubconsciousMiddleware] Complete in ${ elapsed }ms | ${ settledResults.length - failures.length }/${ settledResults.length } succeeded | recallContext: ${ recallLen } chars`);
}

// ============================================================================
// SUMMARIZER
// ============================================================================

async function runSummarizer(state: BaseThreadState): Promise<void> {
  const startTime = Date.now();
  const messagesBefore = state.messages.length;

  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createSummarizer(state);
    console.log(`[SubconsciousMiddleware:Summarizer] Started | threadId: ${ threadId } | messages: ${ messagesBefore }`);

    await graph.execute(subState, 'subconscious', { maxIterations: 1 });

    // Apply compressed messages if the summarizer produced them
    const compressedMessages = (subState.metadata as any).compressedMessages;
    if (compressedMessages && Array.isArray(compressedMessages)) {
      const deletedCount = (subState.metadata as any).deletedCount || 0;
      const summarizedCount = (subState.metadata as any).summarizedCount || 0;

      // Replace the live state's messages with the compressed version
      state.messages.splice(0, state.messages.length, ...compressedMessages);

      console.log(`[SubconsciousMiddleware:Summarizer] Applied in ${ Date.now() - startTime }ms | deleted: ${ deletedCount }, summarized: ${ summarizedCount }, messages: ${ messagesBefore } → ${ state.messages.length }`);
    } else {
      console.log(`[SubconsciousMiddleware:Summarizer] No changes in ${ Date.now() - startTime }ms`);
    }
  } catch (error) {
    console.error(`[SubconsciousMiddleware:Summarizer] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
  }
}

// ============================================================================
// MEMORY RECALL
// ============================================================================

async function runMemoryRecall(state: BaseThreadState): Promise<string | null> {
  const startTime = Date.now();

  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createMemoryRecall(state);
    console.log(`[SubconsciousMiddleware:MemoryRecall] Started | threadId: ${ threadId }`);

    await graph.execute(subState, 'subconscious', { maxIterations: 20 });

    const agentMeta = (subState.metadata as any).agent || {};
    const iterations = (subState.metadata as any).iterations || 0;
    const toolCalls = subState.messages.filter((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'tool_use'),
    ).length;

    // Extract the agent's accumulated response.
    // Fallback: if response is empty (e.g. hit max_iterations), grab the
    // last substantial assistant message from the subconscious conversation.
    let response = agentMeta.response;
    if (!response || !String(response).trim()) {
      for (let i = subState.messages.length - 1; i >= 0; i--) {
        const msg = subState.messages[i];
        if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 50) {
          response = msg.content;
          break;
        }
      }
    }

    if (response && typeof response === 'string' && response.trim()) {
      console.log(`[SubconsciousMiddleware:MemoryRecall] Returning ${ response.length } chars in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
      return response.trim();
    }

    console.log(`[SubconsciousMiddleware:MemoryRecall] No relevant context found in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
    return null;
  } catch (error) {
    console.error(`[SubconsciousMiddleware:MemoryRecall] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================================================
// OBSERVATION AGENT
// ============================================================================

async function runObservationAgent(state: BaseThreadState): Promise<void> {
  const startTime = Date.now();

  try {
    // Load current observations
    const rawObservations = await SullaSettingsModel.get('observationalMemory', '[]');
    let memoryObj: any[];
    try {
      memoryObj = parseJson(rawObservations) as any[];
      if (!Array.isArray(memoryObj)) memoryObj = [];
    } catch {
      memoryObj = [];
    }

    const observationsText = memoryObj
      .map((entry: any) => `[id:${ entry.id }] ${ entry.priority } ${ entry.timestamp } ${ entry.content }`)
      .join('\n');

    const { graph, state: subState, threadId } = await GraphRegistry.createObservationAgent(state, observationsText);
    console.log(`[SubconsciousMiddleware:Observation] Started (fire-and-forget) | threadId: ${ threadId } | existing observations: ${ memoryObj.length }`);

    await graph.execute(subState, 'subconscious', { maxIterations: 20 });

    const agentMeta = (subState.metadata as any).agent || {};
    const iterations = (subState.metadata as any).iterations || 0;
    const toolCalls = subState.messages.filter((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'tool_use'),
    ).length;

    // The observation agent applies its side effects via tools (add/remove observational memory).
    // No additional state merge needed — the tools write directly to SullaSettingsModel.

    console.log(`[SubconsciousMiddleware:Observation] Completed in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
  } catch (error) {
    console.error(`[SubconsciousMiddleware:Observation] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
  }
}

// ============================================================================
// HELPERS
// ============================================================================

