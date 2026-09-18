import { ApprovalService, type UserQuestion } from '@pkg/agent/services/ApprovalService';
import { WorkItemsModel } from '@pkg/agent/database/models/WorkItemsModel';
import { WorkLaneDefinitionModel } from '@pkg/agent/database/models/WorkLaneDefinitionModel';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getHeartbeatService } from '@pkg/agent/services/HeartbeatService';

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

// A narrow, authenticated owner surface. Never dispatch arbitrary tool names.
export async function mobileCompanionRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
  case 'chat.answer': {
    const id = typeof params.id === 'string' ? params.id : '';
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
  default: throw new Error('Unsupported companion request');
  }
}
