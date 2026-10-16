import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileAgentKeySource, VaultCredentialBroker, type ToolExecutionContext } from './index';
import {
  createUserKeyPair,
  encryptItem,
  generateKey,
  type AgentPolicy,
} from '../../../packages/vault-crypto/src/index';
import { createApp } from '../../../services/sulla-vault/src/app';
import { connectDatabase, migrate } from '../../../services/sulla-vault/src/db';

import type { VaultConfig } from '../../../services/sulla-vault/src/config';
import type { AddressInfo } from 'node:net';

const databaseUrl = process.env.SULLA_VAULT_TEST_DATABASE_URL;

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return (server.address() as AddressInfo).port;
}

test('broker injects an allowed credential and audits every policy denial', { skip: !databaseUrl }, async() => {
  const config: VaultConfig = {
    mode:               'server',
    port:               0,
    databaseUrl:        databaseUrl!,
    extensionOrigins:   [],
    jwtSecret:          'broker-test-jwt-secret-at-least-thirty-two-characters',
    brokerServiceId:    'sulla-tools',
    brokerServiceToken: 'broker-test-service-token-at-least-thirty-two',
  };
  const db = await connectDatabase(config);
  await migrate(db);
  const userId = randomUUID();
  const ownerId = randomUUID();
  const agentId = 'security-test-agent';
  const podId = 'security-test-pod';
  const ownerKey = await generateKey();
  const agentOwnerKey = await generateKey();
  const agent = await createUserKeyPair(agentOwnerKey);
  const allowedPolicy: AgentPolicy = {
    mode:              'agents',
    level:             'autofill',
    agents:            [agentId],
    sites:             [],
    expiresAt:         null,
    askFirst:          false,
    allowServerAgents: true,
  };
  const allowedId = randomUUID();
  const disabledId = randomUUID();
  const collectionDeniedId = randomUUID();
  const wrongAgentId = randomUUID();
  const secretValue = `broker-secret-${ randomUUID() }`;
  const integrationRef = `echo/${ randomUUID() }`;
  const [integrationId, accountId] = integrationRef.split('/');
  const makeItem = (id: string, policy: AgentPolicy, wrap: boolean) => encryptItem(JSON.stringify({
    type:        'apiKey',
    name:        id,
    integration: { integrationId, accountId, properties: { api_key: secretValue } },
    agentPolicy: policy,
  }), ownerKey, { itemId: id, ownerId: userId }, wrap ? agent.publicKey : undefined);
  const [allowed, disabled, wrongAgent] = await Promise.all([
    makeItem(allowedId, allowedPolicy, true),
    makeItem(disabledId, { ...allowedPolicy, mode: 'only_me' }, false),
    makeItem(wrongAgentId, { ...allowedPolicy, agents: ['different-agent'] }, true),
  ]);
  const json = JSON.stringify({ test: true });
  let vaultServer: http.Server | undefined;
  let echoServer: http.Server | undefined;
  const keyDir = fs.mkdtempSync(path.join('/dev/shm', 'sulla-broker-test-'));
  const keyPath = path.join(keyDir, 'agent-key.json');
  fs.writeFileSync(keyPath, JSON.stringify({ publicKey: agent.publicKey, privateKey: Buffer.from(agent.privateKey).toString('base64url') }), { mode: 0o400 });

  try {
    await db.query(
      `INSERT INTO users(id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf)
       VALUES ($1,$2,'x','x','key',$3,$3,$3),($4,$5,'x','x','key',$3,$3,$3)`,
      [userId, `${ userId }@test.invalid`, json, ownerId, `${ ownerId }@test.invalid`],
    );
    const org = await db.query<{ id: string }>('INSERT INTO orgs(encrypted_name,created_by) VALUES ($1,$2) RETURNING id', [json, ownerId]);
    await db.query(
      `INSERT INTO org_members(org_id,user_id,role,wrapped_org_key,status)
       VALUES ($1,$2,'owner',$4,'confirmed'),($1,$3,'member',$4,'confirmed')`,
      [org.rows[0].id, ownerId, userId, json],
    );
    const collection = await db.query<{ id: string }>(
      'INSERT INTO collections(org_id,encrypted_name,wrapped_collection_key) VALUES ($1,$2,$2) RETURNING id', [org.rows[0].id, json],
    );
    await db.query(
      `INSERT INTO collection_members(collection_id,user_id,can_view,can_use_by_agents)
       VALUES ($1,$2,true,false)`, [collection.rows[0].id, userId],
    );
    const insertPersonal = (id: string, encrypted: Awaited<ReturnType<typeof encryptItem>>, policy: AgentPolicy, integrationRef: string | null) => db.query(
      `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_wrapped_item_key,agent_policy,integration_ref)
       VALUES ($1,$2,'apiKey',$3,$4,$5,$6,$7)`,
      [id, userId, encrypted.ciphertext, encrypted.encryptedItemKey, encrypted.agentWrappedItemKey ?? null, policy, integrationRef],
    );
    await insertPersonal(allowedId, allowed, allowedPolicy, integrationRef);
    await insertPersonal(disabledId, disabled, { ...allowedPolicy, mode: 'only_me' }, null);
    await insertPersonal(wrongAgentId, wrongAgent, { ...allowedPolicy, agents: ['different-agent'] }, null);
    const collectionItem = await encryptItem(JSON.stringify({ type: 'apiKey', name: 'collection', agentPolicy: allowedPolicy }), ownerKey,
      { itemId: collectionDeniedId, ownerId: collection.rows[0].id }, agent.publicKey);
    await db.query(
      `INSERT INTO items(id,collection_id,item_type,ciphertext,encrypted_item_key,agent_wrapped_item_key,agent_policy)
       VALUES ($1,$2,'apiKey',$3,$4,$5,$6)`,
      [collectionDeniedId, collection.rows[0].id, collectionItem.ciphertext, collectionItem.encryptedItemKey, collectionItem.agentWrappedItemKey, allowedPolicy],
    );

    vaultServer = createApp(db, config).listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { vaultServer!.once('listening', resolve); vaultServer!.once('error', reject) });
    const vaultPort = (vaultServer.address() as AddressInfo).port;
    let receivedAuthorization = '';
    echoServer = http.createServer((request, response) => {
      receivedAuthorization = request.headers.authorization ?? '';
      response.writeHead(204).end();
    });
    const echoPort = await listen(echoServer);
    const ctx: ToolExecutionContext = {
      request_id: randomUUID(),
      claims:     {
        v:        1,
        iss:      'test',
        aud:      'sulla-tools',
        sub:      userId,
        agent_id: agentId,
        pod_id:   podId,
        scopes:   ['*'],
        iat:      1,
        exp:      4_000_000_000,
        jti:      randomUUID(),
      },
    };
    const broker = new VaultCredentialBroker(`http://127.0.0.1:${ vaultPort }`, 'sulla-tools', config.brokerServiceToken, new FileAgentKeySource(keyPath));
    const upstreamStatus = await broker.useCredential(ctx, { integrationId: integrationRef, field: 'api_key' }, async(secret) => {
      const upstream = await fetch(`http://127.0.0.1:${ echoPort }`, { headers: { authorization: `Bearer ${ secret.toString('utf8') }` } });
      return upstream.status;
    });
    assert.equal(upstreamStatus, 204);
    assert.equal(receivedAuthorization, `Bearer ${ secretValue }`);

    const denied = async(itemId: string) => {
      const response = await fetch(`http://127.0.0.1:${ vaultPort }/v1/broker/credential`, {
        method:  'POST',
        headers: { authorization: `Bearer ${ config.brokerServiceToken }`, 'x-sulla-service-id': 'sulla-tools', 'content-type': 'application/json' },
        body:    JSON.stringify({ claims: ctx.claims, ref: { itemId } }),
      });
      assert.equal(response.status, 403);
    };
    await denied(disabledId);
    await denied(collectionDeniedId);
    await denied(wrongAgentId);
    const audits = await db.query(
      `SELECT blocked,reason FROM audit_log WHERE actor_user_id=$1 AND pod_id=$2 AND action='agent_credential_broker_use' ORDER BY id`,
      [userId, podId],
    );
    assert.equal(audits.rowCount, 4);
    assert.deepEqual(audits.rows.map(row => row.blocked), [false, true, true, true]);
    assert.match(audits.rows[1].reason, /owner|enabled/i);
    assert.match(audits.rows[2].reason, /collection/i);
    assert.match(audits.rows[3].reason, /allowed list/i);
  } finally {
    agent.privateKey.fill(0);
    agentOwnerKey.fill(0);
    ownerKey.fill(0);
    if (vaultServer) await new Promise<void>(resolve => vaultServer!.close(() => resolve()));
    if (echoServer) await new Promise<void>(resolve => echoServer!.close(() => resolve()));
    await db.end();
    try { fs.unlinkSync(keyPath) } catch { /* already removed */ }
    fs.rmdirSync(keyDir);
  }
});
