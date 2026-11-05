// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { AgentWaitRequest } from '../../../services/AgentWaitRequest';
describe('AgentWaitRequest', () => {
  it('creates a bounded durable deadline', () => {
    // risk: invalid timers strand workers or overload the scheduler
    expect(AgentWaitRequest.create(10, 'wait', new Date(1000)).wakeAt.getTime()).toBe(11000);
    expect(() => AgentWaitRequest.create(9, 'wait')).toThrow('between 10 and 14400');
    expect(() => AgentWaitRequest.create(14401, 'wait')).toThrow('between 10 and 14400');
  });
});
