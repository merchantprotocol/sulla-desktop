// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { TracePayloadRedactor } from './TracePayloadRedactor';

describe('TracePayloadRedactor', () => {
  const redactor = new TracePayloadRedactor();
  it('redacts credentials and tokens in every text field', () => {
    // risk: secret disclosure — trace fields are all user-visible.
    const text = 'Bearer abc slack_bot_token=xoxb-12345678 sk-live-secret ghp_12345678 password=hunter2';
    expect(redactor.redactText(text)).not.toMatch(/abc|xoxb|sk-live|ghp_|hunter2/);
  });
  it('redacts env-style, YAML, JSON, and CLI secret assignments', () => {
    // risk: secret disclosure — common credential key names must fail closed at any prefix.
    const text = 'DB_PASSWORD=x AWS_SECRET_ACCESS_KEY=x export STRIPE_SECRET_KEY="x" GITHUB_TOKEN: x {\"apiKey\": \"x\"} --api-key x --token=x';
    expect(redactor.redactText(text)).not.toMatch(/DB_PASSWORD|AWS_SECRET_ACCESS_KEY|STRIPE_SECRET_KEY|GITHUB_TOKEN|apiKey|--api-key x|--token=x|\bx\b/);
  });
  it('redacts connection query and mysql attached password parameters without treating ls -p as a secret', () => {
    // risk: secret disclosure — credentials often occur outside URL userinfo.
    expect(redactor.redactText('postgres://host/db?password=hunter2&token=abc;Password=xyz;')).not.toMatch(/hunter2|abc|xyz/);
    expect(redactor.redactText('mysql -uroot -phunter2 ls -p')).not.toContain('hunter2');
    expect(redactor.redactText('ls -p')).toBe('ls -p');
  });
  it('handles long hostile input without pathological regex backtracking', () => {
    // risk: renderer denial of service from untrusted trace text.
    const started = performance.now();
    redactor.redactText('A'.repeat(200_000) + ' PASSWORD=' + 'x'.repeat(200_000));
    expect(performance.now() - started).toBeLessThan(200);
  });

  it.each([
    ['Bash', 'cat .env'],
    ['exec_command', 'cat .env.local'],
    ['run_terminal_cmd', 'cat .aws/credentials'],
    ['terminal/exec', 'cat ~/.ssh/id_ed25519'],
    ['sulla meta/exec', 'cat ./service.pem'],
    ['local_shell', 'cat credentials.key'],
  ])('fails closed regardless of tool name (%s)', (_tool, command) => {
    // risk: secret disclosure — every tool surface can expose command output.
    expect(redactor.isSensitiveCommand(command, _tool)).toBe(true);
  });

  it.each([
    { command: 'cat .env' },
    { cmd: ['grep', 'TOKEN', '.env.production'] },
    { args: ['base64', '.ssh/id_rsa'] },
  ])('detects structured command input %o', input => {
    // risk: secret disclosure — tool adapters encode commands in object and array inputs.
    expect(redactor.isSensitiveCommand(input, 'any-tool')).toBe(true);
  });

  it.each([
    'less .env', 'more .env.local', 'head -n 2 config/.env', 'tail config/.env', 'bat .env',
    'grep TOKEN .env', 'rg SECRET .env.production', 'awk 1 .env', 'sed -n 1p .env',
    'source .env', '. .env', 'xxd .ssh/id_rsa', 'base64 service.pem', 'cp .env backup', 'scp .env host:/tmp',
    'env', 'printenv', 'set', 'export -p', 'docker inspect app', 'kubectl get secret app',
    'security find-generic-password -s app', 'op read op://vault/item/password', 'gh auth token',
    'aws configure get aws_access_key_id', 'gcloud auth print-access-token',
    'cat .npmrc', 'cat .netrc', 'cat .pgpass', 'cat .git-credentials', 'cat .docker/config.json', 'cat kubeconfig',
  ])('detects secret reader command %s', command => {
    // risk: secret disclosure — credential readers must never reach the detailed trace.
    expect(redactor.isSensitiveCommand(command, 'unrelated-tool')).toBe(true);
  });

  it('does not classify ordinary words as secret readers', () => {
    expect(redactor.isSensitiveCommand('print the environment settings', 'safe-tool')).toBe(false);
  });

  it('fails closed for sensitive tools and caps serialized payloads', () => {
    // risk: wallet/vault disclosure and unbounded renderer payloads.
    expect(redactor.serialize({ input: 'private' }, 'vault/read')).toBe('Details withheld');
    expect(redactor.serialize('x'.repeat(21), 'safe', 20)).toContain('… truncated');
  });
});
