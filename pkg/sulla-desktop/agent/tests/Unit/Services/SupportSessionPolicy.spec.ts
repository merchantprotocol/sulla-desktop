import { describe, expect, it } from 'vitest';
import { SupportSessionPolicy } from '../../../services/SupportSessionPolicy';

describe('SupportSessionPolicy', () => {
  const policy = new SupportSessionPolicy();

  it('preserves an active support capability across internal follow-ups but clears it for an ordinary chat turn', () => {
    // risk: permissions — internal completion/orchestrator messages must not revoke the live support turn, while normal chats must not inherit support access.
    expect(policy.shouldClearCapability({ source: 'sub_agent_completion' })).toBe(false);
    expect(policy.shouldClearCapability({ source: 'orchestrator_job_message' })).toBe(false);
    expect(policy.shouldClearCapability({ source: 'inject' })).toBe(true);
    expect(policy.shouldClearCapability({})).toBe(true);
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
