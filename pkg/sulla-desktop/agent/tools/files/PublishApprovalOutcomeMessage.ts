// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord } from '@pkg/shared/decisions';

export interface HumanNameReader {
  name(): Promise<string>;
}

/** Words a publish decision for the agent that asked, naming the human who decided. */
export class PublishApprovalOutcomeMessage {
  private static readonly UNNAMED_HUMAN = 'The human';

  constructor(private readonly human: HumanNameReader) {}

  async for(record: DecisionRecord): Promise<string> {
    const subject = `"${ record.title.replace(/\?+\s*$/, '') }" (decision ${ record.id })`;
    if (record.status === 'expired') {
      return `[Human decision] The request to publish ${ subject } expired: request a fresh publish if still needed.`;
    }
    const verb = record.status === 'approved' ? 'approved' : 'denied';
    return `[Human decision] ${ await this.decider() } ${ verb } publishing ${ subject }.`;
  }

  private async decider(): Promise<string> {
    try {
      return (await this.human.name()).trim() || PublishApprovalOutcomeMessage.UNNAMED_HUMAN;
    } catch {
      return PublishApprovalOutcomeMessage.UNNAMED_HUMAN;
    }
  }
}

/** Reads the name the human gave the app in its settings. */
export class SettingsHumanNameReader implements HumanNameReader {
  async name(): Promise<string> {
    const { SullaSettingsModel } = await import('../../database/models/SullaSettingsModel');
    return String(await SullaSettingsModel.get('primaryUserName', '') ?? '');
  }
}
