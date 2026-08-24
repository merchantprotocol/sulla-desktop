import { down, up } from '../0084_activate_protected_review';

describe('0084_activate_protected_review', () => {
  it('adds capability telemetry and promotes only known dark-rollout defaults', () => {
    expect(up).toContain('ADD COLUMN IF NOT EXISTS details JSONB');
    expect(up).toContain("('taskVerifierEnabled', 'true', 'boolean')");
    expect(up).toContain("('taskVerifierOwner', 'core-routine', 'string')");
    expect(up).toContain("('taskReviewCoreRoutineEnabled', 'true', 'boolean')");
    expect(up).toContain("sulla_settings.value = 'legacy'");
    expect(up).toContain("sulla_settings.value = 'false'");
    expect(down).toContain('DROP COLUMN IF EXISTS details');
  });
});
