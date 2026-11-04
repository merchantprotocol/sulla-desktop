// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PostgresConnection } from '@sulla/foundation/postgres';

import type { PostgresClient as DesktopClient } from '../../database/PostgresClient';

/** Adapts Desktop's existing pool owner to foundation without creating another pool. */
export class DesktopPostgresConnection extends PostgresConnection {
  constructor(client: DesktopClient) {
    super({ query: (sql, bindings) => client.queryWithResult(sql, [...(bindings ?? [])]) });
  }
}
