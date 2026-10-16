import Logging from '@pkg/utils/logging';

const console = Logging.background;
const DEFAULT_URL = 'http://127.0.0.1:30122';

export class WorkflowManagerClient {
  private lastHealth: { healthy: boolean; checkedAt: number } | null = null;

  constructor(private readonly baseUrl = process.env.SULLA_WORKFLOW_MANAGER_URL ?? DEFAULT_URL) {}

  async isHealthy(force = false): Promise<boolean> {
    if (!force && this.lastHealth && Date.now() - this.lastHealth.checkedAt < 2_000) return this.lastHealth.healthy;
    let healthy = false;
    try {
      const response = await fetch(`${ this.baseUrl }/healthz`, { signal: AbortSignal.timeout(1_000) });
      healthy = response.ok && (await response.json() as any).ok === true;
    } catch { /* container unavailable */ }
    this.lastHealth = { healthy, checkedAt: Date.now() };
    return healthy;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${ this.baseUrl }${ path }`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(json.error ?? `Workflow manager returned HTTP ${ response.status }`);
    return json as T;
  }

  async startRun(input: Record<string, unknown>): Promise<any> {
    return this.request('POST', '/v1/runs', input);
  }

  logFallback(operation: string, error?: unknown): void {
    console.error(`[WorkflowManagerClient] CONTAINER UNAVAILABLE — falling back to in-process ${ operation }. ` +
      'This path exists for Desktop startup recovery only; schedules must never run in both places.', error ?? '');
  }
}

let instance: WorkflowManagerClient | null = null;
export function getWorkflowManagerClient(): WorkflowManagerClient {
  instance ??= new WorkflowManagerClient();
  return instance;
}
