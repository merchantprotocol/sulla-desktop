// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { GraphRegistry } from '../services/GraphRegistry';
import { subconsciousWriterGate } from '../services/SubconsciousWriterGate';

import {
  V7MemoryRunLog,
  V7MemoryScheduler,
  V7MemoryTurnPipeline,
  type V7MemoryAgents,
  type V7MemoryTurnInput,
} from './V7MemoryTurnPipeline';
import { V7SubjectMemoryStore } from './V7SubjectMemoryWriter';

import type { BaseThreadState, Graph } from '../nodes/Graph';

type V7GraphFactory = () => Promise<{ graph: Graph<BaseThreadState>; state: BaseThreadState }>;

/** Runs the elephant and goldfish as single-call subconscious graphs. */
export class GraphRegistryV7MemoryAgents implements V7MemoryAgents {
  elephantDraft(input: V7MemoryTurnInput, abort: AbortController): Promise<string | null> {
    return this.once(() => GraphRegistry.createV7Elephant(this.parent(input), this.options(input, abort)));
  }

  goldfish(input: V7MemoryTurnInput, draftJson: string, abort: AbortController): Promise<string | null> {
    return this.once(() => GraphRegistry.createV7Goldfish(this.parent(input), draftJson, this.options(input, abort)));
  }

  elephantFinal(input: V7MemoryTurnInput, draftJson: string, feedbackJson: string, abort: AbortController): Promise<string | null> {
    return this.once(() => GraphRegistry.createV7ElephantFinal(this.parent(input), draftJson, feedbackJson, this.options(input, abort)));
  }

  /** Exactly one model call: no tools and maxIterations 1. */
  private async once(create: V7GraphFactory): Promise<string | null> {
    const { graph, state } = await create();
    await graph.execute(state, 'subconscious', { maxIterations: 1 });
    const output = (state.metadata as any).v7MemoryOutput;
    return typeof output === 'string' ? output : null;
  }

  private parent(input: V7MemoryTurnInput): BaseThreadState {
    return input.state as BaseThreadState;
  }

  private options(input: V7MemoryTurnInput, abort: AbortController) {
    return { contextWindow: input.contextWindow, coalescedTurns: input.coalescedTurns, abort };
  }
}

const runLog = new V7MemoryRunLog();

/** Process-wide per-turn memory scheduler: one elephant sequence per conversation at a time. */
export const v7MemoryScheduler = new V7MemoryScheduler(
  new V7MemoryTurnPipeline(new GraphRegistryV7MemoryAgents(), new V7SubjectMemoryStore(), runLog),
  subconsciousWriterGate,
  runLog,
);
