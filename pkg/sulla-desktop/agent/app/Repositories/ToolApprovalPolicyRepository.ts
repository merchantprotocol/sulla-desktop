// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface ToolApprovalPolicyQueryClient {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
}

/** Tools that always require a human approval (`tool_approval_policies`). */
export class ToolApprovalPolicyRepository {
  constructor(private readonly client: ToolApprovalPolicyQueryClient) {}

  async exists(toolName: string): Promise<boolean> {
    const rows = await this.client.query('SELECT tool_name FROM tool_approval_policies WHERE tool_name = $1', [toolName]);
    return rows.length > 0;
  }

  async listToolNames(): Promise<string[]> {
    const rows = await this.client.query<{ tool_name: string }>('SELECT tool_name FROM tool_approval_policies ORDER BY tool_name');
    return rows.map(row => row.tool_name);
  }

  async add(toolName: string): Promise<void> {
    await this.client.query('INSERT INTO tool_approval_policies (tool_name) VALUES ($1) ON CONFLICT DO NOTHING', [toolName]);
  }

  async remove(toolName: string): Promise<void> {
    await this.client.query('DELETE FROM tool_approval_policies WHERE tool_name = $1', [toolName]);
  }
}
