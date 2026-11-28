// @vitest-environment jsdom
/*
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn() } }));
vi.mock('@pkg/composables/useBrowserTabs', () => ({ openWorkspaceTab: vi.fn() }));

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import InlineFileMessage from '../../../../pages/chat/components/files/InlineFileMessage.vue';

const source = '<!doctype html><html><head><style>@font-face{font-family:PreviewFace;src:url("./fonts/preview.woff2")}</style></head><body><img src="./images/hero.png"><script>window.previewRan = true;</script></body></html>';
const assetBaseUrl = 'sulla-files-preview://fixture-token/Projects/synthetic/page.html';

describe('InlineFileMessage HTML preview assets', () => {
  it('uses the Files capability URL as the relative asset base and revokes it when the card unmounts', async() => {
    // risk: data access and resource lifecycle — relative HTML assets must use the authorized Files URL, and its temporary access token must not outlive the card.
    const invoke = ipcRenderer.invoke as any;
    invoke.mockReset();
    invoke.mockImplementation(async(channel: string) => {
      if (channel === 'sulla-files:preview-read') return {
        state:'ready', kind:'html', content:source, truncated:false,
        document:{ id:'file-id', path:'Projects/synthetic/page.html', name:'page.html', mime:'text/html', size:source.length, currentVersionId:'version-id' },
      };
      if (channel === 'files:preview:open') return { token:'fixture-token', url:assetBaseUrl };
      if (channel === 'files:preview:revoke') return undefined;
      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    const wrapper = mount(InlineFileMessage, { props:{ reference:{ fileId:'file-id', collectionId:'collection-id', toolCallId:'tool-call-id', threadId:'thread-id' } } });
    await flushPromises();

    const frame = wrapper.get('iframe');
    expect(frame.attributes('sandbox')).toBe('allow-scripts allow-forms allow-popups allow-modals');
    expect(frame.attributes('srcdoc')).toBe(source.replace('<head>', `<head><base href="${assetBaseUrl}">`));
    expect(invoke).toHaveBeenNthCalledWith(1, 'sulla-files:preview-read', { fileId:'file-id' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'files:preview:open', { collectionId:'collection-id', fileId:'file-id' });

    wrapper.unmount();

    expect(invoke).toHaveBeenLastCalledWith('files:preview:revoke', { token:'fixture-token' });
  });
});
