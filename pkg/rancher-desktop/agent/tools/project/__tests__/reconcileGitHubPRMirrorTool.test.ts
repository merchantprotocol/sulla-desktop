/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';

import { projectToolManifests } from '../manifests';

describe('reconcile_github_pr_mirror manifest', () => {
  it('is generic, explicitly scoped, and has no private defaults', async() => {
    const manifest = projectToolManifests.find(tool => tool.name === 'reconcile_github_pr_mirror');
    expect(manifest).toBeDefined();
    expect(manifest?.schemaDef.repositories).toMatchObject({ type: 'array' });
    expect(manifest?.schemaDef.epic_id).toMatchObject({ type: 'string' });
    expect(manifest?.schemaDef.parent_id).toMatchObject({ type: 'string', optional: true });
    expect(manifest?.schemaDef.dry_run).toMatchObject({ type: 'boolean', optional: true });
    expect(manifest?.schemaDef.repositories).not.toHaveProperty('default');
    const module = await manifest!.loader();
    expect(typeof (module).ReconcileGitHubPRMirrorWorker).toBe('function');
  });
});
