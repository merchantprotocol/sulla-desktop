// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DesktopStreamClient, type StreamCall, type StreamCallOutcome } from './DesktopStreamClient.js';
import { LoadOptionsParser, type LoadOptions } from './LoadOptions.js';
import { LoadReport } from './Report.js';
import { MetricsSampler, type ResourceSummary } from './MetricsSampler.js';
import { CertificateFactory, MachineCapacityGuard, ProcessHandleReader, type MachineCapacity } from './TestAssets.js';
import { SyntheticUpstream, type SyntheticUpstreamSnapshot } from './SyntheticUpstream.js';
import { TestVaultInstance, type SyntheticServiceIdentities } from './TestVaultInstance.js';
import { VaultProbeClient, type ProbeResult } from './VaultProbeClient.js';

const SOFT_VAULT_LIMIT_MIB = 768;
const EXPECTED_VAULT_OLD_SPACE_MIB = 256;
const VAULT_SEMI_SPACE_MIB = 2;
const DEFAULT_VAULT_PORT = 40_135;

interface PhaseSummary {
  requested: number;
  headersReceived: number;
  failures: number;
  canceled: number;
  failureKinds: Record<string, number>;
  failureDetails: Record<string, number>;
  statusCodes: Record<string, number>;
  maxConcurrentStreams: number;
  activeStreamsAfter: number;
  upstreamRequests: number;
  requestBodyBytes: number;
  maxRequestBodyBytes: number;
  timeToHeaders: ReturnType<typeof LoadReport.latency> & {
    p50AboveSingleCallMs: number | null;
    p95AboveSingleCallMs: number | null;
  };
  requestReceivedToUpstreamConnectMs: ReturnType<typeof LoadReport.latency>;
}

interface ProbeSummary {
  requestedPerKind: number;
  activeStreamsAtStart: number;
  activeStreamsAtEnd: number;
  results: Record<string, { p50Ms: number | null; p95Ms: number | null; failures: number; statuses: Record<string, number> }>;
}

/** Owns one disposable synthetic vault + TLS upstream and emits a secret-free JSON baseline. */
export class VaultLoadRunner {
  constructor(
    private readonly options: LoadOptions,
    private readonly capacity: MachineCapacity,
    private readonly tempDirectory: string,
  ) {}

  static async fromArgs(argv: string[]): Promise<VaultLoadRunner> {
    const options = new LoadOptionsParser().parse(argv);
    const capacity = await new MachineCapacityGuard().check();
    const tempDirectory = await mkdtemp(join(os.tmpdir(), 'sulla-vault-load-'));
    return new VaultLoadRunner(options, capacity, tempDirectory);
  }

  async run(): Promise<void> {
    const identities = this.syntheticIdentities();
    let certificates: Awaited<ReturnType<CertificateFactory['create']>>;
    let upstream: SyntheticUpstream;
    try {
      certificates = await new CertificateFactory().create(this.tempDirectory);
      upstream = new SyntheticUpstream(certificates.upstreamCertificatePem, await readFile(certificates.upstreamPrivateKeyPath));
    } catch (error) {
      await rm(this.tempDirectory, { recursive: true, force: true });
      throw error;
    }
    let vault: TestVaultInstance | undefined;
    let upstreamStarted = false;
    let streamClient: DesktopStreamClient | undefined;
    let probes: VaultProbeClient | undefined;
    let probeAgentClosed = false;
    let transportClosed = false;
    let summary: Record<string, unknown> | undefined;
    try {
      const upstreamAddress = await upstream.start();
      upstreamStarted = true;
      vault = new TestVaultInstance({
        tempDir: this.tempDirectory,
        vaultCertificatePath: certificates.vaultCertificatePath,
        vaultPrivateKeyPath: certificates.vaultPrivateKeyPath,
        vaultCertificatePem: certificates.vaultCertificatePem,
        upstreamCertificatePath: certificates.upstreamCertificatePath,
        upstreamOrigin: upstreamAddress.origin,
        identities,
      });
      await vault.start();
      const { principalId } = await vault.provisionSyntheticCredential();
      process.env.XDG_DATA_HOME = join(this.tempDirectory, 'xdg-data');
      streamClient = new DesktopStreamClient(vault.origin, upstreamAddress.origin, principalId, identities);
      await streamClient.create();
      probes = new VaultProbeClient(vault.origin, upstreamAddress.origin, principalId, identities, certificates.vaultCertificatePem);

      const body = this.syntheticProviderBody(this.options.bodyKb);
      const baseline = await this.singleCallBaseline(streamClient, vault, upstream, body);
      const mainHoldSeconds = this.options.durationSeconds || this.options.holdSeconds;
      const main = await this.saturationRun(streamClient, vault, upstream, probes, body, baseline, mainHoldSeconds);
      const cancellation = await this.cancelAndRecover(streamClient, vault, upstream, body, this.options.cancelCount);
      let processStatus = await vault.status();
      const desktopTransportConnections = await this.readDesktopTransportConnectionSetting();
      let vaultRuntimeMetrics: Record<string, unknown> = {};
      try { vaultRuntimeMetrics = await vault.readMetrics(); } catch { /* preserve heap-OOM and exit status in the report */ }

      // Close owned client pools before comparing post-run fd/socket counts.
      await streamClient.close();
      transportClosed = true;
      await probes.close();
      probeAgentClosed = true;
      if (upstreamStarted) {
        await upstream.stop();
        upstreamStarted = false;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
      const handlesAfter = await new ProcessHandleReader().read(process.pid);
      const vaultHandlesAfter = processStatus.pid ? await new ProcessHandleReader().read(processStatus.pid) : { fdCount: null, socketCount: null };
      await vault.stop();
      processStatus = await vault.status();
      const vaultProcessExited = processStatus.pid ? !this.pidExists(processStatus.pid) : true;

      const resource = main.resources as ResourceSummary;
      const recoveryMetrics = cancellation as {
        cancellation?: { requested?: number; activeStreamsAtAbort?: number };
        recovery?: { requested?: number; headersReceived?: number; maxConcurrentStreams?: number };
        clientSocketCountReturned?: boolean | null;
        vaultSocketCountReturned?: boolean | null;
      };
      const shortCallFailures = Object.values(main.probes.results).reduce((total, result) => total + result.failures, 0);
      const shortCallP95Within500Ms = Object.values(main.probes.results)
        .every(result => result.p95Ms !== null && result.p95Ms <= 500);
      const p95AboveBaseline = main.phase.timeToHeaders.p95AboveSingleCallMs;
      const summaryObject = {
        format: 'sulla-vault-load-summary/v1',
        generatedAt: new Date().toISOString(),
        result: 'baseline',
        machine: {
          loadAverage: this.capacity.loadAverage,
          memAvailableMiB: LoadReport.mib(this.capacity.memAvailableBytes),
          memTotalMiB: LoadReport.mib(this.capacity.memTotalBytes),
          guardMinimumMemAvailableMiB: 4_096,
        },
        configuration: {
          concurrency: this.options.concurrency,
          holdSeconds: this.options.holdSeconds,
          bodyKb: this.options.bodyKb,
          cancelCount: this.options.cancelCount,
          durationSeconds: this.options.durationSeconds,
          effectiveMainHoldSeconds: mainHoldSeconds,
          maximumAllowedConnections: 1_000,
          softVaultRssLimitMiB: SOFT_VAULT_LIMIT_MIB,
          vaultNodeOptions: `--max-old-space-size=${ EXPECTED_VAULT_OLD_SPACE_MIB } --max-semi-space-size=${ VAULT_SEMI_SPACE_MIB }`,
          containerConfigNote: 'Desktop-generated Compose sets mem_limit=768m and NODE_OPTIONS=--max-old-space-size=256 --max-semi-space-size=2; the packaged Dockerfile uses Node 24 and UV_THREADPOOL_SIZE=16. This test child mirrors those flags under the available host Node runtime; 768 MiB is observed, not enforced as a test cgroup limit.',
          upstream: 'synthetic HTTPS only, bound to 127.0.0.1, exact api.openai.com test origin, generated self-signed CA',
          database: 'fresh PGlite data directory for this run; no Postgres/container or live vault used',
          upstreamConnectTiming: 'vault request middleware receive to synthetic HTTPS secureConnection; includes request parsing, PGlite credential lookup, localhost-only DNS/libuv resolver and outbound TLS connect',
          vaultPort: DEFAULT_VAULT_PORT,
          realVaultPortTouched: false,
        },
        transport: {
          path: 'DesktopVaultTransport.fetchStream -> Node undici Agent + repository TLS-pin connector',
          electronSessionFactoryInvocations: 0,
          desktopUndiciAgentConnectionsFromSource: desktopTransportConnections,
          vaultHttpsServerMaxConnections: vaultRuntimeMetrics.httpsServerMaxConnections ?? null,
          desktopUndiciMaxObservedUpstreamStreams: (main.upstreamMetrics as SyntheticUpstreamSnapshot).maxConcurrentStreams,
          vaultOutboundHttpsGlobalAgentMaxSockets: vaultRuntimeMetrics.outboundAgentMaxSockets ?? null,
          vaultUvThreadpoolSize: vaultRuntimeMetrics.uvThreadpoolSize ?? 16,
          productionPostgresPoolMax: 10,
          testDatabasePool: 'PGlite adapter (no PostgreSQL connection pool; pg Pool queue is not measured by this run)',
          testVaultRuntime: {
            nodeVersion: vaultRuntimeMetrics.nodeVersion ?? null,
            nodeOptions: vaultRuntimeMetrics.nodeOptions ?? '--max-old-space-size=256 --max-semi-space-size=2',
            heapSizeLimitMiB: LoadReport.mib(Number(vaultRuntimeMetrics.heapSizeLimitBytes)),
            outboundAgentKeepAlive: vaultRuntimeMetrics.outboundAgentKeepAlive ?? null,
          },
        },
        baseline,
        saturation: {
          ...main.phase,
          shortCalls: main.probes,
          resources: resource,
          vaultMemory: {
            rssPeakMiB: resource.vaultRssPeakMiB,
            heapUsedPeakMiB: resource.vaultHeapUsedPeakMiB,
            heapTotalPeakMiB: resource.vaultHeapTotalPeakMiB,
            oldSpaceLimitMiB: EXPECTED_VAULT_OLD_SPACE_MIB,
            softRssLimitMiB: SOFT_VAULT_LIMIT_MIB,
            rssWithinSoftLimit: resource.vaultRssPeakMiB === null ? null : resource.vaultRssPeakMiB < SOFT_VAULT_LIMIT_MIB,
            heapOom: processStatus.heapOom,
            exitCode: processStatus.exitCode,
            exitSignal: processStatus.signal,
          },
        },
        acceptance: {
          requestedStreamConcurrency: this.options.concurrency,
          observedPeakUpstreamStreams: main.phase.maxConcurrentStreams,
          streamConcurrencyTargetReached: main.phase.maxConcurrentStreams >= this.options.concurrency,
          p95HeadersWithin1sOfSingleCall: p95AboveBaseline !== null && p95AboveBaseline <= 1_000,
          shortCallFailures,
          shortCallP95Within500Ms,
          cancellationTargetReached: this.options.cancelCount === 0 ||
            (recoveryMetrics.cancellation?.activeStreamsAtAbort ?? 0) >= this.options.cancelCount,
          recoveryConcurrencyTargetReached: this.options.cancelCount === 0 ||
            (recoveryMetrics.recovery?.maxConcurrentStreams ?? 0) >= this.options.concurrency,
          cancellationClientSocketsReturned: this.options.cancelCount === 0 || recoveryMetrics.clientSocketCountReturned === true,
          cancellationVaultSocketsReturned: this.options.cancelCount === 0 || recoveryMetrics.vaultSocketCountReturned === true,
          vaultRssWithin768MiB: resource.vaultRssPeakMiB === null ? null : resource.vaultRssPeakMiB < SOFT_VAULT_LIMIT_MIB,
          vaultHeapOom: processStatus.heapOom,
          clientProcessNodeVersion: process.version,
        },
        cancellationRecovery: cancellation,
        socketAudit: {
          clientProcessBeforeMain: resource.clientHandlesBefore,
          clientProcessAfterAllOwnedAgentsClosed: handlesAfter,
          clientFdsReturnedToOrBelowBaseline: this.notAbove(handlesAfter.fdCount, resource.clientHandlesBefore.fdCount),
          vaultProcessBeforeMain: resource.vaultHandlesBefore,
          vaultProcessAfterStreamsAndAgentClose: vaultHandlesAfter,
          vaultFdsReturnedToOrBelowBaseline: this.notAbove(vaultHandlesAfter.fdCount, resource.vaultHandlesBefore.fdCount),
        },
        cleanup: {
          upstreamStopped: !upstreamStarted,
          vaultProcessExited,
          desktopTransportAgentClosed: transportClosed,
          probeAgentClosed,
          tempDirectoryRemoved: false,
        },
      };
      summary = summaryObject;
    } finally {
      if (streamClient && !transportClosed) await streamClient.close().catch(() => undefined);
      if (probes && !probeAgentClosed) await probes.close().catch(() => undefined);
      if (upstreamStarted) await upstream.stop().catch(() => undefined);
      if (vault) await vault.stop().catch(() => undefined);
      await rm(this.tempDirectory, { recursive: true, force: true });
    }
    if (!summary) throw new Error('Vault load harness finished without a summary');
    (summary.cleanup as Record<string, unknown>).tempDirectoryRemoved = true;
    process.stdout.write(`${ JSON.stringify(summary, null, 2) }\n`);
  }

  private async singleCallBaseline(
    client: DesktopStreamClient,
    vault: TestVaultInstance,
    upstream: SyntheticUpstream,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    upstream.reset();
    const single = client.open({ holdSeconds: this.options.holdSeconds, body, cancelAfterHeaders: true });
    const header = await single.headers;
    const outcome = await single.done;
    await this.waitFor(() => upstream.snapshot().activeStreams === 0, 2_000);
    const metrics = upstream.snapshot();
    const timings = await vault.readRequestTimings();
    return {
      requestCount: 1,
      headerLatencyMs: header.elapsedMs === null ? null : LoadReport.round(header.elapsedMs),
      status: header.status,
      failed: header.failed || outcome.failed,
      failureKind: header.failureKind,
      failureDetail: header.failureDetail,
      canceledAfterHeaders: true,
      upstreamRequests: metrics.totalStreamRequests,
      maxConcurrentStreams: metrics.maxConcurrentStreams,
      requestReceivedToUpstreamConnectMs: this.connectDelays(timings, metrics),
    };
  }

  private async saturationRun(
    client: DesktopStreamClient,
    vault: TestVaultInstance,
    upstream: SyntheticUpstream,
    probes: VaultProbeClient,
    body: Record<string, unknown>,
    baseline: Record<string, unknown>,
    holdSeconds: number,
  ): Promise<{ phase: PhaseSummary; probes: ProbeSummary; resources: ResourceSummary; upstreamMetrics: SyntheticUpstreamSnapshot }> {
    upstream.reset();
    const sampler = new MetricsSampler(vault);
    await sampler.start();
    const calls = this.makeCalls(client, this.options.concurrency, holdSeconds, body);
    const done = Promise.all(calls.map(call => call.done));
    const targetActive = this.options.concurrency;
    await this.waitFor(() => upstream.snapshot().activeStreams >= targetActive, 5_000);
    const activeAtProbe = upstream.snapshot().activeStreams;
    const shortCalls = await this.shortProbes(probes, upstream, Math.min(20, this.options.concurrency), activeAtProbe);

    if (this.options.durationSeconds > 0) {
      const stopAfterSoak = await Promise.race([
        done.then(() => false),
        new Promise<boolean>(resolve => setTimeout(() => resolve(true), this.options.durationSeconds * 1_000)),
      ]);
      if (stopAfterSoak) calls.forEach(call => call.abort());
    }
    const outcomes = await done;
    const resources = await sampler.stop();
    const upstreamMetrics = upstream.snapshot();
    const received = await vault.readRequestTimings();
    const connect = this.connectDelayValues(received, upstreamMetrics);
    const headerValues = outcomes.map(outcome => outcome.elapsedMs).filter((value): value is number => value !== null);
    const latency = LoadReport.latency(headerValues);
    const base = Number((baseline as { headerLatencyMs?: number | null }).headerLatencyMs);
    const delta = Number.isFinite(base);
    const phase: PhaseSummary = {
      requested: calls.length,
      headersReceived: headerValues.length,
      failures: outcomes.filter(outcome => outcome.failed).length,
      canceled: outcomes.filter(outcome => outcome.canceled).length,
      failureKinds: this.failureCounts(outcomes),
      failureDetails: this.failureDetailCounts(outcomes),
      statusCodes: this.statusCounts(outcomes),
      maxConcurrentStreams: upstreamMetrics.maxConcurrentStreams,
      activeStreamsAfter: upstreamMetrics.activeStreams,
      upstreamRequests: upstreamMetrics.totalStreamRequests,
      requestBodyBytes: upstreamMetrics.requestBodyBytes,
      maxRequestBodyBytes: upstreamMetrics.maxRequestBodyBytes,
      timeToHeaders: {
        ...latency,
        p50AboveSingleCallMs: delta && latency.p50Ms !== null ? LoadReport.round(latency.p50Ms - base) : null,
        p95AboveSingleCallMs: delta && latency.p95Ms !== null ? LoadReport.round(latency.p95Ms - base) : null,
      },
      requestReceivedToUpstreamConnectMs: LoadReport.latency(connect),
    };
    return { phase, probes: shortCalls, resources, upstreamMetrics };
  }

  private async cancelAndRecover(
    client: DesktopStreamClient,
    vault: TestVaultInstance,
    upstream: SyntheticUpstream,
    body: Record<string, unknown>,
    cancelCount: number,
  ): Promise<Record<string, unknown>> {
    const beforeClient = await new ProcessHandleReader().read(process.pid);
    const vaultPid = vault.pid;
    const beforeVault = vaultPid ? await new ProcessHandleReader().read(vaultPid) : { fdCount: null, socketCount: null };
    let cancellation: Record<string, unknown> = { requested: 0, skipped: true };
    if (cancelCount > 0) {
      upstream.reset();
      const calls = this.makeCalls(client, cancelCount, this.options.holdSeconds, body);
      const done = Promise.all(calls.map(call => call.done));
      await this.waitFor(() => upstream.snapshot().activeStreams >= cancelCount, 2_000);
      const activeAtAbort = upstream.snapshot().activeStreams;
      calls.forEach(call => call.abort());
      const outcomes = await done;
      const returnedToIdle = await this.waitFor(() => upstream.snapshot().activeStreams === 0, 3_000);
      const metrics = upstream.snapshot();
      cancellation = {
        requested: cancelCount,
        activeStreamsAtAbort: activeAtAbort,
        maxConcurrentStreamsBeforeAbort: metrics.maxConcurrentStreams,
        canceledOrAbortedRequests: outcomes.filter(outcome => outcome.canceled).length,
        failures: outcomes.filter(outcome => outcome.failed).length,
        activeStreamsAfterAbort: metrics.activeStreams,
        upstreamReturnedToIdle: returnedToIdle,
      };
    }

    upstream.reset();
    const recovery = this.makeCalls(client, this.options.concurrency, this.options.holdSeconds, body);
    const recoveryDone = await Promise.all(recovery.map(call => call.done));
    const recoveryMetrics = upstream.snapshot();
    const handlesAfter = await new ProcessHandleReader().read(process.pid);
    const vaultHandlesAfter = vaultPid ? await new ProcessHandleReader().read(vaultPid) : { fdCount: null, socketCount: null };
    return {
      cancellation,
      recovery: {
        requested: recovery.length,
        headersReceived: recoveryDone.filter(outcome => outcome.elapsedMs !== null).length,
        failures: recoveryDone.filter(outcome => outcome.failed).length,
        maxConcurrentStreams: recoveryMetrics.maxConcurrentStreams,
        activeStreamsAfter: recoveryMetrics.activeStreams,
        upstreamRequests: recoveryMetrics.totalStreamRequests,
      },
      socketHandlesBeforeCancellation: { client: beforeClient, vault: beforeVault },
      socketHandlesAfterRecovery: { client: handlesAfter, vault: vaultHandlesAfter },
      clientSocketCountReturned: this.notAbove(handlesAfter.socketCount, beforeClient.socketCount),
      vaultSocketCountReturned: this.notAbove(vaultHandlesAfter.socketCount, beforeVault.socketCount),
    };
  }

  private async shortProbes(probes: VaultProbeClient, upstream: SyntheticUpstream, requestedPerKind: number, activeStreamsAtStart: number): Promise<ProbeSummary> {
    const resultEntries: Array<[string, ProbeResult[]]> = await Promise.all([
      probes.runGroup('credentialLookup', requestedPerKind).then(result => ['credentialLookup', result]),
      probes.runGroup('brokerExecute', requestedPerKind).then(result => ['brokerExecute', result]),
      probes.runGroup('health', requestedPerKind).then(result => ['health', result]),
    ]);
    const results: ProbeSummary['results'] = {};
    for (const [name, group] of resultEntries) {
      const times = group.map(result => result.elapsedMs);
      const stats = LoadReport.latency(times);
      results[name] = {
        p50Ms: stats.p50Ms,
        p95Ms: stats.p95Ms,
        failures: group.filter(result => result.failed).length,
        statuses: this.probeStatusCounts(group),
      };
    }
    return {
      requestedPerKind,
      activeStreamsAtStart,
      activeStreamsAtEnd: upstream.snapshot().activeStreams,
      results,
    };
  }

  private makeCalls(client: DesktopStreamClient, count: number, holdSeconds: number, body: Record<string, unknown>): StreamCall[] {
    return Array.from({ length: count }, () => client.open({ holdSeconds, body }));
  }

  private syntheticProviderBody(bodyKb: number): Record<string, unknown> {
    const targetBytes = bodyKb * 1_000;
    const empty = JSON.stringify({ model: 'gpt-4.1', input: '', stream: true });
    const inputBytes = targetBytes - Buffer.byteLength(empty);
    if (inputBytes < 1) throw new Error('Synthetic provider JSON size is too small');
    return { model: 'gpt-4.1', input: 'x'.repeat(inputBytes), stream: true };
  }

  private syntheticIdentities(): SyntheticServiceIdentities {
    const token = () => randomBytes(48).toString('base64url');
    return { broker: token(), control: token(), approval: token(), files: token(), bootstrap: token() };
  }

  private connectDelays(received: Record<string, string>, metrics: SyntheticUpstreamSnapshot): ReturnType<typeof LoadReport.latency> {
    return LoadReport.latency(this.connectDelayValues(received, metrics));
  }

  private connectDelayValues(received: Record<string, string>, metrics: SyntheticUpstreamSnapshot): number[] {
    const samples: number[] = [];
    for (const [requestId, connectedAt] of Object.entries(metrics.tlsConnectedAtNs)) {
      const receivedAt = received[requestId];
      if (!receivedAt) continue;
      samples.push(Number(connectedAt) >= Number(receivedAt) ? (Number(connectedAt) - Number(receivedAt)) / 1_000_000 : 0);
    }
    return samples;
  }

  private statusCounts(outcomes: StreamCallOutcome[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const outcome of outcomes) {
      const key = outcome.status === null ? 'no_headers' : String(outcome.status);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  private failureCounts(outcomes: StreamCallOutcome[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const outcome of outcomes) if (outcome.failureKind) {
      counts[outcome.failureKind] = (counts[outcome.failureKind] ?? 0) + 1;
    }
    return counts;
  }

  private failureDetailCounts(outcomes: StreamCallOutcome[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const outcome of outcomes) if (outcome.failureDetail) {
      counts[outcome.failureDetail] = (counts[outcome.failureDetail] ?? 0) + 1;
    }
    return counts;
  }

  private probeStatusCounts(outcomes: ProbeResult[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const outcome of outcomes) counts[String(outcome.status)] = (counts[String(outcome.status)] ?? 0) + 1;
    return counts;
  }

  private async waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return true;
  }

  private notAbove(after: number | null, before: number | null): boolean | null {
    if (after === null || before === null) return null;
    return after <= before;
  }

  private pidExists(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }

  private async readDesktopTransportConnectionSetting(): Promise<{ control: number | null; stream: number | null }> {
    const currentFile = fileURLToPath(import.meta.url);
    const source = await readFile(join(dirname(currentFile), '../../../../pkg/sulla-desktop/vault-broker/desktopTransport.ts'), 'utf8');
    const control = /const\s+VAULT_CONTROL_CONNECTIONS\s*=\s*(\d+)/m.exec(source);
    const stream = /const\s+VAULT_STREAM_CONNECTIONS\s*=\s*(\d+)/m.exec(source);
    // Main's pre-#2970 transport embeds the 64-connection limit directly in its dispatcher.
    const legacyStream = /createNodeStreamDispatcher\(\):\s*Agent\s*\{\s*return\s+new Agent\(\{\s*connections:\s*(\d+)/s.exec(source);
    return {
      control: control ? Number(control[1]) : null,
      stream: stream ? Number(stream[1]) : legacyStream ? Number(legacyStream[1]) : null,
    };
  }
}
