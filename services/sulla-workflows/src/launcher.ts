import crypto from 'node:crypto';

import tar from 'tar-stream';

import { config } from './config.js';
import { DockerRuntimeDriver, KubernetesRuntimeDriver } from '../../../pkg/rancher-desktop/runtime/containerRuntime.js';

export interface RunLaunch {
  executionId: string;
  runToken:    string;
}

export interface WorkflowLauncher {
  prepareRunner(run: RunLaunch): Promise<string>;
  startRunner(runnerId: string, run: RunLaunch): Promise<void>;
  stopRunner(runnerId: string): Promise<void>;
  runnerExists(runnerId: string): Promise<boolean>;
}

export class DockerWorkflowLauncher implements WorkflowLauncher {
  constructor(
    private readonly docker = new DockerRuntimeDriver(),
    private readonly filesGuestMount = config.filesGuestMount,
  ) {}

  async prepareRunner(run: RunLaunch): Promise<string> {
    const safe = run.executionId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 90);
    const id = await this.docker.create({
      name:       `sulla-workflow-runner-${ safe }-${ crypto.randomBytes(3).toString('hex') }`,
      image:      config.workflowImage,
      command:    ['node', 'dist/services/sulla-workflows/src/runner.js'],
      env:        {
        SULLA_WORKFLOW_ROLE:  'runner',
        SULLA_WORKFLOW_MODE:  config.mode,
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
      // Docker rejects an rslave bind of a non-shared path, so the Files mount
      // is bound only when Desktop confirmed its anchor.
      binds:      [
        '/var/run/docker.sock:/var/run/docker.sock',
        ...(this.filesGuestMount ? ['/mnt/sulla-files:/mnt/sulla-files:rslave'] : []),
      ],
      tmpfs:      { '/run/sulla-workflows-private': 'rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000' },
    });
    return id;
  }

  async startRunner(runnerId: string, run: RunLaunch): Promise<void> {
    try {
      const pack = tar.pack();
      pack.entry({ name: 'sulla-run-token', mode: 0o400, uid: 1000, gid: 1000 }, run.runToken);
      pack.finalize();
      const chunks: Buffer[] = [];
      for await (const chunk of pack) chunks.push(Buffer.from(chunk));
      const archive = Buffer.concat(chunks);
      try {
        // Docker's archive endpoint cannot reliably copy into a mounted tmpfs
        // before start. Stage in the private rootfs, then let the entrypoint
        // move and unlink the token before the runner process starts.
        await this.docker.upload(runnerId, '/run/sulla-workflows-bootstrap', archive);
        await this.docker.start(runnerId);
      } finally {
        archive.fill(0);
        chunks.forEach(chunk => chunk.fill(0));
      }
    } catch (error) {
      await this.docker.remove(runnerId).catch(() => {});
      throw error;
    }
  }

  async stopRunner(runnerId: string): Promise<void> {
    await this.docker.remove(runnerId, true);
  }

  async runnerExists(runnerId: string): Promise<boolean> {
    try {
      const inspected = await this.docker.inspect(runnerId);
      return inspected?.State?.Running === true;
    } catch (error) {
      if (String(error).includes('404')) return false;
      throw error;
    }
  }
}

export class KubernetesWorkflowLauncher implements WorkflowLauncher {
  constructor(private readonly runtime = new KubernetesRuntimeDriver()) {}
  async prepareRunner(_run: RunLaunch): Promise<string> {
    return this.runtime.create({ name: 'workflow-runner', image: config.workflowImage });
  }

  async startRunner(runnerId: string, _run: RunLaunch): Promise<void> {
    await this.runtime.start(runnerId);
  }

  async stopRunner(runnerId: string): Promise<void> {
    await this.runtime.remove(runnerId, true);
  }

  async runnerExists(runnerId: string): Promise<boolean> {
    try {
      const inspected = await this.runtime.inspect(runnerId);
      return inspected?.status?.phase === 'Running' || inspected?.State?.Running === true;
    } catch (error) {
      if (String(error).includes('404')) return false;
      throw error;
    }
  }
}

export function createWorkflowLauncher(): WorkflowLauncher {
  return config.launcher === 'kubernetes'
    ? new KubernetesWorkflowLauncher()
    : new DockerWorkflowLauncher();
}
