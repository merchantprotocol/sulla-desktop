// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import type { ChannelName, SenderAllowlist } from './types';
export class SlackSenderAllowlist implements SenderAllowlist {
  async allows(channel: ChannelName, senderId: string): Promise<boolean> {
    if (channel !== 'slack' || !senderId) return false;
    const value = await SullaSettingsModel.get('channels.slack.directorUserIds', []);
    return Array.isArray(value) && value.some(id => typeof id === 'string' && id === senderId);
  }
}
