// SPDX-License-Identifier: GPL-2.0-or-later
import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { ConversationHistoryModel } from '@pkg/agent/database/models/ConversationHistoryModel';

const f = vi.hoisted(() => ({ db:undefined as PGlite | undefined }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient: {
  query: async(sql:string, args?:unknown[]) => (await f.db!.query(sql, args)).rows,
  queryOne: async(sql:string, args?:unknown[]) => (await f.db!.query(sql, args)).rows[0],
} }));

it('keeps delegated built-in Advisor history hidden without hiding a custom collision or ordinary Advisor chat', async() => {
  const db = f.db = new PGlite();
  try {
    await ConversationHistoryModel.ensureTable();
    await db.exec(`CREATE TABLE agent_definitions(slug text PRIMARY KEY, is_builtin boolean);
      INSERT INTO agent_definitions VALUES ('advisor',true),('opus-worker',false)`);
    const record = async(id:string, channel_id:string, delegated:boolean, builtin?:boolean) => {
      await ConversationHistoryModel.recordConversation({ id, channel_id, type:'graph', graphOrigin:{ delegated, builtin } });
    };
    await record('delegation','advisor',true,true);
    await record('human','advisor',false,true);
    await record('restored','advisor',true);
    await record('custom-legacy','opus-worker',true);
    await record('original-legacy','opus-worker',true,true);
    await record('custom-new','advisor',true,false);
    expect((await db.query<{ id:string }>('SELECT id FROM conversation_history WHERE NOT hidden ORDER BY id')).rows.map(row => row.id))
      .toEqual(['custom-legacy','custom-new','human']);
    expect((await db.query<{ id:string }>('SELECT id FROM conversation_history WHERE hidden ORDER BY id')).rows.map(row => row.id))
      .toEqual(['delegation','original-legacy','restored']);
  } finally { await db.close() }
});
