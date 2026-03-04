import events from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import timers from 'timers';
import util from 'util';

import semver from 'semver';
import yaml from 'yaml';

import { Architecture, BackendSettings, RestartReasons } from '../backend';
import BackendHelper, { MANIFEST_CERT_MANAGER, MANIFEST_SPIN_OPERATOR } from '../backendHelper';
import K3sHelper, { ExtraRequiresReasons, NoCachedK3sVersionsError, ShortVersion } from '../k3sHelper';
import LimaBackend, { Action, MACHINE_NAME } from '../lima';

import INSTALL_K3S_SCRIPT from '@pkg/assets/scripts/install-k3s';
import LOGROTATE_K3S_SCRIPT from '@pkg/assets/scripts/logrotate-k3s';
import SERVICE_CRI_DOCKERD_SCRIPT from '@pkg/assets/scripts/service-cri-dockerd.initd';
import SERVICE_K3S_SCRIPT from '@pkg/assets/scripts/service-k3s.initd';
import * as K8s from '@pkg/backend/k8s';
import { KubeClient } from '@pkg/backend/kube/client';
import { LockedFieldError } from '@pkg/config/commandLineOptions';
import { ContainerEngine } from '@pkg/config/settings';
import mainEvents from '@pkg/main/mainEvents';
import { checkConnectivity } from '@pkg/main/networking';
import clone from '@pkg/utils/clone';
import { SemanticVersionEntry } from '@pkg/utils/kubeVersions';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';
import { RecursivePartial } from '@pkg/utils/typeUtils';
import { showMessageBox } from '@pkg/window';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

import SULLA_DEPLOYMENTS from '@pkg/assets/sulla-deployments.yaml';

import { instantiateSullaStart } from '@pkg/sulla';

const console = Logging.kube;

export default class LimaKubernetesBackend extends events.EventEmitter implements K8s.KubernetesBackend {
  constructor(arch: Architecture, vm: LimaBackend) {
    super();
    this.arch = arch;
    this.vm = vm;

    this.k3sHelper = new K3sHelper(arch);
    this.k3sHelper.on('versions-updated', () => this.emit('versions-updated'));
    this.k3sHelper.initialize().catch((err) => {
      console.log('k3sHelper.initialize failed: ', err);
      // If we fail to initialize, we still need to continue (with no versions).
      this.emit('versions-updated');
    });
    mainEvents.on('network-ready', () => this.k3sHelper.networkReady());
  }

  /**
   * Download K3s images.  This will also calculate the version to download.
   * @precondition The VM must be running.
   * @returns The version of K3s images downloaded, and whether this is a
   * downgrade.
   */
  async download(cfg: BackendSettings): Promise<[semver.SemVer | undefined, boolean]> {
    this.cfg = cfg;
    const interval = timers.setInterval(() => {
      const statuses = [
        this.k3sHelper.progress.checksum,
        this.k3sHelper.progress.exe,
        this.k3sHelper.progress.images,
      ];
      const sum = (key: 'current' | 'max') => {
        return statuses.reduce((v, c) => v + c[key], 0);
      };

      const current = sum('current');
      const max = sum('max');

      this.progressTracker.numeric('Downloading Kubernetes components', current, max);
    });

    try {
      const persistedVersion = await K3sHelper.getInstalledK3sVersion(this.vm);
      const desiredVersion = await this.desiredVersion;

      if (desiredVersion === undefined) {
        // If we could not determine the desired version (e.g. we have no cached
        // versions and the machine is offline), bail out.
        return [undefined, false];
      }

      const isDowngrade = (version: semver.SemVer | string) => {
        return !!persistedVersion && semver.gt(persistedVersion, version);
      };

      console.debug(`Download: desired=${ desiredVersion } persisted=${ persistedVersion }`);
      try {
        await this.progressTracker.action('Checking k3s images', 100, this.k3sHelper.ensureK3sImages(desiredVersion));

        return [desiredVersion, isDowngrade(desiredVersion)];
      } catch (ex) {
        if (!await checkConnectivity('github.com')) {
          throw ex;
        }

        try {
          const newVersion = await K3sHelper.selectClosestImage(desiredVersion);

          // Show a warning if we are downgrading from the desired version, but
          // only if it's not already a downgrade (where the user had already
          // accepted it).
          if (desiredVersion.compare(newVersion) > 0 && !isDowngrade(desiredVersion)) {
            const options: Electron.MessageBoxOptions = {
              message:   `Downgrading from ${ desiredVersion.raw } to ${ newVersion.raw } will lose existing Kubernetes workloads. Delete the data?`,
              type:      'question',
              buttons:   ['Delete Workloads', 'Cancel'],
              defaultId: 1,
              title:     'Confirming migration',
              cancelId:  1,
            };
            const result = await showMessageBox(options, true);

            if (result.response !== 0) {
              return [undefined, true];
            }
          }
          console.log(`Going with alternative version ${ newVersion.raw }`);

          return [newVersion, isDowngrade(newVersion)];
        } catch (ex: any) {
          if (ex instanceof NoCachedK3sVersionsError) {
            throw new K8s.KubernetesError('No version available', 'The k3s cache is empty and there is no network connection.');
          }
          throw ex;
        }
      }
    } finally {
      timers.clearInterval(interval);
    }
  }

  /**
   * Install the Kubernetes files.
   */
  async install(config: BackendSettings, desiredVersion: semver.SemVer, allowSudo: boolean) {
    await this.progressTracker.action('Installing k3s', 50, async() => {
      const promises: Promise<void>[] = [];
      promises.push(this.writeServiceScript(config, desiredVersion, allowSudo));

      promises.push((async() => {
        // installK3s removes old config and makes sure the directories are recreated;
        // this means it must be done before adding custom manifests.
        await this.installK3s(desiredVersion);

        const localPromises: Promise<void>[] = [];

        if (config.experimental?.containerEngine?.webAssembly?.enabled) {
          localPromises.push(BackendHelper.configureRuntimeClasses(this.vm));
          if (config.experimental?.kubernetes?.options?.spinkube) {
            localPromises.push(BackendHelper.configureSpinOperator(this.vm));
          }
        }
        await Promise.all(localPromises);
      })());
      await Promise.all(promises);
    });

    this.activeVersion = desiredVersion;
  }

  /**
   * Start Kubernetes.
   * @returns The Kubernetes endpoint
   */
  async start(config_: BackendSettings, kubernetesVersion: semver.SemVer, kubeClient?: () => KubeClient): Promise<void> {
    const config = this.cfg = clone(config_);

    // Remove flannel config if necessary, before starting k3s
    if (!config.kubernetes.options.flannel) {
      await this.vm.execCommand({ root: true }, 'rm', '-f', '/etc/cni/net.d/10-flannel.conflist');
    }

    await this.progressTracker.action('Starting k3s', 100, async() => {
      // Run rc-update as we have dynamic dependencies.
      await this.vm.execCommand({ root: true }, '/sbin/rc-update', '--update');
      await this.vm.execCommand({ root: true }, '/sbin/rc-service', '--ifnotstarted', 'k3s', 'start');
    });

    const aborted = await this.progressTracker.action(
      'Waiting for Kubernetes API',
      100,
      async() => {
        await this.k3sHelper.waitForServerReady(() => Promise.resolve('127.0.0.1'), config.kubernetes.port);
        while (true) {
          if (this.vm.currentAction !== Action.STARTING) {
            // User aborted
            return true;
          }
          try {
            await this.vm.execCommand({ expectFailure: true }, 'ls', '/etc/rancher/k3s/k3s.yaml');
            break;
          } catch (ex) {
            console.log('Configuration /etc/rancher/k3s/k3s.yaml not present in lima vm; will check again...');
            await util.promisify(setTimeout)(1_000);
          }
        }
        console.debug('/etc/rancher/k3s/k3s.yaml is ready.');

        return false;
      },
    );

    if (aborted) {
      return;
    }
    await this.progressTracker.action(
      'Updating kubeconfig',
      50,
      this.k3sHelper.updateKubeconfig(
        () => this.vm.execCommand({ capture: true, root: true }, 'cat', '/etc/rancher/k3s/k3s.yaml'),
      ));

    const client = this.client = kubeClient?.() || new KubeClient();

    await this.progressTracker.action(
      'Waiting for services',
      50,
      async() => {
        await client.waitForServiceWatcher();
        client.on('service-changed', (services) => {
          this.emit('service-changed', services);
        });
        client.on('service-error', (service, errorMessage) => {
          this.emit('service-error', service, errorMessage);
        });
      },
    );

    this.activeVersion = kubernetesVersion;
    this.currentPort = config.kubernetes.port;
    this.emit('current-port-changed', this.currentPort);

    // Remove traefik if necessary.
    if (!this.cfg?.kubernetes?.options.traefik) {
      await this.progressTracker.action(
        'Removing Traefik',
        50,
        this.k3sHelper.uninstallHelmChart(client, 'traefik'));
    }
    if (!this.cfg?.experimental?.kubernetes?.options?.spinkube) {
      await this.progressTracker.action(
        'Removing spinkube operator',
        50,
        Promise.all([
          this.k3sHelper.uninstallHelmChart(client, MANIFEST_CERT_MANAGER),
          this.k3sHelper.uninstallHelmChart(client, MANIFEST_SPIN_OPERATOR),
        ]));
    }

    await this.progressTracker.action('Ensuring compatible kubectl', 50,
      this.k3sHelper.getCompatibleKubectlVersion(this.activeVersion));
    if (this.cfg?.kubernetes?.options.flannel) {
      await this.progressTracker.action(
        'Waiting for nodes',
        100,
        client.waitForReadyNodes());
    } else {
      await this.progressTracker.action(
        'Skipping node checks, flannel is disabled',
        100,
        async() => {
          await new Promise(resolve => setTimeout(resolve, 5000));
        });
    }
  }

  async stop() {
    if (this.cfg?.kubernetes?.enabled) {
      try {
        const script = 'if [ -e /etc/init.d/k3s ]; then /sbin/rc-service --ifstarted k3s stop; fi';

        await this.vm.execCommand({ root: true, expectFailure: true }, '/bin/sh', '-c', script);
      } catch (ex) {
        console.error('Failed to stop k3s while stopping kube backend: ', ex);
      }
    }
    await this.cleanup();
  }

  cleanup(): Promise<void> {
    this.client?.destroy();

    return Promise.resolve();
  }

  async reset() {
    await this.k3sHelper.deleteKubeState(this.vm);
  }

  cfg: BackendSettings | undefined;

  protected readonly arch:  Architecture;
  protected readonly vm:    LimaBackend;
  protected activeVersion?: semver.SemVer;

  /** The port Kubernetes is actively listening on. */
  protected currentPort = 0;

  /** Helper object to manage available K3s versions. */
  readonly k3sHelper: K3sHelper;

  protected client: KubeClient | null = null;

  private tempSullaWorkdir?: string;

  protected get progressTracker() {
    return this.vm.progressTracker;
  }

  get version(): ShortVersion {
    return this.activeVersion?.version ?? '';
  }

  get availableVersions(): Promise<SemanticVersionEntry[]> {
    return this.k3sHelper.availableVersions;
  }

  async cachedVersionsOnly(): Promise<boolean> {
    return await K3sHelper.cachedVersionsOnly();
  }

  get desiredPort() {
    return this.cfg?.kubernetes?.port ?? 6443;
  }

  protected get desiredVersion(): Promise<semver.SemVer | undefined> {
    return (async() => {
      let availableVersions: SemanticVersionEntry[];
      let available = true;

      try {
        availableVersions = await this.k3sHelper.availableVersions;

        return await BackendHelper.getDesiredVersion(
          this.cfg!,
          availableVersions,
          this.vm.noModalDialogs,
          this.vm.writeSetting.bind(this.vm));
      } catch (ex) {
        // Locked field errors are fatal and will quit the application
        if (ex instanceof LockedFieldError) {
          throw ex;
        }
        console.error(`Could not get desired version: ${ ex }`);
        available = false;

        return undefined;
      } finally {
        mainEvents.emit('diagnostics-event', { id: 'kube-versions-available', available });
      }
    })();
  }

  /**
   * Install K3s into the VM for execution.
   * @param version The version to install.
   */
  protected async installK3s(version: semver.SemVer) {
    const k3s = this.arch === 'aarch64' ? 'k3s-arm64' : 'k3s';

    await this.vm.execCommand('mkdir', '-p', 'bin');
    await this.vm.writeFile('bin/install-k3s', INSTALL_K3S_SCRIPT, 'a+x');
    await fs.promises.chmod(path.join(paths.cache, 'k3s', version.raw, k3s), 0o755);
    await this.vm.execCommand({ root: true }, 'bin/install-k3s', version.raw, path.join(paths.cache, 'k3s'));
  }

  /**
   * Write the openrc script for k3s.
   */
  protected async writeServiceScript(cfg: BackendSettings, desiredVersion: semver.SemVer, allowSudo: boolean) {
    const allPlatformsThresholdVersion = '1.31.0';
    const config: Record<string, string> = {
      PORT:            this.desiredPort.toString(),
      ENGINE:          cfg.containerEngine.name ?? ContainerEngine.NONE,
      ADDITIONAL_ARGS: `--node-ip ${ await this.vm.ipAddress }`,
      LOG_DIR:         paths.logs,
      USE_CRI_DOCKERD: BackendHelper.requiresCRIDockerd(cfg.containerEngine.name, desiredVersion.version).toString(),
      ALLPLATFORMS:    semver.lt(desiredVersion, allPlatformsThresholdVersion) ? '--all-platforms' : '',
    };

    if (os.platform() === 'darwin') {
      if (cfg.kubernetes.options.flannel) {
        const { iface, addr } = await this.vm.getListeningInterface(allowSudo);

        config.ADDITIONAL_ARGS += ` --flannel-iface ${ iface }`;
        if (addr) {
          config.ADDITIONAL_ARGS += ` --node-external-ip ${ addr }`;
        }
      } else {
        console.log(`Disabling flannel and network policy`);
        config.ADDITIONAL_ARGS += ' --flannel-backend=none --disable-network-policy';
      }
    }
    if (!cfg.kubernetes.options.traefik) {
      config.ADDITIONAL_ARGS += ' --disable traefik';
    }
    if (cfg.application.debug) {
      config.ADDITIONAL_ARGS += ' --debug';
    }
    await this.vm.writeFile('/etc/init.d/cri-dockerd', SERVICE_CRI_DOCKERD_SCRIPT, 0o755);
    await this.vm.writeConf('cri-dockerd', {
      LOG_DIR: paths.logs,
      ENGINE:  cfg.containerEngine.name ?? ContainerEngine.NONE,
    });
    await this.vm.writeFile('/etc/init.d/k3s', SERVICE_K3S_SCRIPT, 0o755);
    await this.vm.writeConf('k3s', config);
    await this.vm.writeFile('/etc/logrotate.d/k3s', LOGROTATE_K3S_SCRIPT);
  }

  async deleteIncompatibleData(desiredVersion: semver.SemVer) {
    const existingVersion = await K3sHelper.getInstalledK3sVersion(this.vm);

    if (!existingVersion) {
      return;
    }
    if (semver.gt(existingVersion, desiredVersion)) {
      await this.progressTracker.action(
        'Deleting incompatible Kubernetes state',
        100,
        this.k3sHelper.deleteKubeState(this.vm));
    }
  }

  async requiresRestartReasons(currentConfig: BackendSettings, desiredConfig: RecursivePartial<BackendSettings>, extra: ExtraRequiresReasons): Promise<RestartReasons> {
    // This is a placeholder to force this method to be async
    await Promise.all([]);

    return this.k3sHelper.requiresRestartReasons(
      currentConfig,
      desiredConfig,
      {
        'application.adminAccess': undefined,
      },
      extra,
    );
  }

  listServices(namespace?: string): K8s.ServiceEntry[] {
    return this.client?.listServices(namespace) || [];
  }

  async forwardPort(namespace: string, service: string, k8sPort: number | string, hostPort: number): Promise<number | undefined> {
    return await this.client?.forwardPort(namespace, service, k8sPort, hostPort);
  }

  async cancelForward(namespace: string, service: string, k8sPort: number | string): Promise<void> {
    await this.client?.cancelForwardPort(namespace, service, k8sPort);
  }

  async applySullaManifests(): Promise<void> {
    await this.applySullaManifestsInternal();
  }

  public async prepareSullaDeploymentFiles(): Promise<void> {
    this.tempSullaWorkdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sulla-deploy-'));
    const deploymentPath = path.join(this.tempSullaWorkdir, 'sulla-deployments.yaml');

    // Fetch settings from SullaSettingsModel
    const sullaServicePassword = await SullaSettingsModel.get('sullaServicePassword') || 'sulla_dev_password';
    const sullaN8nEncryptionKey = await SullaSettingsModel.get('sullaN8nEncryptionKey') || 'changeMeToA32CharRandomString1234';

    const deployments = (SULLA_DEPLOYMENTS as unknown[]).map((doc: unknown) => {
      const deployment = doc as Record<string, unknown>;
      if (deployment.kind === 'Deployment' && (deployment.metadata as Record<string, unknown>)?.name === 'postgres') {
        const spec = deployment.spec as Record<string, unknown>;
        const template = spec?.template as Record<string, unknown>;
        const podSpec = template?.spec as Record<string, unknown>;
        const containers = podSpec?.containers as Array<Record<string, unknown>>;
        if (containers?.[0]?.env) {
          containers[0].env = (containers[0].env as Array<any>).map((envVar: any) => {
            if (envVar.name === 'POSTGRES_PASSWORD' || envVar.name === 'DB_POSTGRESDB_PASSWORD') {
              envVar.value = sullaServicePassword;
            }
            return envVar;
          });
        }
      }
      if (deployment.kind === 'Deployment' && (deployment.metadata as Record<string, unknown>)?.name === 'n8n') {
        const spec = deployment.spec as Record<string, unknown>;
        const template = spec?.template as Record<string, unknown>;
        const podSpec = template?.spec as Record<string, unknown>;
        const containers = podSpec?.containers as Array<Record<string, unknown>>;
        if (containers?.[0]?.env) {
          containers[0].env = (containers[0].env as Array<any>).map((envVar: any) => {
            if (envVar.name === 'N8N_ENCRYPTION_KEY') {
              envVar.value = sullaN8nEncryptionKey;
            }
            if (envVar.name === 'N8N_USER_MANAGEMENT_JWT_SECRET') {
              envVar.value = sullaN8nEncryptionKey;
            }
            if (envVar.name === 'N8N_BASIC_AUTH_PASSWORD') {
              envVar.value = sullaServicePassword;
            }
            return envVar;
          });
        }
      }
      return deployment;
    });

    const yamlContent = deployments.map(doc => yaml.stringify(doc, { defaultStringType: 'QUOTE_DOUBLE' })).join('---\n');
    await fs.promises.writeFile(deploymentPath, yamlContent, 'utf-8');
    await this.vm.lima('copy', deploymentPath, `${ MACHINE_NAME }:/tmp/sulla-deployments.yaml`);
  }

  private async applySullaManifestsInternal(): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.vm.execCommand({ root: true }, 'k3s', 'kubectl', 'apply', '--server-side', '--force-conflicts', '-f', '/tmp/sulla-deployments.yaml');
        console.log(`Sulla Desktop deployments applied successfully (attempt ${ attempt })`);
        const status = await this.vm.execCommand({ root: true, capture: true }, 'k3s', 'kubectl', 'get', 'pods,svc', '-n', 'sulla', '-o', 'wide');
        console.log('Sulla pods/services:\n', status);
        break;
      } catch (err) {
        console.warn(`Sulla deployment attempt ${ attempt } failed:`, err);
        if (attempt === 3) {
          await this.logK8sDiagnostics('Deployment apply failed');
          throw err;
        }
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  private async waitForDeployment(name: string, timeoutSec: number = 600): Promise<void> {
    return this.waitForCondition(async () => {
      try {
        const status = await this.vm.execCommand({ capture: true, root: true }, 'k3s', 'kubectl', 'get', 'deployment', '-n', 'sulla', name, '-o', 'jsonpath={.status.availableReplicas}');
        return parseInt(status.trim()) > 0;
      } catch {
        return false;
      }
    }, timeoutSec);
  }

  private async waitForPodCondition(label: string, conditionType: string, expectedStatus: string, timeoutSec: number = 180): Promise<void> {
    return this.waitForCondition(async () => {
      try {
        const status = await this.vm.execCommand(
          { capture: true, root: true },
          'k3s', 'kubectl', 'get', 'pod', '-n', 'sulla',
          '-l', `app=${label}`,
          '-o', `jsonpath={.items[0].status.conditions[?(@.type=="${conditionType}")].status}`
        );
        return status.trim() === expectedStatus;
      } catch {
        return false;
      }
    }, timeoutSec);
  }

  private async waitForCondition(check: () => Promise<boolean>, timeoutSec: number = 120, intervalMs: number = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutSec * 1000) {
      if (await check()) return;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`Timeout waiting for condition after ${timeoutSec}s`);
  }

  private async logK8sDiagnostics(message: string): Promise<void> {
    console.error(message);
    try {
      const events = await this.vm.execCommand({ capture: true, root: true }, 'k3s', 'kubectl', 'get', 'events', '-n', 'sulla', '--sort-by=.metadata.creationTimestamp');
      console.log('Sulla namespace events:\n', events);
    } catch (e) {
      console.error('Failed to collect K8s diagnostics:', e);
    }
  }

  async sullaStepCustomEnvironment(): Promise<void> {
    // Reset progress counter at the start
    this.progressTracker.numeric('Starting Sulla deployment', 0, 100);

    await this.progressTracker.action('Preparing Sulla deployment files', 30, async () => {
      this.progressTracker.numeric('Preparing Sulla deployment files', 5, 100);
      await this.prepareSullaDeploymentFiles();
      this.progressTracker.numeric('Deployment files prepared', 15, 100);
    });

    await this.progressTracker.action('Applying Sulla manifests', 50, async () => {
      this.progressTracker.numeric('Applying Sulla manifests', 20, 100);
      await this.applySullaManifests();
      this.progressTracker.numeric('Manifests applied', 35, 100);
    });

    await this.progressTracker.action('Booting Virtual Container Environment...', 60, async () => {
      this.progressTracker.numeric('Booting Virtual Container Environment', 40, 100);
      const containers = ['ws-server', 'redis', 'postgres', 'n8n'];
      
      // Track each container individually
      for (const container of containers) {
        await this.progressTracker.action(`Downloading and Starting ${container}`, 100, async () => {
          await this.waitForDeployment(`${container}`, 600);
        });
      }
      this.progressTracker.numeric('Container environment booted', 60, 100);
    });

    this.progressTracker.numeric('Sulla deployment completed', 100, 100);

    instantiateSullaStart();

    mainEvents.emit('sulla-first-run-complete');
  }

  // #region Events
  eventNames(): (keyof K8s.KubernetesBackendEvents)[] {
    return super.eventNames() as (keyof K8s.KubernetesBackendEvents)[];
  }

  listeners<eventName extends keyof K8s.KubernetesBackendEvents>(
    event: eventName,
  ): K8s.KubernetesBackendEvents[eventName][] {
    return super.listeners(event) as K8s.KubernetesBackendEvents[eventName][];
  }

  rawListeners<eventName extends keyof K8s.KubernetesBackendEvents>(
    event: eventName,
  ): K8s.KubernetesBackendEvents[eventName][] {
    return super.rawListeners(event) as K8s.KubernetesBackendEvents[eventName][];
  }
  // #endregion
}
