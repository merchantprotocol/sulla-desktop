// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
export class SlackApiError extends Error {
  constructor(readonly method: string, readonly slackError: string, readonly status: number) {
    super(`Slack API ${method} failed: ${slackError}`); this.name = 'SlackApiError';
  }
}
