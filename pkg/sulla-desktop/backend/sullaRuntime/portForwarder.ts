// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import http from 'http';
import net from 'net';

import Logging from '@pkg/utils/logging';
import { describePortOwner } from '@pkg/utils/portOwner';

const console = Logging.sullaRuntime;

// guest.sock stream selector for published-port forwarding (see the runtime's
// guest agent protocol); the guest dials 127.0.0.1:<port> where dockerd's
// userland proxy listens for every published port.
const FORWARD_STREAM_PORT = 2376;
const RECONNECT_DELAY_MS = 2_000;
/** How often a port another Mac process held is tried again. */
const UNAVAILABLE_RETRY_MS = 30_000;

interface ContainerPort {
  IP?:         string;
  PrivatePort: number;
  PublicPort?: number;
  Type:        string;
}

/**
 * Makes published container ports reachable on the Mac. It follows Docker
 * over the runtime's docker.sock (one container listing, then the event
 * stream; no polling) and keeps one 127.0.0.1 listener per published TCP
 * port. Each accepted connection is relayed through guest.sock to the guest's
 * 127.0.0.1:<port>. Listeners bind loopback only, even for 0.0.0.0 publishes.
 */
export class SullaRuntimePortForwarder {
  readonly #listeners = new Map<number, net.Server>();
  // Ports another Mac process owns; retried every 30s while a container publishes them.
  readonly #unavailable = new Set<number>();
  #events: http.ClientRequest | undefined;
  #stopped = true;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #retryTimer: NodeJS.Timeout | undefined;
  #syncing: Promise<void> = Promise.resolve();

  constructor(private readonly dockerSocket: string, private readonly guestSocket: string) {}

  start(): void {
    this.#stopped = false;
    this.followEvents();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#events?.destroy();
    this.#events = undefined;
    for (const [port, server] of this.#listeners) {
      server.close();
      this.#listeners.delete(port);
    }
    this.#unavailable.clear();
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
    const wanted = new Set<number>();

    for (const container of containers) {
      for (const port of container.Ports ?? []) {
        if (port.Type === 'tcp' && port.PublicPort) wanted.add(port.PublicPort);
      }
    }
    for (const [port, server] of this.#listeners) {
      if (!wanted.has(port)) {
        server.close();
        this.#listeners.delete(port);
        console.log(`[sulla-runtime] stopped forwarding 127.0.0.1:${ port }`);
      }
    }
    for (const port of this.#unavailable) {
      if (!wanted.has(port)) this.#unavailable.delete(port);
    }
    for (const port of wanted) {
      if (!this.#listeners.has(port) && !this.#unavailable.has(port)) this.listen(port);
    }
  }

  protected listContainers(): Promise<Array<{ Ports?: ContainerPort[] }>> {
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

  protected listen(port: number): void {
    const server = net.createServer({ allowHalfOpen: true }, client => this.relay(client, port));

    this.#listeners.set(port, server);
    server.on('error', (error: NodeJS.ErrnoException) => {
      // Something else on the Mac owns the port; carry on without it and try again later.
      void describePortOwner(port).then(owner => console.warn(
        `[sulla-runtime] cannot forward 127.0.0.1:${ port }: ${ error.code ?? error.message }${ owner ? `; it is used by ${ owner }` : '' }`));
      if (this.#listeners.get(port) === server) {
        this.#listeners.delete(port);
        this.#unavailable.add(port);
        this.scheduleUnavailableRetry();
      }
    });
    server.listen(port, '127.0.0.1', () => console.log(`[sulla-runtime] forwarding 127.0.0.1:${ port }`));
  }

  /** Try the ports another process held again in 30s; sync drops the ones no longer wanted. */
  protected scheduleUnavailableRetry(): void {
    if (this.#retryTimer || this.#stopped) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#stopped || !this.#unavailable.size) return;
      this.#unavailable.clear();
      this.scheduleSync();
    }, UNAVAILABLE_RETRY_MS);
    this.#retryTimer.unref?.();
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
