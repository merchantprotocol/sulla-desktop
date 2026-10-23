import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentPolicy } from '@sulla/vault-crypto';
import type { BrokerExecuteRequest } from './contracts.js';
import { brokerTransferLimits, FILES_SYNC_OPERATION, validateOperation } from './operationPolicy.js';

const HOST = 'sulla-workers.merchantprotocol.workers.dev';
const ITEM_POLICY = { level: 'autofill', agents: [], sites: [] } as unknown as AgentPolicy;
const CID = '0b6f0c32-4d1e-4c8a-9a59-2f9f6d1e0a11';
const CHUNK = 'a'.repeat(64);

function request(path:string, method = 'GET', extra:Partial<BrokerExecuteRequest> = {}):BrokerExecuteRequest {
  return {
    claims: { sub: 'user', agent_id: 'sulla-files', pod_id: 'sulla-files' },
    operation: FILES_SYNC_OPERATION,
    ref: { integrationId: 'sulla-cloud', accountId: 'default' },
    url: `https://${ HOST }${ path }`,
    method,
    injections: [{ field: 'api_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    ...extra,
  };
}

const allowed = (input:BrokerExecuteRequest) => {
  try {
    validateOperation(input, new URL(input.url).hostname, ITEM_POLICY);
    return true;
  } catch {
    return false;
  }
};

test('files-sync broker operation allows only the /files-sync/v1 routes', () => {
  for (const [path, method] of [
    ['/files-sync/v1/collections', 'GET'],
    [`/files-sync/v1/collections/${ CID }?op=create`, 'PUT'],
    [`/files-sync/v1/collections/${ CID }/keys/1`, 'PUT'],
    [`/files-sync/v1/collections/${ CID }/uploads`, 'POST'],
    [`/files-sync/v1/collections/${ CID }/commit?deviceId=dev-1`, 'POST'],
    [`/files-sync/v1/collections/${ CID }/changes?since=0&limit=500`, 'GET'],
    [`/files-sync/v1/collections/${ CID }/chunks/${ CHUNK }`, 'GET'],
    [`/files-sync/v1/uploads/${ CID }/chunks/${ CHUNK }`, 'PUT'],
    [`/files-sync/v1/collections/${ CID }`, 'DELETE'],
    ['/files-sync/v1/usage', 'GET'],
  ]) assert.equal(allowed(request(path, method)), true, `${ method } ${ path }`);

  for (const [path, method] of [
    ['/shares', 'GET'],
    ['/calls', 'POST'],
    ['/files-sync/v2/collections', 'GET'],
    [`/files-sync/v1/collections/${ CID }/other`, 'GET'],
    [`/files-sync/v1/collections/${ CID }/chunks/${ CHUNK }/extra`, 'GET'],
    [`/files-sync/v1/collections/${ CID }/chunks/XYZ`, 'GET'],
    [`/files-sync/v1/collections/${ CID }/keys/1`, 'PATCH'],
  ]) assert.equal(allowed(request(path, method)), false, `${ method } ${ path }`);

  assert.equal(allowed({ ...request('/files-sync/v1/usage'), url: 'https://evil.example.com/files-sync/v1/usage' }), false);
  assert.equal(allowed({ ...request('/files-sync/v1/usage'), ref: { integrationId: 'github', accountId: 'default' } }), false);
});

test('base64 responses and 6 MiB transfers belong to the files-sync operation alone', () => {
  assert.equal(allowed(request(`/files-sync/v1/collections/${ CID }/chunks/${ CHUNK }`, 'GET', { responseType: 'base64' })), true);
  assert.equal(allowed(request(`/files-sync/v1/uploads/${ CID }/chunks/${ CHUNK }`, 'PUT', { body: 'AAAA', bodyEncoding: 'base64' })), true);
  const shares:BrokerExecuteRequest = { ...request('/shares'), operation: 'sulla-cloud.shares', responseType: 'base64' };
  assert.equal(allowed(shares), false);

  const sixMiB = 6 * 1024 * 1024;
  assert.deepEqual(brokerTransferLimits(FILES_SYNC_OPERATION), { request: sixMiB, response: sixMiB });
  for (const operation of ['sulla-cloud.api', 'sulla-cloud.shares', 'github.api']) {
    assert.deepEqual(brokerTransferLimits(operation), { request: 1_048_576, response: 1_048_576 });
  }
  // A full 4 MiB chunk wire fits; anything past 6 MiB does not.
  assert.ok(4 * 1024 * 1024 + 64 * 1024 <= brokerTransferLimits(FILES_SYNC_OPERATION).request);
  assert.ok(sixMiB + 1 > brokerTransferLimits(FILES_SYNC_OPERATION).request);
});
