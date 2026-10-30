// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import http from 'http';
import net from 'net';

import Logging from '@pkg/utils/logging';
import { resolveServicePort } from '@pkg/main/serviceDirectory';

const console = Logging.sullaRuntime;

// guest.sock stream selector for published-port forwarding (see the runtime's
// guest agent protocol); the guest dials 127.0.0.1:<port> where dockerd's
// userland proxy listens for every published port.
const FORWARD_STREAM_PORT = 2376;
const RECONNECT_DELAY_MS = 2_000;

interface ContainerPort {
  IP?:         string;
  PrivatePort: number;
  PublicPort?: number;
  Type:        string;
}

interface ContainerSummary { Names?: string[]; Ports?: ContainerPort[] }

/**
 * Makes published container ports reachable on the Mac. It follows Docker
 * over the runtime's docker.sock (one container listing, then the event
 * stream; no polling) and keeps one 127.0.0.1 listener per published TCP
 * port. Each accepted connection is relayed through guest.sock to the guest's
 * 127.0.0.1:<port>. Listeners bind loopback only, even for 0.0.0.0 publishes.
 */
export class SullaRuntimePortForwarder {
  readonly #listeners = new Map<number, net.Server>();
  readonly #servicePorts = new Map<string, number>();
  readonly #guestPorts = new Map<number, number>();
  // Ports another Mac process owns; retried once no container publishes them.
  readonly #unavailable = new Set<number>();
  #events: http.ClientRequest | undefined;
  #stopped = true;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #syncing: Promise<void> = Promise.resolve();

  constructor(private readonly dockerSocket: string, private readonly guestSocket: string) {}

  start(): void {
    this.#stopped = false;
    this.followEvents();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    this.#events?.destroy();
    this.#events = undefined;
    for (const [port, server] of this.#listeners) {
      server.close();
      this.#listeners.delete(port);
    }
    this.#unavailable.clear();
    this.#servicePorts.clear();
    this.#guestPorts.clear();
  }

  get forwardedPorts(): number[] {
    return [...this.#listeners.keys()].sort((a, b) => a - b);
  }

  protected followEvents(): void {
    if (this.#stopped) return;
    const filters = JSON.stringify({ type: ['container'], event: ['start', 'die', 'stop', 'kill', 'destroy', 'pause', 'unpause'] });
    const request = http.request({
      socketPath: this.dockerSocket,
      path:       `/events?filters=${ encodeURIComponent(filters) }`,
      method:     'GET',
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        this.reconnect(`events returned HTTP ${ response.statusCode }`);

        return;
      }
      // Listing after the stream is open means no change between the two is missed.
      this.scheduleSync();
      response.setEncoding('utf8');
      response.on('data', () => this.scheduleSync());
      response.on('end', () => this.reconnect('event stream ended'));
      response.on('error', error => this.reconnect(error.message));
    });

    request.on('error', error => this.reconnect(error.message));
    request.end();
    this.#events = request;
  }

  protected reconnect(reason: string): void {
    if (this.#stopped) return;
    this.#events?.destroy();
    this.#events = undefined;
    clearTimeout(this.#reconnectTimer);
    console.warn(`[sulla-runtime] port forwarding lost the Docker event stream (${ reason }); reconnecting`);
    this.#reconnectTimer = setTimeout(() => this.followEvents(), RECONNECT_DELAY_MS);
  }

  /** Serialize re-listings so a burst of events never reconciles out of order. */
  protected scheduleSync(): void {
    this.#syncing = this.#syncing.then(() => this.sync()).catch((error) => {
      console.warn('[sulla-runtime] could not list containers for port forwarding:', error);
    });
  }

  protected async sync(): Promise<void> {
    if (this.#stopped) return;
    const containers = await this.listContainers();
    const wanted = new Map<number, { guestPort: number; service: string }>();

    for (const container of containers) {
      for (const port of container.Ports ?? []) {
        if (port.Type === 'tcp' && port.PublicPort) {
          const service = this.serviceName(container.Names?.[0] ?? '', port.PrivatePort);
          const hostPort = await resolveServicePort(service, this.#servicePorts.get(service));
          wanted.set(hostPort, { guestPort: port.PublicPort, service });
        }
      }
    }
    for (const [port, server] of this.#listeners) {
      if (!wanted.has(port)) {
        server.close();
        this.#listeners.delete(port);
        this.#guestPorts.delete(port);
        for (const [service, servicePort] of this.#servicePorts) if (servicePort === port) this.#servicePorts.delete(service);
        console.log(`[sulla-runtime] stopped forwarding 127.0.0.1:${ port }`);
      }
    }
    for (const port of this.#unavailable) {
      if (!wanted.has(port)) this.#unavailable.delete(port);
    }
    for (const [port, target] of wanted) {
      if (this.#listeners.has(port) && this.#guestPorts.get(port) !== target.guestPort) {
        const existing = this.#listeners.get(port);
        if (existing) await new Promise<void>(resolve => existing.close(() => resolve()));
        this.#listeners.delete(port);
        this.#guestPorts.delete(port);
      }
      if (!this.#listeners.has(port) && !this.#unavailable.has(port)) this.listen(port, target.guestPort, target.service);
    }
  }

  protected listContainers(): Promise<ContainerSummary[]> {
    return new Promise((resolve, reject) => {
      const request = http.get({ socketPath: this.dockerSocket, path: '/containers/json' }, (response) => {
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${ response.statusCode }`));

            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      });

      request.on('error', reject);
    });
  }

  protected serviceName(containerName: string, privatePort: number): string {
    const clean = containerName.replace(/^\//, '').replace(/^sulla_/, '');
    const aliases: Record<string, string> = {
      workflow_manager: 'workflows',
      python_runtime: 'runtime-python',
      shell_runtime: 'runtime-shell',
      node_runtime: 'runtime-node',
    };
    return (aliases[clean] ?? clean) || `container-${ privatePort }`;
  }

  protected listen(port: number, guestPort: number, service: string): void {
    const server = net.createServer({ allowHalfOpen: true }, client => this.relay(client, guestPort));

    this.#listeners.set(port, server);
    this.#guestPorts.set(port, guestPort);
    this.#servicePorts.set(service, port);
    server.on('error', (error: NodeJS.ErrnoException) => {
      // Something else on the Mac owns the port; carry on without it.
      console.warn(`[sulla-runtime] cannot forward 127.0.0.1:${ port }: ${ error.code ?? error.message }`);
      if (this.#listeners.get(port) === server) {
        this.#listeners.delete(port);
        this.#guestPorts.delete(port);
        this.#servicePorts.delete(service);
        this.#unavailable.add(port);
        void resolveServicePort(service).then(() => {
          this.#unavailable.delete(port);
          this.scheduleSync();
        }).catch(resolveError => console.warn(`[ports] could not reassign ${ service }:`, resolveError));
      }
    });
    server.listen(port, '127.0.0.1', () => console.log(`[sulla-runtime] forwarding ${ service } on 127.0.0.1:${ port } -> guest:${ guestPort }`));
  }

  protected relay(client: net.Socket, port: number): void {
    const guest = net.connect({ path: this.guestSocket, allowHalfOpen: true });

    // Queued in order ahead of any client bytes.
    guest.write(`${ FORWARD_STREAM_PORT }\n${ JSON.stringify({ port }) }\n`);
    client.pipe(guest);
    guest.pipe(client);
    const destroy = () => {
      client.destroy();
      guest.destroy();
    };

    client.on('error', destroy);
    guest.on('error', destroy);
    client.on('close', () => guest.destroy());
    guest.on('close', () => client.destroy());
  }
}
