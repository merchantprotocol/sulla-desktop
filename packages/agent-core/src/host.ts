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

/**
 * The subset of AbortSignal the core reads. Pass a real AbortSignal where
 * the platform has one: the listener methods let the core stop waiting on a
 * pending approval the moment the run is aborted.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener?(type: 'abort', listener: () => void): void;
  removeEventListener?(type: 'abort', listener: () => void): void;
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

/** Status of a streamed response, known once the body has ended. */
export interface StreamResponseHead {
  ok:     boolean;
  status: number;
}

/**
 * Streaming transport. The host sends the request and calls `onChunk` with
 * each piece of the response body as decoded text, in order, then resolves
 * once the body has ended. Error bodies are delivered the same way.
 *
 * This is a callback, not a ReadableStream, because React Native's fetch
 * has no streaming body: the phone host can feed chunks from XHR progress
 * events or a native module.
 */
export type StreamTransport = (
  request: HttpRequest,
  onChunk: (text: string) => void,
  signal?: AbortSignalLike,
) => Promise<StreamResponseHead>;

/**
 * Sends a provider request with the user's credential added by the host
 * (Desktop vault, phone native module, Cloud vault broker). The core only
 * names the provider; it never sees the key.
 */
export interface KeyBroker {
  fetch(providerId: string, request: HttpRequest, signal?: AbortSignalLike): Promise<HttpResponseLike>;
  /** Optional streaming send (see `StreamTransport`). Without it, turns don't stream. */
  stream?(providerId: string, request: HttpRequest, onChunk: (text: string) => void, signal?: AbortSignalLike): Promise<StreamResponseHead>;
}

export interface ToolInvocationContext {
  runId:   string;
  signal?: AbortSignalLike;
}

export interface ToolHost {
  invoke(call: { id: string; name: string; args: Record<string, unknown> }, ctx: ToolInvocationContext): Promise<ToolResult>;
  /**
   * Asks a human to approve a call that `needsApproval` (irreversible, or
   * `requiresApproval` set by the host). Hosts without a way to ask must
   * leave this out; the core then refuses those calls. `ctx.signal` aborts
   * with the run: the core stops waiting then, and the host should dismiss
   * the prompt.
   */
  approve?(call: { id: string; name: string; args: Record<string, unknown> }, spec: ToolSpec, ctx: ToolInvocationContext): Promise<boolean>;
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

/**
 * Saves loop state after every model and tool step so a host can resume.
 * If `save` throws, the turn runs no further tools, answers any pending
 * tool calls, and ends with status `checkpoint_failed`: the host can't
 * resume past a step it didn't store.
 */
export interface Checkpoint {
  save(state: TurnCheckpoint): Promise<void>;
}

export interface AgentHost {
  keyBroker:   KeyBroker;
  toolHost:    ToolHost;
  clock?:      Clock;
  checkpoint?: Checkpoint;
}
