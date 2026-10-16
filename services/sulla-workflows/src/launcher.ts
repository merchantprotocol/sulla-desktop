import fs from 'node:fs';

import tar from 'tar-stream';

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
      name:       `sulla-workflow-runner-${ safe }`,
      image:      config.workflowImage,
      entrypoint: ['/bin/sh'],
      command:    ['-c', 'while [ ! -s /run/secrets/sulla-run-token ]; do sleep 0.05; done; export SULLA_RUN_TOKEN="$(cat /run/secrets/sulla-run-token)"; rm -f /run/secrets/sulla-run-token; exec node dist/services/sulla-workflows/src/runner.js'],
      env:        {
        SULLA_WORKFLOW_ROLE:  'runner',
        SULLA_EXECUTION_ID:   run.executionId,
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
      tmpfs:      { '/run/secrets': 'rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000' },
    });
    try {
      await this.docker.start(id);
      const pack = tar.pack();
      pack.entry({ name: 'sulla-run-token', mode: 0o400, uid: 1000, gid: 1000 }, run.runToken);
      pack.finalize();
      const chunks: Buffer[] = [];
      for await (const chunk of pack) chunks.push(Buffer.from(chunk));
      const archive = Buffer.concat(chunks);
      try {
        await this.docker.upload(id, '/run/secrets', archive);
      } finally {
        archive.fill(0);
        chunks.forEach(chunk => chunk.fill(0));
      }
      return id;
    } catch (error) {
      await this.docker.remove(id).catch(() => {});
      throw error;
    }
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
