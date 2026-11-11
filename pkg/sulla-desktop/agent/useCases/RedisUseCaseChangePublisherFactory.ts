// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { redisClient } from '../database/RedisClient';

import { RedisUseCaseChangeTransport, UseCaseChangeAnnouncer, type UseCaseChangePublisher } from './UseCaseChangeBus';

/**
 * Builds the default post-commit publisher for one write. Stateless: callers
 * create one per operation (or inject their own), so no publisher instance is
 * retained in module or class state. It rides the app's existing Redis client.
 */
export class RedisUseCaseChangePublisherFactory {
  create(): UseCaseChangePublisher { return new UseCaseChangeAnnouncer(new RedisUseCaseChangeTransport(redisClient)) }
}
