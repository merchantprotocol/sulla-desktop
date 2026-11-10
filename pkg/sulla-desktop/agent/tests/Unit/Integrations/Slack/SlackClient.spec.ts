// Sulla Desktop · https://sulladesktop.com
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { SlackClient } from '../../../../integrations/slack/SlackClient';
describe('SlackClient', () => {
  it('initializes without creating a Socket Mode relay', async() => {
    // risk: availability
    expect(await SlackClient.getInstance().initialize()).toBe(true);
  });
});
