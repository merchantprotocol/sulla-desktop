// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';

import { useDragDrop } from '@pkg/pages/chat/composables/useDragDrop';

vi.mock('electron', () => ({ webUtils: { getPathForFile: (file: File) => `/Users/me/${ file.name }` } }));
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke } }));

function chatTab(isActive: Ref<boolean | undefined>) {
  const controller = { stageAttachment: vi.fn() };
  const wrapper = mount(defineComponent({
    setup() { useDragDrop(controller as any, isActive); return () => h('div') },
  }), { attachTo: document.body });

  return { controller, wrapper };
}

async function dropFile(name: string): Promise<void> {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as any;
  event.dataTransfer = { files: [new File(['x'], name)], types: ['Files'] };
  document.dispatchEvent(event);
  await new Promise(resolve => setTimeout(resolve, 0));
}

const mounted: { wrapper: { unmount(): void } }[] = [];
afterEach(() => { mounted.splice(0).forEach(tab => tab.wrapper.unmount()); invoke.mockReset() });

describe('dropping files into chat', () => {
  // risk: every open chat tab listens on the whole document, so one drop
  // attached the same files to every open conversation
  it('attaches dropped files only to the chat tab the user is looking at', async() => {
    invoke.mockResolvedValue([{ fileId: 'f1', path: 'Chat uploads/report.pdf', size: 10, mime: 'application/pdf' }]);
    const visible = chatTab(ref(true));
    const background = chatTab(ref(false));
    mounted.push(visible, background);

    await dropFile('report.pdf');

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(visible.controller.stageAttachment).toHaveBeenCalledTimes(1);
    expect(background.controller.stageAttachment).not.toHaveBeenCalled();
  });

  it('still accepts drops in a chat that is not inside a tab', async() => {
    invoke.mockResolvedValue([{ fileId: 'f2', path: 'Chat uploads/notes.md', size: 10, mime: 'text/markdown' }]);
    const standalone = chatTab(ref(undefined));
    mounted.push(standalone);

    await dropFile('notes.md');

    expect(standalone.controller.stageAttachment).toHaveBeenCalledTimes(1);
  });
});
