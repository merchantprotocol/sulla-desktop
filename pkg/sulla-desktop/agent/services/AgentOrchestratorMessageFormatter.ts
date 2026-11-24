// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Preserves the established manager-to-agent framing on delegated wake messages. */
export class AgentOrchestratorMessageFormatter {
  format(message: string): string {
    return `[Message from orchestrator]\n${ message }`;
  }
}
