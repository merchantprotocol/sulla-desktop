import type { FilesIdentity } from './auth.js';

/**
 * Test-phase switch for agent access. It is deliberately enabled by default so
 * every authenticated agent can exercise the complete Files surface while
 * existing ACL rows remain intact for the lockdown rollout.
 */
export const FILES_TEST_PHASE_ALLOW_ALL_AGENTS = process.env.SULLA_FILES_TEST_PHASE_ALLOW_ALL_AGENTS !== '0';

export function allowAllAgentAccess(actor:Pick<FilesIdentity, 'agentId'|'jobId'>):boolean {
  return FILES_TEST_PHASE_ALLOW_ALL_AGENTS && Boolean(actor.agentId || actor.jobId);
}
