/**
 * @jest-environment node
 */
/* eslint-disable @typescript-eslint/require-await -- async mocks stand in for the docker CLI */
import { describe, expect, it, jest } from '@jest/globals';

import { dockerLinksFromPs, listDockerLinks, parsePublishedPorts } from '../dockerLinks';

const psLine = (Names: string, Ports: string, Labels = '', State = 'running') => JSON.stringify({ Names, Ports, Labels, State });

describe('parsePublishedPorts', () => {
  it('dedupes IPv4/IPv6 bindings and keeps the container port', () => {
    expect(parsePublishedPorts('0.0.0.0:6152->80/tcp, [::]:6152->80/tcp, 0.0.0.0:6153->443/tcp')).toEqual([
      { hostIp: '0.0.0.0', hostPort: 6152, containerPort: 80 },
      { hostIp: '0.0.0.0', hostPort: 6153, containerPort: 443 },
    ]);
  });

  it('ignores unpublished and UDP ports and expands (capped) ranges', () => {
    expect(parsePublishedPorts('9000/tcp, 0.0.0.0:53->53/udp')).toEqual([]);
    expect(parsePublishedPorts('127.0.0.1:8000-8002->9000-9002/tcp').map(p => [p.hostPort, p.containerPort])).toEqual([[8000, 9000], [8001, 9001], [8002, 9002]]);
    expect(parsePublishedPorts('0.0.0.0:1000-1999->1000-1999/tcp')).toHaveLength(20);
  });
});

describe('dockerLinksFromPs', () => {
  it('builds localhost links, skips databases and Sulla infrastructure, names multi-port containers', () => {
    const out = [
      psLine('www-sulladesktop', '0.0.0.0:5173->5173/tcp, [::]:5173->5173/tcp, 0.0.0.0:6152->80/tcp, 0.0.0.0:6153->443/tcp', 'com.docker.compose.project=www-sulladesktop,com.docker.compose.service=app'),
      psLine('ripplecore-frontend-react-dev', '0.0.0.0:5199->5199/tcp, [::]:5199->5199/tcp'),
      psLine('sulla_postgres', '0.0.0.0:30116->5432/tcp'),
      psLine('sulla_node_runtime', '127.0.0.1:30120->8080/tcp'),
      psLine('some-db', '0.0.0.0:15432->5432/tcp'),
      psLine('worker-no-ports', ''),
      psLine('stopped', '0.0.0.0:7000->7000/tcp', '', 'exited'),
      'not json',
    ].join('\n');

    expect(dockerLinksFromPs(out).map(l => [l.title, l.url, l.project])).toEqual([
      ['ripplecore-frontend-react-dev', 'http://localhost:5199/', null],
      ['www-sulladesktop :5173', 'http://localhost:5173/', 'www-sulladesktop'],
      ['www-sulladesktop :6152', 'http://localhost:6152/', 'www-sulladesktop'],
      ['www-sulladesktop :6153', 'https://localhost:6153/', 'www-sulladesktop'],
    ]);
  });
});

describe('listDockerLinks', () => {
  it('falls back to the VM when the host docker CLI fails', async() => {
    const run = jest.fn(async(_cmd: string, _args: string[], opts: any) => (opts.runInLimaShell
      ? { exitCode: 0, stdout: psLine('app', '0.0.0.0:3000->3000/tcp'), stderr: '' }
      : { exitCode: 127, stdout: '', stderr: 'docker: not found' }));

    const result = await listDockerLinks(run as any);

    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ available: true, links: [expect.objectContaining({ title: 'app', url: 'http://localhost:3000/' })] });
  });

  it('reports docker as unavailable when both attempts fail', async() => {
    const run = jest.fn(async() => ({ exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }));

    await expect(listDockerLinks(run as any)).resolves.toEqual({ available: false, links: [], error: 'Cannot connect to the Docker daemon' });
  });
});
