// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Human-readable labels for audit events, shared by the audit view and item activity.
export class AuditEventFormatter {
  static AGENT_USE_ACTIONS = ['vault_outbound_request', 'agent_credential_broker_use', 'agent_credential_use'];

  constructor(state) {
    this.state = state;
  }

  isAgent(event) { return Boolean(event.metadata?.agentId) || AuditEventFormatter.AGENT_USE_ACTIONS.includes(event.action); }

  action(event) {
    return event.blocked && AuditEventFormatter.AGENT_USE_ACTIONS.includes(event.action)
      ? 'Attempted credential use' : ({
        human_item_reveal: 'Revealed item', human_item_created: 'Created item', human_item_updated: 'Changed item', human_item_deleted: 'Deleted item',
        vault_outbound_request: 'Used credential', agent_credential_broker_use: 'Used credential', agent_credential_use: 'Used credential',
      })[event.action] || String(event.action || 'Recorded action').replaceAll('_', ' ');
  }

  item(event) { return this.state.itemById(event.item_id)?.name || (event.item_id ? 'Deleted or unavailable item' : 'Vault'); }

  where(event) { return event.metadata?.destination || event.metadata?.operation || event.pod_id || 'Desktop vault'; }

  result(event) { return event.blocked ? 'Blocked' : (this.isAgent(event) ? 'Allowed' : 'Recorded'); }
}
