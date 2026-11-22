import { describe, expect, it } from 'vitest';
import { SupportSessionPolicy } from '../../../services/SupportSessionPolicy';

describe('SupportSessionPolicy', () => {
  const policy = new SupportSessionPolicy();

  // risk: permissions — changing agents or reopening scoped history must not grant local tools.
  it('keeps a scoped transcript bound and leaves a fresh local turn unscoped', () => {
    expect(policy.sessionForTurn(undefined, undefined)).toBe('');
    expect(policy.sessionForTurn(undefined, '../../local')).toBe('');
    expect(policy.sessionForTurn(undefined, 'session-123')).toBe('session-123');
    expect(policy.sessionForTurn('session-123', undefined)).toBe('session-123');
    expect(policy.sessionForTurn('session-123', 'other-session')).toBe('session-123');
  });

  // risk: permissions — a remote tool result must not be able to drive local tools.
  it('exposes only the narrow remote tool surface', () => {
    expect(policy.remoteToolNames(['support.update.status', 'support.runtime.exec', 'github_trigger_workflow_run', 'exec']))
      .toEqual(['support.update.status']);
  });

  it('adds support restrictions to the provider system prompt only when a session context exists', () => {
    // risk: permissions — Claude Code must receive the scope restrictions instead of silently omitting them from its native prompt.
    expect(policy.appendSupportContext('Sulla agent prompt', 'Only use approved remote support tools.'))
      .toBe('Sulla agent prompt\n\n<support_context>\nOnly use approved remote support tools.\n</support_context>');
    expect(policy.appendSupportContext('Sulla agent prompt', undefined)).toBe('Sulla agent prompt');
  });

  it('distinguishes an unattached chat from a tool denied by the session allowlist', () => {
    // risk: permissions — refusal diagnostics must preserve the distinction between missing session scope and an unapproved operation.
    expect(policy.toolRefusalReason('', ['support.logs.tail'], 'support.logs.tail'))
      .toBe('This chat is not attached to a support session.');
    expect(policy.toolRefusalReason('session-123', ['support.logs.tail'], 'support.containers.restart'))
      .toBe('This support tool is not allowed in this session.');
    expect(policy.toolRefusalReason('session-123', ['support.logs.tail'], 'support.logs.tail')).toBeNull();
  });
});
