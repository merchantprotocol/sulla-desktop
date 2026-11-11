// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
/** Instance-scoped Slack team-to-account mapping, populated by workspace registration. */
export class SlackWorkspaceAccountRegistry {
  private readonly accountsByTeam = new Map<string, string>();
  register(teamId: string, accountId: string): void { this.accountsByTeam.set(teamId, accountId); }
  resolve(teamId: string): string | undefined { return this.accountsByTeam.get(teamId); }
}
