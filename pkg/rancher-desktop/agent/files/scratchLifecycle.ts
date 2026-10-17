import { hostname } from 'node:os';

import { filesContainerRequest } from './containerClient';

export async function beginAgentScratch(agentRunId:string, userId:string, orgId?:string, threadId?:string):Promise<void> {
  try {
    await filesContainerRequest('/v1/agent-files/ensure', { sub: userId, org_id: orgId, device_id: hostname(), job_id: agentRunId, agent_id: agentRunId, thread_id: threadId }, { method: 'POST', body: '{}' });
  } catch (error) { console.warn(`[SullaFiles] could not provision scratch for ${ agentRunId }:`, error) }
}
export async function endAgentScratch(agentRunId:string, userId = process.env.SULLA_FILES_USER_ID ?? 'desktop-user'):Promise<void> {
  try { await filesContainerRequest(`/v1/agent-runs/${ encodeURIComponent(agentRunId) }/end`, { sub: userId, device_id: hostname(), job_id: agentRunId, agent_id: agentRunId }, { method: 'POST', body: '{}' }) } catch (error) { console.warn(`[SullaFiles] could not set scratch expiry for ${ agentRunId }:`, error) }
}
