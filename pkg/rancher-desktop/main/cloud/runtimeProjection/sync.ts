import { pushAgentProjection } from '@pkg/agent/tools/agents/cloudProjection';
import { cloudRequest, isCloudSignedIn } from '../cloudFetch';
import { pushWorkflowProjection } from './workflows';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
// Each check rebuilds both projections from Postgres; keep it modest.
const CHECK_MS = 15_000;
const FORCE_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
let lastHash = '';
let lastPush = 0;

async function upload(path: string, body: unknown): Promise<void> {
  const res = await cloudRequest('PUT', path, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`projection upload failed (${res.status})`);
}

async function snapshotHash(): Promise<string> {
  const [{ buildAgentProjection }, { buildWorkflowProjection }] = await Promise.all([
    import('@pkg/agent/tools/agents/cloudProjection'), import('./workflows'),
  ]);
  const [agents, workflows] = await Promise.all([buildAgentProjection(), buildWorkflowProjection()]);
  return JSON.stringify({ agents, workflows });
}

async function tick(force = false): Promise<void> {
  if (busy || !(await isCloudSignedIn())) return;
  busy = true;
  try {
    const hash = await snapshotHash();
    if (!force && hash === lastHash && Date.now() - lastPush < FORCE_MS) return;
    await Promise.all([pushWorkflowProjection(upload), pushAgentProjection(upload)]);
    lastHash = hash;
    lastPush = Date.now();
  } catch (error) {
    console.warn(`[CloudRuntimeProjection] ${error instanceof Error ? error.message : error}`);
  } finally { busy = false; }
}

export const CloudRuntimeProjectionSync = {
  start(): void { if (timer) return; void tick(true); timer = setInterval(() => { void tick(false) }, CHECK_MS); },
  stop(): void { if (timer) { clearInterval(timer); timer = null; } lastHash = ''; lastPush = 0; },
  changed(): void { void tick(false); },
};
