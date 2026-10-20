import assert from 'node:assert/strict';
import test from 'node:test';

import { FilesAuditEmitter } from './filesAudit.js';

const config = {
  mode: 'server', filesServiceToken: 'synthetic-files-token', filesApiUrl: 'http://files.test', auditSpoolDir: '/tmp/sulla-vault-audit-test',
} as any;

test('reveal audit payload never contains the secret value', async() => {
  let body = '';
  const fetcher = async(_input: string | URL, init?: RequestInit) => {
    body = String(init?.body ?? '');
    return new Response(JSON.stringify({ ok: true }), { status: 202 });
  };
  const emitter = new FilesAuditEmitter(config, fetcher);
  emitter.emit({ subjectKind: 'vault-secret', subjectId: 'secret-id', action: 'human_item_reveal', actor: 'human', result: 'allowed', path: 'Synthetic login', meta: { value: 'synthetic-secret-value', operation: 'reveal' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.doesNotMatch(body, /synthetic-secret-value/);
  assert.match(body, /Synthetic login/);
});
