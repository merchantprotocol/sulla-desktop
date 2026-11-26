// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'node:path';

import { redisClient } from '../../database/RedisClient';
import { ConversationHistoryModel } from '../../database/models/ConversationHistoryModel';
import { resolveSullaHomeDir } from '../../utils/sullaPaths';
import {
  FallbackThreadStateRepository, FileThreadCheckpointRepository, LogRecoveryThreadStateRepository,
  MemoryThreadStateRepository, RedisThreadStateRepository,
} from '../Repositories/ThreadStateRepository';

export class ThreadStateServiceProvider {
  readonly memory = new MemoryThreadStateRepository();
  readonly redis = new RedisThreadStateRepository(redisClient);
  readonly recovery = new LogRecoveryThreadStateRepository(ConversationHistoryModel);
  readonly repository = new FallbackThreadStateRepository(
    this.redis, this.memory, this.recovery, console,
    new FileThreadCheckpointRepository(() => path.join(resolveSullaHomeDir(), 'thread-checkpoints')),
  );
}
export const threadStateProvider = new ThreadStateServiceProvider();
