// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import '../../Support/TestHomeEnv';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({
  getWebSocketClientService: () => ({ connect: vi.fn(), onMessage: vi.fn(() => () => {}), send: vi.fn(async() => true) }),
}));

import { ToolExecutor } from '@pkg/agent/controllers/ToolExecutor';
import { BaseTool } from '@pkg/agent/tools/base';
import { BrowseToolsWorker } from '@pkg/agent/tools/meta/browse_tools';
import '@pkg/agent/tools/manifests';
import { ChatCompletionsServer } from '@pkg/main/chatCompletionsServer';
import { getMCPServerHost } from '@pkg/main/MCPServerHost';

// Built-in workers run slim mode with NO allowedToolNames: the setting alone must refuse launch tools.
const workerState = (agentAwareness: boolean) => ({
  messages: [],
  metadata: { threadId: 'worker-thread', agentId: 'codex-luna-worker', wsChannel: 'codex-luna-worker', agentAwareness },
}) as any;

describe('Sees other agents OFF is enforced where tools execute', () => {
  let server: ChatCompletionsServer;
  let listener: any;
  let base = '';
  const ran: string[] = [];

  beforeAll(async() => {
    vi.spyOn(BaseTool.prototype, 'call').mockImplementation(async function(this: BaseTool) {
      ran.push(this.name);
      return { toolName: this.name, success: true, result: 'ran' } as any;
    });
    server = new ChatCompletionsServer();
    (server as any).apiToken = 'installation-token';
    listener = (server as any).app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    base = `http://127.0.0.1:${ (listener.address() as AddressInfo).port }`;
  });

  afterAll(async() => {
    await new Promise(resolve => listener.close(resolve));
    vi.restoreAllMocks();
  });

  const callCli = async(path: string, aware: boolean) => {
    vi.spyOn(getMCPServerHost(), 'getToolSession').mockReturnValue({ state: workerState(aware) } as any);
    // Loopback only: plain node:http to the in-process server (the spec network guard wraps fetch).
    return await new Promise<{ status: number; body: { error?: string } }>((resolve, reject) => {
      const req = request(`${ base }/v1/tools/internal/${ path }/call`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer installation-token', 'X-Sulla-Tool-Session': 'worker-session' },
      }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end('{}');
    });
  };

  it('refuses spawn_agent and agents/directory on the real sulla CLI route, and still runs reporting tools', async() => {
    // risk: permissions — a worker with the setting OFF could still launch agents through `sulla meta/spawn_agent`.
    for (const path of ['meta/spawn_agent', 'agents/spawn_agent', 'agents/directory']) {
      const refused = await callCli(path, false);
      expect(refused.status, path).toBe(403);
      expect(refused.body.error).toBe('not available to this agent');
    }
    expect(ran).toEqual([]);

    for (const path of ['agents/report_progress', 'agents/return_result', 'agents/wait']) {
      const allowed = await callCli(path, false);
      expect(allowed.status, path).toBe(200);
    }
    expect(ran).toHaveLength(3);

    const aware = await callCli('agents/directory', true);
    expect(aware.status).toBe(200);
  });

  it('refuses launch tools at the ToolExecutor gate without an allowlist', async() => {
    // risk: permissions — slim-mode VM graph workers execute through ToolExecutor, not the CLI route.
    const executor = new ToolExecutor({
      nodeId: 'n', nodeName: 'n', currentNodeRunContext: null, wsChatMessage: async() => true, bumpStateVersion: () => {},
    });
    expect(await executor.getToolPolicyBlockReason(workerState(false), 'spawn_agent')).toContain('not available to this agent');
    expect(await executor.getToolPolicyBlockReason(workerState(false), 'agents_directory')).toContain('not available to this agent');
    for (const name of ['report_progress', 'return_result', 'wait']) {
      expect(await executor.getToolPolicyBlockReason(workerState(false), name)).toBeNull();
    }
    expect(await executor.getToolPolicyBlockReason(workerState(true), 'spawn_agent')).toBeNull();
  });

  it('leaves launch tools out of browse_tools for an agent with the setting OFF', async() => {
    // risk: permissions — the catalog would keep advertising commands the gate refuses.
    const worker = new BrowseToolsWorker();
    worker.setState(workerState(false));
    const off = (await (BrowseToolsWorker.prototype as any)._validatedCall.call(worker, { category: 'agents' })).responseString as string;
    expect(off).not.toMatch(/spawn_agent|agents\/directory/);
    expect(off).toContain('report_progress');
    worker.setState(workerState(true));
    const on = (await (BrowseToolsWorker.prototype as any)._validatedCall.call(worker, { category: 'agents' })).responseString as string;
    expect(on).toMatch(/spawn_agent|agents\/directory/);
  });
});
