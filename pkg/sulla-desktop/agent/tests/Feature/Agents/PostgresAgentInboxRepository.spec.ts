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
  it('renews an owned row after its original lease expires so it cannot be reclaimed',async()=>{ // risk: duplicate agent turns during long turns
    const target={channel:'researcher',threadId:'long-turn-thread',agentId:'researcher'};
    const messageId=`renew-${Date.now()}`;
    await repository.enqueue({target,envelope:{from:'mobile-relay',kind:'peer',body:'long turn',ids:{messageId}}});
    const first=await repository.claim(target,'live-main-process');
    expect(first.entries).toHaveLength(1);
    await database.query(`UPDATE agent_inbox_messages SET lease_expires_at=now()-interval '1 second' WHERE message_id=$1`,[messageId]);
    await repository.renew(first);
    expect((await repository.claim(target,'stale-reclaimer')).entries).toHaveLength(0);
  });
});
