import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';

export async function initialize(): Promise<void> {
  // Schema and default/legacy lane reconciliation are owned by the Projects
  // service. Desktop only waits for that service boundary to be ready.
  await getProjectsApplicationService().ready();
}
