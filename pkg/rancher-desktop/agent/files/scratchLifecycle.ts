import { hostname } from 'node:os';

import { getSullaFilesService } from './runtime';

export async function beginAgentScratch(agentRunId:string, userId:string, orgId?:string):Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1_000);
    await getSullaFilesService().ensureScratch({ v: 1, iss: 'sulla-desktop', aud: 'sulla-tools', sub: userId, org_id: orgId, device_id: hostname(), job_id: agentRunId, agent_id: agentRunId, scopes: ['files/*'], iat: now, exp: now + 3_600, jti: agentRunId, request_id: agentRunId });
  } catch (error) { console.warn(`[SullaFiles] could not provision scratch for ${ agentRunId }:`, error) }
}
export async function endAgentScratch(agentRunId:string):Promise<void> {
  try { await getSullaFilesService().endScratchRun(agentRunId) } catch (error) { console.warn(`[SullaFiles] could not set scratch expiry for ${ agentRunId }:`, error) }
}
