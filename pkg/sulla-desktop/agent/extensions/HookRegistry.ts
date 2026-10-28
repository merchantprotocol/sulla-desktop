// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Stable Extension Contract v1 hook runtime. Extensions never receive vault material. */
export const EXTENSION_HOOKS = {
  before_tool_call: 'filter', after_tool_call: 'action', before_model_call: 'filter', after_model_response: 'action',
  on_user_message: 'action', on_memory_write: 'action', on_workflow_node_start: 'action', on_workflow_node_finish: 'action',
  on_agent_job_start: 'action', on_agent_job_finish: 'action',
} as const;
export type ExtensionHookName = keyof typeof EXTENSION_HOOKS;
export interface HookDecision<T> { value: T; denied?: boolean; reason?: string }
export interface HookAuditEvent { extensionId: string; hook: ExtensionHookName; outcome: 'ok'|'denied'|'error'|'timeout'|'permission_denied'; durationMs: number; timestamp: number; detail?: string }
export interface HookRegistration<T = unknown> { extensionId: string; hook: ExtensionHookName; priority?: number; timeoutMs?: number; handler: (value: Readonly<T>) => unknown | Promise<unknown> }
export interface HookRegistryOptions { granted?: (extensionId: string, hook: ExtensionHookName) => boolean | Promise<boolean>; audit?: (event: HookAuditEvent) => void; defaultTimeoutMs?: number }

const SECRET_KEY = /(?:secret|token|password|credential|api[_-]?key|private[_-]?key|authorization|cookie)/i;
const REDACTED = '[REDACTED]';
export function redactHookPayload<T>(input: T): T {
  const seen = new WeakSet<object>();
  const walk = (value: any): any => {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(walk);
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, SECRET_KEY.test(key) ? REDACTED : walk(val)]));
  };
  return walk(input);
}

/** Restore protected fields from core input. A hook can neither read nor replace them. */
function restoreRedacted<T>(candidate: T, original: T): T {
  const walk = (next: any, source: any, key?: string): any => {
    if (key && SECRET_KEY.test(key)) return source;
    if (next === REDACTED) return source;
    if (Array.isArray(next) && Array.isArray(source)) return next.map((item, i) => walk(item, source[i]));
    if (next && source && typeof next === 'object' && typeof source === 'object') {
      return Object.fromEntries(Object.entries(next).map(([childKey, value]) => [childKey, walk(value, source[childKey], childKey)]));
    }
    return next;
  };
  return walk(candidate, original);
}

export class HookRegistry {
  private readonly entries = new Map<ExtensionHookName, HookRegistration[]>();
  constructor(private readonly options: HookRegistryOptions = {}) {}
  register<T>(registration: HookRegistration<T>): () => void {
    if (!(registration.hook in EXTENSION_HOOKS)) throw new Error(`Unknown extension hook: ${ registration.hook }`);
    const list = this.entries.get(registration.hook) ?? [];
    list.push(registration as HookRegistration);
    list.sort((a, b) => (a.priority ?? 10) - (b.priority ?? 10));
    this.entries.set(registration.hook, list);
    return () => this.entries.set(registration.hook, list.filter(entry => entry !== registration));
  }
  clear(): void { this.entries.clear() }
  async runAction<T>(hook: ExtensionHookName, payload: T): Promise<void> {
    for (const entry of this.entries.get(hook) ?? []) await this.invoke(entry, redactHookPayload(payload));
  }
  async runFilter<T>(hook: ExtensionHookName, initial: T): Promise<HookDecision<T>> {
    const entries = this.entries.get(hook) ?? [];
    // Critical identity path: core data is not cloned or redacted when no hook can run.
    if (entries.length === 0) return { value: initial };
    let value = initial;
    for (const entry of entries) {
      const outcome = await this.invoke(entry, redactHookPayload(value));
      if (!outcome.called) continue;
      const result = outcome.result as any;
      if (result?.denied === true || result?.allow === false) return { value, denied: true, reason: String(result.reason || `Denied by ${ entry.extensionId }`) };
      const candidate = result && typeof result === 'object' && 'value' in result ? result.value : result;
      if (candidate !== undefined) value = restoreRedacted(candidate, value);
    }
    return { value };
  }
  private async invoke(entry: HookRegistration, payload: unknown): Promise<{ called: boolean; result?: unknown }> {
    const started = Date.now();
    // No grant provider means no permission. The exported singleton is therefore deny-by-default.
    if (!this.options.granted || !await this.options.granted(entry.extensionId, entry.hook)) {
      this.audit(entry, 'permission_denied', started, 'Hook was not granted by the user');
      return { called: false };
    }
    const timeoutMs = Math.max(1, entry.timeoutMs ?? this.options.defaultTimeoutMs ?? 1_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(entry.handler(payload)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HOOK_TIMEOUT')), timeoutMs) }),
      ]);
      this.audit(entry, (result as any)?.denied === true || (result as any)?.allow === false ? 'denied' : 'ok', started);
      return { called: true, result };
    } catch (error) {
      const timeout = error instanceof Error && error.message === 'HOOK_TIMEOUT';
      this.audit(entry, timeout ? 'timeout' : 'error', started, timeout ? `Exceeded ${ timeoutMs }ms` : String(error));
      return { called: false };
    } finally { if (timer) clearTimeout(timer) }
  }
  private audit(entry: HookRegistration, outcome: HookAuditEvent['outcome'], started: number, detail?: string): void {
    const event = { extensionId: entry.extensionId, hook: entry.hook, outcome, durationMs: Date.now() - started, timestamp: Date.now(), detail };
    try { this.options.audit?.(event) } catch { /* audit sinks never affect core */ }
    try { console.info('[ExtensionHookAudit]', JSON.stringify(event)) } catch { /* best-effort */ }
  }
}

async function persistedGrant(extensionId: string, hook: ExtensionHookName): Promise<boolean> {
  const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
  const grants = await SullaSettingsModel.get('extensionHookGrants', {});
  return grants?.[extensionId]?.[hook] === true;
}
const AUDIT_LIMIT = 500;
const auditListeners = new Set<(event: HookAuditEvent) => void>();
export function onExtensionHookAudit(listener: (event: HookAuditEvent) => void): () => void { auditListeners.add(listener); return () => auditListeners.delete(listener); }
let auditWrite = Promise.resolve();
async function persistAuditEvent(event: HookAuditEvent): Promise<void> {
  const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
  const current = await SullaSettingsModel.get('extensionHookAuditEvents', []);
  await SullaSettingsModel.set('extensionHookAuditEvents', [...(current || []), event].slice(-AUDIT_LIMIT), 'json');
}
function queueAuditEvent(event: HookAuditEvent): void {
  for (const listener of auditListeners) { try { listener(event) } catch { /* listeners never affect hooks */ } }
  auditWrite = auditWrite.then(() => persistAuditEvent(event)).catch(error => console.warn('[ExtensionHookAudit] Could not persist event', error));
}
export async function listExtensionHookAuditEvents(): Promise<HookAuditEvent[]> {
  const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
  return await SullaSettingsModel.get('extensionHookAuditEvents', []);
}
export const extensionHooks = new HookRegistry({ granted: persistedGrant, audit: queueAuditEvent });

/** Persist the user's install/first-use decision for one extension hook. */
export async function setExtensionHookGrant(extensionId: string, hook: ExtensionHookName, granted: boolean): Promise<void> {
  const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
  const grants = await SullaSettingsModel.get('extensionHookGrants', {});
  await SullaSettingsModel.set('extensionHookGrants', {
    ...(grants || {}),
    [extensionId]: { ...(grants?.[extensionId] || {}), [hook]: granted },
  }, 'json');
}
