// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { expect, it, vi } from 'vitest';

import { BackgroundBrowseWorker } from '../../../tools/browser/background_browse';
import { ArtifactOpenWorker } from '../../../tools/chat/artifact_open';

const edges = vi.hoisted(() => {
  const tab = { id: 'hidden-fixture', url: 'https://example.invalid/private-url', title: 'PRIVATE_TITLE' };
  return {
    tab,
    openFile: vi.fn(),
    browser: {
      tabs: {
        create: vi.fn(async () => tab), get: vi.fn(async () => tab), update: vi.fn(),
        remove: vi.fn(), query: vi.fn(async () => [tab]),
      },
      scripting: { executeScript: vi.fn(async () => [{ result: 'PRIVATE_BODY' }]) },
      captureHiddenTabScreenshot: vi.fn(async () => ({ base64: 'PRIVATE_IMAGE', mediaType: 'image/png' })),
    },
  };
});
vi.mock('@pkg/main/chromeApi', () => ({ getChromeApi: () => edges.browser }));
vi.mock('../../../tools/browser/screenshot_store', () => ({ saveScreenshot: async () => ({ path: 'PRIVATE_PATH' }) }));
vi.mock('../../../services/ChatArtifactService', () => ({ getChatArtifactService: () => ({ openFile: edges.openFile }) }));

class BrowserFixtureWorker extends BackgroundBrowseWorker {
  run(input: object) { return this._validatedCall(input) }
}
class ArtifactFixtureWorker extends ArtifactOpenWorker {
  run(input: object) { return this._validatedCall(input) }
}

// risk: operations executed by the tool are omitted or disclose URLs, page bodies, scripts or screenshot paths.
it.each(['open', 'navigate', 'read', 'screenshot', 'list', 'close'])('reports actual %s start and completion without tool payload', async(action) => {
  const tool = new BrowserFixtureWorker();
  const report = vi.fn(async () => true);
  tool.setState({ metadata: { threadId: 'thread-a' } });
  tool.sendChatMessage = report;

  const result = await tool.run({ action, tabId: edges.tab.id, url: edges.tab.url, code: 'PRIVATE_SCRIPT', waitMs: 1 });
  expect(result.successBoolean).toBe(true);
  expect(report.mock.calls).toEqual([
    ['', 'chat_tool_activity', { chatToolActivity: `browser:${ action }:Running` }],
    ['', 'chat_tool_activity', { chatToolActivity: `browser:${ action }:Completed` }],
  ]);
});

// risk: failed operations appear successful or disclose an internal browser error to the transcript.
it('reports an actual browser failure without exporting the error', async() => {
  const tool = new BrowserFixtureWorker();
  const report = vi.fn(async () => true);
  tool.setState({ metadata: { threadId: 'thread-a' } });
  tool.sendChatMessage = report;
  edges.browser.scripting.executeScript.mockRejectedValueOnce(new Error('PRIVATE_FAILURE'));
  expect((await tool.run({ action: 'read', tabId: edges.tab.id })).successBoolean).toBe(false);
  expect(report.mock.calls).toEqual([
    ['', 'chat_tool_activity', { chatToolActivity: 'browser:read:Running' }],
    ['', 'chat_tool_activity', { chatToolActivity: 'browser:read:Failed' }],
  ]);
});

// risk: a failed or unbound Files open posts a misleading or cross-thread breadcrumb.
it('reports a successful Files open only in the originating chat', async() => {
  const tool = new ArtifactFixtureWorker();
  const report = vi.fn(async () => true);
  tool.setState({ metadata: { threadId: 'thread-a' } });
  tool.sendChatMessage = report;
  const artifact = { id: 'artifact-a', name: 'PRIVATE_NAME', content: 'PRIVATE_BODY', filesRegistrationStatus: 'synced' };

  edges.openFile.mockResolvedValueOnce({ created: false, artifact });
  expect((await tool.run({ file_id: 'file-a', thread_id: 'other-thread', focus: false })).successBoolean).toBe(true);
  expect(edges.openFile).toHaveBeenLastCalledWith('thread-a', 'file-a', false);
  expect(report.mock.calls).toEqual([['', 'chat_tool_activity', { chatToolActivity: 'artifact-opened' }]]);

  edges.openFile.mockRejectedValueOnce(new Error('Not authorized'));
  await expect(tool.run({ file_id: 'file-b' })).rejects.toThrow('Not authorized');
  expect(report).toHaveBeenCalledTimes(1);

  tool.executionContext = { thread_id: 'other-thread' } as NonNullable<typeof tool.executionContext>;
  edges.openFile.mockResolvedValueOnce({ created: true, artifact });
  await tool.run({ file_id: 'file-a' });
  expect(report).toHaveBeenCalledTimes(1);
});
