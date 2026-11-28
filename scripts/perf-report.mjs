// SPDX-License-Identifier: GPL-2.0-or-later
// Read-only aggregate report for safe agent-turn and provider-bridge timing records.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TURN_PREFIX = '[TurnTiming]';
const BRIDGE_PREFIX = '[BridgeTiming]';
const PROVIDERS = Object.freeze(['codex', 'claude', 'api', 'other']);
const SURFACES = Object.freeze(['chat', 'delegated', 'heartbeat', 'other']);
const SOURCES = Object.freeze(['native', 'codex_cli', 'claude_cli', 'mcp']);
const PHASE_FIELDS = Object.freeze(['queueWaitMs', 'preModelMs', 'reasoningMs', 'firstVisibleTextMs', 'totalMs']);
const MAX_TOOL_LABELS = 10;

class PerfLogReader {
  constructor({ readFile = readFileSync } = {}) {
    this.readFile = readFile;
  }

  read(filePath) {
    return this.parseLines(this.readFile(filePath, 'utf8').split(/\r?\n/));
  }

  parseLines(lines) {
    const result = { turns: [], bridgeTimings: [], skippedLines: 0, ignoredLines: 0 };

    for (const line of lines) {
      if (!line.trim()) continue;

      const turnMarker = line.indexOf(TURN_PREFIX);
      if (turnMarker >= 0) {
        const turn = this.parseTurn(line.slice(turnMarker + TURN_PREFIX.length).trim());
        if (turn) result.turns.push(turn);
        else result.skippedLines += 1;
        continue;
      }

      if (line.includes(BRIDGE_PREFIX)) {
        const bridgeTiming = this.parseBridgeTiming(line);
        if (bridgeTiming) result.bridgeTimings.push(bridgeTiming);
        else result.skippedLines += 1;
        continue;
      }

      result.ignoredLines += 1;
    }

    return result;
  }

  parseTurn(jsonText) {
    let record;
    try {
      record = JSON.parse(jsonText);
    } catch {
      return null;
    }
    return this.isValidTurn(record) ? record : null;
  }

  isValidTurn(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (record.schemaVersion !== 1 || typeof record.runId !== 'string') return false;
    if (!SURFACES.includes(record.surface) || !PROVIDERS.includes(record.provider)) return false;
    if (!(record.model === null || typeof record.model === 'string')) return false;
    if (!['ok', 'error', 'aborted'].includes(record.outcome)) return false;
    if (typeof record.threadId !== 'string' || !(record.jobId === null || typeof record.jobId === 'string')) return false;
    if (!(record.taskIndex === null || this.isNonNegativeInteger(record.taskIndex))) return false;
    if (!this.isNonNegativeNumber(record.startedAtMs)) return false;
    if (!this.isNullableNonNegativeNumber(record.queueWaitMs)
      || !this.isNullableNonNegativeNumber(record.preModelMs)
      || !this.isNullableNonNegativeNumber(record.firstVisibleTextMs)
      || !this.isNullableNonNegativeNumber(record.reasoningMs)
      || !this.isNonNegativeNumber(record.totalMs)) return false;
    if (!Array.isArray(record.providerRequests) || !Array.isArray(record.toolSteps)) return false;
    if (record.providerRequests.length > 500 || record.toolSteps.length > 500) return false;
    if (record.truncatedSteps !== undefined && !this.isNonNegativeInteger(record.truncatedSteps)) return false;
    return record.providerRequests.every(request => this.isValidProviderRequest(request))
      && record.toolSteps.every(step => this.isValidToolStep(step));
  }

  isValidProviderRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
    return typeof request.bridgeRequestId === 'string'
      && this.isNonNegativeNumber(request.startMs)
      && this.isNullableNonNegativeNumber(request.firstByteMs)
      && this.isNullableNonNegativeNumber(request.firstTextMs)
      && this.isNullableNonNegativeNumber(request.endMs)
      && this.isNullableNonNegativeNumber(request.status)
      && this.isNullableNonNegativeNumber(request.bodyBytes);
  }

  isValidToolStep(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
    return typeof step.name === 'string'
      && SOURCES.includes(step.source)
      && this.isNonNegativeNumber(step.startMs)
      && this.isNullableNonNegativeNumber(step.endMs)
      && this.isNullableNonNegativeNumber(step.durationMs)
      && (step.ok === null || typeof step.ok === 'boolean');
  }

  isNonNegativeNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  isNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
  }

  isNullableNonNegativeNumber(value) {
    return value === null || this.isNonNegativeNumber(value);
  }

  parseBridgeTiming(line) {
    const marker = line.indexOf(BRIDGE_PREFIX);
    if (marker < 0) return null;

    const fields = new Map();
    for (const match of line.slice(marker + BRIDGE_PREFIX.length).matchAll(/([A-Za-z][A-Za-z0-9]*)=([^\s]+)/g)) {
      if (['provider', 'totalMs', 'firstChunkMs', 'bodyBytes'].includes(match[1])) fields.set(match[1], match[2]);
    }

    const provider = fields.get('provider');
    const totalMs = this.parseNonNegativeNumber(fields.get('totalMs'));
    const firstChunkMs = this.parseNullableNumber(fields.get('firstChunkMs'));
    const bodyBytes = this.parseNonNegativeInteger(fields.get('bodyBytes'));
    if (!PROVIDERS.includes(provider) || totalMs === null || firstChunkMs === undefined || bodyBytes === null) return null;

    const timestampText = line.slice(0, marker).match(/\b\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
    const timestampMs = timestampText ? Date.parse(timestampText[0]) : null;
    return { provider, totalMs, firstChunkMs, bodyBytes, timestampMs: Number.isFinite(timestampMs) ? timestampMs : null };
  }

  parseNonNegativeNumber(value) {
    if (value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  parseNullableNumber(value) {
    if (value === undefined) return undefined;
    if (value === 'null') return null;
    const number = this.parseNonNegativeNumber(value);
    return number === null ? undefined : number;
  }

  parseNonNegativeInteger(value) {
    const number = this.parseNonNegativeNumber(value);
    return Number.isInteger(number) ? number : null;
  }
}

class TurnTimingAggregator {
  aggregate(turns, bridgeTimings, { sinceMs = null, provider = null, surface = null } = {}) {
    const filteredTurns = turns.filter(turn => (sinceMs === null || turn.startedAtMs >= sinceMs)
      && (provider === null || turn.provider === provider)
      && (surface === null || turn.surface === surface));
    const filteredBridgeTimings = bridgeTimings.filter(timing => (provider === null || timing.provider === provider)
      && (sinceMs === null || (timing.timestampMs !== null && timing.timestampMs >= sinceMs)));
    const bridgeWithoutTimestamp = sinceMs === null ? 0 : bridgeTimings.filter(timing => timing.timestampMs === null
      && (provider === null || timing.provider === provider)).length;

    return {
      skippedLines: 0,
      ignoredLines: 0,
      turnTiming: this.groupTurns(filteredTurns),
      bridgeTiming: this.groupBridgeTimings(filteredBridgeTimings),
      filteredBridgeWithoutTimestamp: bridgeWithoutTimestamp,
    };
  }

  groupTurns(turns) {
    const byProvider = new Map();
    for (const turn of turns) {
      if (!byProvider.has(turn.provider)) byProvider.set(turn.provider, []);
      byProvider.get(turn.provider).push(turn);
    }

    return [...byProvider.keys()].sort().map(provider => {
      const providerTurns = byProvider.get(provider);
      const bySurface = new Map();
      for (const turn of providerTurns) {
        if (!bySurface.has(turn.surface)) bySurface.set(turn.surface, []);
        bySurface.get(turn.surface).push(turn);
      }
      return {
        provider,
        ...this.summarizeTurns(providerTurns),
        surfaces: [...bySurface.keys()].sort().map(surface => ({
          surface,
          ...this.summarizeTurns(bySurface.get(surface)),
        })),
      };
    });
  }

  summarizeTurns(turns) {
    const phaseStats = {};
    for (const field of PHASE_FIELDS) phaseStats[field] = this.distribution(turns.map(turn => turn[field]));

    const requests = turns.flatMap(turn => turn.providerRequests);
    const toolsByLabel = new Map();
    for (const turn of turns) {
      for (const step of turn.toolSteps) {
        const label = this.safeToolLabel(step.name);
        const duration = this.toolDuration(step);
        if (duration === null) continue;
        if (!toolsByLabel.has(label)) toolsByLabel.set(label, []);
        toolsByLabel.get(label).push(duration);
      }
    }

    const toolTotalsByTurn = turns.map(turn => turn.toolSteps.reduce((total, step) => total + (this.toolDuration(step) ?? 0), 0));
    return {
      n: turns.length,
      phases: phaseStats,
      providerRequestsPerTurn: this.distribution(turns.map(turn => turn.providerRequests.length), false),
      requestLatencyMs: {
        firstByte: this.distribution(requests.map(request => request.firstByteMs === null || request.firstByteMs < request.startMs ? null : request.firstByteMs - request.startMs)),
        firstText: this.distribution(requests.map(request => request.firstTextMs === null || request.firstTextMs < request.startMs ? null : request.firstTextMs - request.startMs)),
        duration: this.distribution(requests.map(request => request.endMs === null || request.endMs < request.startMs ? null : request.endMs - request.startMs)),
      },
      toolTimePerTurnMs: this.distribution(toolTotalsByTurn, false),
      topTools: [...toolsByLabel.entries()]
        .map(([label, durations]) => ({ label, count: durations.length, ...this.distribution(durations), totalMs: durations.reduce((total, value) => total + value, 0) }))
        .sort((left, right) => right.totalMs - left.totalMs || left.label.localeCompare(right.label))
        .slice(0, MAX_TOOL_LABELS)
        .map(({ label, count, p50, p90, max }) => ({ label, count, p50, p90, max })),
      timeShare: this.timeShare(turns),
    };
  }

  distribution(values, includeMax = true) {
    const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((left, right) => left - right);
    if (!sorted.length) return includeMax ? { p50: null, p90: null, max: null } : { p50: null, p90: null };
    const result = { p50: this.nearestRank(sorted, 0.5), p90: this.nearestRank(sorted, 0.9) };
    if (includeMax) result.max = sorted.at(-1);
    return result;
  }

  nearestRank(sortedValues, percentile) {
    const rank = Math.ceil(percentile * sortedValues.length);
    return sortedValues[Math.max(0, rank - 1)];
  }

  toolDuration(step) {
    if (step.endMs !== null && step.endMs >= step.startMs) return step.endMs - step.startMs;
    if (step.durationMs !== null) return step.durationMs;
    return null;
  }

  safeToolLabel(label) {
    const normalized = label.trim();
    if (/^sulla [A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(normalized)) return normalized;
    if (/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(normalized)) return normalized;
    return 'other';
  }

  timeShare(turns) {
    const totals = { modelMs: 0, toolsMs: 0, otherMs: 0, turnMs: 0 };
    for (const turn of turns) {
      if (turn.totalMs <= 0) continue;
      const allocated = this.allocateTurnTime(turn);
      totals.modelMs += allocated.modelMs;
      totals.toolsMs += allocated.toolsMs;
      totals.otherMs += allocated.otherMs;
      totals.turnMs += turn.totalMs;
    }
    if (totals.turnMs === 0) return { modelPercent: null, toolsPercent: null, otherPercent: null };
    return {
      modelPercent: (totals.modelMs / totals.turnMs) * 100,
      toolsPercent: (totals.toolsMs / totals.turnMs) * 100,
      otherPercent: (totals.otherMs / totals.turnMs) * 100,
    };
  }

  allocateTurnTime(turn) {
    const events = new Map([[0, { model: 0, tools: 0 }], [turn.totalMs, { model: 0, tools: 0 }]]);
    const addInterval = (kind, start, end) => {
      const clippedStart = Math.max(0, Math.min(turn.totalMs, start));
      const clippedEnd = Math.max(0, Math.min(turn.totalMs, end));
      if (clippedEnd <= clippedStart) return;
      if (!events.has(clippedStart)) events.set(clippedStart, { model: 0, tools: 0 });
      if (!events.has(clippedEnd)) events.set(clippedEnd, { model: 0, tools: 0 });
      events.get(clippedStart)[kind] += 1;
      events.get(clippedEnd)[kind] -= 1;
    };

    for (const request of turn.providerRequests) {
      if (request.endMs !== null && request.endMs >= request.startMs) addInterval('model', request.startMs, request.endMs);
    }
    for (const step of turn.toolSteps) {
      const duration = this.toolDuration(step);
      if (duration === null) continue;
      addInterval('tools', step.startMs, step.endMs !== null && step.endMs >= step.startMs ? step.endMs : step.startMs + duration);
    }

    const ordered = [...events.entries()].sort((left, right) => left[0] - right[0]);
    const totals = { modelMs: 0, toolsMs: 0, otherMs: 0 };
    const active = { model: 0, tools: 0 };
    let priorTime = ordered[0][0];
    for (const [time, delta] of ordered) {
      const elapsed = time - priorTime;
      const activeCategories = Number(active.model > 0) + Number(active.tools > 0);
      if (activeCategories === 0) totals.otherMs += elapsed;
      else if (activeCategories === 1) {
        if (active.model > 0) totals.modelMs += elapsed;
        if (active.tools > 0) totals.toolsMs += elapsed;
      } else {
        totals.modelMs += elapsed / 2;
        totals.toolsMs += elapsed / 2;
      }
      active.model += delta.model;
      active.tools += delta.tools;
      priorTime = time;
    }
    return totals;
  }

  groupBridgeTimings(timings) {
    const byProvider = new Map();
    for (const timing of timings) {
      if (!byProvider.has(timing.provider)) byProvider.set(timing.provider, []);
      byProvider.get(timing.provider).push(timing);
    }
    return [...byProvider.keys()].sort().map(provider => {
      const providerTimings = byProvider.get(provider);
      return {
        provider,
        n: providerTimings.length,
        totalMs: this.distribution(providerTimings.map(timing => timing.totalMs), false),
        firstChunkMs: this.distribution(providerTimings.map(timing => timing.firstChunkMs), false),
        bodyBytes: this.distribution(providerTimings.map(timing => timing.bodyBytes), false),
      };
    });
  }
}

class ReportFormatter {
  format(report, asJson = false) {
    if (asJson) return `${JSON.stringify(report, null, 2)}\n`;
    const lines = [`TurnTiming samples: ${report.turnTiming.reduce((sum, group) => sum + group.n, 0)}`, `BridgeTiming samples: ${report.bridgeTiming.reduce((sum, group) => sum + group.n, 0)}`, `Skipped timing records: ${report.skippedLines}`, `Ignored non-timing lines: ${report.ignoredLines}`];
    if (report.filteredBridgeWithoutTimestamp > 0) lines.push(`BridgeTiming lines omitted by --since (no timestamp): ${report.filteredBridgeWithoutTimestamp}`);
    lines.push('TurnTiming by provider:');
    if (report.turnTiming.length === 0) lines.push('  no samples');
    for (const group of report.turnTiming) {
      lines.push(`  ${group.provider} (n=${group.n})`);
      this.appendSummary(lines, group, '    ');
      for (const surface of group.surfaces) {
        lines.push(`    surface ${surface.surface} (n=${surface.n})`);
        this.appendSummary(lines, surface, '      ');
      }
    }
    lines.push('BridgeTiming by provider:');
    if (report.bridgeTiming.length === 0) lines.push('  no samples');
    for (const group of report.bridgeTiming) {
      lines.push(`  ${group.provider} (n=${group.n}) totalMs ${this.formatDistribution(group.totalMs)} firstChunkMs ${this.formatDistribution(group.firstChunkMs)} bodyBytes ${this.formatDistribution(group.bodyBytes)}`);
    }
    return `${lines.join('\n')}\n`;
  }

  appendSummary(lines, summary, indent) {
    for (const [phase, distribution] of Object.entries(summary.phases)) lines.push(`${indent}${phase} ${this.formatDistribution(distribution)}`);
    lines.push(`${indent}providerRequestsPerTurn ${this.formatDistribution(summary.providerRequestsPerTurn)}`);
    for (const [phase, distribution] of Object.entries(summary.requestLatencyMs)) lines.push(`${indent}request ${phase}Ms ${this.formatDistribution(distribution)}`);
    lines.push(`${indent}toolTimePerTurnMs ${this.formatDistribution(summary.toolTimePerTurnMs)}`);
    const share = summary.timeShare;
    lines.push(`${indent}timeShare model=${this.formatNumber(share.modelPercent)}% tools=${this.formatNumber(share.toolsPercent)}% other=${this.formatNumber(share.otherPercent)}%`);
    lines.push(`${indent}topTools`);
    if (summary.topTools.length === 0) lines.push(`${indent}  none`);
    for (const tool of summary.topTools) lines.push(`${indent}  ${tool.label} count=${tool.count} p50=${this.formatNumber(tool.p50)} p90=${this.formatNumber(tool.p90)} max=${this.formatNumber(tool.max)}`);
  }

  formatDistribution(distribution) {
    const parts = [`p50=${this.formatNumber(distribution.p50)}`, `p90=${this.formatNumber(distribution.p90)}`];
    if ('max' in distribution) parts.push(`max=${this.formatNumber(distribution.max)}`);
    return parts.join(' ');
  }

  formatNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toFixed(2))) : 'n/a';
  }
}

class PerfReportCli {
  constructor({ reader = new PerfLogReader(), aggregator = new TurnTimingAggregator(), formatter = new ReportFormatter(), write = text => process.stdout.write(text) } = {}) {
    this.reader = reader;
    this.aggregator = aggregator;
    this.formatter = formatter;
    this.write = write;
  }

  async run(args) {
    let options;
    try {
      options = this.parseArguments(args);
    } catch (error) {
      this.write(`${error.message}\n`);
      return 2;
    }
    if (options.help) {
      this.write(this.helpText());
      return 0;
    }

    let parsed;
    try {
      parsed = this.reader.read(options.filePath);
    } catch {
      this.write('Unable to read timing log.\n');
      return 1;
    }
    const report = this.aggregator.aggregate(parsed.turns, parsed.bridgeTimings, options);
    report.skippedLines = parsed.skippedLines;
    report.ignoredLines = parsed.ignoredLines;
    this.write(this.formatter.format(report, options.json));
    return 0;
  }

  parseArguments(args) {
    const options = { filePath: path.join(homedir(), 'Library', 'Logs', 'sulla-desktop', 'perf.log'), sinceMs: null, provider: null, surface: null, json: false, help: false };
    let fileProvided = false;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === '--help' || argument === '-h') options.help = true;
      else if (argument === '--json') options.json = true;
      else if (argument === '--since' || argument === '--provider' || argument === '--surface') {
        const value = args[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}. Use --help for usage.`);
        index += 1;
        if (argument === '--since') {
          const sinceMs = Date.parse(value);
          if (!Number.isFinite(sinceMs)) throw new Error('--since must be a valid ISO date/time. Use --help for usage.');
          options.sinceMs = sinceMs;
        } else if (argument === '--provider') {
          if (!PROVIDERS.includes(value)) throw new Error('--provider must be codex, claude, api, or other. Use --help for usage.');
          options.provider = value;
        } else {
          if (!SURFACES.includes(value)) throw new Error('--surface must be chat, delegated, heartbeat, or other. Use --help for usage.');
          options.surface = value;
        }
      } else if (argument.startsWith('-')) throw new Error(`Unknown option ${argument}. Use --help for usage.`);
      else if (!fileProvided) {
        options.filePath = path.resolve(argument);
        fileProvided = true;
      } else throw new Error('Only one perf.log path may be provided. Use --help for usage.');
    }
    return options;
  }

  helpText() {
    return [
      'Usage: node scripts/perf-report.mjs [perf.log] [--since <ISO>] [--provider <name>] [--surface <name>] [--json]',
      `Default input: ${path.join(homedir(), 'Library', 'Logs', 'sulla-desktop', 'perf.log')}`,
      'Reports aggregates only from valid [TurnTiming] records and the secondary [BridgeTiming] section.',
      'Percentiles use nearest rank: sort ascending and select rank ceil(p × n), one-based; null values are excluded.',
      'TurnTiming --since uses startedAtMs; BridgeTiming --since includes only lines with a parseable timestamp.',
      '--surface filters TurnTiming only; BridgeTiming records do not carry a surface.',
      `Top tool labels are limited to ${MAX_TOOL_LABELS} per provider/surface group.`,
      '--provider values: codex, claude, api, other. --surface values: chat, delegated, heartbeat, other.',
      '--json emits only aggregate counts, labels, and numeric summaries.',
    ].join('\n') + '\n';
  }
}

export { PerfLogReader, TurnTimingAggregator, ReportFormatter, PerfReportCli };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const exitCode = await new PerfReportCli().run(process.argv.slice(2));
  process.exitCode = exitCode;
}
