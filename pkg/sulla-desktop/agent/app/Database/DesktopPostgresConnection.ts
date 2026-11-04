// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PostgresConnection } from '@sulla/foundation/postgres';

import type { Binding, Row } from '@sulla/foundation';
import type {
  PostgresClient as FoundationClient,
  PostgresQueryResult,
} from '@sulla/foundation/postgres';
import type { PostgresClient as DesktopClient } from '../../database/PostgresClient';

/** Adapts Desktop's existing pool owner to foundation's client contract. */
class DesktopFoundationClient implements FoundationClient {
  constructor(private readonly client: DesktopClient) {}

  async query<T = Row>(text: string, values?: readonly Binding[]): Promise<PostgresQueryResult<T>> {
    const result = await this.client.queryWithResult(text, [...(values ?? [])]);

    return { ...result, rows: result.rows as unknown as T[] };
  }
}

/** Adapts Desktop's existing pool owner to foundation without creating another pool. */
export class DesktopPostgresConnection extends PostgresConnection {
  constructor(client: DesktopClient) {
    super(new DesktopFoundationClient(client));
  }
}
