import { WorkItemsModel } from '@pkg/agent/database/models/WorkItemsModel';
import { WorkLaneDefinitionModel } from '@pkg/agent/database/models/WorkLaneDefinitionModel';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getHeartbeatService } from '@pkg/agent/services/HeartbeatService';

// A narrow, authenticated owner surface. Never dispatch arbitrary tool names.
export async function mobileCompanionRequest(method: string, params: Record<string, unknown>) {
  switch (method) {
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
