// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../tools/files/common', () => ({ FilesTool: class { state:any = { metadata:{} }; executionContext:any; context() { return this.executionContext ?? { thread_id:this.state?.metadata?.threadId } } emitMessage = async() => true } }));
vi.mock('../../../tools/toolRuntime', () => ({ toolRuntime:{ publishApprovalCoordinator:{ start:() => undefined } } }));
vi.mock('../../../services/DecisionService', () => ({ decisionService:{} }));
import { FilesRequestPublishWorker } from '../../../tools/files/request_publish';

class TestFilesRequestPublishWorker extends FilesRequestPublishWorker {
  posted = 0;
  constructor(coordinator:any, decisions:any, metadata:Record<string, unknown> = { threadId:'thread-1', wsChannel:'sulla-desktop' }) {
    super(coordinator, decisions);
    (this as any).state = { metadata };
  }
  protected override async containerJson<T>(path:string):Promise<T> {
    if (path.includes('publish-request')) this.posted += 1;
    if (path.includes('publish-request')) return { id:'request-1' } as T;
    return { file:{ path:'Use Cases/skills/gate-test/SKILL.md' }, content_base64:'' } as T;
  }
  async execute(input:any) { return this._validatedCall(input) }
}

describe('FilesRequestPublishWorker', () => {
  it('reuses an existing pending Decide approval instead of duplicating it', async() => {
    // risk: irreversible side effects — retries must create exactly one human approval.
    let created = 0, registered = '';
    const coordinator = { start:() => undefined, register:(id:string) => { registered = id } };
    const decisions = {
      pendingApprovalForPayload:async() => ({ id:'decision-1', conversationId:'thread-1', kind:'approval', status:'pending' }),
      request:async() => { created += 1; throw new Error('must not create another approval') },
    };
    const response = await new TestFilesRequestPublishWorker(coordinator, decisions).execute({ file_id:'file-1', version_id:'version-1' });
    expect(JSON.parse(response.responseString)).toEqual({ request_id:'request-1', decision_id:'decision-1', status:'pending' });
    expect({ created, registered }).toEqual({ created:0, registered:'decision-1' });
  });

  it('does not move another conversation approval or completion callback on retry', async() => {
    const register = vi.fn();
    const decisions = { pendingApprovalForPayload: async() => ({ id:'private-decision', conversationId:'other-thread' }), request: vi.fn() };
    await expect(new TestFilesRequestPublishWorker({ start:vi.fn(), register }, decisions).execute({ file_id:'file-1', version_id:'version-1' })).rejects.toThrow('original conversation');
    expect(register).not.toHaveBeenCalled();
    expect(decisions.request).not.toHaveBeenCalled();
  });

  it('refuses a call without the original conversation before creating any publish request', async() => {
    // risk: approval routing — since #2294 an approval with no chat thread is refused, and must leave no orphan request.
    const decisions = {
      pendingApprovalForPayload:async() => { throw new Error('must not look up approvals') },
      request:async() => { throw new Error('must not create an approval') },
    };
    const worker = new TestFilesRequestPublishWorker({ start:() => undefined, register:() => undefined }, decisions, {});
    await expect(worker.execute({ file_id:'file-1', version_id:'version-1' })).rejects.toThrow('Approval requires the original conversation');
    expect(worker.posted).toBe(0);
  });
});

  it('routes an activation approval using verified context when graph metadata is missing', async() => {
    let requested:any;
    const decisions = { pendingApprovalForPayload:async() => undefined, request:async(input:any) => {requested=input;return {record:{id:'decision-1'}}} };
    const worker = new TestFilesRequestPublishWorker({start:() => undefined,register:() => undefined}, decisions, {});
    (worker as any).executionContext={thread_id:'verified-thread',agent_id:'account-manager'};
    await worker.execute({file_id:'file-1',version_id:'version-1',thread_id:'untrusted-thread'});
    expect(requested).toMatchObject({kind:'approval',conversationId:'verified-thread',channel:'sulla-desktop'});
    expect(worker.posted).toBe(1);
  });
  it('does not fall back to stale graph identity when the verified caller lacks a thread', async() => {
    const worker=new TestFilesRequestPublishWorker({start:() => undefined,register:() => undefined}, {});
    (worker as any).executionContext={agent_id:'account-manager'};
    await expect(worker.execute({file_id:'file-1',version_id:'version-1',thread_id:'forged'})).rejects.toThrow('original conversation');
    expect(worker.posted).toBe(0);
  });
