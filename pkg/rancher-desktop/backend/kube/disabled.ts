import events from 'events';

import { KubernetesBackend, KubernetesBackendEvents } from '../k8s';

import K3sHelper from '@pkg/backend/k3sHelper';

/**
 * Kubernetes is not available on the Sulla runtime; every operation is a no-op.
 */
export default class DisabledKubernetesBackend extends events.EventEmitter implements KubernetesBackend {
  readonly availableVersions = Promise.resolve([]);
  version = '';
  desiredPort = 9443;

  readonly k3sHelper = new K3sHelper('x86_64');

  cachedVersionsOnly(): Promise<boolean> {
    return Promise.resolve(false);
  }

  listServices() {
    return [];
  }

  forwardPort(namespace: string, service: string, k8sPort: number | string, hostPort: number): Promise<number | undefined> {
    return Promise.resolve(12345);
  }

  cancelForward(namespace: string, service: string, k8sPort: number | string): Promise<void> {
    return Promise.resolve();
  }

  download() {
    return Promise.resolve([undefined, false] as const);
  }

  deleteIncompatibleData() {
    return Promise.resolve();
  }

  install() {
    return Promise.resolve();
  }

  start() {
    return Promise.resolve();
  }

  stop() {
    return Promise.resolve();
  }

  cleanup() {
    return Promise.resolve();
  }

  reset() {
    return Promise.resolve();
  }

  requiresRestartReasons() {
    return Promise.resolve({});
  }

  // #region Events
  eventNames(): (keyof KubernetesBackendEvents)[] {
    return super.eventNames() as (keyof KubernetesBackendEvents)[];
  }

  listeners<eventName extends keyof KubernetesBackendEvents>(
    event: eventName,
  ): KubernetesBackendEvents[eventName][] {
    return super.listeners(event) as KubernetesBackendEvents[eventName][];
  }

  rawListeners<eventName extends keyof KubernetesBackendEvents>(
    event: eventName,
  ): KubernetesBackendEvents[eventName][] {
    return super.rawListeners(event) as KubernetesBackendEvents[eventName][];
  }
  // #endregion
}
