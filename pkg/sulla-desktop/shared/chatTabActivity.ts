// SPDX-License-Identifier: GPL-2.0-or-later

const THREAD_ACTIVITY_STATES = ['you', 'stalled', 'working', 'quiet', 'waiting', 'idle'] as const;

export type ThreadActivityState = typeof THREAD_ACTIVITY_STATES[number];

export interface ChatTabActivity {
  state: ThreadActivityState;
  active: boolean;
}

export function isChatTabActivity(value: unknown): value is ChatTabActivity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ChatTabActivity>;
  return THREAD_ACTIVITY_STATES.some(state => state === candidate.state) && typeof candidate.active === 'boolean';
}
