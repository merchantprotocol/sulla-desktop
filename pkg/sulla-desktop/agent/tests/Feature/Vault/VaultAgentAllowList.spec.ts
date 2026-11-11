// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// AgentPolicy.agents on the Desktop vault (PERMISSIONS-DESIGN-DRAFT §1.6 bug 3).
// Owner decision 2026-11-11: enforce it; an empty or absent list means every
// agent may use the item, a non-empty list means only the listed agents.
// Drives the real LocalVaultAuthority broker paths with real item encryption;
// only the Postgres item repository is replaced, through its constructor port.

import { randomBytes, randomUUID } from 'node:crypto';

import { DEFAULT_AGENT_POLICY, encryptItem, type AgentPolicy, type VaultItemPlaintext } from '@sulla/vault-crypto';
import { describe, expect, it } from 'vitest';

import { LocalVaultAuthority } from '../../../../../../services/sulla-vault/src/localAuthority';

interface StoredItem { id:string; owner_user_id:string; collection_id:null; item_type:string; ciphertext:unknown; encrypted_item_key:unknown; agent_policy:unknown }

/** In-memory stand-in for PostgresVaultItemRepository's agent listing query. */
class InMemoryAgentItems {
  readonly rows:StoredItem[] = [];
  async listAgentAccessiblePersonal<T>(_values:unknown[]):Promise<{ rows:T[]; rowCount:number }> {
    return { rows:this.rows as unknown as T[], rowCount:this.rows.length };
  }
}

class AgentAllowListFixture {
  private readonly userId = randomUUID();
  private readonly userKey = new Uint8Array(randomBytes(32));
  private readonly brokerToken = randomBytes(32).toString('hex');
  private readonly items = new InMemoryAgentItems();
  private readonly authority:LocalVaultAuthority;

  constructor() {
    const token = () => randomBytes(32).toString('hex');
    const config = {
      mode:'desktop', brokerServiceId:'broker', brokerServiceToken:this.brokerToken, bootstrapServiceToken:token(),
      controlServiceToken:token(), approvalServiceToken:token(), filesServiceToken:token(),
    };
    this.authority = new LocalVaultAuthority({} as never, config as never, undefined, undefined, this.items as never);
    // Unlocked state: the broker only lists items for the unlocked principal.
    Object.assign(this.authority as object, { keys:{ userId:this.userId, publicKey:'pk', userKey:this.userKey, privateKey:new Uint8Array(32) } });
  }

  /** Stores an API-key item usable by agents, with the given agent allow-list (undefined = field absent). */
  async addItem(name:string, agents:string[] | undefined):Promise<string> {
    const id = randomUUID();
    const policy:Partial<AgentPolicy> = { ...DEFAULT_AGENT_POLICY, mode:'agents', level:'autofill' };
    if (agents === undefined) delete policy.agents; else policy.agents = agents;
    const plaintext = { type:'login', name, username:'u', password:'secret-value', agentPolicy:policy,
      proxy:{ hosts:['api.example.test'], rules:[{ source:'password', target:'header', name:'X-Api-Key', scheme:'raw' }] } } as unknown as VaultItemPlaintext;
    const sealed = await encryptItem(JSON.stringify(plaintext), this.userKey, { itemId:id, ownerId:this.userId });
    this.items.rows.push({ id, owner_user_id:this.userId, collection_id:null, item_type:'login', ciphertext:sealed.ciphertext, encrypted_item_key:sealed.encryptedItemKey, agent_policy:policy });
    return id;
  }

  /** What the broker tells this agent it may use. */
  async visibleTo(agentId:string):Promise<string[]> {
    const listed = await this.authority.listBrokerItems({ sub:this.userId, agent_id:agentId, pod_id:'pod-1' } as never, 'broker', this.brokerToken);
    return listed.items.map(item => item.name);
  }
}

describe('Desktop vault enforces the AgentPolicy agent allow-list', () => {
  it('lets a listed agent use the item', async() => {
    // risk: availability — the allow-list must not lock out the agent the owner chose.
    const fixture = new AgentAllowListFixture();
    await fixture.addItem('Restricted key', ['research-agent']);
    expect(await fixture.visibleTo('research-agent')).toEqual(['Restricted key']);
  });

  it('refuses an agent that is not on a non-empty list', async() => {
    // risk: secret disclosure — an item restricted to one agent must not be usable by another.
    const fixture = new AgentAllowListFixture();
    await fixture.addItem('Restricted key', ['research-agent']);
    expect(await fixture.visibleTo('coding-agent')).toEqual([]);
  });

  it('lets every agent use an item whose list is empty', async() => {
    // risk: availability — empty means all agents (owner decision 2026-11-11).
    const fixture = new AgentAllowListFixture();
    await fixture.addItem('Shared key', []);
    expect(await fixture.visibleTo('coding-agent')).toEqual(['Shared key']);
    expect(await fixture.visibleTo('research-agent')).toEqual(['Shared key']);
  });

  it('lets every agent use an item whose list is absent', async() => {
    // risk: availability — older items without the field keep working for all agents.
    const fixture = new AgentAllowListFixture();
    await fixture.addItem('Legacy key', undefined);
    expect(await fixture.visibleTo('coding-agent')).toEqual(['Legacy key']);
  });

  it('filters a mixed vault per agent', async() => {
    // risk: secret disclosure — the check is per item, not per vault.
    const fixture = new AgentAllowListFixture();
    await fixture.addItem('Shared key', []);
    await fixture.addItem('Research only', ['research-agent']);
    expect(await fixture.visibleTo('coding-agent')).toEqual(['Shared key']);
    expect(await fixture.visibleTo('research-agent')).toEqual(['Shared key', 'Research only']);
  });
});
