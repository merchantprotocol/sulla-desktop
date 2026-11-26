// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));

import { RunToolTracker, runTools } from '../../../services/RunToolTracker';
import { TurnToolActivity } from '../../../services/TurnToolActivity';

const activityKey = 'turn-tool-activity-regression';

describe('TurnToolActivity production defaults', () => {
  afterEach(() => runTools?.clearKey(activityKey));

  it('tracks and clears tool calls when constructed with only production metadata', () => {
    // risk: every model tool call throws when the default tracker singleton is missing
    const activity = new TurnToolActivity({ activityKeys: [activityKey] });

    activity.started('call-1', 'bash');
    expect(runTools.inFlight(activityKey)).toMatchObject({ name: 'bash' });

    activity.finished('call-1');
    expect(runTools.inFlight(activityKey)).toBeUndefined();
  });
});
