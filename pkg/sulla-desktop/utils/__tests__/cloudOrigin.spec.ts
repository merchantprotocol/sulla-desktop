/**
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
/**
 * cloudOrigin is dependency-free, so it runs directly with the Node test runner:
 * `node --experimental-strip-types --test pkg/sulla-desktop/utils/__tests__/cloudOrigin.spec.ts`. No install required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Node's strip-types runner requires the explicit TypeScript extension.
import { CloudOriginResolver, PRODUCTION_CLOUD_ORIGIN } from '../cloudOrigin.ts';

class RecordingLogger {
  infos: string[] = [];
  warnings: string[] = [];
  log(message: string) { this.infos.push(message) }
  warn(message: string) { this.warnings.push(message) }
}

function resolve(raw: string | undefined) {
  const logger = new RecordingLogger();
  const resolver = new CloudOriginResolver(raw, logger);
  resolver.announce();
  return { resolver, logger };
}

// risk: production behaviour. Unset env must keep today's exact origins and stay silent.
test('unset override uses the production origin, wss relay, and logs nothing', () => {
  const { resolver, logger } = resolve(undefined);
  assert.equal(resolver.httpOrigin, 'https://sulla-workers.merchantprotocol.workers.dev');
  assert.equal(resolver.relayOrigin, 'wss://sulla-workers.merchantprotocol.workers.dev');
  assert.equal(resolver.httpOrigin, PRODUCTION_CLOUD_ORIGIN);
  assert.deepEqual(logger.infos, []);
  assert.deepEqual(logger.warnings, []);
});

// risk: production behaviour. A blank env var must not count as an override.
test('blank or whitespace-only override is treated as unset', () => {
  for (const raw of ['', '   ']) {
    const { resolver, logger } = resolve(raw);
    assert.equal(resolver.httpOrigin, PRODUCTION_CLOUD_ORIGIN);
    assert.equal(resolver.selection.overridden, false);
    assert.deepEqual(logger.warnings, []);
  }
});

// risk: money-free but core config; a staging https origin must be used for HTTP and relay.
test('valid https override replaces the origin and derives a wss relay, logging once', () => {
  const { resolver, logger } = resolve('https://staging-workers.example.test');
  assert.equal(resolver.httpOrigin, 'https://staging-workers.example.test');
  assert.equal(resolver.relayOrigin, 'wss://staging-workers.example.test');
  assert.equal(logger.infos.length, 1);
  assert.match(logger.infos[0], /override active.*https:\/\/staging-workers\.example\.test/);
  assert.deepEqual(logger.warnings, []);
});

// risk: a trailing slash must not create a double slash in every request path.
test('https override with a trailing slash is normalised to a bare origin', () => {
  const { resolver } = resolve('  https://staging-workers.example.test/  ');
  assert.equal(resolver.httpOrigin, 'https://staging-workers.example.test');
});

// risk: wrangler dev runs on http localhost, so local overrides must work with ws, not wss.
test('http localhost and 127.0.0.1 overrides are accepted and use ws for the relay', () => {
  const local = resolve('http://localhost:8787');
  assert.equal(local.resolver.httpOrigin, 'http://localhost:8787');
  assert.equal(local.resolver.relayOrigin, 'ws://localhost:8787');
  assert.equal(local.logger.warnings.length, 0);

  const loopback = resolve('http://127.0.0.1:8787');
  assert.equal(loopback.resolver.httpOrigin, 'http://127.0.0.1:8787');
  assert.equal(loopback.resolver.relayOrigin, 'ws://127.0.0.1:8787');
});

// risk: security. Plain http to a real host would send bearer tokens in cleartext; it must fall back to prod.
test('plain http to a non-local host is rejected and falls back to production with one warning', () => {
  const { resolver, logger } = resolve('http://staging-workers.example.test');
  assert.equal(resolver.httpOrigin, PRODUCTION_CLOUD_ORIGIN);
  assert.equal(resolver.relayOrigin, 'wss://sulla-workers.merchantprotocol.workers.dev');
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /localhost or 127\.0\.0\.1/);
  assert.deepEqual(logger.infos, []);
});

// risk: invalid input must never reach fetch or the relay socket; each case falls back to production.
test('malformed, non-http, path-bearing and credentialed overrides fall back to production with a warning', () => {
  const invalid = [
    'not a url',
    'ftp://staging-workers.example.test',
    'wss://staging-workers.example.test',
    'https://staging-workers.example.test/api',
    'https://staging-workers.example.test?x=1',
    'https://staging-workers.example.test#frag',
    'https://user:secret@staging-workers.example.test',
  ];
  for (const raw of invalid) {
    const { resolver, logger } = resolve(raw);
    assert.equal(resolver.httpOrigin, PRODUCTION_CLOUD_ORIGIN, `expected fallback for ${ raw }`);
    assert.equal(resolver.selection.overridden, false, `expected not overridden for ${ raw }`);
    assert.equal(logger.warnings.length, 1, `expected one warning for ${ raw }`);
    assert.match(logger.warnings[0], /ignored/);
    assert.deepEqual(logger.infos, []);
  }
});

// risk: the secret-bearing URL must not be echoed in the warning, only the production fallback.
test('warning for a credentialed override does not echo the password', () => {
  const { logger } = resolve('https://user:hunter2@staging-workers.example.test');
  assert.equal(logger.warnings.length, 1);
  assert.equal(logger.warnings[0].includes('hunter2'), false);
});

// risk: relay socket scheme. https maps to wss and http maps to ws, and nothing else is rewritten.
test('toWebSocketOrigin maps https to wss and http to ws only', () => {
  assert.equal(CloudOriginResolver.toWebSocketOrigin('https://a.example.test'), 'wss://a.example.test');
  assert.equal(CloudOriginResolver.toWebSocketOrigin('http://localhost:8787'), 'ws://localhost:8787');
  assert.equal(CloudOriginResolver.toWebSocketOrigin('https://sulla-workers.dev/x-https'), 'wss://sulla-workers.dev/x-https');
});
