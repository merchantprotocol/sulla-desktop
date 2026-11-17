// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {databaseUrl,FilesRoutesFixture} from './FilesAppFixture.js';

describe.skipIf(!databaseUrl)('organization root handoff routes',()=>{
  const fixture=new FilesRoutesFixture();
  beforeAll(()=>fixture.start()); afterAll(()=>fixture.stop());
  it('rejects agent and job capabilities at all root and sync endpoints',async()=>{
    // risk: permissions — agents and jobs must never install org keys or alter desktop sync state.
    const requests=[
      ['/v1/desktop/org-collections/root-transport','POST',{}],
      [`/v1/desktop/org-collections/${fixture.collectionId}/root`,'PUT',{requestId:'bad',keyVersion:1,transport:{}}],
      [`/v1/desktop/org-collections/${fixture.collectionId}/sync`,'POST',{keyVersion:1}],
    ] as const;
    for(const [path,method,body] of requests) for(const identity of [{agent_id:'agent-a'},{job_id:'job-a'}]) {
      expect((await fixture.request(path,method,{body,token:fixture.token(identity)})).status).toBe(403);
    }
  });
});
