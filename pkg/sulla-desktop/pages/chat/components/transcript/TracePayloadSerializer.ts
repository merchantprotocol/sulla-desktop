// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentJobCheckin } from '@pkg/agent/database/models/AgentJobMessagingModel';
import type { AgentTraceHistoryData } from '@pkg/agent/app/Services/AgentTraceHistory';

/** A disclosure source. Equal inputs let a mounted row reuse its cached serialization. */
export class TracePayload {
  constructor(
    private readonly inputs: readonly unknown[],
    readonly serialize: (history?: readonly AgentJobCheckin[], messages?: AgentTraceHistoryData['messages']) => string,
  ) {}

  matches(other: TracePayload): boolean {
    return this.inputs.length === other.inputs.length &&
      this.inputs.every((value, index) => Object.is(value, other.inputs[index]));
  }
}

/** Serializes complete recorded trace payloads without modification. */
export class TracePayloadSerializer {
  serialize(value: unknown): string {
    let text: string;
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
    return text;
  }

  lazy(value: unknown): TracePayload {
    return new TracePayload([value], () => this.serialize(value));
  }

  summary(value: string | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
  }

  preview(value: string | undefined): string {
    // Tool input is already recorded as text. Bound the work before normalizing it.
    return this.summary(value?.slice(0, 300));
  }
}
