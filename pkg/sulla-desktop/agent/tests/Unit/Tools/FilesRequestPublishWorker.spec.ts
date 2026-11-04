// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../tools/files/common', () => ({ FilesTool: class { state = { metadata:{} }; emitMessage = async() => true } }));
vi.mock('../../../tools/toolRuntime', () => ({ toolRuntime:{ publishApprovalCoordinator:{ start:() => undefined } } }));
vi.mock('../../../services/DecisionService', () => ({ decisionService:{} }));
import { FilesRequestPublishWorker } from '../../../tools/files/request_publish';

class TestFilesRequestPublishWorker extends FilesRequestPublishWorker {
  constructor(coordinator:any, decisions:any) { super(coordinator, decisions) }
  protected override async containerJson<T>(path:string):Promise<T> {
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
      pendingApprovalForPayload:async() => ({ id:'decision-1', kind:'approval', status:'pending' }),
      request:async() => { created += 1; throw new Error('must not create another approval') },
    };
    const response = await new TestFilesRequestPublishWorker(coordinator, decisions).execute({ file_id:'file-1', version_id:'version-1' });
    expect(JSON.parse(response.responseString)).toEqual({ request_id:'request-1', decision_id:'decision-1', status:'pending' });
    expect({ created, registered }).toEqual({ created:0, registered:'decision-1' });
  });
});
