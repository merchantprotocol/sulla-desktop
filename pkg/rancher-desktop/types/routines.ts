/**
 * Domain types for the Routines feature.
 *
 * Two distinct shapes:
 *   - RoutineSummary — a row from the workflows table (what the playbill
 *     lists under "My Routines"). Enriched with display fields derived
 *     from the stored `definition` JSONB where available.
 *   - TemplateSummary — a row read from ~/sulla/routines/<slug>/routine.yaml
 *     (what "My Templates" lists). Represents a reusable manifest, not
 *     an instantiated workflow.
 *
 * These are the *view* types — plain data the Vue layer consumes.
 * The DB-native shape lives in agent/database/models/WorkflowModel.ts
 * and is mapped to RoutineSummary by the IPC layer or composable.
 */

export type RoutineStatus = 'running' | 'scheduled' | 'idle' | 'draft' | 'archive';

export interface RoutineSummary {
  id:            string;
  name:          string;
  description:   string;
  category:      RoutineCategory;
  categoryLabel: string;
  initials:      string;
  status:        RoutineStatus;
  statusLabel:   string;
  agents:        number;
  integrations:  string[];
  runsPerWeek?:  number;
  avgCycle?:     string;
  avgCycleUnit?: string;
  costPerRun?:   string;
  lastRunAgo?:   string;
  nextIn?:       string;
  schedule?:     string;
  featured?:     boolean;
}

export type RoutineCategory =
  | 'content'
  | 'research'
  | 'planning'
  | 'leads'
  | 'learning'
  | 'ops'
  | 'goals';

/**
 * A routine template — what shows in My Templates. The file on disk is
 * a full routine DAG (`~/sulla/routines/<slug>/routine.yaml`), so the
 * summary mirrors that shape: metadata + graph counts + the kinds of
 * triggers the routine wires up. None of the fields are invented; they
 * all come straight from the YAML.
 */
export interface TemplateSummary {
  slug:         string;
  id:           string;
  name:         string;
  description:  string;
  version:      string;
  initials:     string;
  /** Kept as a hint for card color only; inferred from name/description. */
  category:     RoutineCategory;
  /** `nodes.length` from the routine document. */
  nodeCount:    number;
  /** `edges.length` from the routine document. */
  edgeCount:    number;
  /** Subtypes of every node whose `data.category === 'trigger'`. */
  triggerTypes: string[];
  updatedAt?:   string;
}

/**
 * Rollup stats for the hero band. Computed from routines list and/or
 * aggregated run history. Strings so display units ("84h", "$42") can
 * be baked in at the aggregation layer.
 */
export interface RoutinesStats {
  runs:      string;
  artifacts: string;
  reclaimed: string;
  spend:     string;
}
