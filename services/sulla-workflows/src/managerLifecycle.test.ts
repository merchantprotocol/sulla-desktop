import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { waitForRunnerHandshake } from './managerLifecycle.js';

describe('workflow runner launch handshake', () => {
  it('accepts the matching runner after it acquires ownership and a live lease', async() => {
    const query = mock.fn(async() => ({
      rows: [{
        status: 'running', runner_id: 'runner-1', owner_id: 'owner-1', lease_token: 'lease-1',
        heartbeat_at: new Date(), lease_expires_at: new Date(Date.now() + 60_000),
      }],
      rowCount: 1,
    }));
    const stopRunner = mock.fn(async() => {});
    const emit = mock.fn(async() => {});

    await waitForRunnerHandshake({
      db: { query }, launcher: { stopRunner }, emit,
      executionId: 'execution-1', runnerId: 'runner-1', timeoutMs: 10, pollMs: 1,
    });
    assert.equal(query.mock.callCount(), 1);
    assert.equal(stopRunner.mock.callCount(), 0);
    assert.equal(emit.mock.callCount(), 0);
  });

  it('settles an unowned launch and removes its runner after the bounded timeout', async() => {
    const responses = [
      { rows: [{ status: 'running', runner_id: 'runner-1', owner_id: null, lease_token: null, heartbeat_at: null, lease_expires_at: null }], rowCount: 1 },
      { rows: [{ workflow_id: 'workflow-1' }], rowCount: 1 },
    ];
    const query = mock.fn(async() => responses.shift()!);
    const stopRunner = mock.fn(async() => {});
    const emit = mock.fn(async() => {});

    await assert.rejects(waitForRunnerHandshake({
      db: { query }, launcher: { stopRunner }, emit,
      executionId: 'execution-1', runnerId: 'runner-1', timeoutMs: 1, pollMs: 1,
    }), /failed to acquire/);

    assert.deepEqual(stopRunner.mock.calls[0].arguments, ['runner-1']);
    assert.deepEqual(emit.mock.calls[0].arguments, ['execution-1', 'workflow-1', 'workflow_failed', { error: 'runner_handshake_timeout' }]);
    assert.match(String(query.mock.calls[1].arguments[0]), /terminal_reason=\$2/);
  });

  it('does not remove a runner that acquires ownership at the timeout boundary', async() => {
    const responses = [
      { rows: [{ status: 'running', runner_id: 'runner-1', owner_id: null, lease_token: null, heartbeat_at: null, lease_expires_at: null }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ];
    const query = mock.fn(async() => responses.shift()!);
    const stopRunner = mock.fn(async() => {});
    const emit = mock.fn(async() => {});

    await assert.rejects(waitForRunnerHandshake({
      db: { query }, launcher: { stopRunner }, emit,
      executionId: 'execution-1', runnerId: 'runner-1', timeoutMs: 1, pollMs: 1,
    }), /failed to acquire/);
    assert.equal(stopRunner.mock.callCount(), 0);
    assert.equal(emit.mock.callCount(), 0);
  });

  for (const status of ['completed', 'failed']) it(`leaves an already terminal ${ status } run untouched`, async() => {
    const query = mock.fn(async() => ({ rows: [{ status }], rowCount: 1 }));
    const stopRunner = mock.fn(async() => {});
    const emit = mock.fn(async() => {});

    await waitForRunnerHandshake({
      db: { query }, launcher: { stopRunner }, emit,
      executionId: 'execution-1', runnerId: 'runner-1', timeoutMs: 1, pollMs: 1,
    });
    assert.equal(query.mock.callCount(), 1);
    assert.equal(stopRunner.mock.callCount(), 0);
    assert.equal(emit.mock.callCount(), 0);
  });
});
