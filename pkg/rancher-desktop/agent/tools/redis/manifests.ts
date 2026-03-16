import type { ToolManifest } from '../registry';

export const redisToolManifests: ToolManifest[] = [
  {
    name:        'redis_decr',
    description: 'Decrement the integer value of a Redis key by one.',
    category:    'redis',
    schemaDef:   {
      key: { type: 'string', description: 'The Redis key to decrement' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./redis_decr'),
  },
  {
    name:        'redis_del',
    description: 'Delete one or more Redis keys.',
    category:    'redis',
    schemaDef:   {
      keys: { type: 'array', items: { type: 'string' }, description: 'The Redis keys to delete' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./redis_del'),
  },
  {
    name:        'redis_expire',
    description: 'Set a timeout on a Redis key.',
    category:    'redis',
    schemaDef:   {
      key:     { type: 'string', description: 'The Redis key to set expiration on' },
      seconds: { type: 'number', description: 'The expiration time in seconds' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./redis_expire'),
  },
  {
    name:        'redis_get',
    description: 'Get the value of a Redis key.',
    category:    'redis',
    schemaDef:   {
      key: { type: 'string', description: 'The Redis key to get' },
    },
    operationTypes: ['read'],
    loader:         () => import('./redis_get'),
  },
  {
    name:        'redis_hget',
    description: 'Get the value of a field in a Redis hash.',
    category:    'redis',
    schemaDef:   {
      key:   { type: 'string', description: 'The Redis hash key' },
      field: { type: 'string', description: 'The field in the hash' },
    },
    operationTypes: ['read'],
    loader:         () => import('./redis_hget'),
  },
  {
    name:        'redis_hgetall',
    description: 'Get all fields and values from a Redis hash.',
    category:    'redis',
    schemaDef:   {
      key: { type: 'string', description: 'The Redis hash key' },
    },
    operationTypes: ['read'],
    loader:         () => import('./redis_hgetall'),
  },
  {
    name:        'redis_hset',
    description: 'Set the value of a field in a Redis hash.',
    category:    'redis',
    schemaDef:   {
      key:   { type: 'string', description: 'The Redis hash key' },
      field: { type: 'string', description: 'The field in the hash' },
      value: { type: 'string', description: 'The value to set' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./redis_hset'),
  },
  {
    name:        'redis_incr',
    description: 'Increment the integer value of a Redis key by one.',
    category:    'redis',
    schemaDef:   {
      key: { type: 'string', description: 'The Redis key to increment' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./redis_incr'),
  },
  {
    name:        'redis_lpop',
    description: 'Remove and return the first element of a Redis list.',
    category:    'redis',
    schemaDef:   {
      key: { type: 'string', description: 'The Redis list key' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./redis_lpop'),
  },
  {
    name:        'redis_rpush',
    description: 'Append one or more values to a Redis list.',
    category:    'redis',
    schemaDef:   {
      key:    { type: 'string', description: 'The Redis list key' },
      values: { type: 'array', items: { type: 'string' }, description: 'The values to append' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./redis_rpush'),
  },
  {
    name:        'redis_set',
    description: 'Set the value of a Redis key.',
    category:    'redis',
    schemaDef:   {
      key:   { type: 'string', description: 'The Redis key to set' },
      value: { type: 'string', description: 'The value to set' },
      ttl:   { type: 'number', optional: true, description: 'Time to live in seconds' },
    },
    operationTypes: ['update'],
    loader:         () => import('./redis_set'),
  },
  {
    name:        'redis_ttl',
    description: 'Get the time to live (TTL) of a Redis key.',
    category:    'redis',
    schemaDef:   {
      key: { type: 'string', description: 'The Redis key to check TTL for' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./redis_ttl'),
  },
];
