// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as childProcess from 'child_process';

import * as pty from 'node-pty';

import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';
import paths from '@pkg/utils/paths';

import { OutputParser } from './OutputParser';

const MOUNT_DEVPTS = 'mountpoint -q /dev/pts || { mkdir -p /dev/pts && mount -t devpts devpts /dev/pts -o newinstance,ptmxmode=0666,mode=0620,gid=5; }';
const GUEST_PTY_RELAY = "import fcntl, os, pty, select, struct, sys, termios, time\npid, fd = pty.fork()\nif pid == 0:\n    os.environ.setdefault(\"TERM\", \"xterm-256color\")\n    os.execvp(sys.argv[1], sys.argv[1:])\nfcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack(\"HHHH\", 30, 1000, 0, 0))\ninputs = [fd, 0]\nwhile True:\n    ready, _, _ = select.select(inputs, [], [])\n    if fd in ready:\n        try:\n            data = os.read(fd, 65536)\n        except OSError:\n            break\n        if not data:\n            break\n        os.write(1, data)\n    if 0 in ready:\n        data = os.read(0, 65536)\n        if data:\n            if data.endswith(b\"\\n\"):\n                body = data[:-1].replace(b\"\\n\", b\"\\r\")\n                if body:\n                    os.write(fd, body)\n                time.sleep(0.3)\n                os.write(fd, b\"\\r\")\n            else:\n                os.write(fd, data.replace(b\"\\n\", b\"\\r\"))\n        else:\n            inputs.remove(0)\n_, status = os.waitpid(pid, 0)\nsys.exit(os.waitstatus_to_exitcode(status))";

export class ClaudeCliUnavailableError extends Error {}

export interface ClaudeSetupTokenCallbacks {
  onOutput:       (text: string) => void;
  onAuthorizeUrl: (url: string) => void;
}

/** Sole owner of `claude setup-token`, including its probe and PTY lifetime. */
export class ClaudeSetupTokenAdapter {
  private process: pty.IPty | null = null;
  private parser = new OutputParser();
  private enterTimer: ReturnType<typeof setTimeout> | null = null;
  private enterRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private authorizeUrlSeen = false;
  private enterAttempts = 0;
  private outputSequence = 0;
  private settled = false;
  private exitCode: number | null = null;

  async prepare(): Promise<string> {
    firstRunTrace('claude', 'CLI ensure started');
    try {
      const { ensureGuestCli } = await import('@pkg/backend/guestClis');
      await ensureGuestCli('claude');
      await this.runGuestCommand(['sh', '-lc', MOUNT_DEVPTS], 30_000);
      const version = await this.runGuestCommand(['claude', '--version'], 15_000);

      firstRunTrace('claude', 'CLI ensure completed', { success: true });
      return version.trim().split('\n').at(-1) || 'unknown';
    } catch (error) {
      firstRunTrace('claude', 'CLI ensure completed', { success: false, error: error instanceof Error ? error.message : String(error) });
      throw new ClaudeCliUnavailableError('Claude CLI is unavailable.');
    }
  }

  run(callbacks: ClaudeSetupTokenCallbacks): Promise<string> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, token?: string) => {
        if (this.settled) return;
        this.settled = true;
        if (error) {
          this.traceOutputTail(error.message);
          reject(error);
        } else resolve(token!);
      };

      try {
        this.process = pty.spawn(paths.sullaRuntime, ['exec', '--', 'python3', '-c', GUEST_PTY_RELAY, 'claude', 'setup-token'], {
          name: 'xterm-256color', cols: 1000, rows: 30, env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      firstRunTrace('claude', 'PTY spawned');
      this.process.onData((chunk) => {
        this.outputSequence++;
        const parsed = this.parser.push(chunk);

        callbacks.onOutput(OutputParser.clean(chunk));
        if (parsed.providerError) {
          finish(new Error(parsed.providerError));
          return;
        }
        if (!this.authorizeUrlSeen && parsed.authorizeUrl) {
          this.authorizeUrlSeen = true;
          callbacks.onAuthorizeUrl(parsed.authorizeUrl);
        }
        if (parsed.token) finish(undefined, parsed.token);
      });
      this.process.onExit(({ exitCode }) => {
        this.exitCode = exitCode;
        const parsed = this.parser.finish();

        if (parsed.token) finish(undefined, parsed.token);
        else if (exitCode === 127) finish(new ClaudeCliUnavailableError('Claude CLI exited before sign-in.'));
        else finish(new Error('Claude sign-in ended before it finished.'));
      });
    });
  }

  submitCode(codeAndState: string): void {
    if (!this.process) throw new Error('Claude setup-token is not running.');
    this.process.write(codeAndState);
    this.enterTimer = setTimeout(() => this.sendEnter(), 400);
  }

  dispose(): void {
    // Cancelled or timed out by the coordinator before the CLI finished: the
    // terminal output is the only record of what the CLI was actually doing.
    if (!this.settled && this.process) this.traceOutputTail('stopped before the CLI finished');
    this.settled = true;
    if (this.enterTimer) clearTimeout(this.enterTimer);
    if (this.enterRetryTimer) clearTimeout(this.enterRetryTimer);
    this.enterTimer = null;
    this.enterRetryTimer = null;
    try { this.process?.kill() } catch { /* already exited */ }
    this.process = null;
  }

  /**
   * Record what `claude setup-token` printed when sign-in fails, so a failed
   * run says why. Only on failure (a successful run ends with the token), and
   * the trace scrubs sk-ant tokens, JWTs, OAuth query values and long opaque
   * strings before anything is written.
   */
  private traceOutputTail(reason: string): void {
    try {
      const text = this.parser.finish().text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      firstRunTrace('claude', 'setup-token output on failure', {
        providerId: 'claude',
        status:     'failure',
        reason,
        exitCode:   this.exitCode,
        error:      text.slice(-240),
        output:     text.slice(-2_000),
      });
    } catch { /* tracing must never break sign-in */ }
  }

  private sendEnter(): void {
    if (!this.process || this.enterAttempts >= 3) return;
    this.enterAttempts++;
    if (this.enterTimer) clearTimeout(this.enterTimer);
    if (this.enterRetryTimer) clearTimeout(this.enterRetryTimer);
    this.enterTimer = null;
    this.enterRetryTimer = null;
    firstRunTrace('claude', 'Enter sent', { attempt: this.enterAttempts });
    this.process.write('\r');

    const outputSequence = this.outputSequence;
    this.enterRetryTimer = setTimeout(() => {
      this.enterRetryTimer = null;
      if (!this.settled && this.outputSequence === outputSequence) this.sendEnter();
    }, 3_000);
  }

  private runGuestCommand(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = childProcess.spawn(paths.sullaRuntime, ['exec', '--', ...args], { env: { ...process.env } });
      let output = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(output);
      };
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already exited */ }
        finish(new Error(`Claude CLI command timed out after ${ timeoutMs }ms.`));
      }, timeoutMs);

      child.stdout.on('data', data => { output += data.toString() });
      child.stderr.on('data', data => { output += data.toString() });
      child.on('error', error => finish(error));
      child.on('close', code => code === 0 ? finish() : finish(new Error(`Claude CLI command exited ${ code }.`)));
    });
  }
}
