// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom
/// <reference path="../../../../typings/shims-vue.d.ts" />

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import TurnWaiting from '@pkg/pages/chat/components/transcript/TurnWaiting.vue';
import { NO_RESPONSE_AFTER_MS, waitingLabel, waitingOn } from '@pkg/pages/chat/messages/waitingStatus';

const user = (id: string, createdAt: number) => ({ id, kind: 'user', createdAt, text: id }) as any;
const sulla = (id: string, createdAt: number) => ({ id, kind: 'sulla', createdAt, text: 'hi' }) as any;

afterEach(() => { vi.useRealTimers() });

describe('a sent message never looks like it vanished', () => {
  // risk: the user sent a message, the chat ran, and nothing at all was shown
  it('shows the wait while running with nothing from Sulla after the message', () => {
    expect(waitingOn([sulla('a', 1), user('b', 2)], true)?.message.id).toBe('b');
  });

  it('ends the wait as soon as Sulla shows anything, and when the run stops', () => {
    expect(waitingOn([user('b', 2), sulla('c', 3)], true)).toBeNull();
    expect(waitingOn([user('b', 2)], false)).toBeNull();
  });

  it('times the wait from the first unanswered message, not a queued follow-up', () => {
    expect(waitingOn([sulla('a', 1), user('b', 100), user('c', 500)], true)).toMatchObject({ since: 100, message: { id: 'c' } });
  });

  it('switches from "working" to "no response" at the threshold', () => {
    expect(waitingLabel(12_000)).toEqual({ text: 'Sulla is working… 0:12', stalled: false });
    expect(waitingLabel(NO_RESPONSE_AFTER_MS)).toEqual({ text: 'No response from Sulla for 1:00', stalled: true });
  });

  it('offers Stop and resend only once Sulla has gone quiet', async() => {
    vi.useFakeTimers();
    const start = Date.now();
    const w = mount(TurnWaiting, { props: { since: start, canResend: true } });
    expect(w.text()).toContain('Sulla is working');
    expect(w.findAll('button')).toHaveLength(0);

    vi.advanceTimersByTime(NO_RESPONSE_AFTER_MS + 1000);
    await w.vm.$nextTick();
    expect(w.text()).toContain('No response from Sulla');
    await w.findAll('button')[1].trigger('click');
    expect(w.emitted('resend')).toHaveLength(1);
    w.unmount();
  });
});
