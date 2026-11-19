// SPDX-License-Identifier: GPL-2.0-or-later

export type ExecutionWaitReason = 'required services' | 'database' | 'recovery storage' | 'model configuration' | 'Password Vault' | 'vault unlock' | 'paused agents';
export const executionAbort = () => Object.assign(new Error('Agent execution interrupted'), { name: 'AbortError' });

/** Shared probes, independent cancellable waiters. Readiness is never cached across turns. */
export class AgentExecutionReadiness {
  private probe?: Promise<ExecutionWaitReason | undefined>;
  private shutdown = new AbortController();
  private runtimeActive = false;
  constructor(private readonly inspect: () => Promise<ExecutionWaitReason | undefined>, private readonly pollMs = 1000) {}

  get draining(): boolean { return this.shutdown.signal.aborted }
  get active(): boolean { return this.runtimeActive }
  activate(): void {
    if (this.draining) { this.shutdown = new AbortController(); this.probe = undefined }
    this.runtimeActive = true;
  }

  close(): void { this.shutdown.abort() }

  async wait(signal?: AbortSignal, waiting?: (reason: ExecutionWaitReason) => void): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    let last: ExecutionWaitReason | undefined;
    while (!combined.aborted) {
      const reason = await this.cancellable(this.check(), combined);
      if (combined.aborted) throw executionAbort();
      if (!reason) return;
      if (reason !== last) { waiting?.(reason); last = reason }
      await this.cancellable(new Promise<void>(resolve => { const timer = setTimeout(resolve, this.pollMs); timer.unref?.() }), combined);
    }
    throw executionAbort();
  }

  private check(): Promise<ExecutionWaitReason | undefined> {
    if (!this.probe) {
      let timer: ReturnType<typeof setTimeout>;
      const current = Promise.race([
        this.inspect(),
        new Promise<ExecutionWaitReason>(resolve => { timer = setTimeout(() => resolve('required services'), 6000); timer.unref?.() }),
      ]).finally(() => { clearTimeout(timer); if (this.probe === current) this.probe = undefined; });
      this.probe = current;
    }
    return this.probe;
  }

  private cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(executionAbort());
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
}

class VaultReadinessDiagnostics {
  private static lastFailure = '';
  static recovered(): void { this.lastFailure = '' }
  static failed(error: any): ExecutionWaitReason {
    // Never log messages, URLs, identities or response bodies from the broker.
    const category = error?.name === 'TimeoutError'
      ? 'timeout'
      : typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'connection';
    if (category !== this.lastFailure) console.warn('[AgentReadiness] Vault probe failed:', category);
    this.lastFailure = category;
    return category === 'vault_locked' ? 'vault unlock' : 'Password Vault';
  }
}

/** No provider inference: verify only the dependencies needed to admit a model turn. */
export const agentExecutionReadiness = new AgentExecutionReadiness(async() => {
  const { getServiceLifecycleManager } = await import('./ServiceLifecycleManager');
  const lifecycle = getServiceLifecycleManager();
  if (lifecycle.isShuttingDown()) throw executionAbort();
  if (!lifecycle.isStarted('database-manager')) return 'database';
  try {
    const { postgresClient } = await import('../database/PostgresClient');
    await postgresClient.query('SELECT 1');
  } catch { return 'database' }
  try {
    const { redisClient } = await import('../database/RedisClient');
    await redisClient.getClient().ping();
  } catch { return 'recovery storage' }
  try {
    const { configuredVaultBrokerProvider } = await import('@pkg/vault-broker');
    const status = await configuredVaultBrokerProvider.requireConfiguredCredentialBroker().status(AbortSignal.timeout(5000));
    VaultReadinessDiagnostics.recovered();
    if (!status.unlocked) return 'vault unlock';
  } catch (error: any) {
    return VaultReadinessDiagnostics.failed(error);
  }
  const { getModelProviderService } = await import('./ModelProviderService');
  return getModelProviderService().isInitialized() ? undefined : 'model configuration';
});

/** Automatic wakes respect the durable launch pause before claiming any work. */
export async function waitForAutomaticAgentExecution(signal?: AbortSignal, waiting?: (reason: ExecutionWaitReason) => void): Promise<void> {
  for (;;) {
    await agentExecutionReadiness.wait(signal, waiting);
    const { agentLaunchPauseService } = await import('./AgentLaunchPauseService');
    if (!await agentLaunchPauseService.isPaused()) return;
    waiting?.('paused agents');
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(executionAbort()) };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, 1000);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
