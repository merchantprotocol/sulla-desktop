// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface AgentWorkspaceBindingRequest {
  jobKey:           string;
  source?:          string;
  stableWorkspace?: string;
}

export interface AgentWorkspaceBindingOperations {
  createEphemeral(jobKey: string): Promise<string>;
  seedEphemeral(source: string, jobKey: string): Promise<string>;
  seedStable(source: string, stableWorkspace: string): Promise<string>;
}

/**
 * Stable delegated threads always reopen one workspace. An explicit
 * workspacePath initializes that workspace once; it must never replace the
 * durable binding with a new ephemeral clone on wake or restart.
 */
export class AgentWorkspaceBinder {
  static async bind(
    request: AgentWorkspaceBindingRequest,
    operations: AgentWorkspaceBindingOperations,
  ): Promise<string> {
    if (request.stableWorkspace) {
      if (request.source) await operations.seedStable(request.source, request.stableWorkspace);
      return request.stableWorkspace;
    }
    if (request.source) return await operations.seedEphemeral(request.source, request.jobKey);
    return await operations.createEphemeral(request.jobKey);
  }
}
