import { getConfiguredApprovalClient, usesContainerVaultAuthority, VaultBrokerError } from '@pkg/vault-broker';

import { getCurrentAccessToken, isCloudSignedIn } from '../sullaCloudAuth';

const CLOUD_ORIGIN = 'https://sulla-workers.merchantprotocol.workers.dev';

export { isCloudSignedIn };

function vaultMessage(error: VaultBrokerError): Error {
  if (error.code === 'vault_locked' || error.status === 423) return new Error('Waiting for the vault to be unlocked.');
  if (error.code === 'credential_field_missing' || /Sulla Cloud session is unavailable/i.test(error.message)) {
    return new Error('Sign in to Sulla Cloud again.');
  }
  if (error.status === 404 && error.code === 'not_found') return new Error('Update Sulla Vault to use Sulla Cloud features.');
  return error;
}

export async function cloudRequest(method: string, path: string, options: {
  headers?: Record<string, string>;
  body?: BodyInit | null;
  responseType?: 'json' | 'text';
} = {}): Promise<Response> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Sulla Cloud path must be relative');
  if (!usesContainerVaultAuthority()) {
    const token = await getCurrentAccessToken();
    if (!token) throw new Error('Not signed in to Sulla Cloud');
    return fetch(`${ CLOUD_ORIGIN }${ path }`, {
      method,
      headers: { ...options.headers, Authorization: `Bearer ${ token }` },
      body: options.body,
      ...(options.body instanceof ReadableStream ? { duplex: 'half' } as any : {}),
    });
  }
  const client = getConfiguredApprovalClient();
  if (!client) throw new Error('Desktop vault cloud service is unavailable');
  let body: unknown = options.body ?? undefined;
  let bodyEncoding: 'base64' | undefined;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = body instanceof ArrayBuffer
      ? Buffer.from(body)
      : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    body = bytes.toString('base64');
    bodyEncoding = 'base64';
  } else if (body instanceof Blob) {
    body = Buffer.from(await body.arrayBuffer()).toString('base64');
    bodyEncoding = 'base64';
  } else if (body instanceof ReadableStream) {
    const bytes = Buffer.from(await new Response(body).arrayBuffer());
    body = bytes.toString('base64');
    bodyEncoding = 'base64';
  }
  try {
    const result = await client.sullaCloudRequest({
      method, path, headers: options.headers, body, bodyEncoding,
      responseType: options.responseType ?? 'json',
    });
    const responseBody = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? null);
    return new Response(responseBody, { status: result.status, headers: result.headers });
  } catch (error) {
    if (error instanceof VaultBrokerError) throw vaultMessage(error);
    throw error;
  }
}
