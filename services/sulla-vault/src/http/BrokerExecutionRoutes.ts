// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { LocalVaultAuthority } from '../localAuthority.js';
import type { VaultRequestInput } from './VaultRequestInput.js';

/** Brokered execution: buffered and streamed requests, and relay sessions (create, NDJSON events, send, close). */
export class BrokerExecutionRoutes {
  constructor(
    private readonly localAuthority: LocalVaultAuthority,
    private readonly input: VaultRequestInput,
  ) {}

  register(app: express.Express): void {
    const { localAuthority } = this;
    const { requiredString, serviceIdentity } = this.input;

    app.post('/v1/broker/execute', async(request, response) => {
      const identity = serviceIdentity(request);
      if (request.body?.operation !== 'clerk.backend') {
        response.json(await localAuthority.execute(request.body, identity.serviceId, identity.token));
        return;
      }
      const controller = new AbortController();
      response.once('close', () => controller.abort());
      response.json(await localAuthority.execute(request.body, identity.serviceId, identity.token, controller.signal));
    });
    app.post('/v1/broker/execute-stream', async(request, response) => {
      const identity = serviceIdentity(request);
      await localAuthority.executeStream(request.body, identity.serviceId, identity.token, {
        start: (status, headers) => { response.status(status); for (const [name, value] of Object.entries(headers)) response.setHeader(name, value); response.flushHeaders(); },
        write: chunk => response.write(chunk),
        onceDrain: callback => response.once('drain', callback),
        end: () => response.end(),
        destroy: error => response.destroy(error),
        onAbort: callback => response.once('close', callback),
      });
    });
    app.post('/v1/broker/relay/session', async(request, response) => {
      const identity = serviceIdentity(request);
      response.status(201).json(await localAuthority.createRelay(request.body, identity.serviceId, identity.token));
    });
    app.get('/v1/broker/relay/:relayId/events', async(request, response) => {
      const identity = serviceIdentity(request);
      const controller = new AbortController();
      request.once('close', () => controller.abort());
      response.status(200);
      response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.flushHeaders();
      for await (const event of localAuthority.relayEvents(
        requiredString(request.params.relayId, 'relayId'), identity.serviceId, identity.token, controller.signal,
      )) {
        if (controller.signal.aborted) break;
        if (!response.write(`${ JSON.stringify(event) }\n`)) {
          await new Promise<void>(resolve => response.once('drain', resolve));
        }
      }
      response.end();
    });
    app.post('/v1/broker/relay/:relayId/send', async(request, response) => {
      const identity = serviceIdentity(request);
      await localAuthority.sendRelay(
        requiredString(request.params.relayId, 'relayId'), request.body, identity.serviceId, identity.token,
      );
      response.status(204).end();
    });
    app.delete('/v1/broker/relay/:relayId', (request, response) => {
      const identity = serviceIdentity(request);
      localAuthority.closeRelay(requiredString(request.params.relayId, 'relayId'), identity.serviceId, identity.token);
      response.status(204).end();
    });
  }
}
