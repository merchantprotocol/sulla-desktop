import fs from 'node:fs';

import { config } from './config.js';
import { DockerRuntimeDriver, KubernetesRuntimeDriver } from '../../../pkg/rancher-desktop/runtime/containerRuntime.js';

export interface RunLaunch {
  executionId: string;
  runToken:    string;
}

export interface WorkflowLauncher {
  launchRunner(run: RunLaunch): Promise<string>;
}

export class DockerWorkflowLauncher implements WorkflowLauncher {
  constructor(private readonly docker = new DockerRuntimeDriver()) {}

  async launchRunner(run: RunLaunch): Promise<string> {
    const safe = run.executionId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 90);
    const id = await this.docker.create({
      name:    `sulla-workflow-runner-${ safe }`,
      image:   config.workflowImage,
      command: ['dist/services/sulla-workflows/src/runner.js'],
      env:     {
        SULLA_WORKFLOW_ROLE:  'runner',
        SULLA_EXECUTION_ID:   run.executionId,
        SULLA_RUN_TOKEN:      run.runToken,
        SULLA_DATABASE_URL:   config.databaseUrl,
        SULLA_REDIS_URL:      config.redisUrl,
        SULLA_MANAGER_URL:    config.managerUrl,
        SULLA_DOCKER_NETWORK: config.dockerNetwork,
      },
      labels: {
        'com.sulla.workload':     'workflow-runner',
        'com.sulla.execution-id': run.executionId,
      },
      network:    config.dockerNetwork,
      autoRemove: true,
      binds:      ['/var/run/docker.sock:/var/run/docker.sock'],
      groupAdd:   [String(fs.statSync('/var/run/docker.sock').gid)],
    });
    await this.docker.start(id);
    return id;
  }
}

export class KubernetesWorkflowLauncher implements WorkflowLauncher {
  constructor(private readonly runtime = new KubernetesRuntimeDriver()) {}
  async launchRunner(_run: RunLaunch): Promise<string> {
    return this.runtime.create({ name: 'workflow-runner', image: config.workflowImage });
  }
}

export function createWorkflowLauncher(): WorkflowLauncher {
  return config.launcher === 'kubernetes'
    ? new KubernetesWorkflowLauncher()
    : new DockerWorkflowLauncher();
}
