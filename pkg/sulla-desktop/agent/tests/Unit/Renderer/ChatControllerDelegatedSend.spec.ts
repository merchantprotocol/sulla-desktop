// SPDX-License-Identifier: GPL-2.0-or-later
// The real ChatController in delegation mode (backend owns the message) must keep the accepted
// auto-title and cleared staging in its saved state, so the next startup does not restore "New chat".
import { describe, expect, it, vi } from 'vitest';

import { ChatController, type ThreadPersister } from '@pkg/pages/chat/controller/ChatController';

import type { ThreadState } from '@pkg/pages/chat/models/Thread';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: {} }));

function recordingPersister() {
  const saved = new Map<string, ThreadState>();
  const persister: ThreadPersister = {
    save: state => { saved.set(state.thread.id, JSON.parse(JSON.stringify(state))) },
    load: id => saved.get(id) ?? null,
    list: () => [...saved.values()],
    remove: id => { saved.delete(id) },
  };
  return { persister, saved };
}

const attachment = { id: 'att-1', name: 'notes.md', size: '1 KB', kind: 'file' } as any;

describe('delegated send persistence', () => {
  it('stores the auto-title and cleared staging so a restart restores them', () => {
    const { persister, saved } = recordingPersister();
    const controller = new ChatController({ persister, sendHandler: vi.fn() });
    controller.stageAttachment(attachment);
    controller.send('Return the harmless menu QA token. Then stop.', [attachment]);

    const stored = saved.get(controller.thread.value.id);
    expect(stored?.thread.title).toBe('Return the harmless menu QA token');
    expect(stored?.staged).toEqual([]);
    const restarted = new ChatController({ persister, hydrateFrom: persister.load(controller.thread.value.id) as ThreadState });
    expect(restarted.thread.value.title).toBe('Return the harmless menu QA token');
    controller.dispose(); restarted.dispose();
  });

  it('keeps a human rename instead of auto-titling later delegated sends', () => {
    const { persister, saved } = recordingPersister();
    const controller = new ChatController({ persister, sendHandler: vi.fn() });
    controller.renameThread('My named chat');
    controller.send('Something else entirely');
    expect(saved.get(controller.thread.value.id)?.thread.title).toBe('My named chat');
    controller.dispose();
  });

  it('still hands the message to the backend and resets staging', () => {
    const sendHandler = vi.fn();
    const controller = new ChatController({ sendHandler });
    controller.stageAttachment(attachment);
    controller.send('hello', [attachment]);
    expect(sendHandler).toHaveBeenCalledWith('hello', [attachment], {});
    expect(controller.staged.value).toEqual([]);
    controller.dispose();
  });

  it('keeps ordinary non-delegated send behavior: user message, title and save', () => {
    const { persister, saved } = recordingPersister();
    const controller = new ChatController({ persister });
    controller.send('Plain local send');
    const stored = saved.get(controller.thread.value.id);
    expect(stored?.thread.title).toBe('Plain local send');
    expect(stored?.thread.messages.map(message => message.kind)).toEqual(['user']);
    controller.dispose();
  });
});
