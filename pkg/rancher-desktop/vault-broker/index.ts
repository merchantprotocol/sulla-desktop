import * as fs from 'node:fs/promises';

import {
  decryptWithKey,
  itemAssociatedData,
  unwrapItemKeyForAgent,
  type EncryptedEnvelope,
  type PublicKeyEnvelope,
  type VaultItemPlaintext,
} from '../../../packages/vault-crypto/src/index';

/** Structural copy of contract 1 while worker A owns the canonical file. */
export interface CapabilityClaims {
  v:                      1;
  iss:                    string;
  aud:                    'sulla-tools';
  sub:                    string;
  org_id?:                string;
  agent_id?:              string;
  pod_id?:                string;
  thread_id?:             string;
  job_id?:                string;
  workflow_execution_id?: string;
  device_id?:             string;
  scopes:                 string[];
  iat:                    number;
  exp:                    number;
  jti:                    string;
}

export interface ToolExecutionContext {
  claims:     CapabilityClaims;
  request_id: string;
}

export interface CredentialReference {
  integrationId?: string;
  itemId?:        string;
  field?:         string;
}

export interface CredentialBroker {
  useCredential<T>(
    ctx: ToolExecutionContext,
    ref: CredentialReference,
    fn: (secret: Buffer) => Promise<T>,
  ): Promise<T>;
}

export interface AgentKeyPair {
  publicKey:  string;
  privateKey: Buffer;
}

export interface AgentKeySource {
  load(): Promise<AgentKeyPair>;
}

/** Docker tmpfs secret or Kubernetes Secret mount. */
export class FileAgentKeySource implements AgentKeySource {
  constructor(private readonly filePath: string) {}

  async load(): Promise<AgentKeyPair> {
    const stat = await fs.stat(this.filePath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error('Agent key file must be a regular file readable only by its owner');
    }
    const raw = await fs.readFile(this.filePath);
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as { publicKey?: unknown; privateKey?: unknown };
      if (typeof parsed.publicKey !== 'string' || typeof parsed.privateKey !== 'string') {
        throw new Error('Agent key file is malformed');
      }
      const privateKey = Buffer.from(parsed.privateKey, 'base64url');
      if (privateKey.byteLength !== 32) {
        privateKey.fill(0);
        throw new Error('Agent private key must be 32 bytes');
      }
      return { publicKey: parsed.publicKey, privateKey };
    } finally {
      raw.fill(0);
    }
  }
}

/** Enterprise implementation point; no local fallback is permitted. */
export class KmsAgentKeySource implements AgentKeySource {
  load(): Promise<AgentKeyPair> {
    return Promise.reject(new Error('Enterprise KMS/HSM agent-key source is not configured'));
  }
}

interface BrokerEnvelope {
  ciphertext:             EncryptedEnvelope;
  agent_wrapped_item_key: PublicKeyEnvelope;
  policyDecision:         { allowed: true; itemId: string; contextOwnerId: string; auditId: string };
}

function credentialField(item: VaultItemPlaintext, ref: CredentialReference): string | undefined {
  const field = ref.field ?? 'password';
  if (field === '__integration_auth__') {
    const properties = item.integration?.properties ?? {};
    const allowed = ['bearer_token', 'access_token', 'api_token', 'api_key', 'basic_username', 'basic_password', 'auth_token'];
    return JSON.stringify(Object.fromEntries(allowed.filter(key => typeof properties[key] === 'string').map(key => [key, properties[key]])));
  }
  return item.integration?.properties?.[field] ??
    (field === 'username' ? item.username : undefined) ??
    (['password', 'api_key', 'bearer_token', 'api_token', 'auth_token'].includes(field) ? item.password : undefined) ??
    item.fields?.find(candidate => candidate.name === field)?.value;
}

export class VaultCredentialBroker implements CredentialBroker {
  constructor(
    private readonly endpoint: string,
    private readonly serviceId: string,
    private readonly serviceToken: string,
    private readonly keySource: AgentKeySource,
  ) {}

  async useCredential<T>(ctx: ToolExecutionContext, ref: CredentialReference, fn: (secret: Buffer) => Promise<T>): Promise<T> {
    if (!ctx.claims.agent_id || !ctx.claims.pod_id) {
      throw new Error('Credential broker requires agent_id and pod_id capability claims');
    }
    const response = await fetch(`${ this.endpoint.replace(/\/$/, '') }/v1/broker/credential`, {
      method:  'POST',
      headers: {
        authorization:        `Bearer ${ this.serviceToken }`,
        'content-type':       'application/json',
        'x-sulla-service-id': this.serviceId,
      },
      body: JSON.stringify({ claims: ctx.claims, ref }),
    });
    const body = await response.json().catch(() => ({})) as BrokerEnvelope & { policyDecision?: { reason?: string } };
    if (!response.ok) {
      throw new Error(body.policyDecision?.reason ?? `Credential broker denied request (${ response.status })`);
    }

    const keyPair = await this.keySource.load();
    let itemKey: Uint8Array | undefined;
    let plaintext: Uint8Array | undefined;
    let secret: Buffer | undefined;
    try {
      itemKey = await unwrapItemKeyForAgent(body.agent_wrapped_item_key, keyPair.publicKey, keyPair.privateKey);
      plaintext = await decryptWithKey(
        body.ciphertext,
        itemKey,
        itemAssociatedData('ciphertext', { itemId: body.policyDecision.itemId, ownerId: body.policyDecision.contextOwnerId }),
      );
      const item = JSON.parse(Buffer.from(plaintext).toString('utf8')) as VaultItemPlaintext;
      const value = credentialField(item, ref);
      if (typeof value !== 'string') throw new Error(`Credential field ${ ref.field ?? 'password' } is unavailable`);
      secret = Buffer.from(value, 'utf8');
      const result = await fn(secret);
      if (result === secret || (typeof result === 'string' && result === value)) {
        throw new Error('Credential callback attempted to return secret material');
      }
      return result;
    } finally {
      secret?.fill(0);
      plaintext?.fill(0);
      itemKey?.fill(0);
      keyPair.privateKey.fill(0);
    }
  }
}

let configuredBroker: CredentialBroker | null | undefined;

export function getConfiguredCredentialBroker(): CredentialBroker | null {
  if (configuredBroker !== undefined) return configuredBroker;
  const endpoint = process.env.SULLA_VAULT_BROKER_URL;
  const token = process.env.SULLA_VAULT_BROKER_TOKEN;
  const keyFile = process.env.SULLA_AGENT_KEY_FILE;
  configuredBroker = endpoint && token && keyFile
    ? new VaultCredentialBroker(endpoint, process.env.SULLA_VAULT_BROKER_SERVICE_ID ?? 'sulla-tools', token, new FileAgentKeySource(keyFile))
    : null;
  return configuredBroker;
}
