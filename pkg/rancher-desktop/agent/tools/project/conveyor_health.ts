import { BaseTool, ToolResponse } from '../base';
import {
  WorkConveyorMetricsModel,
  type ConveyorMetricsOptions,
} from '../../database/models/WorkConveyorMetricsModel';

/**
 * conveyor_health — read-only Projects conveyor-health & productivity snapshot
 * (GitHub issue #717). Returns a compact human summary plus the full structured
 * JSON the Projects UI panel/drill-down consumes. Every number is defined (with
 * denominator) in WorkConveyorMetricsModel.
 */
export class ConveyorHealthWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const opts: ConveyorMetricsOptions = {
        projectId:    typeof input?.project_id === 'string' ? input.project_id : null,
        windowHours:  typeof input?.window_hours === 'number' ? input.window_hours : undefined,
        wipLimit:     typeof input?.wip_limit === 'number' ? input.wip_limit : undefined,
        staleMinutes: typeof input?.stale_minutes === 'number' ? input.stale_minutes : undefined,
      };
      const snap = await WorkConveyorMetricsModel.snapshot(opts);
      const scope = snap.project_id ? `project ${ snap.project_id }` : 'all projects';
      const lines: string[] = [];
      lines.push(`# Projects conveyor health (window ${ snap.window_hours }h, ${ scope })`);
      lines.push('');
      lines.push('## Stage counts (oldest item per semantic stage)');
      for (const s of snap.stages) {
        const age = s.oldestAgeSeconds == null ? '-' : `${ Math.round(s.oldestAgeSeconds / 3600) }h`;
        lines.push(`- ${ s.stage }: ${ s.count }  (oldest ${ age }${ s.oldestTaskId ? ` -> ${ s.oldestTaskId }` : '' })`);
      }
      lines.push('');
      lines.push(`Throughput: entered_review=${ snap.throughput.enteredReview } reviews_completed=${ snap.throughput.reviewsCompleted } reached_done=${ snap.throughput.reachedDone }`);
      lines.push(`Verifier: completed_reviews=${ snap.verifier.completedReviews } per_day=${ snap.verifier.perDay.toFixed(2) } active_leases=${ snap.verifier.activeVerificationLeases }`);
      lines.push(`Rework: rate=${ (snap.rework.reworkRate * 100).toFixed(1) }% avg_repair_loops=${ snap.rework.avgRepairLoops.toFixed(2) } (reviewed ${ snap.rework.reviewed })`);
      lines.push(`Wait adoption: ${ snap.waits.blockedWithActiveWait }/${ snap.waits.blockedTotal } blocked tasks have an active durable wait (${ (snap.waits.adoptionRate * 100).toFixed(0) }%)`);
      lines.push(`Stale leases: ${ snap.leases.staleLeases }/${ snap.leases.activeLeases } running leases stale`);
      lines.push(`Dependency-held: ${ snap.deps.dependencyHeld }`);
      lines.push(`WIP: execution=${ snap.wip.activeExecutionWip }/${ snap.wip.wipLimit } verification=${ snap.wip.activeVerificationWip } backpressure=${ snap.wip.backpressureReason ?? 'none' }`);
      lines.push(`Shipments: independent=${ snap.shipments.independentShipments } integration_train_closures=${ snap.shipments.integrationTrainClosures }`);
      lines.push('');
      lines.push('## Custody completeness by artifact type (structured/legacy/missing/invalid)');
      for (const c of snap.custody) {
        lines.push(`- ${ c.artifactType }: total=${ c.total } structured=${ c.structured } legacy=${ c.legacy } missing=${ c.missing } invalid=${ c.invalid }`);
      }
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(snap, null, 2));
      lines.push('```');
      return { successBoolean: true, responseString: lines.join('\n') };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to compute conveyor health: ${ err?.message }` };
    }
  }
}
