import { decisionService } from '@pkg/agent/services/DecisionService';
import type { DecisionResponse } from '@pkg/shared/decisions';
import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { ApprovalService, type UserQuestion } from '@pkg/agent/services/ApprovalService';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { AgentJobMessagingModel } from '@pkg/agent/database/models/AgentJobMessagingModel';
import { getActiveAgentsRegistry } from '@pkg/agent/services/ActiveAgentsRegistry';
import { getHeartbeatService } from '@pkg/agent/services/HeartbeatService';
import { getModelProviderService } from '@pkg/agent/services/ModelProviderService';
import { sendJobMessage } from '@pkg/agent/tools/agents/send_job_message';
import { findTaskByThread, getAllJobs, getJob } from '@pkg/agent/tools/agents/jobRegistry';
import { stopAgentJob } from '@pkg/agent/tools/agents/stop_agent_job';

// The only desktop switches the phone may flip. Each toggle writes exactly
// one key. (Projects has no automation switch: it is a plain board.)
const DESKTOP_TOGGLES = {
  heartbeat: { key: 'heartbeatEnabled', fallback: false },
} as const;
type DesktopToggle = keyof typeof DESKTOP_TOGGLES;

import { BrowserBookmarkModel } from '@pkg/agent/database/models/BrowserBookmarkModel';
import { listDockerLinks } from '@pkg/main/dockerLinks';
import { isLoopbackUrl, previewShares } from '@pkg/main/previewShare';

const MAX_RELAY_FAVICON_CHARS = 12_000;
const MAX_FLEET_TEXT_CHARS = 400;

type PendingCard = { conversationId: string; kind: string; questions?: UserQuestion[] };
const cards = new Map<string, PendingCard>();
export function registerMobileCard(conversationId: string, kind: string, data: any) {
  const id = kind === 'tool_question' ? data.toolQuestion?.questionId : data.toolApproval?.approvalId;
  if (typeof id !== 'string') return;
  cards.set(id, { conversationId, kind, questions: data.toolQuestion?.questions });
  // The underlying approval service expires requests; this map only binds scope.
  const timer = setTimeout(() => cards.delete(id), 60 * 60 * 1000);
  timer.unref?.();
}

// The phone may only pick a provider this desktop is already signed in to,
// and only a model that provider actually lists — never free text.
async function companionProvider(providerId: unknown) {
  if (typeof providerId !== 'string' || !providerId || providerId.length > 100) throw new Error('Provider required');
  const provider = (await getModelProviderService().getAvailableProviders()).find(p => p.id === providerId);
  if (!provider?.connected) throw new Error('That provider is not connected on this desktop');
  return provider;
}

function companionString(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${ name } required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`Invalid ${ name.toLowerCase() }`);
  const normalized = value.trim();
  if ((!normalized && required) || normalized.length > max) throw new Error(`Invalid ${ name.toLowerCase() }`);
  return normalized;
}

function companionInteger(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${ name }`);
  }
  return value;
}

function fleetText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FLEET_TEXT_CHARS);
}

async function companionJob(params: Record<string, unknown>) {
  const jobId = companionString(params.jobId, 'Job', 200);
  const threadId = companionString(params.threadId, 'Thread', 200);
  if (!jobId && !threadId) throw new Error('jobId or threadId required');
  if (jobId && threadId) throw new Error('Send jobId or threadId, not both');
  if (threadId) {
    const owner = await findTaskByThread(threadId);
    if (!owner) throw new Error(`Agent thread "${ threadId }" not found`);
    return { job: owner.job, jobId: owner.job.jobId, taskIndex: owner.taskIndex, threadId };
  }
  const job = await getJob(jobId!);
  if (!job) throw new Error(`Agent job "${ jobId }" not found`);
  return { job, jobId: jobId!, taskIndex: undefined, threadId: undefined };
}

async function companionJobMessage(target: Awaited<ReturnType<typeof companionJob>>, message: string) {
  const result = await sendJobMessage({ jobId: target.jobId, taskIndex: target.taskIndex, message });
  if (!result.successBoolean) throw new Error(result.responseString);
  return result;
}

// A narrow, authenticated owner surface. Never dispatch arbitrary tool names.
export async function mobileCompanionRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
  case 'decisions.list': return { decisions: await decisionService.list() };
  case 'decisions.resolve': return decisionService.resolve(params as unknown as DecisionResponse);
  case 'chat.answer': {
    const id = typeof params.id === 'string' ? params.id : '';
    const decision = (await decisionService.list()).find(r => r.id === id);
    if (decision) {
      const result = await decisionService.resolve({ id, conversationId: String(params.conversationId || ''),
        action: decision.kind === 'question' ? 'answered' : params.decision as DecisionResponse['action'],
        answers: params.answers as DecisionResponse['answers'] });
      if (!result.settled) throw new Error(result.reason);
      return { accepted: true };
    }
    const card = cards.get(id);
    if (!card || card.conversationId !== params.conversationId) throw new Error('This request is no longer available.');
    let accepted = false;
    if (card.kind === 'tool_question') {
      if (!Array.isArray(params.answers) || params.answers.length !== card.questions?.length) throw new Error('Answer every question');
      const answers = params.answers.map((answer: any, i: number) => {
        const question = card.questions![i];
        if (!Array.isArray(answer.selected) || !answer.selected.length || answer.selected.some((v: unknown) => typeof v !== 'string' || v.length > 10000)) throw new Error('Invalid answer');
        if (!question.multiSelect && answer.selected.length !== 1) throw new Error('Choose one answer');
        return { question: question.question, selected: answer.selected as string[] };
      });
      accepted = ApprovalService.getInstance().resolveQuestion(id, answers);
    } else if (params.decision === 'approved' || params.decision === 'denied') {
      accepted = ApprovalService.getInstance().resolve(id, params.decision);
    } else {
      throw new Error('Choose approve or deny');
    }
    cards.delete(id);
    if (!accepted) throw new Error('Already answered or expired. Ask Sulla for a fresh request.');
    return { accepted: true };
  }
  case 'agents.list': {
    const includeFinishedHours = companionInteger(params.includeFinishedHours, 'includeFinishedHours', 24, 0, 72);
    const limit = companionInteger(params.limit, 'limit', 50, 1, 100);
    const now = Date.now();
    const finishedCutoff = now - includeFinishedHours * 60 * 60 * 1000;
    const [activeAgents, allJobs] = await Promise.all([
      getActiveAgentsRegistry().getAllAgents(),
      getAllJobs(),
    ]);
    const selectedJobs = allJobs
      .filter(job => job.status === 'running' || (includeFinishedHours > 0 && job.finishedAt !== null && job.finishedAt >= finishedCutoff))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    const jobs = await Promise.all(selectedJobs.map(async(job) => {
      const telemetry = await AgentJobMessagingModel.telemetryForJob(job.jobId);

      return {
        jobId:         job.jobId,
        status:        job.status,
        startedAt:     new Date(job.createdAt).toISOString(),
        elapsedMs:     Math.max(0, (job.finishedAt ?? now) - job.createdAt),
        parentThreadId: job.parentThreadId,
        tasks:          job.tasks.map((task, taskIndex) => {
          const checkin = telemetry[taskIndex]?.latestCheckin;

          return {
            taskIndex,
            agentId:   task.agentId,
            label:     task.label,
            status:    task.status,
            visibility: task.visibility ?? job.visibility ?? 'hidden',
            threadId:  task.threadId,
            latestCheckin: checkin ? {
              step:     fleetText(checkin.step),
              summary:  fleetText(checkin.summary),
              percent:  checkin.percent,
              blockers: checkin.blockers.slice(0, 10).map(fleetText),
              time:     new Date(checkin.createdAt).toISOString(),
            } : null,
          };
        }),
      };
    }));
    const agents = activeAgents
      .filter(agent => agent.type !== 'human')
      .map(agent => ({
        channel:  agent.channel,
        name:     agent.name || agent.agentId,
        status:   agent.status,
        uptimeMs: Math.max(0, now - agent.startedAt),
        current:  agent.statusNote && agent.statusNote !== 'idle' ? fleetText(agent.statusNote) : undefined,
      }));

    return {
      generatedAt: new Date(now).toISOString(),
      agents,
      jobs,
      heartbeat: {
        enabled: await SullaSettingsModel.get('heartbeatEnabled', false),
        status:  getHeartbeatService().getStatus(),
      },
    };
  }
  case 'agents.message': {
    const target = await companionJob(params);
    const message = companionString(params.message, 'Message', 10000, true)!;
    await companionJobMessage(target, message);
    return { accepted: true, jobId: target.jobId, taskIndex: target.taskIndex ?? null };
  }
  case 'agents.stop': {
    const target = await companionJob(params);
    const result = await stopAgentJob(target.jobId);
    if (!result.successBoolean) throw new Error(result.responseString);
    return { stopped: true, jobId: target.jobId, mode: 'cooperative-stop' };
  }
  case 'agents.pause': {
    const target = await companionJob(params);
    if (target.job.status !== 'running') throw new Error(`Agent job "${ target.jobId }" is not running`);
    await companionJobMessage(target, 'Cloud dashboard pause requested. Finish the current atomic step, then hold without starting new work until a resume message arrives.');
    return { paused: true, jobId: target.jobId, mode: 'cooperative-hold' };
  }
  case 'agents.resume': {
    const target = await companionJob(params);
    if (target.job.status !== 'running') throw new Error(`Agent job "${ target.jobId }" is not running`);
    await companionJobMessage(target, 'Cloud dashboard resume requested. Release the hold and continue the original task from the saved state.');
    return { resumed: true, jobId: target.jobId, mode: 'cooperative-hold' };
  }
  // Read-only history for the cloud dashboard. Served live from this
  // desktop, so it works even when conversation sync to the cloud is off.
  case 'conversations.list': {
    const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
    const conversations = await postgresClient.query(
      `SELECT id, title, status, last_message_at, last_message_preview, created_at
         FROM claude_conversations
        WHERE deleted_at IS NULL
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT $1`,
      [limit],
    );
    return { conversations };
  }
  case 'conversations.messages': {
    if (typeof params.conversationId !== 'string' || !params.conversationId || params.conversationId.length > 200) throw new Error('Conversation required');
    const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 1000);
    const rows = await postgresClient.query(
      `SELECT id, role, content, created_at FROM (
         SELECT id, role, content, created_at FROM claude_messages
          WHERE conversation_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT $2
       ) recent ORDER BY created_at ASC`,
      [params.conversationId, limit],
    );
    return { conversationId: params.conversationId, messages: rows };
  }
  case 'heartbeat.read':
    return {
      enabled: await SullaSettingsModel.get('heartbeatEnabled', false),
      instructions: await SullaSettingsModel.get('heartbeatMobileInstructions', ''),
      status: getHeartbeatService().getStatus(),
      history: getHeartbeatService().getHistory(80),
    };
  case 'heartbeat.update': {
    // This endpoint is only called by an explicit human action in the phone UI.
    if (typeof params.enabled === 'boolean') {
      await SullaSettingsModel.set('heartbeatEnabled', params.enabled, 'boolean');
    } else if (typeof params.instructions === 'string' && params.instructions.length <= 10000) {
      await SullaSettingsModel.set('heartbeatMobileInstructions', params.instructions, 'string');
    } else {
      throw new Error('Invalid Heartbeat update');
    }
    return mobileCompanionRequest('heartbeat.read', {});
  }
  case 'desktop.settings.read': {
    const entries = await Promise.all(Object.entries(DESKTOP_TOGGLES).map(async([name, { key, fallback }]) =>
      [name, Boolean(await SullaSettingsModel.get(key, fallback))] as const));
    return Object.fromEntries(entries);
  }
  case 'desktop.settings.update': {
    // Called only by an explicit human toggle in the phone's device settings.
    const name = params.setting as DesktopToggle;
    if (typeof name !== 'string' || !Object.hasOwn(DESKTOP_TOGGLES, name) || typeof params.enabled !== 'boolean') {
      throw new Error('Invalid desktop setting update');
    }
    await SullaSettingsModel.set(DESKTOP_TOGGLES[name].key, params.enabled, 'boolean');
    return mobileCompanionRequest('desktop.settings.read', {});
  }
  // Primary language model. Every conversation reads it at the start of its
  // next turn, so switching here also moves active desktop conversations.
  case 'models.read': {
    const mps = getModelProviderService();
    const { primaryProvider, activeModelId } = mps.getState();
    const providers = (await mps.getAvailableProviders()).filter(p => p.connected);
    return { primaryProvider, activeModelId, providers };
  }
  case 'models.list': {
    const provider = await companionProvider(params.providerId);
    return { providerId: provider.id, models: await getModelProviderService().getModelsForProvider(provider.id) };
  }
  case 'models.select': {
    // Called only by an explicit human pick in the phone's device settings.
    const provider = await companionProvider(params.providerId);
    const models = await getModelProviderService().getModelsForProvider(provider.id);
    if (typeof params.modelId !== 'string' || !models.some(m => m.id === params.modelId)) {
      throw new Error('That model is not available for this provider');
    }
    await getModelProviderService().selectModel(provider.id, params.modelId);
    return mobileCompanionRequest('models.read', {});
  }
  // Bookmarks for Sulla Mobile / Sulla Cloud. Local links (localhost,
  // running Docker containers) can't be opened from the phone directly, so
  // `bookmarks.open` returns a gated tunnel link instead of the raw URL.
  case 'bookmarks.list': {
    const [rows, docker] = await Promise.all([BrowserBookmarkModel.list(), listDockerLinks()]);
    const bookmarks = rows.map(row => ({
      id:        row.id,
      parent_id: row.parent_id,
      kind:      row.kind,
      title:     row.title,
      url:       row.url,
      // Inline favicons can be 64KB each; keep the relay frame small.
      favicon:   row.favicon && row.favicon.length <= MAX_RELAY_FAVICON_CHARS ? row.favicon : null,
      position:  row.position,
      local:     !!row.url && isLoopbackUrl(row.url),
    }));

    return { bookmarks, docker };
  }
  case 'bookmarks.open': {
    if (typeof params.url !== 'string' || params.url.length > 4096) throw new Error('Bookmark URL required');
    const url = params.url;
    if (!isLoopbackUrl(url)) return { url, proxied: false };
    // Only tunnel origins the owner has bookmarked or that Docker is serving
    // right now — never an arbitrary local port.
    const origin = new URL(url).origin;
    const [rows, docker] = await Promise.all([BrowserBookmarkModel.list(), listDockerLinks()]);
    const known = [...rows.map(r => r.url), ...docker.links.map(l => l.url)]
      .some(u => !!u && isLoopbackUrl(u) && new URL(u).origin === origin);
    if (!known) throw new Error('That link is not a bookmark or a running Docker container on this desktop');

    // `fresh` asks for a new tunnel hostname when the phone cached a failed lookup.
    return { ...await previewShares.open(url, { fresh: params.fresh === true }), proxied: true };
  }
  case 'bookmarks.close': {
    if (typeof params.url !== 'string' || !isLoopbackUrl(params.url)) throw new Error('Local URL required');
    await previewShares.close(new URL(params.url).origin);

    return { closed: true };
  }
  default: throw new Error('Unsupported companion request');
  }
}
