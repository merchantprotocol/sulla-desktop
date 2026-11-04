// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FallbackThreadStateRepository, LogRecoveryThreadStateRepository, MemoryThreadStateRepository,
  RedisThreadStateRepository } from '../Repositories/ThreadStateRepository';
import { redisClient } from '../../database/RedisClient';
import { ConversationHistoryModel } from '../../database/models/ConversationHistoryModel';

export class ThreadStateServiceProvider {
  readonly memory = new MemoryThreadStateRepository();
  readonly redis = new RedisThreadStateRepository(redisClient.getClient());
  readonly recovery = new LogRecoveryThreadStateRepository(ConversationHistoryModel);
  readonly repository = new FallbackThreadStateRepository(this.redis, this.memory, this.recovery, console);
}
export const threadStateProvider = new ThreadStateServiceProvider();
