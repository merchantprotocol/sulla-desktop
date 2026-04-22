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

export interface TemplateSummary {
  slug:        string;
  name:        string;
  description: string;
  category:    RoutineCategory;
  section:     string;
  initials:    string;
  version:     string;
  runtime?:    string;
  tags:        string[];
  inputCount:  number;
  outputCount: number;
  permissions: string;
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
