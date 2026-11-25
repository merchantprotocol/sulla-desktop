// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Tracks provider-stream activity for the one agent container identified by pod id. */
export class ProviderBridgeActivity {
  private readonly lastActivityByPod = new Map<string, number>();
  /** Chunks of a successful (<400) provider stream: real model output, including reasoning. */
  private readonly lastModelOutputByPod = new Map<string, number>();
  private readonly retryStatusListenersByPod = new Map<string, Set<(status: ProviderBridgeRetryStatus) => void>>();

  mark(podId: string | undefined, at = Date.now()): void {
    if (!podId) return;
    this.lastActivityByPod.set(podId, at);
    // Container ids are unique; discard stale entries so long-lived hosts don't
    // accumulate ids from containers that have already exited.
    for (const [id, lastAt] of this.lastActivityByPod) {
      if (at - lastAt > 60 * 60_000) this.lastActivityByPod.delete(id);
    }
  }

  /**
   * Record a chunk of a successful provider stream. Unlike `mark`, this is
   * model output and counts as agent liveness; retry and error bodies never do.
   */
  markModelOutput(podId: string | undefined, at = Date.now()): void {
    if (!podId) return;
    this.lastModelOutputByPod.set(podId, at);
    for (const [id, lastAt] of this.lastModelOutputByPod) {
      if (at - lastAt > 60 * 60_000) this.lastModelOutputByPod.delete(id);
    }
  }

  lastModelOutputAt(podId: string | undefined): number {
    return podId ? (this.lastModelOutputByPod.get(podId) ?? 0) : 0;
  }

  isActiveSince(podId: string | undefined, since: number): boolean {
    return this.lastActivityAt(podId) > since;
  }

  lastActivityAt(podId: string | undefined): number {
    return podId ? (this.lastActivityByPod.get(podId) ?? 0) : 0;
  }

  publishRetryStatus(podId: string | undefined, status: ProviderBridgeRetryStatus): void {
    if (!podId) return;
    const event = Object.freeze({ ...status });
    for (const listener of this.retryStatusListenersByPod.get(podId) ?? []) {
      try { listener(event); } catch { /* status reporting must not affect the provider stream */ }
    }
  }

  subscribeRetryStatus(podId: string | undefined, listener: (status: ProviderBridgeRetryStatus) => void): () => void {
    if (!podId) return () => {};
    let listeners = this.retryStatusListenersByPod.get(podId);
    if (!listeners) {
      listeners = new Set();
      this.retryStatusListenersByPod.set(podId, listeners);
    }
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners?.delete(listener);
      if (listeners?.size === 0) this.retryStatusListenersByPod.delete(podId);
    };
  }
}

export interface ProviderBridgeRetryStatus {
  status:             429 | 503;
  /** Sanitized, bounded provider error.message only; never headers or credentials. */
  reason?:             string;
  retryAfterSeconds?: number;
}

export const providerBridgeActivity = new ProviderBridgeActivity();
