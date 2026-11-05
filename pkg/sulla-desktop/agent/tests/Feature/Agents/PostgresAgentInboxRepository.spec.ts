// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PostgresConnection } from '@sulla/foundation/postgres';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { PostgresAgentInboxRepository } from '../../../app/Repositories/PostgresAgentInboxRepository';
import { TestDatabase } from '../../Support/TestDatabase';

const database=new TestDatabase();
const suite=TestDatabase.available()?describe:describe.skip;

suite('PostgresAgentInboxRepository',()=>{
  let repository:PostgresAgentInboxRepository;
  beforeAll(async()=>{
    await database.initialize();
    repository=new PostgresAgentInboxRepository(new PostgresConnection({query:async(text:string,values?:readonly unknown[])=>({rows:await database.query(text,[...(values??[])]),rowCount:0})} as any));
  });
  afterAll(async()=>database.dispose());
  it('leases each pending message to only one of two concurrent consumers',async()=>{ // risk: duplicate agent turns across processes
    const target={channel:'researcher',threadId:'parked-thread',agentId:'researcher'};
    await repository.enqueue({target,envelope:{from:'mobile-relay',kind:'peer',body:'one turn only',ids:{messageId:`lease-${Date.now()}`}}});
    const [first,second]=await Promise.all([repository.claim(target,'consumer-a'),repository.claim(target,'consumer-b')]);
    expect(first.entries.length+second.entries.length).toBe(1);
    expect([first.entries.length,second.entries.length].sort()).toEqual([0,1]);
  });
});
