// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Host interfaces. The core never opens a socket, reads a key, touches a
 * file or a database: each platform (Desktop, Mobile, Cloud) implements
 * these and passes them in.
 */

import type { ChatMessage, ToolResult, ToolSpec, Usage } from './types.js';

/** The subset of AbortSignal the core reads. */
export interface AbortSignalLike {
  readonly aborted: boolean;
}

/** A provider HTTP request, built by an adapter. Never carries a credential. */
export interface HttpRequest {
  url:     string;
  method:  'POST' | 'GET';
  headers: Record<string, string>;
  body?:   string;
}

/** The subset of a fetch Response the core reads. */
export interface HttpResponseLike {
  ok:     boolean;
  status: number;
  text(): Promise<string>;
}

/** fetch-shaped transport an adapter calls. */
export type Transport = (request: HttpRequest, signal?: AbortSignalLike) => Promise<HttpResponseLike>;

/**
 * Sends a provider request with the user's credential added by the host
 * (Desktop vault, phone native module, Cloud vault broker). The core only
 * names the provider; it never sees the key.
 */
export interface KeyBroker {
  fetch(providerId: string, request: HttpRequest, signal?: AbortSignalLike): Promise<HttpResponseLike>;
}

export interface ToolInvocationContext {
  runId:   string;
  signal?: AbortSignalLike;
}

export interface ToolHost {
  invoke(call: { id: string; name: string; args: Record<string, unknown> }, ctx: ToolInvocationContext): Promise<ToolResult>;
  /**
   * Asks a human to approve an `irreversible` call. Hosts without a way to
   * ask must leave this out; the core then refuses those calls.
   */
  approve?(call: { id: string; name: string; args: Record<string, unknown> }, spec: ToolSpec): Promise<boolean>;
}

export interface Clock {
  now(): number;
}

export interface TurnCheckpoint {
  runId:     string;
  iteration: number;
  messages:  ChatMessage[];
  usage:     Usage;
}

/** Saves loop state after every model and tool step so a host can resume. */
export interface Checkpoint {
  save(state: TurnCheckpoint): Promise<void>;
}

export interface AgentHost {
  keyBroker:   KeyBroker;
  toolHost:    ToolHost;
  clock?:      Clock;
  checkpoint?: Checkpoint;
}
