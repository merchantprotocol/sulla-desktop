import {
  ARTIFACT_RECEIPT_SCHEMA_VERSION,
  RECEIPT_COMMENT_MAX_CHARS,
  RECEIPT_MARKER_PREFIX,
  buildReceipt,
  computeReceiptFingerprint,
  isLegacyComment,
  recordReceipt,
  redactSecrets,
  renderReceiptComment,
  type ArtifactReceiptInput,
} from '../ArtifactReceiptService';
import { ArtifactReceiptModel } from '../../database/models/ArtifactReceiptModel';
import { postgresClient } from '../../database/PostgresClient';

jest.mock('../../database/models/ArtifactReceiptModel', () => ({
  ArtifactReceiptModel: { insertIfAbsentWithClient: jest.fn(), attachCommentWithClient: jest.fn() },
}));

const insertIfAbsent = ArtifactReceiptModel.insertIfAbsentWithClient as jest.Mock;
const attachComment = ArtifactReceiptModel.attachCommentWithClient as jest.Mock;
const query = jest.fn();

function baseInput(): ArtifactReceiptInput {
  return {
    taskId:            'g3ud',
    eventType:         'execution',
    actor:             'dispatcher',
    disposition:       'pass',
    nextOwner:         'dispatcher',
    validationSummary: '7 suites / 36 tests passed',
    artifacts:         [
      { type: 'pull_request', canonicalRef: 'merchantprotocol/sulla-desktop#720', url: 'https://github.com/merchantprotocol/sulla-desktop/pull/720', hash: 'abc1234' },
      { type: 'projects_task', canonicalRef: 'g3ud' },
    ],
    evidence:          { kind: 'dispatch', ref: 'dispatch-d9bb255d', url: 'https://example/dispatch' },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => callback({ query }));
  query.mockResolvedValue({ rows: [] });
});
afterEach(() => jest.restoreAllMocks());

describe('fingerprint (dedupe + restart determinism)', () => {
  it('is stable across repeated builds of the same event', () => {
    expect(computeReceiptFingerprint(baseInput())).toBe(computeReceiptFingerprint(baseInput()));
  });
  it('is independent of artifact ordering', () => {
    const a = baseInput();
    const b = baseInput();
    b.artifacts = [...b.artifacts!].reverse();
    expect(computeReceiptFingerprint(a)).toBe(computeReceiptFingerprint(b));
  });
  it('changes when an immutable artifact hash changes', () => {
    const a = baseInput();
    const b = baseInput();
    b.artifacts![0] = { ...b.artifacts![0], hash: 'deadbeef' };
    expect(computeReceiptFingerprint(a)).not.toBe(computeReceiptFingerprint(b));
  });
});

describe('redaction', () => {
  it('strips github tokens, api keys and private keys', () => {
    const dirty = 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and Authorization: Bearer sk-abcdefghijklmnopqrstuvwx';
    const clean = redactSecrets(dirty);
    expect(clean).not.toMatch(/ghp_ABCDEF/);
    expect(clean).not.toMatch(/sk-abcdef/);
    expect(clean).toContain('[REDACTED]');
  });
});

describe('renderReceiptComment', () => {
  it('renders one compact multi-artifact receipt with evidence link and marker', () => {
    const body = renderReceiptComment(buildReceipt(baseInput()));
    expect(body).toContain('pull_request');
    expect(body).toContain('projects_task');
    expect(body).toContain('https://example/dispatch');
    expect(body).toContain(RECEIPT_MARKER_PREFIX);
    expect(body).toContain(`v="${ ARTIFACT_RECEIPT_SCHEMA_VERSION }"`);
  });
  it('never exceeds the size limit and redacts secrets even with huge narration', () => {
    const input = baseInput();
    input.validationSummary = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ' + 'x'.repeat(6000);
    const body = renderReceiptComment(buildReceipt(input));
    expect(body.length).toBeLessThanOrEqual(RECEIPT_COMMENT_MAX_CHARS);
    expect(body).not.toMatch(/ghp_ABCDEF/);
    expect(body).toContain(RECEIPT_MARKER_PREFIX);
  });
});

describe('isLegacyComment', () => {
  it('classifies prose without a marker as legacy and receipts as non-legacy', () => {
    expect(isLegacyComment('Did the thing, all good.')).toBe(true);
    expect(isLegacyComment(renderReceiptComment(buildReceipt(baseInput())))).toBe(false);
    expect(isLegacyComment(null)).toBe(true);
  });
});

describe('recordReceipt (linkage + dedupe)', () => {
  it('posts exactly one concise comment linked to full evidence on first sight', async () => {
    insertIfAbsent.mockResolvedValue({ inserted: true, row: { id: 'r1', comment_id: null } });
    const res = await recordReceipt(baseInput());
    expect(res.deduped).toBe(false);
    expect(res.commentId).toMatch(/^artifact-receipt-comment-/);
    expect(query).toHaveBeenCalledTimes(1);
    const body = query.mock.calls[0][1][2] as string;
    expect(body).toContain('https://example/dispatch');
    expect(body).toContain(RECEIPT_MARKER_PREFIX);
    expect(insertIfAbsent.mock.calls[0][1].contentHashes).toContain('abc1234');
    expect(attachComment).toHaveBeenCalledTimes(1);
    expect(attachComment.mock.calls[0][2]).toBe(res.commentId);
  });
  it('does not add a second comment when the same event replays', async () => {
    insertIfAbsent.mockResolvedValue({ inserted: false, row: { id: 'r1', comment_id: 'c1' } });
    const res = await recordReceipt(baseInput());
    expect(res.deduped).toBe(true);
    expect(res.commentId).toBe('c1');
    expect(query).not.toHaveBeenCalled();
    expect(attachComment).not.toHaveBeenCalled();
  });
  it('keeps receipt insertion and comment creation in one rollback boundary', async () => {
    insertIfAbsent.mockResolvedValue({ inserted: true, row: { id: 'r1', comment_id: null } });
    query.mockRejectedValueOnce(new Error('comment insert failed'));
    await expect(recordReceipt(baseInput())).rejects.toThrow('comment insert failed');
    expect(attachComment).not.toHaveBeenCalled();
    expect(postgresClient.transaction).toHaveBeenCalledTimes(1);
  });
});
