import { decisionService } from '@pkg/agent/services/DecisionService';
import type { DecisionResponse } from '@pkg/shared/decisions';
import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { ApprovalService, type UserQuestion } from '@pkg/agent/services/ApprovalService';
import { WorkItemsModel } from '@pkg/agent/database/models/WorkItemsModel';
import { WorkLaneDefinitionModel } from '@pkg/agent/database/models/WorkLaneDefinitionModel';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getHeartbeatService } from '@pkg/agent/services/HeartbeatService';
import { MASTER_ENABLED_KEY as PM_AUTOMATION_KEY } from '@pkg/agent/services/RoutineConcurrencyPolicy';
import { getModelProviderService } from '@pkg/agent/services/ModelProviderService';

// The only desktop switches the phone may flip. Heartbeat and Projects
// automation are independent systems — each toggle writes exactly one key.
const DESKTOP_TOGGLES = {
  heartbeat:         { key: 'heartbeatEnabled', fallback: false },
  projectAutomation: { key: PM_AUTOMATION_KEY, fallback: true },
} as const;
type DesktopToggle = keyof typeof DESKTOP_TOGGLES;

import { BrowserBookmarkModel } from '@pkg/agent/database/models/BrowserBookmarkModel';
import { listDockerLinks } from '@pkg/main/dockerLinks';
import { isLoopbackUrl, previewShares } from '@pkg/main/previewShare';

const MAX_RELAY_FAVICON_CHARS = 12_000;

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

async function companionTask(taskId: unknown) {
  if (typeof taskId !== 'string' || !taskId || taskId.length > 200) throw new Error('Task required');
  const task = await WorkItemsModel.getTask(taskId);
  if (!task || task.archived) throw new Error('Task not found');
  return task;
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
  case 'projects.list':
    return { projects: await WorkItemsModel.listProjects({ includeDone: true, limit: 1000 }) };
  case 'projects.detail': {
    if (typeof params.projectId !== 'string') throw new Error('Project required');
    const project = await WorkItemsModel.getProject(params.projectId);
    if (!project || project.archived) throw new Error('Project not found');
    const [tasks, lanes] = await Promise.all([
      WorkItemsModel.listTasks({ projectId: project.id, includeDone: true, limit: 5000 }),
      WorkLaneDefinitionModel.resolveEffective(project.id),
    ]);
    return { project, tasks, lanes, truncated: tasks.length >= 5000 };
  }
  // One ticket with its thread, opened from the phone's dashboard or board.
  case 'projects.task': {
    const task = await companionTask(params.taskId);
    const [project, lanes, comments] = await Promise.all([
      WorkItemsModel.getProject(task.project_id),
      WorkLaneDefinitionModel.resolveEffective(task.project_id),
      WorkItemsModel.listComments(task.id),
    ]);
    return { task, project, lanes, comments };
  }
  // Only ever a human comment: the phone owner typed it and pressed Post.
  case 'projects.comment': {
    const body = typeof params.body === 'string' ? params.body.trim() : '';
    if (!body || body.length > 20000) throw new Error('Write a comment first (20,000 characters max)');
    const task = await companionTask(params.taskId);
    const { getProjectsApplicationService } = await import('@pkg/agent/projects/application/ProjectsApplicationService');
    const comment = await getProjectsApplicationService().addComment({ task_id: task.id, body, author: 'human' }, { actor: 'human', source: 'ipc' });
    return { comment };
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
      activity: await WorkItemsModel.listRecentActivity({ author: 'heartbeat', limit: 50 }),
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

    return { ...await previewShares.open(url), proxied: true };
  }
  case 'bookmarks.close': {
    if (typeof params.url !== 'string' || !isLoopbackUrl(params.url)) throw new Error('Local URL required');
    await previewShares.close(new URL(params.url).origin);

    return { closed: true };
  }
  default: throw new Error('Unsupported companion request');
  }
}
