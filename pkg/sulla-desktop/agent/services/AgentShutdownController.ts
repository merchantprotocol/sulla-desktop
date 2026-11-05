// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface AgentQuitEmitter { once(event: 'before-quit', listener: () => void): unknown; }
export interface AgentShutdownResource { dispose(): void; }
export interface AgentLivenessResource { stop(): void; }

/** Owns shutdown of agent startup and periodic liveness work. */
export class AgentShutdownController {
  private disposed = false;
  constructor(private readonly rehydration: AgentShutdownResource, private readonly liveness: AgentLivenessResource) {}

  register(app: AgentQuitEmitter): void { app.once('before-quit', () => this.dispose()); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rehydration.dispose();
    this.liveness.stop();
  }
}
