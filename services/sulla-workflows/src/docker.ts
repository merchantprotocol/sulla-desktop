import http from 'node:http';

export interface ContainerSpec {
  name: string;
  image: string;
  command?: string[];
  env?: Record<string, string>;
  labels?: Record<string, string>;
  network?: string;
  autoRemove?: boolean;
  binds?: string[];
  groupAdd?: string[];
}

interface DockerResponse<T> {
  status: number;
  body: T;
}

export class DockerApi {
  constructor(private readonly socketPath = '/var/run/docker.sock') {}

  private request<T>(method: string, requestPath: string, body?: unknown, rawBody?: Buffer): Promise<DockerResponse<T>> {
    return new Promise((resolve, reject) => {
      const payload = rawBody ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
      const request = http.request({
        socketPath: this.socketPath,
        path: requestPath,
        method,
        headers: payload ? {
          'Content-Type': rawBody ? 'application/x-tar' : 'application/json',
          'Content-Length': String(payload.length),
        } : undefined,
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try { parsed = text ? JSON.parse(text) : {}; } catch { /* Docker sometimes returns text */ }
          const status = response.statusCode ?? 500;
          if (status >= 400) reject(new Error(`Docker API ${ method } ${ requestPath } returned ${ status }: ${ text }`));
          else resolve({ status, body: parsed as T });
        });
      });
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  async create(spec: ContainerSpec): Promise<string> {
    const response = await this.request<{ Id: string }>('POST', `/containers/create?name=${ encodeURIComponent(spec.name) }`, {
      Image: spec.image,
      Cmd: spec.command,
      Env: Object.entries(spec.env ?? {}).map(([key, value]) => `${ key }=${ value }`),
      Labels: spec.labels,
      HostConfig: {
        AutoRemove: spec.autoRemove ?? false,
        NetworkMode: spec.network,
        Binds: spec.binds,
        GroupAdd: spec.groupAdd,
      },
    });
    return response.body.Id;
  }

  async start(id: string): Promise<void> {
    await this.request('POST', `/containers/${ encodeURIComponent(id) }/start`);
  }

  async inspect(id: string): Promise<any> {
    return (await this.request<any>('GET', `/containers/${ encodeURIComponent(id) }/json`)).body;
  }

  async upload(id: string, targetPath: string, archive: Buffer): Promise<void> {
    await this.request('PUT', `/containers/${ encodeURIComponent(id) }/archive?path=${ encodeURIComponent(targetPath) }`, undefined, archive);
  }

  async remove(id: string, force = true): Promise<void> {
    try {
      await this.request('DELETE', `/containers/${ encodeURIComponent(id) }?force=${ force ? '1' : '0' }&v=1`);
    } catch (error) {
      if (!String(error).includes('404')) throw error;
    }
  }
}
