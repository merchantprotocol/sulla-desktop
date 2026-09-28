// dockerLinks.ts — turn running Docker containers into browsable links for
// the Bookmarks pane's live "Docker" section. Nothing here is persisted: the
// list is rebuilt from `docker ps` each time the pane asks.

import { runCommand } from '@pkg/agent/tools/util/CommandRunner';

export interface DockerLink {
  id:        string;
  container: string;
  project:   string | null;
  title:     string;
  url:       string;
  hostPort:  number;
}

export interface DockerLinksResult {
  available: boolean;
  links:     DockerLink[];
  error?:    string;
}

// Container ports that are almost never something to open in a browser
// (databases, caches, brokers, ssh/mail).
const NON_HTTP_PORTS = new Set([
  21, 22, 23, 25, 53, 110, 143, 389, 465, 587, 993, 995,
  1433, 1521, 2375, 2376, 3306, 5432, 5672, 6379, 6380, 9042, 11211, 27017, 27018, 26257,
]);
const HTTPS_PORTS = new Set([443, 8443, 9443]);
// Sulla's own infrastructure containers (postgres, redis, runtimes) aren't
// the user's projects.
const INTERNAL_PREFIX = /^sulla_/;
const MAX_RANGE = 20;

interface PublishedPort {
  hostIp:        string;
  hostPort:      number;
  containerPort: number;
}

/**
 * Parse docker's Ports column, e.g.
 *   "0.0.0.0:6152->80/tcp, [::]:6152->80/tcp, 127.0.0.1:8000-8001->8000-8001/tcp, 9000/tcp"
 * Only published TCP ports are returned, deduplicated by host port.
 */
export function parsePublishedPorts(ports: string): PublishedPort[] {
  const out: PublishedPort[] = [];
  const seen = new Set<number>();

  for (const raw of (ports || '').split(',')) {
    const m = /^\s*(\[[^\]]*\]|[^:\s]*):(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(tcp|udp|sctp)\s*$/.exec(raw);
    if (m?.[6] !== 'tcp') continue;
    const [, hostIp, hStart, hEnd, cStart] = m;
    const first = Number(hStart);
    const last = Math.min(Number(hEnd || hStart), first + MAX_RANGE - 1);
    for (let hostPort = first; hostPort <= last; hostPort++) {
      if (seen.has(hostPort)) continue;
      seen.add(hostPort);
      out.push({ hostIp, hostPort, containerPort: Number(cStart) + (hostPort - first) });
    }
  }

  return out;
}

function composeLabel(labels: string, key: string): string | null {
  for (const part of (labels || '').split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === key) return part.slice(eq + 1) || null;
  }

  return null;
}

/** Convert `docker ps --format '{{json .}}'` output into links. */
export function dockerLinksFromPs(stdout: string): DockerLink[] {
  const links: DockerLink[] = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const container = String(row.Names || '').split(',')[0];
    if (!container || container.startsWith('sulla_')) continue;
    if (row.State && row.State !== 'running') continue;

    const ports = parsePublishedPorts(String(row.Ports || ''))
      .filter(p => !NON_HTTP_PORTS.has(p.containerPort));
    const project = composeLabel(String(row.Labels || ''), 'com.docker.compose.project');

    for (const p of ports) {
      const scheme = HTTPS_PORTS.has(p.containerPort) ? 'https' : 'http';
      links.push({
        id:        `docker:${ container }:${ p.hostPort }`,
        container,
        project,
        title:     ports.length > 1 ? `${ container } :${ p.hostPort }` : container,
        url:       `${ scheme }://localhost:${ p.hostPort }/`,
        hostPort:  p.hostPort,
      });
    }
  }

  return links.sort((a, b) => a.container.localeCompare(b.container) || a.hostPort - b.hostPort);
}

type Runner = typeof runCommand;

/**
 * List links for running containers. Tries the host docker CLI first (it
 * talks to the VM's daemon through the forwarded socket), then the VM.
 */
export async function listDockerLinks(run: Runner = runCommand): Promise<DockerLinksResult> {
  const args = ['ps', '--format', '{{json .}}'];
  const opts = { timeoutMs: 10_000, maxOutputChars: 500_000 };
  let res = await run('docker', args, opts);
  if (res.exitCode !== 0) {
    res = await run('docker', args, { ...opts, runInLimaShell: true });
  }
  if (res.exitCode !== 0) {
    return { available: false, links: [], error: (res.stderr || res.stdout || 'docker ps failed').trim().slice(0, 300) };
  }

  return { available: true, links: dockerLinksFromPs(res.stdout) };
}
