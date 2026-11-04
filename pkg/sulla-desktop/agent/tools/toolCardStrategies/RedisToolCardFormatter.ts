// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class RedisToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  redis_get(args) { return { label: 'Redis', summary: `Getting ${ text.string(args.key) }` } },
  redis_set(args) { return { label: 'Redis', summary: `Setting ${ text.string(args.key) }` } },
  redis_del(args) {
    const keys = Array.isArray(args.keys) ? args.keys : [];
    return { label: 'Redis', summary: `Deleting ${ keys.length } key${ keys.length === 1 ? '' : 's' }` };
  },
  redis_hget(args) { return { label: 'Redis', summary: `Getting ${ text.string(args.key) }.${ text.string(args.field) }` } },
  redis_hgetall(args) { return { label: 'Redis', summary: `Getting all fields of ${ text.string(args.key) }` } },
  redis_hset(args) { return { label: 'Redis', summary: `Setting ${ text.string(args.key) }.${ text.string(args.field) }` } },
  redis_incr(args) { return { label: 'Redis', summary: `Incrementing ${ text.string(args.key) }` } },
  redis_decr(args) { return { label: 'Redis', summary: `Decrementing ${ text.string(args.key) }` } },
  redis_lpop(args) { return { label: 'Redis', summary: `Popping from ${ text.string(args.key) }` } },
  redis_rpush(args) { return { label: 'Redis', summary: `Appending to ${ text.string(args.key) }` } },
  redis_expire(args) { return { label: 'Redis', summary: `Setting TTL on ${ text.string(args.key) }` } },
  redis_ttl(args) { return { label: 'Redis', summary: `Checking TTL of ${ text.string(args.key) }` } },
    });
  }
}
